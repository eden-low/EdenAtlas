// EdenAtlas — browser-side timezone-aware date-key helper.
//
// A browser (ESM) counterpart to netlify/functions/lib/date-utils.js's localDateString(): that
// file is CommonJS and only ever runs server-side (Netlify Functions never import a browser ES
// module, and vice versa — see assistant.js's own header comment on this repo's per-runtime
// duplication convention). The underlying Intl-based algorithm is the same on purpose.
//
// Used by home.html's Daily Reflection card (via js/reflection.js): the reflection document ID
// and its `dateKey` field must land on the SAME calendar day regardless of the visitor's own
// device/OS timezone or whatever timezone the browser/Netlify edge happens to be running in —
// a same-day reflection must always resolve to one deterministic document (see firestore.rules'
// daily_reflections match block, and CLAUDE.md's Production Hardening history).

export const DEFAULT_TIME_ZONE = "Asia/Kuala_Lumpur";
export const MALAYSIA_UTC_OFFSET = "+08:00";

const DATE_LITERAL_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function daysInMonth(year, month) {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

// Strict source-date contract: date-only values stay as literal YYYY-MM-DD strings. This helper
// validates the civil date without constructing a Date, so there is no implicit UTC or device-
// timezone conversion anywhere in literal-date normalization.
export function isDateLiteral(value) {
  if (typeof value !== "string") return false;
  const match = DATE_LITERAL_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export function normalizeDateLiteral(value) {
  if (!isDateLiteral(value)) throw new RangeError("invalid_date_literal");
  return value;
}

// life_events.date is an existing Firestore Timestamp field. Until a separately-approved data
// migration changes that storage shape, convert its literal form input to an instant at explicit
// Malaysia midnight. The explicit +08:00 offset makes this independent of the browser/OS zone.
export function malaysiaDateLiteralToInstant(value) {
  const literal = normalizeDateLiteral(value);
  const instant = new Date(`${literal}T00:00:00${MALAYSIA_UTC_OFFSET}`);
  if (!Number.isFinite(instant.getTime())) throw new RangeError("invalid_date_literal");
  return instant;
}

// Calendar projections use an exclusive all-day end. Calculate the next civil date directly;
// never send the literal through UTC just to add one day.
export function nextDateLiteral(value) {
  const literal = normalizeDateLiteral(value);
  let [year, month, day] = literal.split("-").map(Number);
  day++;
  if (day > daysInMonth(year, month)) {
    day = 1;
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }
  if (year > 9999) throw new RangeError("date_literal_out_of_range");
  return `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
}

// { year, month (1-12), day } for `date` as seen in `timeZone` — the authoritative "local date"
// everything else here is built on. Handles the UTC-midnight-vs-local-date distinction: a
// `date` instant just after UTC midnight can already be the *next* calendar day in
// Asia/Kuala_Lumpur (UTC+8), and this always reflects the local one, not the UTC one.
export function localDateParts(date, timeZone = DEFAULT_TIME_ZONE) {
  const dtf = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = {};
  for (const { type, value } of dtf.formatToParts(date)) {
    if (type !== "literal") parts[type] = value;
  }
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

// "YYYY-MM-DD" for `date` as seen in `timeZone`.
export function localDateString(date, timeZone = DEFAULT_TIME_ZONE) {
  const { year, month, day } = localDateParts(date, timeZone);
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function dateLikeToDate(value) {
  try {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
    if (value && typeof value.toDate === "function") {
      const date = value.toDate();
      return date instanceof Date && Number.isFinite(date.getTime()) ? date : null;
    }
  } catch {
    return null;
  }
  return null;
}

// New Journal records carry an explicit entryDate. Legacy documents are still readable, but
// their Malaysia-local date is explicitly marked as a createdAt fallback so adapters/UI can
// distinguish it and avoid silently persisting it as though it had always been authoritative.
export function resolveJournalEntryDate(entry, timeZone = DEFAULT_TIME_ZONE) {
  if (entry && Object.prototype.hasOwnProperty.call(entry, "entryDate")) {
    if (isDateLiteral(entry.entryDate)) {
      return { date: entry.entryDate, basis: "entryDate", isLegacyFallback: false };
    }
    return { date: null, basis: "invalid_entryDate", isLegacyFallback: false };
  }

  const createdAt = dateLikeToDate(entry && entry.createdAt);
  if (!createdAt) return { date: null, basis: "missing", isLegacyFallback: true };
  return {
    date: localDateString(createdAt, timeZone),
    basis: "legacy_createdAt",
    isLegacyFallback: true,
  };
}

// Journey remains a single-day model. Existing Timestamp values and a future literal-compatible
// read shape both resolve to one date and one exclusive next-day boundary; no range is inferred.
export function resolveJourneyDate(event, timeZone = DEFAULT_TIME_ZONE) {
  const value = event && event.date;
  if (isDateLiteral(value)) {
    return { date: value, endDateExclusive: nextDateLiteral(value), allDay: true, basis: "date" };
  }
  const timestampDate = dateLikeToDate(value);
  if (!timestampDate) return { date: null, endDateExclusive: null, allDay: true, basis: "missing" };
  const date = localDateString(timestampDate, timeZone);
  return { date, endDateExclusive: nextDateLiteral(date), allDay: true, basis: "date" };
}
