import { createHash } from "node:crypto";

export interface ReservationSlot {
  schoolName: string;
  lessonName: string;
  targetStartAt: string;
}

export function reservationSlotKey(slot: ReservationSlot): string {
  // The start time identifies the occurrence; ignore redundant display times in the lesson name.
  const lesson = slot.lessonName.normalize("NFKC").replace(/\s*\d{1,2}:\d{2}\s*[~\u301c-]\s*\d{1,2}:\d{2}\s*$/, "");
  const parts = [normalizeName(slot.schoolName), normalizeName(lesson), new Date(slot.targetStartAt).toISOString()];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function normalizeName(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, "");
}

export function schoolDisplayName(slug: string): string {
  if (slug === "fc-tennis") return "ファーストシティテニスクラブ";
  return slug;
}
