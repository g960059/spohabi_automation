export const JST_OFFSET_MINUTES = 9 * 60;

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseJstDateTime(input: string): Date {
  const normalized = input.trim().replace(/\//g, "-").replace("T", " ");
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    throw new Error(`Invalid JST datetime: ${input}`);
  }
  const [, y, m, d, hh, mm, ss = "00"] = match;
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh) - 9, Number(mm), Number(ss)));
}

export function parseJstDateAndTime(date: string, time: string): Date {
  return parseJstDateTime(`${date} ${time}`);
}

export function toJstParts(date: Date): {
  date: string;
  time: string;
  timeWithSeconds: string;
  compactDateTime: string;
  watchKeyDateTime: string;
} {
  const jst = new Date(date.getTime() + JST_OFFSET_MINUTES * 60_000);
  const y = jst.getUTCFullYear();
  const m = `${jst.getUTCMonth() + 1}`.padStart(2, "0");
  const d = `${jst.getUTCDate()}`.padStart(2, "0");
  const hh = `${jst.getUTCHours()}`.padStart(2, "0");
  const mm = `${jst.getUTCMinutes()}`.padStart(2, "0");
  const ss = `${jst.getUTCSeconds()}`.padStart(2, "0");
  return {
    date: `${y}-${m}-${d}`,
    time: `${hh}:${mm}`,
    timeWithSeconds: `${hh}:${mm}:${ss}`,
    compactDateTime: `${y}/${m}/${d} ${hh}:${mm}`,
    watchKeyDateTime: `${y}${m}${d}T${hh}${mm}${ss}JST`
  };
}

export function expireAtForLessonStart(startAt: Date): string {
  return new Date(startAt.getTime() - 10 * 60_000).toISOString();
}

export function isExpired(expiresAtIso: string, at = new Date()): boolean {
  return new Date(expiresAtIso).getTime() <= at.getTime();
}

export function normalizeLessonUrl(url: string): string {
  const parsed = new URL(url.trim());
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/, "");
}

export function extractLessonInfo(url: string): { slug: string; lessonId: number } {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/([^/]+)\/lesson\/(\d+)/);
  if (!match) throw new Error(`Unsupported Spohabi lesson URL: ${url}`);
  return { slug: match[1], lessonId: Number(match[2]) };
}
