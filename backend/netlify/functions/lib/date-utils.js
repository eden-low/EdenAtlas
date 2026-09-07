// EdenAtlas Atlas Assistant — deterministic, timezone-aware date resolution.
//
// Root cause this file fixes: "What did I record this month?" and "if June?" were answered
// against 2024 in production, even though Firestore data for July 2026 genuinely existed
// (proven by the fact an explicit "July 2026" query worked correctly). The tool-calling loop
// gave Qwen no ground truth for "today," so when it had to translate a relative phrase like
// "this month" into concrete YYYY-MM-DD arguments for list_calendar, it fell back to its own
// training-data notion of "now" — which is not this deployment's clock, this user's clock, or
// even a fixed year at all. The fix has two parts: (1) inject an explicit, machine-readable
// currentLocalDate/currentYear/currentMonth/timeZone fact into the system prompt (see
// buildDateContext() below, used by assistant.js), so the model has real ground truth instead
// of guessing; (2) give list_calendar/list_journey an alternative, server-resolved
// `relativePeriod` parameter (see resolveRelativePeriod() below) so the actual date-math for
// common phrases ("this month," "last month," a bare month name) happens in THIS deterministic,
// unit-tested code — not inside the model's own reasoning — eliminating the hallucination
// vector entirely for the phrases this covers, rather than just hoping better prompt wording
// fixes it.
//
// Every function here takes `now` (a real Date instant) as an explicit parameter. Nothing in
// this file calls `new Date()` itself — a test can pass a fixed `now` and get fully
// deterministic, reproducible output regardless of when the test actually runs.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DEFAULT_TIME_ZONE = "Asia/Kuala_Lumpur";

const MONTH_NAMES = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function pad2(n) {
  return String(n).padStart(2, "0");
}

// The offset (in minutes, east-positive) of `timeZone` from UTC at the instant `date`.
// Asia/Kuala_Lumpur has no DST and is a fixed UTC+8, but this is written generically (via
// Intl, not a hardcoded "+8") so it stays correct for any IANA zone name passed in.
function timeZoneOffsetMinutes(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = {};
  for (const { type, value } of dtf.formatToParts(date)) {
    if (type !== "literal") parts[type] = value;
  }
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

// { year, month (1-12), day } for `date` as seen in `timeZone` — this is the "authoritative
// local date" the whole rest of this module is built on. Handles the UTC-midnight-vs-Malaysia-
// local-date distinction explicitly: a `date` instant just after UTC midnight can already be
// the *next* calendar day in Asia/Kuala_Lumpur (UTC+8), and this always reflects the local one.
function localDateParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const [{ value: year }, , { value: month }, , { value: day }] = dtf.formatToParts(date);
  return { year: Number(year), month: Number(month), day: Number(day) };
}

function localDateString(date, timeZone) {
  const { year, month, day } = localDateParts(date, timeZone);
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

// The UTC instant corresponding to local midnight (00:00:00.000) on {year}-{month}-{day} in
// `timeZone`. Two-pass: guess the instant as if the local wall-clock time were UTC, measure that
// guess's actual offset in `timeZone`, then correct by it. Correct for any fixed- or DST-offset
// zone at the day-boundary granularity this module needs (never used for a specific hour/minute).
function localMidnightUtc(year, month, day, timeZone) {
  const guess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const offsetMin = timeZoneOffsetMinutes(guess, timeZone);
  return new Date(guess.getTime() - offsetMin * 60000);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate(); // handles leap-year February correctly
}

// Machine-readable "today" facts for the system prompt (task A/B) — the model's only source of
// truth for "now," never its own training cutoff or an assumed year.
function buildDateContext(now, timeZone = DEFAULT_TIME_ZONE) {
  const { year, month, day } = localDateParts(now, timeZone);
  return {
    currentLocalDate: `${year}-${pad2(month)}-${pad2(day)}`,
    currentYear: year,
    currentMonth: month,
    timeZone,
  };
}

// A concrete calendar-month range, expressed both as real UTC instants (for filtering Firestore
// Timestamps) and as YYYY-MM-DD strings (for the tool result's resolvedRange / the model).
function monthRange(year, month, timeZone) {
  const lastDay = daysInMonth(year, month);
  const start = localMidnightUtc(year, month, 1, timeZone);
  const endOfLastDay = localMidnightUtc(year, month, lastDay, timeZone);
  const end = new Date(endOfLastDay.getTime() + MS_PER_DAY - 1);
  return {
    start, end,
    startDate: `${year}-${pad2(month)}-01`,
    endDate: `${year}-${pad2(month)}-${pad2(lastDay)}`,
  };
}

function yearRange(year, timeZone) {
  const start = localMidnightUtc(year, 1, 1, timeZone);
  const endOfLastDay = localMidnightUtc(year, 12, 31, timeZone);
  const end = new Date(endOfLastDay.getTime() + MS_PER_DAY - 1);
  return { start, end, startDate: `${year}-01-01`, endDate: `${year}-12-31` };
}

// The full relative-phrase vocabulary the `relativePeriod`/`direction` tool parameters accept.
// Every entry here is resolved purely from `now`/`timeZone` — never a value the model invents on
// its own, and never ambiguous: each phrase maps to exactly one algorithm, so there is nothing
// for the model to get wrong once it picks the right phrase for what the user asked.
const RELATIVE_PERIODS = new Set([
  "this_month", "last_month", "next_month", "this_year", "last_year",
  ...Object.keys(MONTH_NAMES),
]);

// Resolves a `relativePeriod` (+ optional `direction: "forward"`) into a concrete range, given
// an authoritative `now`/`timeZone`. Returns null for an unrecognized phrase — the caller (tools.
// js's resolveDateRange) treats that as "fall through to explicit startDate/endDate, or the
// tool's own default window" rather than silently guessing.
//
// Rule for a bare month name with no explicit year (task A): "the most recent occurrence not
// after the supplied local date" — e.g. asking for "June" while currentLocalDate is 2026-07-18
// means June 2026 (already past this year, most recent occurrence); asking in 2026-03-01 would
// mean June 2025 (2026's June hasn't happened yet, so the most recent *completed* one is last
// year's). `direction: "forward"` flips this to "the next occurrence on or after today" instead,
// for wording that clearly says upcoming/next.
function resolveRelativePeriod(relativePeriod, { now, timeZone = DEFAULT_TIME_ZONE, direction } = {}) {
  if (!relativePeriod || !RELATIVE_PERIODS.has(relativePeriod)) return null;
  const today = localDateParts(now, timeZone);

  if (relativePeriod === "this_month") return { ...monthRange(today.year, today.month, timeZone), timeZone };
  if (relativePeriod === "last_month") {
    const month = today.month === 1 ? 12 : today.month - 1;
    const year = today.month === 1 ? today.year - 1 : today.year;
    return { ...monthRange(year, month, timeZone), timeZone };
  }
  if (relativePeriod === "next_month") {
    const month = today.month === 12 ? 1 : today.month + 1;
    const year = today.month === 12 ? today.year + 1 : today.year;
    return { ...monthRange(year, month, timeZone), timeZone };
  }
  if (relativePeriod === "this_year") return { ...yearRange(today.year, timeZone), timeZone };
  if (relativePeriod === "last_year") return { ...yearRange(today.year - 1, timeZone), timeZone };

  const mm = MONTH_NAMES[relativePeriod];
  if (mm) {
    const forward = direction === "forward";
    const year = forward
      ? (mm >= today.month ? today.year : today.year + 1) // next occurrence on/after today
      : (mm <= today.month ? today.year : today.year - 1); // most recent occurrence not after today
    return { ...monthRange(year, mm, timeZone), timeZone };
  }
  return null;
}

module.exports = {
  DEFAULT_TIME_ZONE,
  RELATIVE_PERIODS,
  MS_PER_DAY,
  buildDateContext,
  localDateParts,
  localDateString,
  localMidnightUtc,
  daysInMonth,
  monthRange,
  yearRange,
  resolveRelativePeriod,
  timeZoneOffsetMinutes,
};
