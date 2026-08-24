// Pure canonical Calendar contract for EdenAtlas. This module deliberately has no Firestore,
// provider, OAuth, network, environment, or browser dependency. Adapters may normalize untrusted
// source records through this boundary, but provider synchronization and identity generation live
// in later phases.

const CALENDAR_EVENT_SCHEMA_VERSION = 1;

const CALENDAR_EVENT_ORIGINS = Object.freeze(["edenatlas", "google"]);
const CALENDAR_SOURCE_ENTITY_TYPES = Object.freeze(["expense", "journal", "journey", "google_event"]);
const CALENDAR_EVENT_STATUSES = Object.freeze(["confirmed", "tentative", "cancelled"]);
const CALENDAR_SYNC_DIRECTIONS = Object.freeze([
  "none",
  "edenatlas_to_google",
  "google_to_edenatlas",
  "bidirectional",
]);
const CALENDAR_SYNC_STATES = Object.freeze([
  "local_only",
  "pending_create",
  "synced",
  "pending_update",
  "pending_delete",
  "failed",
  "conflict",
  "reconnect_required",
]);

const CALENDAR_EVENT_LIMITS = Object.freeze({
  idChars: 128,
  ownerUidChars: 128,
  sourceEntityIdChars: 1024,
  titleChars: 200,
  summaryChars: 1000,
  timeZoneChars: 100,
  timestampChars: 64,
});

const EVENT_FIELDS = Object.freeze([
  "id",
  "schemaVersion",
  "ownerUid",
  "origin",
  "sourceEntityType",
  "sourceEntityId",
  "title",
  "summary",
  "start",
  "end",
  "allDay",
  "timeZone",
  "status",
  "deletedAt",
  "deletionOrigin",
  "sourceCreatedAt",
  "sourceUpdatedAt",
  "createdAt",
  "updatedAt",
  "version",
  "sync",
]);
const BOUNDARY_FIELDS = Object.freeze(["type", "date", "dateTime"]);
const SYNC_FIELDS = Object.freeze(["direction", "state", "lastSyncedAt"]);
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/u;
const IDENTIFIER_RE = /^[^\s/]+$/u;
const DATE_LITERAL_RE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/u;
const IANA_TIME_ZONE_RE = /^(?:UTC|[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)+)$/u;

class CalendarEventValidationError extends Error {
  constructor(code, field = null) {
    super(code);
    this.name = "CalendarEventValidationError";
    this.code = code;
    this.field = field;
  }
}

function fail(code, field = null) {
  throw new CalendarEventValidationError(code, field);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function requireExactKeys(value, expectedKeys, code, field) {
  if (!hasExactKeys(value, expectedKeys)) fail(code, field);
}

function daysInMonth(year, month) {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isValidDateLiteral(value) {
  if (typeof value !== "string") return false;
  const match = DATE_LITERAL_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

// Gregorian calendar date to a day offset from 1970-01-01. This keeps comparisons deterministic
// and avoids converting all-day values through Date/UTC, which would violate their date semantics.
function daysFromCivil(year, month, day) {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const adjustedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * adjustedMonth + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4)
    - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

function parseRfc3339(value) {
  if (typeof value !== "string" || value.length > CALENDAR_EVENT_LIMITS.timestampChars) return null;
  const match = RFC3339_RE.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
      || hour > 23 || minute > 59 || second > 59) return null;

  const offsetHour = match[8] === "Z" ? 0 : Number(match[10]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[11]);
  if (offsetHour > 23 || offsetMinute > 59) return null;
  const offsetSign = match[9] === "-" ? -1 : 1;
  const offsetSeconds = match[8] === "Z" ? 0 : offsetSign * (offsetHour * 3600 + offsetMinute * 60);
  const localSeconds = daysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second;
  const fraction = (match[7] || "").padEnd(9, "0");
  const epochNanoseconds = BigInt(localSeconds - offsetSeconds) * 1_000_000_000n
    + BigInt(fraction || "0");
  return { value, epochNanoseconds };
}

function isValidRfc3339Timestamp(value) {
  return parseRfc3339(value) !== null;
}

function isValidIanaTimeZone(value) {
  if (typeof value !== "string" || !value || value.length > CALENDAR_EVENT_LIMITS.timeZoneChars
      || CONTROL_CHAR_RE.test(value) || !IANA_TIME_ZONE_RE.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function normalizedIdentifier(value, { field, maxChars }) {
  if (typeof value !== "string") fail(`invalid_${field}`, field);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxChars || CONTROL_CHAR_RE.test(normalized)
      || !IDENTIFIER_RE.test(normalized)) fail(`invalid_${field}`, field);
  return normalized;
}

function normalizedText(value, { field, maxChars, nullable = false, allowEmpty = false }) {
  if (value === null && nullable) return null;
  if (typeof value !== "string") fail(`invalid_${field}`, field);
  const normalized = value.trim();
  if ((!allowEmpty && !normalized) || normalized.length > maxChars || CONTROL_CHAR_RE.test(normalized)) {
    fail(`invalid_${field}`, field);
  }
  return normalized;
}

function normalizedTimestamp(value, { field, nullable }) {
  if (value === null && nullable) return null;
  if (!isValidRfc3339Timestamp(value)) fail(`invalid_${field}`, field);
  return value;
}

function normalizeCalendarBoundary(value, field = "boundary") {
  requireExactKeys(value, BOUNDARY_FIELDS, "invalid_boundary_schema", field);
  if (value.type === "date") {
    if (!isValidDateLiteral(value.date) || value.dateTime !== null) fail("invalid_date_boundary", field);
    return { type: "date", date: value.date, dateTime: null };
  }
  if (value.type === "dateTime") {
    if (value.date !== null || !isValidRfc3339Timestamp(value.dateTime)) {
      fail("invalid_datetime_boundary", field);
    }
    return { type: "dateTime", date: null, dateTime: value.dateTime };
  }
  fail("invalid_boundary_type", field);
}

function normalizeSync(value) {
  requireExactKeys(value, SYNC_FIELDS, "invalid_sync_schema", "sync");
  if (!CALENDAR_SYNC_DIRECTIONS.includes(value.direction)) fail("invalid_sync_direction", "sync.direction");
  if (!CALENDAR_SYNC_STATES.includes(value.state)) fail("invalid_sync_state", "sync.state");
  return {
    direction: value.direction,
    state: value.state,
    lastSyncedAt: normalizedTimestamp(value.lastSyncedAt, { field: "sync.lastSyncedAt", nullable: true }),
  };
}

function compareRfc3339(left, right) {
  return parseRfc3339(left).epochNanoseconds < parseRfc3339(right).epochNanoseconds ? -1
    : parseRfc3339(left).epochNanoseconds > parseRfc3339(right).epochNanoseconds ? 1 : 0;
}

function normalizeCanonicalCalendarEvent(value) {
  requireExactKeys(value, EVENT_FIELDS, "invalid_event_schema", "event");

  if (value.schemaVersion !== CALENDAR_EVENT_SCHEMA_VERSION) {
    fail("schema_version_mismatch", "schemaVersion");
  }
  if (!CALENDAR_EVENT_ORIGINS.includes(value.origin)) fail("invalid_origin", "origin");
  if (!CALENDAR_SOURCE_ENTITY_TYPES.includes(value.sourceEntityType)) {
    fail("invalid_source_entity_type", "sourceEntityType");
  }
  if ((value.origin === "google") !== (value.sourceEntityType === "google_event")) {
    fail("invalid_source_origin_pair", "sourceEntityType");
  }
  if (!CALENDAR_EVENT_STATUSES.includes(value.status)) fail("invalid_status", "status");
  if (typeof value.allDay !== "boolean") fail("invalid_all_day", "allDay");
  if (!Number.isSafeInteger(value.version) || value.version < 1) fail("invalid_version", "version");

  const start = normalizeCalendarBoundary(value.start, "start");
  const end = normalizeCalendarBoundary(value.end, "end");
  if (start.type !== end.type) fail("boundary_type_mismatch", "end");

  let timeZone = null;
  if (value.allDay) {
    if (start.type !== "date") fail("all_day_boundary_mismatch", "allDay");
    if (value.timeZone !== null) fail("all_day_timezone_must_be_null", "timeZone");
    if (end.date <= start.date) fail("invalid_event_range", "end");
  } else {
    if (start.type !== "dateTime") fail("timed_boundary_mismatch", "allDay");
    if (!isValidIanaTimeZone(value.timeZone)) fail("invalid_time_zone", "timeZone");
    timeZone = value.timeZone;
    if (compareRfc3339(end.dateTime, start.dateTime) <= 0) fail("invalid_event_range", "end");
  }

  const deletedAt = normalizedTimestamp(value.deletedAt, { field: "deletedAt", nullable: true });
  let deletionOrigin = null;
  if (value.deletionOrigin !== null) {
    if (!CALENDAR_EVENT_ORIGINS.includes(value.deletionOrigin)) {
      fail("invalid_deletion_origin", "deletionOrigin");
    }
    deletionOrigin = value.deletionOrigin;
  }
  if ((deletedAt === null) !== (deletionOrigin === null)) {
    fail("incomplete_deletion_state", "deletionOrigin");
  }

  const sourceCreatedAt = normalizedTimestamp(value.sourceCreatedAt, { field: "sourceCreatedAt", nullable: true });
  const sourceUpdatedAt = normalizedTimestamp(value.sourceUpdatedAt, { field: "sourceUpdatedAt", nullable: true });
  const createdAt = normalizedTimestamp(value.createdAt, { field: "createdAt", nullable: false });
  const updatedAt = normalizedTimestamp(value.updatedAt, { field: "updatedAt", nullable: false });
  if (compareRfc3339(updatedAt, createdAt) < 0) fail("invalid_updated_at_order", "updatedAt");
  if (sourceCreatedAt !== null && sourceUpdatedAt !== null
      && compareRfc3339(sourceUpdatedAt, sourceCreatedAt) < 0) {
    fail("invalid_source_updated_at_order", "sourceUpdatedAt");
  }
  if (deletedAt !== null && compareRfc3339(deletedAt, createdAt) < 0) {
    fail("invalid_deleted_at_order", "deletedAt");
  }

  return {
    id: normalizedIdentifier(value.id, { field: "id", maxChars: CALENDAR_EVENT_LIMITS.idChars }),
    schemaVersion: CALENDAR_EVENT_SCHEMA_VERSION,
    ownerUid: normalizedIdentifier(value.ownerUid, {
      field: "owner_uid",
      maxChars: CALENDAR_EVENT_LIMITS.ownerUidChars,
    }),
    origin: value.origin,
    sourceEntityType: value.sourceEntityType,
    sourceEntityId: normalizedIdentifier(value.sourceEntityId, {
      field: "source_entity_id",
      maxChars: CALENDAR_EVENT_LIMITS.sourceEntityIdChars,
    }),
    title: normalizedText(value.title, { field: "title", maxChars: CALENDAR_EVENT_LIMITS.titleChars }),
    summary: normalizedText(value.summary, {
      field: "summary",
      maxChars: CALENDAR_EVENT_LIMITS.summaryChars,
      nullable: true,
      allowEmpty: true,
    }),
    start,
    end,
    allDay: value.allDay,
    timeZone,
    status: value.status,
    deletedAt,
    deletionOrigin,
    sourceCreatedAt,
    sourceUpdatedAt,
    createdAt,
    updatedAt,
    version: value.version,
    sync: normalizeSync(value.sync),
  };
}

function validateCanonicalCalendarEvent(value) {
  normalizeCanonicalCalendarEvent(value);
  return true;
}

module.exports = {
  CalendarEventValidationError,
  CALENDAR_EVENT_SCHEMA_VERSION,
  CALENDAR_EVENT_ORIGINS,
  CALENDAR_SOURCE_ENTITY_TYPES,
  CALENDAR_EVENT_STATUSES,
  CALENDAR_SYNC_DIRECTIONS,
  CALENDAR_SYNC_STATES,
  CALENDAR_EVENT_LIMITS,
  isValidDateLiteral,
  isValidRfc3339Timestamp,
  isValidIanaTimeZone,
  normalizeCalendarBoundary,
  normalizeCanonicalCalendarEvent,
  validateCanonicalCalendarEvent,
};
