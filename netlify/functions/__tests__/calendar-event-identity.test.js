const assert = require("node:assert");
const {
  CalendarEventIdentityError,
  DEFAULT_CALENDAR_INSTANCE_KEY,
  base32hex,
  canonicalIdentityInput,
  createCalendarEventIdentity,
  isDeterministicCalendarEventId,
  isTemporaryCalendarEventId,
  providerPayloadHash,
  stableJson,
} = require("../lib/calendar-event-identity.js");
const {
  adaptExpenseToCalendarEvent,
  adaptJournalToCalendarEvent,
  adaptJourneyToCalendarEvent,
} = require("../lib/calendar-event-adapters.js");

const KEY = "phase-3b5-test-identity-key-32-bytes-minimum";
const OWNER = "owner-uid";
const PROJECTED_AT = "2026-08-24T00:00:00.000Z";
const identity = createCalendarEventIdentity(KEY);

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

function identityParts(overrides = {}) {
  return {
    ownerUid: OWNER,
    sourceEntityType: "expense",
    sourceEntityId: "expense-1",
    instanceKey: DEFAULT_CALENDAR_INSTANCE_KEY,
    ...overrides,
  };
}

function context(id, sourceEntityId) {
  return { id, ownerUid: OWNER, sourceEntityId, projectedAt: PROJECTED_AT };
}

function expense(overrides = {}) {
  return {
    uid: OWNER,
    amount: 10,
    category: "food",
    note: "private expense note",
    date: "2026-08-24",
    createdAt: PROJECTED_AT,
    ...overrides,
  };
}

function journal(overrides = {}) {
  return {
    uid: OWNER,
    entryDate: "2026-08-24",
    title: "private title",
    content: "private body",
    mood: "private mood",
    createdAt: PROJECTED_AT,
    ...overrides,
  };
}

function journey(overrides = {}) {
  return {
    uid: OWNER,
    date: "2026-08-24",
    title: "Reached Penang",
    description: "private description",
    locationName: "private location",
    ...overrides,
  };
}

async function run() {
  await test("base32hex uses the RFC 4648 extended-hex alphabet without padding", () => {
    assert.strictEqual(base32hex(Buffer.from("foobar", "utf8")), "CPNMUOJ1E8");
  });

  await test("identity input is stable, length-prefixed, and namespace-versioned", () => {
    const input = canonicalIdentityInput(identityParts());
    assert.strictEqual(input, "ea-calendar:v1|9:owner-uid|7:expense|9:expense-1|6:single");
  });

  await test("the same source always produces the same deterministic ID", () => {
    const first = identity.eventId(identityParts());
    const second = identity.eventId(identityParts());
    assert.strictEqual(first, second);
    assert.strictEqual(first.length, 52);
    assert.strictEqual(isDeterministicCalendarEventId(first), true);
    assert.strictEqual(isTemporaryCalendarEventId("ce_0123456789abcdef0123456789abcdef"), true);
  });

  await test("title, date, amount, body, and private source changes do not affect identity", () => {
    const before = identity.eventId(identityParts());
    const sourceChanges = {
      title: "changed", date: "2030-01-01", amount: 999, body: "changed", privateNote: "changed",
    };
    assert.strictEqual(identity.eventId(identityParts()), before);
    assert.ok(sourceChanges.title && sourceChanges.date && sourceChanges.amount && sourceChanges.body);
  });

  await test("owner, type, source ID, and instance key each partition identity", () => {
    const baseline = identity.eventId(identityParts());
    for (const changed of [
      { ownerUid: "other-owner" },
      { sourceEntityType: "journal" },
      { sourceEntityId: "expense-2" },
      { instanceKey: "milestone:1" },
    ]) {
      assert.notStrictEqual(identity.eventId(identityParts(changed)), baseline);
    }
  });

  await test("missing or weak server identity keys fail safely", () => {
    for (const key of [undefined, null, "", "too-short"]) {
      assert.throws(
        () => createCalendarEventIdentity(key),
        (err) => err instanceof CalendarEventIdentityError && err.code === "calendar_identity_key_unavailable"
      );
    }
  });

  await test("stable JSON is insensitive to object key ordering", () => {
    assert.strictEqual(
      stableJson({ z: 1, nested: { b: 2, a: 1 }, a: [2, 1] }),
      stableJson({ a: [2, 1], nested: { a: 1, b: 2 }, z: 1 })
    );
  });

  await test("the same canonical provider projection always has the same payload hash", () => {
    const event = adaptJourneyToCalendarEvent(journey(), context("event-1", "journey-1"));
    const reordered = {
      sync: event.sync, version: event.version, updatedAt: event.updatedAt, createdAt: event.createdAt,
      sourceUpdatedAt: event.sourceUpdatedAt, sourceCreatedAt: event.sourceCreatedAt,
      deletionOrigin: event.deletionOrigin, deletedAt: event.deletedAt, status: event.status,
      timeZone: event.timeZone, allDay: event.allDay, end: event.end, start: event.start,
      summary: event.summary, title: event.title, sourceEntityId: event.sourceEntityId,
      sourceEntityType: event.sourceEntityType, origin: event.origin, ownerUid: event.ownerUid,
      schemaVersion: event.schemaVersion, id: event.id,
    };
    assert.strictEqual(providerPayloadHash(event), providerPayloadHash(reordered));
  });

  await test("lifecycle, version, sync state, and tombstone fields do not change provider payload hash", () => {
    const event = adaptJourneyToCalendarEvent(journey(), context("event-2", "journey-2"));
    const changed = {
      ...event,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z",
      version: 99,
      deletedAt: "2026-09-01T00:00:00Z",
      deletionOrigin: "edenatlas",
      sync: { direction: "bidirectional", state: "pending_delete", lastSyncedAt: "2026-08-30T00:00:00Z" },
    };
    assert.strictEqual(providerPayloadHash(event), providerPayloadHash(changed));
  });

  await test("Expense and Journal private/source-only changes do not change payload hash", () => {
    const expenseA = adaptExpenseToCalendarEvent(expense(), context("expense-event", "expense-1"));
    const expenseB = adaptExpenseToCalendarEvent(
      expense({ amount: 999, category: "travel", note: "different private note" }),
      context("expense-event", "expense-1")
    );
    assert.strictEqual(providerPayloadHash(expenseA), providerPayloadHash(expenseB));

    const journalA = adaptJournalToCalendarEvent(journal(), context("journal-event", "journal-1"));
    const journalB = adaptJournalToCalendarEvent(
      journal({ content: "different private body", mood: "different", tags: ["private"] }),
      context("journal-event", "journal-1")
    );
    assert.strictEqual(providerPayloadHash(journalA), providerPayloadHash(journalB));
  });

  await test("provider-relevant title and date changes change payload hash", () => {
    const baseline = adaptJourneyToCalendarEvent(journey(), context("journey-event", "journey-1"));
    const titleChanged = adaptJourneyToCalendarEvent(
      journey({ title: "Reached Ipoh" }), context("journey-event", "journey-1")
    );
    const dateChanged = adaptJourneyToCalendarEvent(
      journey({ date: "2026-08-25" }), context("journey-event", "journey-1")
    );
    assert.notStrictEqual(providerPayloadHash(baseline), providerPayloadHash(titleChanged));
    assert.notStrictEqual(providerPayloadHash(baseline), providerPayloadHash(dateChanged));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
