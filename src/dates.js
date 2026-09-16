// Shared date parsing/formatting.
//
// Tournament dates typed before the admin's date picker existed are plain
// "D/M/YYYY" strings — day first, the convention this league actually
// used (confirmed after a tournament dated "4/9/2026", meaning 4
// September, displayed as April 9th: JS's own Date parser always reads
// an ambiguous slash-separated string as M/D/Y and got it backwards).
// This is the one place that ambiguity gets resolved, so every view
// agrees. Firestore Timestamps and the admin's date picker (which always
// stores unambiguous ISO "YYYY-MM-DD") are unaffected — only bare
// "N/N/YYYY" strings go through the day-first reading.

const SLASH_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const ISO_DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

// Accepts a Firestore Timestamp, JS Date, epoch number, or date string.
export function toJsDate(value) {
  if (!value) return null;
  if (typeof value?.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  if (typeof value !== "string") return null;

  const trimmed = value.trim();

  const slash = SLASH_DATE.exec(trimmed);
  if (slash) {
    const day = Number(slash[1]);
    const month = Number(slash[2]);
    const year = Number(slash[3]);
    // Only read it as day/month when day/month are both plausible calendar
    // values — otherwise (e.g. "12/25/2025") day-first is impossible and
    // the string can only be the standard M/D/Y JS already parses fine.
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return new Date(year, month - 1, day);
    }
  }

  // A bare "YYYY-MM-DD" (what <input type="date"> — the admin's date
  // picker — always produces) is parsed by the JS spec as UTC midnight,
  // which rolls back to the previous *local* day in any timezone behind
  // UTC. Build it from local components instead.
  const iso = ISO_DATE_ONLY.exec(trimmed);
  if (iso) {
    return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatDate(
  value,
  options = { year: "numeric", month: "short", day: "numeric" },
) {
  const d = toJsDate(value);
  if (!d) return "";
  return d.toLocaleDateString(undefined, options);
}
