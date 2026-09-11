import { extractLessonInfo, normalizeLessonUrl, parseJstDateAndTime } from "./time.js";
import type { ParsedReservationCancellationEmail, ParsedReservationConfirmationEmail, ParsedVacancyEmail } from "./types.js";

const VACANCY_PHRASE = "以下のレッスンに空席が出ました";
const RESERVATION_COMPLETE_PHRASE = "以下のご予約が完了しました";
const RESERVATION_CANCEL_PATTERNS = [
  "以下のご予約をキャンセルしました",
  "以下のご予約がキャンセルされました",
  "以下のご予約が、キャンセルされました",
  "予約のキャンセル",
  "予約キャンセル",
  "レッスン予約のキャンセル"
];
const RESERVATION_REMINDER_PATTERNS = ["ご予約の前日となりました", "下記の内容でご予約をお取りしております"];

export function isSpohabiVacancyText(text: string): boolean {
  return text.includes(VACANCY_PHRASE) && text.includes("レッスンURL:") && text.includes("予約日程:");
}

export function parseVacancyEmail(text: string): ParsedVacancyEmail | null {
  if (!isSpohabiVacancyText(text)) return null;

  const schoolName = matchLine(text, /スクール:\s*(.+)/);
  const lessonName = matchLine(text, /レッスン:\s*(.+)/);
  const lessonUrlRaw = matchLine(text, /レッスンURL:\s*(https?:\/\/\S+)/);
  const dateRaw = matchLine(text, /予約日程:\s*(\d{4}\/\d{2}\/\d{2})\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);

  if (!lessonUrlRaw || !dateRaw || !lessonName) return null;

  const dateMatch = text.match(/予約日程:\s*(\d{4}\/\d{2}\/\d{2})\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
  if (!dateMatch) return null;

  const lessonUrl = normalizeLessonUrl(lessonUrlRaw);
  const { lessonId, slug } = extractLessonInfo(lessonUrl);
  const targetStartAt = parseJstDateAndTime(dateMatch[1], dateMatch[2]).toISOString();
  const targetEndAt = parseJstDateAndTime(dateMatch[1], dateMatch[3]).toISOString();

  return {
    lessonUrl,
    lessonId,
    schoolSlug: slug,
    lessonName: lessonName.trim(),
    schoolName: schoolName?.trim() ?? null,
    targetStartAt,
    targetEndAt
  };
}

export function isSpohabiReservationConfirmationText(text: string): boolean {
  return text.includes(RESERVATION_COMPLETE_PHRASE) && /予約日程[:：]/.test(text) && /レッスン[:：]/.test(text);
}

export function isSpohabiReservationCancellationText(text: string): boolean {
  return RESERVATION_CANCEL_PATTERNS.some((pattern) => text.includes(pattern)) && /予約日程[:：]/.test(text) && /レッスン(?:（イベント）|\(イベント\))?[:：]/.test(text);
}

export function isSpohabiReservationReminderText(text: string): boolean {
  return RESERVATION_REMINDER_PATTERNS.some((pattern) => text.includes(pattern)) && /予約日程[:：]/.test(text) && /レッスン(?:（イベント）)?[:：]/.test(text);
}

export function parseReservationCancellationEmail(text: string): ParsedReservationCancellationEmail | null {
  if (!isSpohabiReservationCancellationText(text)) return null;
  const schoolName = matchLine(text, /^スクール[:：][ \t]*(.+)$/m);
  const lessonName = matchLine(text, /^レッスン(?:（イベント）|\(イベント\))?[:：][ \t]*(.+)$/m);
  const dateMatch = text.match(/^予約日程[:：][ \t]*(\d{4}\/\d{2}\/\d{2})[ \t]+(\d{1,2}:\d{2})[ \t]*-[ \t]*(\d{1,2}:\d{2})[ \t]*\r?$/m);
  if (!schoolName || !lessonName || !dateMatch) return null;
  const start = parseJstDateAndTime(dateMatch[1], dateMatch[2]);
  const end = parseJstDateAndTime(dateMatch[1], dateMatch[3]);
  // Reject invalid dates instead of letting Date normalize them into another lesson's slot.
  for (const [date, time] of [[start, dateMatch[2]], [end, dateMatch[3]]] as const) {
    const expected = `${dateMatch[1].replace(/\//g, "-")}T${time.padStart(5, "0")}:00.000Z`;
    if (!Number.isFinite(date.getTime()) || new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString() !== expected) return null;
  }
  if (end <= start) return null;
  return { schoolName, lessonName, targetStartAt: start.toISOString(), targetEndAt: end.toISOString() };
}

export function parseReservationConfirmationEmail(text: string): ParsedReservationConfirmationEmail | null {
  if (!isSpohabiReservationConfirmationText(text)) return null;
  const schoolName = matchLine(text, /スクール[:：]\s*(.+)/);
  const lessonName = matchLine(text, /レッスン[:：]\s*(.+)/);
  const court = matchLine(text, /コート[:：]\s*(.+)/);
  const reservationMethod = matchLine(text, /予約方法[:：]\s*(.+)/);
  const dateMatch = text.match(/予約日程[:：]\s*(\d{4}\/\d{2}\/\d{2})\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
  if (!schoolName || !lessonName || !dateMatch) return null;
  return {
    schoolName: schoolName.trim(),
    lessonName: lessonName.trim(),
    targetStartAt: parseJstDateAndTime(dateMatch[1], dateMatch[2]).toISOString(),
    targetEndAt: parseJstDateAndTime(dateMatch[1], dateMatch[3]).toISOString(),
    court: court?.trim() ?? null,
    reservationMethod: reservationMethod?.trim() ?? null
  };
}

function matchLine(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  return match?.[1]?.trim() ?? null;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\r/g, "")
    .trim();
}
