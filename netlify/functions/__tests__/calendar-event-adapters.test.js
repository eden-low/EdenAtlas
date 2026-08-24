const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const adapters = require("../lib/calendar-event-adapters.js");
const { validateCanonicalCalendarEvent } = require("../lib/calendar-event-model.js");

const {
  CalendarEventAdapterError,
  adaptExpenseToCalendarEvent,
  adaptJournalToCalendarEvent,
  adaptJourneyToCalendarEvent,
  resolveJournalCalendarDate,
} = adapters;

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    fail++;
    console.log(`FAIL  - ${name}`);
    console.log(`        ${err.stack || err.message}`);
  }
}

function timestamp(iso) {
  return { toDate: () => new Date(iso) };
}

function context(sourceEntityId, overrides = {}) {
  return {
    id: `view-${sourceEntityId}`,
    ownerUid: "owner-uid",
    sourceEntityId,
    projectedAt: "2026-08-24T08:00:00Z",
    ...overrides,
  };
}

function expense(overrides = {}) {
  return {
    uid: "owner-uid",
    amount: 18.9,
    currency: "MYR",
    category: "food",
    note: "Secret lunch note, not a merchant",
    date: "2026-08-24",
    createdAt: timestamp("2026-08-24T02:00:00Z"),
    ...overrides,
  };
}

function journal(overrides = {}) {
  return {
    uid: "owner-uid",
    entryDate: "2026-08-24",
    title: "Private title",
    content: "PRIVATE_JOURNAL_BODY",
    privateNotes: "PRIVATE_NOTES",
    mood: "happy",
    tags: ["private-tag"],
    imageUrl: "https://private.invalid/image.jpg",
    locationName: "PRIVATE_LOCATION",
    visibility: "VISIBILITY_SECRET",
    createdAt: timestamp("2026-08-24T03:00:00Z"),
    ...overrides,
  };
}

function journey(overrides = {}) {
  return {
    uid: "owner-uid",
    date: "2026-08-24",
    title: "Reached Ipoh",
    description: "PRIVATE_JOURNEY_DESCRIPTION",
    locationName: "PRIVATE_JOURNEY_LOCATION",
    visibility: "private",
    ...overrides,
  };
}

function rejectsAdapter(code, fn) {
  assert.throws(fn, (err) => err instanceof CalendarEventAdapterError && err.code === code);
}

function assertProviderSafeBase(event, type) {
  assert.strictEqual(event.origin, "edenatlas");
  assert.strictEqual(event.sourceEntityType, type);
  assert.strictEqual(event.allDay, true);
  assert.strictEqual(event.timeZone, null);
  assert.strictEqual(event.summary, null);
  assert.deepStrictEqual(event.sync, {
    direction: "none",
    state: "local_only",
    lastSyncedAt: null,
  });
  assert.strictEqual(validateCanonicalCalendarEvent(event), true);
}

test("Expense maps its validated transaction date to a provider-safe canonical event", () => {
  const event = adaptExpenseToCalendarEvent(expense(), context("expense-doc-1"));
  assertProviderSafeBase(event, "expense");
  assert.strictEqual(event.sourceEntityId, "expense-doc-1");
  assert.strictEqual(event.title, "Expense");
  assert.deepStrictEqual(event.start, { type: "date", date: "2026-08-24", dateTime: null });
  assert.deepStrictEqual(event.end, { type: "date", date: "2026-08-25", dateTime: null });
});

test("Expense Timestamp conversion uses Asia/Kuala_Lumpur and keeps an exclusive end", () => {
  const event = adaptExpenseToCalendarEvent(
    expense({ date: timestamp("2026-08-24T16:30:00Z") }),
    context("expense-doc-2")
  );
  assert.strictEqual(event.start.date, "2026-08-25");
  assert.strictEqual(event.end.date, "2026-08-26");
});

test("Expense amount/category/note never leak and note is never inferred as merchant", () => {
  const event = adaptExpenseToCalendarEvent(expense(), context("expense-doc-3"));
  const serialized = JSON.stringify(event);
  for (const forbidden of ["18.9", "food", "Secret lunch note", "merchant"]) {
    assert.ok(!serialized.includes(forbidden), `leaked Expense value: ${forbidden}`);
  }
  assert.strictEqual(event.summary, null);
});

test("Expense rejects a missing or malformed transaction date instead of using createdAt", () => {
  rejectsAdapter("invalid_expense_transaction_date", () => {
    adaptExpenseToCalendarEvent(expense({ date: undefined }), context("expense-doc-4"));
  });
  rejectsAdapter("invalid_expense_transaction_date", () => {
    adaptExpenseToCalendarEvent(expense({ date: "2026-02-30" }), context("expense-doc-5"));
  });
});

test("Journal uses explicit entryDate and an exclusive next-day end", () => {
  const event = adaptJournalToCalendarEvent(journal(), context("journal-doc-1"));
  assertProviderSafeBase(event, "journal");
  assert.strictEqual(event.title, "Journal entry");
  assert.strictEqual(event.start.date, "2026-08-24");
  assert.strictEqual(event.end.date, "2026-08-25");
  assert.deepStrictEqual(resolveJournalCalendarDate(journal()), {
    date: "2026-08-24",
    basis: "entryDate",
    isLegacyFallback: false,
  });
});

test("legacy Journal fallback is Malaysia-local and remains explicitly distinguishable", () => {
  const legacy = journal({ entryDate: undefined, createdAt: timestamp("2026-08-24T16:30:00Z") });
  delete legacy.entryDate;
  assert.deepStrictEqual(resolveJournalCalendarDate(legacy), {
    date: "2026-08-25",
    basis: "legacy_createdAt",
    isLegacyFallback: true,
  });
  const event = adaptJournalToCalendarEvent(legacy, context("journal-doc-legacy"));
  assert.strictEqual(event.start.date, "2026-08-25");
  assert.strictEqual(event.end.date, "2026-08-26");
});

test("Journal body and every private source field are absent from the canonical event", () => {
  const event = adaptJournalToCalendarEvent(journal(), context("journal-doc-private"));
  const serialized = JSON.stringify(event);
  for (const forbidden of [
    "PRIVATE_JOURNAL_BODY", "PRIVATE_NOTES", "happy", "private-tag",
    "private.invalid", "PRIVATE_LOCATION", "Private title",
  ]) {
    assert.ok(!serialized.includes(forbidden), `leaked Journal value: ${forbidden}`);
  }
});

test("malformed explicit Journal entryDate is rejected and never falls back to createdAt", () => {
  const malformed = journal({ entryDate: "2026-02-30" });
  assert.deepStrictEqual(resolveJournalCalendarDate(malformed), {
    date: null,
    basis: "invalid_entryDate",
    isLegacyFallback: false,
  });
  rejectsAdapter("invalid_journal_entry_date", () => {
    adaptJournalToCalendarEvent(malformed, context("journal-doc-invalid"));
  });
});

test("Journey maps the current single date to one all-day event with exclusive end", () => {
  const event = adaptJourneyToCalendarEvent(journey(), context("journey-doc-1"));
  assertProviderSafeBase(event, "journey");
  assert.strictEqual(event.title, "Reached Ipoh");
  assert.strictEqual(event.start.date, "2026-08-24");
  assert.strictEqual(event.end.date, "2026-08-25");
});

test("Journey Timestamp conversion uses Asia/Kuala_Lumpur semantics", () => {
  const event = adaptJourneyToCalendarEvent(
    journey({ date: timestamp("2026-08-24T16:30:00Z") }),
    context("journey-doc-2")
  );
  assert.strictEqual(event.start.date, "2026-08-25");
  assert.strictEqual(event.end.date, "2026-08-26");
});

test("Journey never infers a multi-day range from unrelated source fields", () => {
  const event = adaptJourneyToCalendarEvent(journey({
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    startTime: "09:00",
    endTime: "18:00",
  }), context("journey-doc-range-noise"));
  assert.strictEqual(event.start.date, "2026-08-24");
  assert.strictEqual(event.end.date, "2026-08-25");
  assert.strictEqual(event.allDay, true);
});

test("Journey description, location, and visibility never leak", () => {
  const event = adaptJourneyToCalendarEvent(journey(), context("journey-doc-private"));
  const serialized = JSON.stringify(event);
  for (const forbidden of ["PRIVATE_JOURNEY_DESCRIPTION", "PRIVATE_JOURNEY_LOCATION", "VISIBILITY_SECRET"]) {
    assert.ok(!serialized.includes(forbidden), `leaked Journey value: ${forbidden}`);
  }
});

test("Journey rejects missing and malformed dates", () => {
  rejectsAdapter("invalid_journey_date", () => {
    adaptJourneyToCalendarEvent(journey({ date: undefined }), context("journey-doc-3"));
  });
  rejectsAdapter("invalid_journey_date", () => {
    adaptJourneyToCalendarEvent(journey({ date: "2026-13-01" }), context("journey-doc-4"));
  });
});

test("Journey titles are deterministically bounded to the canonical limit", () => {
  const event = adaptJourneyToCalendarEvent(journey({ title: `  ${"x".repeat(240)}  ` }), context("journey-doc-long"));
  assert.strictEqual(event.title.length, 200);
  assert.strictEqual(validateCanonicalCalendarEvent(event), true);
});

test("caller-supplied identity and verified owner context are preserved, never generated", () => {
  const event = adaptExpenseToCalendarEvent(expense(), context("expense-doc-context", { id: "caller-projection-id" }));
  assert.strictEqual(event.id, "caller-projection-id");
  assert.strictEqual(event.ownerUid, "owner-uid");
  assert.strictEqual(event.sourceEntityId, "expense-doc-context");
  rejectsAdapter("source_owner_mismatch", () => {
    adaptExpenseToCalendarEvent(expense({ uid: "other-user" }), context("expense-doc-cross-user"));
  });
});

test("projection is deterministic and does not mutate source or context", () => {
  const source = journey({ description: "unchanged" });
  const adapterContext = context("journey-doc-deterministic");
  const sourceBefore = { ...source };
  const contextBefore = { ...adapterContext };
  const first = adaptJourneyToCalendarEvent(source, adapterContext);
  const second = adaptJourneyToCalendarEvent(source, adapterContext);
  assert.deepStrictEqual(first, second);
  assert.deepStrictEqual(source, sourceBefore);
  assert.deepStrictEqual(adapterContext, contextBefore);
});

test("adapter modules are pure and contain no sync, provider, persistence, or identity generator", () => {
  const corePath = path.resolve(__dirname, "../../../js/calendar-event-adapter-core.js");
  const facadePath = path.resolve(__dirname, "../lib/calendar-event-adapters.js");
  const source = `${fs.readFileSync(corePath, "utf8")}\n${fs.readFileSync(facadePath, "utf8")}`;
  for (const forbidden of [
    "process.env", "firebase-admin", "getFirestore", "fetch(", "window.", "document.",
    "calendar.events.insert", "calendar.events.update", "calendar.events.delete",
    "googleEventId", "externalEventId", "createHmac", "calendar_events", "calendar_sync_jobs",
  ]) {
    assert.ok(!source.includes(forbidden), `forbidden adapter dependency/behavior: ${forbidden}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
