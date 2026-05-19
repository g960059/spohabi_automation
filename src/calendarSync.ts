import type { calendar_v3 } from "googleapis";
import { createHash } from "node:crypto";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { toJstParts } from "./time.js";
import type { ParsedReservationConfirmationEmail, SpohabiReservation } from "./types.js";

export interface CalendarSyncOutcome {
  status: "created" | "exists" | "disabled";
  eventId?: string;
}

export class CalendarSync {
  constructor(private calendar: calendar_v3.Calendar | null) {}

  async syncReservation(messageId: string, reservation: ParsedReservationConfirmationEmail): Promise<CalendarSyncOutcome> {
    if (!config.GOOGLE_CALENDAR_ENABLED) {
      logger.info({ messageId }, "Google Calendar sync disabled");
      return { status: "disabled" };
    }
    if (!this.calendar) throw new Error("Google Calendar client is required when calendar sync is enabled");

    const eventId = calendarEventId(reservation);
    const event = {
      id: eventId,
      summary: `${reservation.lessonName}（スポハビ）`,
      location: [reservation.schoolName, reservation.court].filter(Boolean).join(" "),
      description: [
        "スポハビ予約完了メールから自動作成しました。",
        `スクール: ${reservation.schoolName}`,
        `レッスン: ${reservation.lessonName}`,
        reservation.court ? `コート: ${reservation.court}` : null,
        reservation.reservationMethod ? `予約方法: ${reservation.reservationMethod}` : null,
        `Gmail message id: ${messageId}`
      ]
        .filter(Boolean)
        .join("\n"),
      start: {
        dateTime: toCalendarDateTime(reservation.targetStartAt),
        timeZone: "Asia/Tokyo"
      },
      end: {
        dateTime: toCalendarDateTime(reservation.targetEndAt),
        timeZone: "Asia/Tokyo"
      },
      source: {
        title: "スポハビ",
        url: "https://spohabi.com/"
      }
    } satisfies calendar_v3.Schema$Event;

    try {
      const response = await this.calendar.events.insert({
        calendarId: config.GOOGLE_CALENDAR_ID,
        requestBody: event
      });
      logger.info({ messageId, eventId: response.data.id ?? eventId }, "Created Google Calendar event for Spohabi reservation");
      return { status: "created", eventId: response.data.id ?? eventId };
    } catch (error) {
      if (isCalendarConflict(error)) {
        logger.info({ messageId, eventId }, "Google Calendar event already exists");
        return { status: "exists", eventId };
      }
      throw error;
    }
  }

  async reconcileReservations(input: {
    reservations: SpohabiReservation[];
    timeMin: string;
    timeMax: string;
    deleteExtra?: boolean;
  }): Promise<{ created: number; exists: number; deleted: number; kept: number }> {
    if (!config.GOOGLE_CALENDAR_ENABLED) return { created: 0, exists: 0, deleted: 0, kept: 0 };
    if (!this.calendar) throw new Error("Google Calendar client is required when calendar sync is enabled");
    const desiredIds = new Set(input.reservations.map((item) => calendarEventId(item)));
    let created = 0;
    let exists = 0;
    let deleted = 0;

    for (const reservation of input.reservations) {
      const outcome = await this.upsertCalendarReservation(reservation);
      if (outcome.status === "created") created += 1;
      if (outcome.status === "exists") exists += 1;
    }

    if (input.deleteExtra) {
      const current = await this.calendar.events.list({
        calendarId: config.GOOGLE_CALENDAR_ID,
        timeMin: input.timeMin,
        timeMax: input.timeMax,
        singleEvents: true,
        orderBy: "startTime",
        q: "スポハビ"
      });
      for (const event of current.data.items ?? []) {
        if (!event.id?.startsWith("spohabi")) continue;
        if (desiredIds.has(event.id)) continue;
        await this.calendar.events.delete({ calendarId: config.GOOGLE_CALENDAR_ID, eventId: event.id });
        deleted += 1;
      }
    }

    return { created, exists, deleted, kept: desiredIds.size };
  }

  private async upsertCalendarReservation(reservation: ParsedReservationConfirmationEmail | SpohabiReservation): Promise<CalendarSyncOutcome> {
    if (!this.calendar) throw new Error("Google Calendar client is required");
    const eventId = calendarEventId(reservation);
    const event = buildCalendarEvent(eventId, reservation);
    try {
      const response = await this.calendar.events.insert({
        calendarId: config.GOOGLE_CALENDAR_ID,
        requestBody: event
      });
      return { status: "created", eventId: response.data.id ?? eventId };
    } catch (error) {
      if (!isCalendarConflict(error)) throw error;
      await this.calendar.events.patch({
        calendarId: config.GOOGLE_CALENDAR_ID,
        eventId,
        requestBody: event
      });
      return { status: "exists", eventId };
    }
  }
}

function calendarEventId(reservation: ParsedReservationConfirmationEmail | SpohabiReservation): string {
  const key = [reservation.schoolName, reservation.lessonName, reservation.targetStartAt, reservation.targetEndAt].join("|");
  return `spohabi${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

function buildCalendarEvent(eventId: string, reservation: ParsedReservationConfirmationEmail | SpohabiReservation): calendar_v3.Schema$Event {
  const location = [reservation.schoolName, reservation.court].filter(Boolean).join(" ");
  const descriptionLines = [
    "スポハビ予約から自動作成しました。",
    `スクール: ${reservation.schoolName}`,
    `レッスン: ${reservation.lessonName}`,
    reservation.court ? `コート: ${reservation.court}` : null,
    "reservationMethod" in reservation && reservation.reservationMethod ? `予約方法: ${reservation.reservationMethod}` : null,
    "coach" in reservation && reservation.coach ? `担当: ${reservation.coach}` : null,
    "level" in reservation && reservation.level ? `レベル: ${reservation.level}` : null,
    "lessonUrl" in reservation && reservation.lessonUrl ? `URL: ${reservation.lessonUrl}` : null
  ].filter(Boolean);
  return {
    id: eventId,
    summary: `${reservation.lessonName}（スポハビ）`,
    location,
    description: descriptionLines.join("\n"),
    start: {
      dateTime: toCalendarDateTime(reservation.targetStartAt),
      timeZone: "Asia/Tokyo"
    },
    end: {
      dateTime: toCalendarDateTime(reservation.targetEndAt),
      timeZone: "Asia/Tokyo"
    },
    source: {
      title: "スポハビ",
      url: "https://spohabi.com/"
    }
  };
}

function toCalendarDateTime(iso: string): string {
  const parts = toJstParts(new Date(iso));
  return `${parts.date}T${parts.timeWithSeconds}`;
}

function isCalendarConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { code?: unknown; status?: unknown }).code ?? (error as { code?: unknown; status?: unknown }).status;
  return status === 409 || status === "409";
}
