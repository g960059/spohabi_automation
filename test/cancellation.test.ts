import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { parseReservationCancellationEmail } from "../src/emailParser.js";
import { FirestoreStore } from "../src/firestoreStore.js";
import { ReservationOrchestrator } from "../src/reservationOrchestrator.js";
import { reservationSlotKey } from "../src/reservationSlot.js";
import { SpohabiClient } from "../src/spohabiClient.js";
import { SlackNotifier } from "../src/slackNotifier.js";
import { memoryFirestore } from "./helpers/memoryFirestore.js";

const cancellation = `以下のご予約が、キャンセルされました。

スクール：ファーストシティテニスクラブ
予約日程：2026/09/12 08:00 - 09:20
レッスン：土曜A 初中級 8:00～9:20
コート：インドアB
予約方法：チケットで予約`;
const slot = {
  schoolName: "ファーストシティテニスクラブ",
  lessonName: "土曜A 初中級 8:00～9:20",
  targetStartAt: "2026-09-11T23:00:00.000Z",
  targetEndAt: "2026-09-12T00:20:00.000Z"
};
const watchInput = {
  ...slot,
  lessonUrl: "https://spohabi.com/fc-tennis/lesson/57",
  lessonId: 57,
  schoolSlug: "fc-tennis",
  expiresAt: "2026-09-11T22:00:00.000Z"
};
const vacancy = `以下のレッスンに空席が出ました。
スクール: ${slot.schoolName}
レッスン: ${slot.lessonName}
レッスンURL: ${watchInput.lessonUrl}
予約日程: 2026/09/12 08:00-09:20`;
const email = (messageId: string, text: string) => ({
  messageId, text, from: "spohabi <system@spohabi.com>", subject: null,
  authenticationResults: "mx.example; dkim=pass header.d=spohabi.com"
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-11T14:30:00Z"));
  vi.spyOn(config, "GOOGLE_CALENDAR_ENABLED", "get").mockReturnValue(false);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request in cancellation test"); }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("cancellation identification", () => {
  it("parses the supplied cancellation without needing a lesson URL", () => {
    expect(parseReservationCancellationEmail(cancellation)).toEqual(slot);
  });

  it("accepts CRLF, ASCII colons and event labels", () => {
    const text = cancellation.replaceAll("：", ": ").replace("レッスン:", "レッスン(イベント):").replaceAll("\n", "\r\n");
    expect(parseReservationCancellationEmail(text)).toEqual(slot);
  });

  it.each([
    cancellation.replace("2026/09/12", "2026/02/30"),
    cancellation.replace("08:00 - 09:20", "25:00 - 26:20"),
    cancellation.replace("08:00 - 09:20", "09:20 - 08:00"),
    cancellation.replace(`スクール：${slot.schoolName}`, ""),
    cancellation.replace("以下のご予約が、キャンセルされました。", "以下のご予約が完了しました。"),
    vacancy
  ])("rejects incomplete/invalid or non-cancellation messages", (text) => {
    expect(parseReservationCancellationEmail(text)).toBeNull();
  });

  it("normalizes display names/times but retains the occurrence, lesson and school", () => {
    const key = reservationSlotKey(slot);
    expect(reservationSlotKey({ ...slot, lessonName: "土曜Ａ　初中級 08:00〜09:20", targetStartAt: "2026-09-12T08:00:00+09:00" })).toBe(key);
    expect(reservationSlotKey({ ...slot, lessonName: "土曜A 初中級" })).toBe(key);
    expect(reservationSlotKey({ ...slot, targetStartAt: "2026-09-18T23:00:00Z" })).not.toBe(key);
    expect(reservationSlotKey({ ...slot, lessonName: "土曜A 中級" })).not.toBe(key);
    expect(reservationSlotKey({ ...slot, schoolName: "別のスクール" })).not.toBe(key);
  });
});

describe("persistent auto-reservation stop", () => {
  it("records cancellation before the first vacancy and keeps it stopped across new store instances", async () => {
    const { db, data } = memoryFirestore();
    expect(await new FirestoreStore(db).cancelAutoReservation(slot, "cancel-1")).toBe(0);
    const store = new FirestoreStore(db);
    const watch = await store.upsertWatchFromVacancy(watchInput);
    expect(watch.status).toBe("cancelled");
    expect(await store.claimWatchForReservation(watch.id, "vacancy-1")).toBe(false);
    expect(data.get(`reservation_cancellations/${reservationSlotKey(slot)}`)?.messageId).toBe("cancel-1");
  });

  it.each(["watching", "reserving", "reserved", "expired"] as const)("does not revive a cancelled %s watch through retries or forced updates", async (status) => {
    const { db, data } = memoryFirestore();
    const store = new FirestoreStore(db);
    const watch = await store.addWatch(watchInput);
    await store.claimWatchForReservation(watch.id, "vacancy-1");
    await store.updateWatchStatus(watch.id, status);
    // Deployed watches predate the schoolName field.
    delete data.get(`watchlist/${watch.id}`)!.schoolName;
    expect(await store.cancelAutoReservation(slot, "cancel-1")).toBe(1);
    expect(await store.canReserveWatch(watch.id, "vacancy-1")).toBe(false);
    await store.releaseWatchReservation(watch.id);
    await store.updateWatchStatus(watch.id, "reserved");
    expect((await store.upsertWatchFromVacancy(watchInput)).status).toBe("cancelled");
    expect((await store.addWatch(watchInput)).status).toBe("cancelled");
    expect(await store.claimWatchForReservation(watch.id, "vacancy-2")).toBe(false);
    expect(await store.expireDueWatches(new Date("2026-09-13"))).toEqual([]);
    expect(await store.findWatchById(watch.id)).toMatchObject({ status: "cancelled", reservation_message_id: null, reservation_lease_until: null });
  });

  it("does not stop other weeks, lessons or schools", async () => {
    const store = new FirestoreStore(memoryFirestore().db);
    const others = [
      { ...watchInput, targetStartAt: "2026-09-18T23:00:00Z" },
      { ...watchInput, lessonId: 58, lessonName: "土曜A 中級 8:00～9:20" },
      { ...watchInput, schoolSlug: "other", schoolName: "別のスクール" }
    ];
    const watches = await Promise.all(others.map((input) => store.upsertWatchFromVacancy(input)));
    expect(await store.cancelAutoReservation(slot, "cancel-1")).toBe(0);
    for (const watch of watches) expect(await store.claimWatchForReservation(watch.id, "vacancy-1")).toBe(true);
  });

  it("checks the resolved lesson for manually-created watches with no lesson name", async () => {
    const store = new FirestoreStore(memoryFirestore().db);
    const watch = await store.addWatch({ ...watchInput, lessonName: undefined });
    await store.cancelAutoReservation(slot, "cancel-1");
    await store.claimWatchForReservation(watch.id, "manual-1");
    expect(await store.canReserveWatch(watch.id, "manual-1", slot)).toBe(false);
    expect(await store.canReserveWatch(watch.id, "wrong-owner")).toBe(false);
  });

  it("only allows an unexpired lease held by the calling attempt", async () => {
    const store = new FirestoreStore(memoryFirestore().db);
    const watch = await store.addWatch(watchInput);
    await store.claimWatchForReservation(watch.id, "vacancy-1");
    expect(await store.canReserveWatch(watch.id, "vacancy-1", slot)).toBe(true);
    expect(await store.canReserveWatch(watch.id, "vacancy-2", slot)).toBe(false);
    vi.setSystemTime(new Date(Date.now() + 181_000));
    expect(await store.canReserveWatch(watch.id, "vacancy-1", slot)).toBe(false);
  });
});

function workflow() {
  const memory = memoryFirestore();
  const store = new FirestoreStore(memory.db);
  const client = new SpohabiClient();
  const reserve = vi.spyOn(client, "reserveForWatch").mockResolvedValue({ status: "dry_run", reason: "dry_run" });
  vi.spyOn(client, "listCurrentReservations").mockRejectedValue(new Error("Mock calendar failure"));
  const notifier = new SlackNotifier();
  const notify = vi.spyOn(notifier, "reservationAttempt").mockResolvedValue();
  vi.spyOn(notifier, "expired").mockResolvedValue();
  return { store, reserve, notify, data: memory.data, orchestrator: new ReservationOrchestrator(store, null, client, notifier) };
}

describe("cancellation email workflow", () => {
  it("ignores subsequent vacancy emails for the slot and still processes next week's vacancy", async () => {
    const { orchestrator, reserve, notify, data } = workflow();
    await orchestrator.processEmailNotification(email("cancel-1", cancellation));
    await orchestrator.processEmailNotification(email("vacancy-1", vacancy));
    await orchestrator.processEmailNotification(email("cancel-1", cancellation));
    await orchestrator.processEmailNotification(email("vacancy-2", vacancy));
    expect(reserve).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(data.get("processed_messages/vacancy-2")).toMatchObject({ status: "ignored", reason: "reservation_cancelled" });
    await orchestrator.processEmailNotification(email("vacancy-next-week", vacancy.replace("2026/09/12", "2026/09/19")));
    expect(reserve).toHaveBeenCalledOnce();
  });

  it("keeps the stop when calendar synchronization fails", async () => {
    vi.spyOn(config, "GOOGLE_CALENDAR_ENABLED", "get").mockReturnValue(true);
    const { orchestrator, reserve, data } = workflow();
    await orchestrator.processEmailNotification(email("cancel-1", cancellation));
    expect(data.get("processed_messages/cancel-1")?.status).toBe("calendar_failed");
    await orchestrator.processEmailNotification(email("vacancy-1", vacancy));
    expect(reserve).not.toHaveBeenCalled();
  });

  it("does not stop a slot from unauthenticated mail", async () => {
    const { orchestrator, data } = workflow();
    await orchestrator.processEmailNotification({ ...email("cancel-1", cancellation), authenticationResults: null });
    expect(data.get("processed_messages/cancel-1")?.reason).toBe("untrusted_sender");
    expect(data.has(`reservation_cancellations/${reservationSlotKey(slot)}`)).toBe(false);
  });

  it("leaves failed stop writes retryable and succeeds on redelivery", async () => {
    const { orchestrator, store, data } = workflow();
    vi.spyOn(store, "cancelAutoReservation").mockRejectedValueOnce(new Error("Firestore unavailable"));
    await expect(orchestrator.processEmailNotification(email("cancel-1", cancellation))).rejects.toThrow("Firestore unavailable");
    expect(data.get("processed_messages/cancel-1")?.status).toBe("retryable");
    await orchestrator.processEmailNotification(email("cancel-1", cancellation));
    expect(data.has(`reservation_cancellations/${reservationSlotKey(slot)}`)).toBe(true);
  });

  it("does not mark malformed cancellation as successfully processed", async () => {
    const { orchestrator, data } = workflow();
    await expect(orchestrator.processEmailNotification(email("cancel-1", cancellation.replace("2026/09/12", "2026/02/30")))).rejects.toThrow("Cannot identify");
    expect(data.has("processed_messages/cancel-1")).toBe(false);
  });

  it("handles a cancellation arriving during reservation preparation without reviving the watch or notifying", async () => {
    const { orchestrator, reserve, notify, store } = workflow();
    reserve.mockImplementationOnce(async (_watch, canReserve) => {
      expect(await canReserve!()).toBe(true);
      await orchestrator.processEmailNotification(email("cancel-1", cancellation));
      expect(await canReserve!(slot)).toBe(false);
      return { status: "blocked", reason: "auto_reservation_stopped" };
    });
    await orchestrator.processEmailNotification(email("vacancy-1", vacancy));
    const id = store.watchId("fc-tennis", 57, slot.targetStartAt);
    expect((await store.findWatchById(id))?.status).toBe("cancelled");
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("reservation API stop guard", () => {
  it("checks cancellation immediately before submitting, even after passing the first check", async () => {
    vi.spyOn(config, "DRY_RUN", "get").mockReturnValue(false);
    const store = new FirestoreStore(memoryFirestore().db);
    const watch = await store.addWatch(watchInput);
    await store.claimWatchForReservation(watch.id, "vacancy-1");
    const client = new SpohabiClient();
    const mockPrivate = (method: string, value: unknown) => vi.spyOn(client as any, method).mockResolvedValue(value);
    mockPrivate("resolveSchool", { id: 1, slug: "fc-tennis", schema: "school" });
    mockPrivate("resolveEventDate", { reserve_event_dates: [], schedule: { max_people: 8, lesson: { lesson_name: slot.lessonName } } });
    mockPrivate("findMemberByEmail", { id: 1, school_members: [{ id: 2, school_id: 1 }] });
    mockPrivate("memberHeaders", {});
    mockPrivate("hasSameTimeReservation", false);
    mockPrivate("listUsableTickets", []);
    vi.spyOn(client as any, "chooseTicket").mockReturnValue({ id: 1 });
    vi.spyOn(client as any, "buildReservationPayload").mockReturnValue({});
    vi.spyOn(client as any, "spohabiApiKey").mockImplementation(async () => {
      await store.cancelAutoReservation(slot, "cancel-1");
      return "test-api-key";
    });
    const guard = vi.fn((resolvedSlot) => store.canReserveWatch(watch.id, "vacancy-1", resolvedSlot));
    const result = await client.reserveForWatch((await store.findWatchById(watch.id))!, guard);
    expect(result).toEqual({ status: "blocked", reason: "auto_reservation_stopped" });
    expect(guard).toHaveBeenCalledTimes(2);
    expect(guard).toHaveBeenLastCalledWith({ schoolName: slot.schoolName, lessonName: slot.lessonName, targetStartAt: slot.targetStartAt });
    expect(fetch).not.toHaveBeenCalled();
  });
});
