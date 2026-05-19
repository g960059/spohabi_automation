export type WatchStatus = "watching" | "reserving" | "reserved" | "missed" | "expired" | "blocked";

export interface WatchlistItem {
  id: string;
  lesson_url: string;
  lesson_id: number;
  school_slug: string;
  target_start_at: string;
  expires_at: string;
  lesson_name: string | null;
  ticket_priority_json: string | null;
  note: string | null;
  status: WatchStatus;
  event_date_id: number | null;
  reservation_lease_until: string | null;
  reservation_message_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ParsedVacancyEmail {
  lessonUrl: string;
  lessonId: number;
  schoolSlug: string;
  lessonName: string;
  schoolName: string | null;
  targetStartAt: string;
  targetEndAt: string | null;
}

export interface ParsedReservationConfirmationEmail {
  schoolName: string;
  lessonName: string;
  targetStartAt: string;
  targetEndAt: string;
  court: string | null;
  reservationMethod: string | null;
}

export interface SpohabiReservation {
  id: string;
  reserveEventDateId: string;
  schoolName: string;
  lessonName: string;
  targetStartAt: string;
  targetEndAt: string;
  court: string | null;
  coach: string | null;
  level: string | null;
  lessonUrl: string | null;
}

export interface ReservationOutcome {
  status: "reserved" | "missed" | "blocked" | "failed" | "dry_run";
  reason: string;
  raw?: unknown;
}
