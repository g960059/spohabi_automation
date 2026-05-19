import { describe, expect, it } from "vitest";
import { isSpohabiReservationCancellationText, isSpohabiReservationReminderText, parseReservationConfirmationEmail, parseVacancyEmail } from "../src/emailParser.js";
import { toJstParts } from "../src/time.js";

const sample = `spohabi-スポハビ- <system@spohabi.com>

平川 雄亮 様

以下のレッスンに空席が出ました。
お早めにご予約されることをお勧めいたします。

スクール: ファーストシティテニスクラブ
レッスン: 土曜C 初中級 11:00～12:20
レッスンURL: https://spohabi.com/fc-tennis/lesson/62
予約日程: 2026/05/02 11:00-12:20
`;

describe("parseVacancyEmail", () => {
  it("extracts lesson URL and JST schedule", () => {
    const parsed = parseVacancyEmail(sample);
    expect(parsed).not.toBeNull();
    expect(parsed?.lessonUrl).toBe("https://spohabi.com/fc-tennis/lesson/62");
    expect(parsed?.lessonId).toBe(62);
    expect(parsed?.schoolSlug).toBe("fc-tennis");
    expect(parsed?.lessonName).toBe("土曜C 初中級 11:00～12:20");
    expect(toJstParts(new Date(parsed!.targetStartAt)).compactDateTime).toBe("2026/05/02 11:00");
  });

  it("ignores non vacancy mail", () => {
    expect(parseVacancyEmail("hello")).toBeNull();
  });
});

const reservationComplete = `【スポハビ】レッスン予約の完了のお知らせ

平川 雄亮 様

以下のご予約が完了しました。

スクール：ファーストシティテニスクラブ
予約日程：2026/05/20 18:20 - 19:40
レッスン：水曜G 初中級 18:20～19:40
コート：インドアB
予約方法：チケットで予約
`;

describe("parseReservationConfirmationEmail", () => {
  it("extracts a completed reservation for calendar sync", () => {
    const parsed = parseReservationConfirmationEmail(reservationComplete);
    expect(parsed).not.toBeNull();
    expect(parsed?.schoolName).toBe("ファーストシティテニスクラブ");
    expect(parsed?.lessonName).toBe("水曜G 初中級 18:20～19:40");
    expect(parsed?.court).toBe("インドアB");
    expect(parsed?.reservationMethod).toBe("チケットで予約");
    expect(toJstParts(new Date(parsed!.targetStartAt)).compactDateTime).toBe("2026/05/20 18:20");
    expect(toJstParts(new Date(parsed!.targetEndAt)).compactDateTime).toBe("2026/05/20 19:40");
  });
});

const reservationCanceled = `【スポハビ】レッスン予約のキャンセルのお知らせ

平川 雄亮 様

以下のご予約がキャンセルされました。

スクール：ファーストシティテニスクラブ
予約日程：2026/05/20 18:20 - 19:40
レッスン：水曜G 初中級 18:20～19:40
`;

describe("isSpohabiReservationCancellationText", () => {
  it("detects reservation cancellation mail for calendar reconcile", () => {
    expect(isSpohabiReservationCancellationText(reservationCanceled)).toBe(true);
  });

  it("detects cancellation mail with Japanese comma", () => {
    const text = `【スポハビ】レッスン予約キャンセルのお知らせ

以下のご予約が、キャンセルされました。

スクール：ファーストシティテニスクラブ
予約日程：2026/05/13 18:20 - 19:40
レッスン：水曜G 初中級 18:20～19:40
コート：インドアB
予約方法：チケットで予約`;
    expect(isSpohabiReservationCancellationText(text)).toBe(true);
  });

  it("does not treat arbitrary cancel text as reservation cancellation", () => {
    expect(isSpohabiReservationCancellationText("キャンセルしました")).toBe(false);
  });
});

describe("isSpohabiReservationReminderText", () => {
  it("detects previous-day reservation reminder mail for calendar reconcile", () => {
    const text = `【スポハビ】ご予約の前日のお知らせ

ご予約の前日となりました。
下記の内容でご予約をお取りしておりますので、ご確認ください。

スクール：ファーストシティテニスクラブ
予約日程：2026/04/28 21:20 - 22:40
レッスン（イベント）：火曜I 初中級 21:20～22:40
レベル：初中級【ナイター】
コート：インドアB
予約方法：チケットで予約`;
    expect(isSpohabiReservationReminderText(text)).toBe(true);
  });
});
