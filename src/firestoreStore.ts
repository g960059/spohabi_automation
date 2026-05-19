import { Firestore, FieldValue, Timestamp } from "@google-cloud/firestore";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { nowIso, toJstParts } from "./time.js";
import type { WatchStatus, WatchlistItem } from "./types.js";

const MESSAGE_LEASE_MS = 180_000;
const WATCH_LEASE_MS = 180_000;
const SYNC_LEASE_MS = 120_000;
const PROCESSED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ATTEMPT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface GmailSyncLease {
  owner: string;
  lastHistoryId: string | null;
  pendingHistoryId: string | null;
}

export class FirestoreStore {
  private db = config.GOOGLE_CLOUD_PROJECT ? new Firestore({ projectId: config.GOOGLE_CLOUD_PROJECT }) : new Firestore();

  gmailStateRef() {
    return this.db.collection("app_state").doc("gmail");
  }

  watchId(schoolSlug: string, lessonId: number, targetStartAtIso: string): string {
    return `${schoolSlug}_${lessonId}_${toJstParts(new Date(targetStartAtIso)).watchKeyDateTime}`;
  }

  async addWatch(input: {
    lessonUrl: string;
    lessonId: number;
    schoolSlug: string;
    targetStartAt: string;
    expiresAt: string;
    lessonName?: string;
    ticketPriority?: string[];
    note?: string;
  }): Promise<WatchlistItem> {
    const id = this.watchId(input.schoolSlug, input.lessonId, input.targetStartAt);
    const at = nowIso();
    await this.db.collection("watchlist").doc(id).set(
      {
        lessonUrl: input.lessonUrl,
        lessonId: input.lessonId,
        schoolSlug: input.schoolSlug,
        targetStartAt: Timestamp.fromDate(new Date(input.targetStartAt)),
        expiresAt: Timestamp.fromDate(new Date(input.expiresAt)),
        lessonName: input.lessonName ?? null,
        ticketPriority: input.ticketPriority ?? [],
        note: input.note ?? null,
        status: "watching",
        eventDateId: null,
        reservationLeaseUntil: null,
        reservationMessageId: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
    const watch = await this.findWatchById(id);
    if (!watch) throw new Error(`Failed to create watchlist item: ${id}`);
    return watch;
  }

  async upsertWatchFromVacancy(input: {
    lessonUrl: string;
    lessonId: number;
    schoolSlug: string;
    targetStartAt: string;
    expiresAt: string;
    lessonName?: string;
    note?: string;
  }): Promise<WatchlistItem> {
    const id = this.watchId(input.schoolSlug, input.lessonId, input.targetStartAt);
    const ref = this.db.collection("watchlist").doc(id);
    const now = Date.now();
    await this.db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      const data = doc.data() ?? {};
      const status = data.status;
      const lease = data.reservationLeaseUntil instanceof Timestamp ? data.reservationLeaseUntil.toMillis() : 0;
      const keepReservationLease = status === "reserving" && lease > now;
      const next = {
        lessonUrl: input.lessonUrl,
        lessonId: input.lessonId,
        schoolSlug: input.schoolSlug,
        targetStartAt: Timestamp.fromDate(new Date(input.targetStartAt)),
        expiresAt: Timestamp.fromDate(new Date(input.expiresAt)),
        lessonName: input.lessonName ?? data.lessonName ?? null,
        note: input.note ?? data.note ?? null,
        ticketPriority: data.ticketPriority ?? [],
        status: keepReservationLease ? "reserving" : "watching",
        eventDateId: keepReservationLease ? (data.eventDateId ?? null) : null,
        reservationLeaseUntil: keepReservationLease ? data.reservationLeaseUntil : null,
        reservationMessageId: keepReservationLease ? data.reservationMessageId : null,
        updatedAt: FieldValue.serverTimestamp()
      };
      if (!doc.exists) {
        tx.set(ref, { ...next, createdAt: FieldValue.serverTimestamp() });
      } else {
        tx.set(ref, next, { merge: true });
      }
    });
    const watch = await this.findWatchById(id);
    if (!watch) throw new Error(`Failed to upsert vacancy watch item: ${id}`);
    return watch;
  }

  async listWatches(status?: WatchStatus): Promise<WatchlistItem[]> {
    const base = this.db.collection("watchlist");
    const snapshot = status ? await base.where("status", "==", status).orderBy("targetStartAt").get() : await base.orderBy("targetStartAt").get();
    return snapshot.docs.map((doc) => fromWatchDoc(doc.id, doc.data()));
  }

  async findWatch(lessonUrl: string, targetStartAt: string, schoolSlug?: string, lessonId?: number): Promise<WatchlistItem | null> {
    if (schoolSlug && lessonId) return this.findWatchById(this.watchId(schoolSlug, lessonId, targetStartAt));
    const snapshot = await this.db
      .collection("watchlist")
      .where("lessonUrl", "==", lessonUrl)
      .where("targetStartAt", "==", Timestamp.fromDate(new Date(targetStartAt)))
      .limit(1)
      .get();
    const doc = snapshot.docs[0];
    return doc ? fromWatchDoc(doc.id, doc.data()) : null;
  }

  async findWatchById(id: string): Promise<WatchlistItem | null> {
    const doc = await this.db.collection("watchlist").doc(id).get();
    return doc.exists ? fromWatchDoc(doc.id, doc.data() ?? {}) : null;
  }

  async expireDueWatches(at = new Date()): Promise<WatchlistItem[]> {
    const snapshot = await this.db.collection("watchlist").where("status", "in", ["watching", "reserving"]).where("expiresAt", "<=", Timestamp.fromDate(at)).get();
    if (snapshot.empty) return [];
    const batch = this.db.batch();
    const expired = snapshot.docs.map((doc) => fromWatchDoc(doc.id, doc.data()));
    for (const doc of snapshot.docs) {
      batch.update(doc.ref, { status: "expired", updatedAt: FieldValue.serverTimestamp() });
    }
    await batch.commit();
    return expired.map((item) => ({ ...item, status: "expired" as const }));
  }

  async updateWatchStatus(id: string, status: WatchStatus, eventDateId?: number | null): Promise<void> {
    await this.db
      .collection("watchlist")
      .doc(id)
      .set(
        {
          status,
          ...(eventDateId !== undefined && eventDateId !== null ? { eventDateId } : {}),
          ...(status !== "reserving" ? { reservationLeaseUntil: null, reservationMessageId: null } : {}),
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );
  }

  async claimWatchForReservation(id: string, messageId: string): Promise<boolean> {
    const ref = this.db.collection("watchlist").doc(id);
    const now = Date.now();
    return this.db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) return false;
      const data = doc.data() ?? {};
      const status = data.status;
      const lease = data.reservationLeaseUntil instanceof Timestamp ? data.reservationLeaseUntil.toMillis() : 0;
      if (status !== "watching" && !(status === "reserving" && lease <= now)) return false;
      tx.update(ref, {
        status: "reserving",
        reservationLeaseUntil: Timestamp.fromMillis(now + WATCH_LEASE_MS),
        reservationMessageId: messageId,
        updatedAt: FieldValue.serverTimestamp()
      });
      return true;
    });
  }

  async releaseWatchReservation(id: string): Promise<void> {
    await this.db.collection("watchlist").doc(id).set(
      {
        status: "watching",
        reservationLeaseUntil: null,
        reservationMessageId: null,
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  }

  async hasProcessedMessage(messageId: string): Promise<boolean> {
    const doc = await this.db.collection("processed_messages").doc(messageId).get();
    const status = doc.data()?.status;
    return Boolean(status && isTerminalMessageStatus(status));
  }

  async claimMessage(messageId: string, historyId?: string, allowDryRunReplay = false): Promise<boolean> {
    const ref = this.db.collection("processed_messages").doc(messageId);
    const now = Date.now();
    return this.db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      const data = doc.data();
      if (!data) {
        tx.set(ref, messageClaimData(historyId, now));
        return true;
      }
      const status = data.status;
      const lease = data.leaseUntil instanceof Timestamp ? data.leaseUntil.toMillis() : 0;
      if (status === "processing" && lease > now) return false;
      if (status === "processing" || status === "retryable" || (allowDryRunReplay && status === "dry_run")) {
        tx.set(ref, messageClaimData(historyId, now), { merge: true });
        return true;
      }
      return false;
    });
  }

  async markProcessed(input: { messageId: string; historyId?: string; watchlistId?: string; status: string; reason?: string }): Promise<void> {
    await this.db.collection("processed_messages").doc(input.messageId).set(
      {
        historyId: input.historyId ?? null,
        watchId: input.watchlistId ?? null,
        status: input.status,
        reason: input.reason ?? null,
        leaseUntil: null,
        ttlAt: Timestamp.fromMillis(Date.now() + PROCESSED_TTL_MS),
        updatedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  }

  async addAttempt(input: { watchlistId?: string; messageId?: string; status: string; reason?: string; raw?: unknown }): Promise<void> {
    await this.db.collection("reservation_attempts").add({
      watchId: input.watchlistId ?? null,
      messageId: input.messageId ?? null,
      status: input.status,
      reason: input.reason ?? null,
      rawResponse: input.raw ?? null,
      ttlAt: Timestamp.fromMillis(Date.now() + ATTEMPT_TTL_MS),
      createdAt: FieldValue.serverTimestamp()
    });
  }

  async updatePendingHistoryId(historyId: string): Promise<void> {
    const ref = this.gmailStateRef();
    await this.db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      const current = historyIdString(doc.data()?.pendingHistoryId);
      tx.set(
        ref,
        {
          pendingHistoryId: maxHistoryId(current, historyId),
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    });
  }

  async acquireSyncLease(): Promise<GmailSyncLease | null> {
    const ref = this.gmailStateRef();
    const owner = randomUUID();
    const now = Date.now();
    return this.db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      const data = doc.data() ?? {};
      const lastHistoryId = historyIdString(data.lastHistoryId);
      const pendingHistoryId = historyIdString(data.pendingHistoryId);
      if (!pendingHistoryId || (lastHistoryId && maxHistoryId(lastHistoryId, pendingHistoryId) === lastHistoryId)) return null;
      const leaseUntil = data.syncLeaseUntil instanceof Timestamp ? data.syncLeaseUntil.toMillis() : 0;
      if (leaseUntil > now) return null;
      tx.set(
        ref,
        {
          syncLeaseOwner: owner,
          syncLeaseUntil: Timestamp.fromMillis(now + SYNC_LEASE_MS),
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );
      return {
        owner,
        lastHistoryId,
        pendingHistoryId
      };
    });
  }

  async completeSyncLease(owner: string, historyId: string): Promise<void> {
    const ref = this.gmailStateRef();
    await this.db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      const data = doc.data() ?? {};
      if (data.syncLeaseOwner !== owner) return;
      const nextHistoryId = maxHistoryId(historyIdString(data.lastHistoryId), historyId);
      const pendingHistoryId = maxHistoryId(historyIdString(data.pendingHistoryId), nextHistoryId);
      tx.set(
        ref,
        {
          lastHistoryId: nextHistoryId,
          pendingHistoryId,
          syncLeaseOwner: null,
          syncLeaseUntil: null,
          lastSuccessfulSyncAt: FieldValue.serverTimestamp(),
          lastError: null,
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    });
  }

  async failSyncLease(owner: string, error: string): Promise<void> {
    const ref = this.gmailStateRef();
    await this.db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if ((doc.data() ?? {}).syncLeaseOwner !== owner) return;
      tx.set(
        ref,
        {
          syncLeaseOwner: null,
          syncLeaseUntil: null,
          lastError: error,
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    });
  }

  async resetHistoryAfter404(newHistoryId: string): Promise<void> {
    await this.gmailStateRef().set(
      {
        lastHistoryId: newHistoryId,
        pendingHistoryId: newHistoryId,
        historyResetCount: FieldValue.increment(1),
        lastSuccessfulSyncAt: FieldValue.serverTimestamp(),
        lastError: "history_404_reset",
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  }

  async setWatchRenewal(watch: { historyId: string; expiration?: string | null }): Promise<void> {
    await this.gmailStateRef().set(
      {
        watchExpiration: watch.expiration ? Timestamp.fromMillis(Number(watch.expiration)) : null,
        lastWatchRenewalAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  }

  async shouldNotifySystemWarning(key: string, intervalMs: number): Promise<boolean> {
    const ref = this.db.collection("app_state").doc(`system_warning_${key}`);
    const now = Date.now();
    return this.db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      const lastNotifiedAt = doc.data()?.lastNotifiedAt instanceof Timestamp ? doc.data()?.lastNotifiedAt.toMillis() : 0;
      if (lastNotifiedAt && now - lastNotifiedAt < intervalMs) return false;
      tx.set(
        ref,
        {
          key,
          lastNotifiedAt: Timestamp.fromMillis(now),
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );
      return true;
    });
  }
}

export function maxHistoryId(a: string | null | undefined, b: string | null | undefined): string {
  if (!a) return b ?? "";
  if (!b) return a;
  try {
    return BigInt(a) >= BigInt(b) ? a : b;
  } catch {
    return a.localeCompare(b) >= 0 ? a : b;
  }
}

function historyIdString(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === "bigint") return value.toString();
  return null;
}

function messageClaimData(historyId: string | undefined, now: number): Record<string, unknown> {
  return {
    historyId: historyId ?? null,
    status: "processing",
    reason: null,
    leaseUntil: Timestamp.fromMillis(now + MESSAGE_LEASE_MS),
    ttlAt: Timestamp.fromMillis(now + PROCESSED_TTL_MS),
    updatedAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp()
  };
}

function isTerminalMessageStatus(status: string): boolean {
  return status !== "dry_run" && status !== "processing" && status !== "retryable";
}

function fromWatchDoc(id: string, data: FirebaseFirestore.DocumentData): WatchlistItem {
  return {
    id,
    lesson_url: data.lessonUrl,
    lesson_id: data.lessonId,
    school_slug: data.schoolSlug,
    target_start_at: timestampToIso(data.targetStartAt),
    expires_at: timestampToIso(data.expiresAt),
    lesson_name: data.lessonName ?? null,
    ticket_priority_json: JSON.stringify(data.ticketPriority ?? []),
    note: data.note ?? null,
    status: data.status,
    event_date_id: data.eventDateId ?? null,
    reservation_lease_until: data.reservationLeaseUntil ? timestampToIso(data.reservationLeaseUntil) : null,
    reservation_message_id: data.reservationMessageId ?? null,
    created_at: data.createdAt ? timestampToIso(data.createdAt) : nowIso(),
    updated_at: data.updatedAt ? timestampToIso(data.updatedAt) : nowIso()
  };
}

function timestampToIso(value: unknown): string {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return nowIso();
}
