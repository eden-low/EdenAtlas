const assert = require("node:assert");
const model = require("../lib/calendar-event-model.js");

const {
  CalendarEventValidationError,
  CALENDAR_EVENT_SCHEMA_VERSION,
  CALENDAR_EVENT_LIMITS,
  isValidDateLiteral,
  isValidRfc3339Timestamp,
  isValidIanaTimeZone,
  normalizeCalendarBoundary,
  normalizeCanonicalCalendarEvent,
  validateCanonicalCalendarEvent,
} = model;

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    fail++;
    console.log(`FAIL  - ${name}`);
    console.log(`        ${err.stack || err.message}`);
  }
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function allDayBoundary(date) {
  return { type: "date", date, dateTime: null };
}

function timedBoundary(dateTime) {
  return { type: "dateTime", date: null, dateTime };
}

function validAllDay(overrides = {}) {
  return {
    id: "canonical_event_01",
    schemaVersion: CALENDAR_EVENT_SCHEMA_VERSION,
    ownerUid: "firebase-user-01",
    origin: "edenatlas",
    sourceEntityType: "expense",
    sourceEntityId: "expense-document-01",
    title: "Expense",
    summary: null,
    start: allDayBoundary("2026-08-24"),
    end: allDayBoundary("2026-08-25"),
    allDay: true,
    timeZone: null,
    status: "confirmed",
    deletedAt: null,
    deletionOrigin: null,
    sourceCreatedAt: "2026-08-24T02:00:00Z",
    sourceUpdatedAt: null,
    createdAt: "2026-08-24T02:00:01Z",
    updatedAt: "2026-08-24T02:00:01Z",
    version: 1,
    sync: {
      direction: "none",
      state: "local_only",
      lastSyncedAt: null,
    },
    ...overrides,
  };
}

function validTimed(overrides = {}) {
  return validAllDay({
    sourceEntityType: "journey",
    title: "Flight",
    start: timedBoundary("2026-08-24T09:30:00+08:00"),
    end: timedBoundary("2026-08-24T11:45:00+08:00"),
    allDay: false,
    timeZone: "Asia/Kuala_Lumpur",
    ...overrides,
  });
}

function rejects(code, fn) {
  assert.throws(fn, (err) => err instanceof CalendarEventValidationError && err.code === code);
}

test("valid all-day event normalizes without converting its literal dates", () => {
  const input = validAllDay();
  const result = normalizeCanonicalCalendarEvent(input);
  assert.deepStrictEqual(result.start, allDayBoundary("2026-08-24"));
  assert.deepStrictEqual(result.end, allDayBoundary("2026-08-25"));
  assert.strictEqual(result.timeZone, null);
  assert.strictEqual(validateCanonicalCalendarEvent(input), true);
});

test("valid timed event requires and preserves its RFC3339 boundaries and IANA timezone", () => {
  const result = normalizeCanonicalCalendarEvent(validTimed());
  assert.strictEqual(result.start.dateTime, "2026-08-24T09:30:00+08:00");
  assert.strictEqual(result.end.dateTime, "2026-08-24T11:45:00+08:00");
  assert.strictEqual(result.timeZone, "Asia/Kuala_Lumpur");
});

test("one-day all-day event uses an exclusive next-day end", () => {
  const result = normalizeCanonicalCalendarEvent(validAllDay());
  assert.deepStrictEqual([result.start.date, result.end.date], ["2026-08-24", "2026-08-25"]);
});

test("multi-day all-day event accepts a strictly later exclusive end", () => {
  const result = normalizeCanonicalCalendarEvent(validAllDay({
    sourceEntityType: "journey",
    start: allDayBoundary("2026-08-24"),
    end: allDayBoundary("2026-08-29"),
  }));
  assert.strictEqual(result.end.date, "2026-08-29");
});

test("invalid YYYY-MM-DD values are rejected semantically", () => {
  for (const value of ["2026-2-03", "2026-02-30", "2025-02-29", "0000-01-01", "2026-13-01"] ) {
    assert.strictEqual(isValidDateLiteral(value), false);
    rejects("invalid_date_boundary", () => normalizeCanonicalCalendarEvent(validAllDay({
      start: allDayBoundary(value),
    })));
  }
  assert.strictEqual(isValidDateLiteral("2024-02-29"), true);
});

test("all-day end equal to or before start is rejected", () => {
  for (const end of ["2026-08-24", "2026-08-23"]) {
    rejects("invalid_event_range", () => normalizeCanonicalCalendarEvent(validAllDay({
      end: allDayBoundary(end),
    })));
  }
});

test("timed event missing an IANA timezone is rejected", () => {
  rejects("invalid_time_zone", () => normalizeCanonicalCalendarEvent(validTimed({ timeZone: null })));
  rejects("invalid_time_zone", () => normalizeCanonicalCalendarEvent(validTimed({ timeZone: "GMT+8" })));
  assert.strictEqual(isValidIanaTimeZone("Asia/Kuala_Lumpur"), true);
});

test("all-day event with a timezone is rejected", () => {
  rejects("all_day_timezone_must_be_null", () => normalizeCanonicalCalendarEvent(validAllDay({
    timeZone: "Asia/Kuala_Lumpur",
  })));
});

test("allDay must agree with date versus dateTime boundary types", () => {
  rejects("all_day_boundary_mismatch", () => normalizeCanonicalCalendarEvent(validTimed({ allDay: true, timeZone: null })));
  rejects("timed_boundary_mismatch", () => normalizeCanonicalCalendarEvent(validAllDay({
    allDay: false,
    timeZone: "Asia/Kuala_Lumpur",
  })));
});

test("date and dateTime members must explicitly match boundary type", () => {
  rejects("invalid_date_boundary", () => normalizeCalendarBoundary({
    type: "date",
    date: "2026-08-24",
    dateTime: "2026-08-24T00:00:00Z",
  }, "start"));
  rejects("invalid_datetime_boundary", () => normalizeCalendarBoundary({
    type: "dateTime",
    date: "2026-08-24",
    dateTime: "2026-08-24T00:00:00Z",
  }, "start"));
  rejects("boundary_type_mismatch", () => normalizeCanonicalCalendarEvent(validAllDay({
    end: timedBoundary("2026-08-25T00:00:00Z"),
  })));
});

test("RFC3339 validation rejects malformed and impossible timestamps", () => {
  for (const value of [
    "2026-08-24 09:30:00Z",
    "2026-02-30T09:30:00Z",
    "2026-08-24T24:00:00Z",
    "2026-08-24T09:60:00Z",
    "2026-08-24T09:30:00",
    "not-a-timestamp",
  ]) assert.strictEqual(isValidRfc3339Timestamp(value), false);
  assert.strictEqual(isValidRfc3339Timestamp("2026-08-24T09:30:00.123456789+08:00"), true);
});

test("timed end must be strictly after start as an instant, including offsets and nanoseconds", () => {
  rejects("invalid_event_range", () => normalizeCanonicalCalendarEvent(validTimed({
    start: timedBoundary("2026-08-24T09:30:00+08:00"),
    end: timedBoundary("2026-08-24T01:30:00Z"),
  })));
  const result = normalizeCanonicalCalendarEvent(validTimed({
    start: timedBoundary("2026-08-24T01:30:00.000000001Z"),
    end: timedBoundary("2026-08-24T01:30:00.000000002Z"),
    timeZone: "UTC",
  }));
  assert.strictEqual(result.end.dateTime, "2026-08-24T01:30:00.000000002Z");
});

test("invalid origin is rejected", () => {
  rejects("invalid_origin", () => normalizeCanonicalCalendarEvent(validAllDay({ origin: "outlook" })));
});

test("invalid sourceEntityType is rejected", () => {
  rejects("invalid_source_entity_type", () => normalizeCanonicalCalendarEvent(validAllDay({
    sourceEntityType: "memory",
  })));
});

test("origin and sourceEntityType pairing distinguishes Google-origin events", () => {
  const google = normalizeCanonicalCalendarEvent(validAllDay({
    origin: "google",
    sourceEntityType: "google_event",
    sourceEntityId: "google-event-01",
    sync: { direction: "google_to_edenatlas", state: "synced", lastSyncedAt: "2026-08-24T03:00:00Z" },
  }));
  assert.strictEqual(google.origin, "google");
  rejects("invalid_source_origin_pair", () => normalizeCanonicalCalendarEvent(validAllDay({
    origin: "google",
    sourceEntityType: "expense",
  })));
  rejects("invalid_source_origin_pair", () => normalizeCanonicalCalendarEvent(validAllDay({
    sourceEntityType: "google_event",
  })));
});

test("invalid status is rejected", () => {
  rejects("invalid_status", () => normalizeCanonicalCalendarEvent(validAllDay({ status: "deleted" })));
});

test("invalid sync direction is rejected", () => {
  const event = validAllDay();
  event.sync.direction = "google_to_outlook";
  rejects("invalid_sync_direction", () => normalizeCanonicalCalendarEvent(event));
});

test("invalid sync state is rejected", () => {
  const event = validAllDay();
  event.sync.state = "complete";
  rejects("invalid_sync_state", () => normalizeCanonicalCalendarEvent(event));
});

test("version must be a positive safe integer", () => {
  for (const version of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
    rejects("invalid_version", () => normalizeCanonicalCalendarEvent(validAllDay({ version })));
  }
});

test("missing required top-level and nested fields are rejected", () => {
  const missingTitle = validAllDay();
  delete missingTitle.title;
  rejects("invalid_event_schema", () => normalizeCanonicalCalendarEvent(missingTitle));

  const missingNullableSummary = validAllDay();
  delete missingNullableSummary.summary;
  rejects("invalid_event_schema", () => normalizeCanonicalCalendarEvent(missingNullableSummary));

  const missingBoundaryNull = validAllDay();
  delete missingBoundaryNull.start.dateTime;
  rejects("invalid_boundary_schema", () => normalizeCanonicalCalendarEvent(missingBoundaryNull));

  const missingSyncTimestamp = validAllDay();
  delete missingSyncTimestamp.sync.lastSyncedAt;
  rejects("invalid_sync_schema", () => normalizeCanonicalCalendarEvent(missingSyncTimestamp));
});

test("bounded strings reject oversized identifiers, title, summary, and timezone", () => {
  const cases = [
    validAllDay({ id: "x".repeat(CALENDAR_EVENT_LIMITS.idChars + 1) }),
    validAllDay({ ownerUid: "x".repeat(CALENDAR_EVENT_LIMITS.ownerUidChars + 1) }),
    validAllDay({ sourceEntityId: "x".repeat(CALENDAR_EVENT_LIMITS.sourceEntityIdChars + 1) }),
    validAllDay({ title: "x".repeat(CALENDAR_EVENT_LIMITS.titleChars + 1) }),
    validAllDay({ summary: "x".repeat(CALENDAR_EVENT_LIMITS.summaryChars + 1) }),
    validTimed({ timeZone: `Area/${"x".repeat(CALENDAR_EVENT_LIMITS.timeZoneChars)}` }),
  ];
  for (const event of cases) assert.throws(() => normalizeCanonicalCalendarEvent(event), CalendarEventValidationError);
});

test("unexpected top-level, boundary, sync, and array structures are rejected", () => {
  rejects("invalid_event_schema", () => normalizeCanonicalCalendarEvent({ ...validAllDay(), providerPayload: {} }));

  const extraBoundary = validAllDay();
  extraBoundary.start.timeZone = "UTC";
  rejects("invalid_boundary_schema", () => normalizeCanonicalCalendarEvent(extraBoundary));

  const extraSync = validAllDay();
  extraSync.sync.externalEventId = "provider-controlled";
  rejects("invalid_sync_schema", () => normalizeCanonicalCalendarEvent(extraSync));

  rejects("invalid_event_schema", () => normalizeCanonicalCalendarEvent([]));
});

test("nullable fields are explicit and preserved as null", () => {
  const input = validAllDay({
    summary: null,
    deletedAt: null,
    deletionOrigin: null,
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    sync: { direction: "none", state: "local_only", lastSyncedAt: null },
  });
  const result = normalizeCanonicalCalendarEvent(input);
  assert.deepStrictEqual({
    summary: result.summary,
    deletedAt: result.deletedAt,
    deletionOrigin: result.deletionOrigin,
    sourceCreatedAt: result.sourceCreatedAt,
    sourceUpdatedAt: result.sourceUpdatedAt,
    lastSyncedAt: result.sync.lastSyncedAt,
  }, {
    summary: null,
    deletedAt: null,
    deletionOrigin: null,
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    lastSyncedAt: null,
  });
});

test("complete deletion metadata accepts only an allowlisted origin", () => {
  const deleted = normalizeCanonicalCalendarEvent(validAllDay({
    deletedAt: "2026-08-24T04:00:00Z",
    deletionOrigin: "edenatlas",
    sync: { direction: "edenatlas_to_google", state: "pending_delete", lastSyncedAt: null },
  }));
  assert.strictEqual(deleted.deletionOrigin, "edenatlas");

  rejects("incomplete_deletion_state", () => normalizeCanonicalCalendarEvent(validAllDay({
    deletedAt: "2026-08-24T04:00:00Z",
  })));
  rejects("invalid_deletion_origin", () => normalizeCanonicalCalendarEvent(validAllDay({
    deletedAt: "2026-08-24T04:00:00Z",
    deletionOrigin: "browser",
  })));
});

test("schema version mismatch is rejected", () => {
  rejects("schema_version_mismatch", () => normalizeCanonicalCalendarEvent(validAllDay({
    schemaVersion: CALENDAR_EVENT_SCHEMA_VERSION + 1,
  })));
});

test("canonical and source timestamp ordering is deterministic", () => {
  rejects("invalid_updated_at_order", () => normalizeCanonicalCalendarEvent(validAllDay({
    updatedAt: "2026-08-24T02:00:00Z",
  })));
  rejects("invalid_source_updated_at_order", () => normalizeCanonicalCalendarEvent(validAllDay({
    sourceUpdatedAt: "2026-08-24T01:59:59Z",
  })));
});

test("normalization returns a new deterministic value without mutating the input", () => {
  const input = validAllDay({ id: "  canonical_event_01  ", title: "  Expense  ", summary: "  owner text  " });
  const before = copy(input);
  const first = normalizeCanonicalCalendarEvent(input);
  const second = normalizeCanonicalCalendarEvent(input);
  assert.deepStrictEqual(input, before);
  assert.deepStrictEqual(first, second);
  assert.strictEqual(first.id, "canonical_event_01");
  assert.strictEqual(first.title, "Expense");
  assert.strictEqual(first.summary, "owner text");
});

test("Phase 3B.1 exports no identity generator or synchronization operation", () => {
  const exportedNames = Object.keys(model);
  assert.ok(!exportedNames.some((name) => /hmac|identity|syncEvent|createGoogle|updateGoogle|deleteGoogle/i.test(name)));
});

Promise.resolve().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
});
