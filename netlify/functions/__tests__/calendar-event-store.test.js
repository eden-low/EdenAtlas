const assert = require("node:assert");
const {
  CalendarEventStoreError,
  createCalendarEventStore,
} = require("../lib/calendar-event-store.js");
const { validateCanonicalCalendarEvent } = require("../lib/calendar-event-model.js");

const OWNER_UID = "owner-uid";
const OTHER_UID = "other-uid";

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

function snapshot(id, value) {
  return {
    id,
    exists: value !== undefined,
    data: () => value,
  };
}

function createMockDb() {
  const collections = new Map();
  function records(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }
  function ref(name, id) {
    return {
      id,
      async get() { return snapshot(id, records(name).get(id)); },
    };
  }
  function collection(name) {
    return {
      doc: (id) => ref(name, id),
      where(field, op, value) {
        assert.strictEqual(op, "==");
        return {
          async get() {
            return {
              docs: [...records(name).entries()]
                .filter(([, data]) => data[field] === value)
                .map(([id, data]) => snapshot(id, data)),
            };
          },
        };
      },
    };
  }
  async function runTransaction(callback) {
    const writes = [];
    const result = await callback({
      get: (documentRef) => documentRef.get(),
      set: (documentRef, data) => writes.push({ documentRef, data }),
    });
    writes.forEach(({ documentRef, data }) => records("calendar_events").set(documentRef.id, data));
    return result;
  }
  return {
    collection,
    runTransaction,
    seed(name, id, data) { records(name).set(id, data); },
    read(name, id) { return records(name).get(id); },
  };
}

function timestamp(iso) {
  return { toDate: () => new Date(iso) };
}

function expense(overrides = {}) {
  return {
    uid: OWNER_UID,
    amount: 42.5,
    category: "food",
    note: "EXPENSE_PRIVATE_NOTE",
    date: "2026-08-24",
    createdAt: timestamp("2026-08-24T02:00:00Z"),
    ...overrides,
  };
}

function journal(overrides = {}) {
  return {
    uid: OWNER_UID,
    entryDate: "2026-08-25",
    title: "PRIVATE_JOURNAL_TITLE",
    content: "PRIVATE_JOURNAL_BODY",
    mood: "PRIVATE_MOOD",
    tags: ["PRIVATE_TAG"],
    locationName: "PRIVATE_JOURNAL_LOCATION",
    visibility: "private",
    createdAt: timestamp("2026-08-25T03:00:00Z"),
    ...overrides,
  };
}

function journey(overrides = {}) {
  return {
    uid: OWNER_UID,
    date: "2026-08-26",
    title: "Reached Penang",
    description: "PRIVATE_JOURNEY_DESCRIPTION",
    locationName: "PRIVATE_JOURNEY_LOCATION",
    visibility: "private",
    ...overrides,
  };
}

function harness({ ids = ["temporary-event-1"], times = ["2026-08-30T00:00:00Z"] } = {}) {
  const db = createMockDb();
  let idIndex = 0;
  let timeIndex = 0;
  const store = createCalendarEventStore({
    db,
    generateId: () => ids[Math.min(idIndex++, ids.length - 1)],
    now: () => new Date(times[Math.min(timeIndex++, times.length - 1)]),
  });
  return { db, store };
}

async function rejects(code, promise) {
  await assert.rejects(promise, (err) => err instanceof CalendarEventStoreError && err.code === code);
}

async function run() {
await test("create persists a validated canonical event with initial version 1", async () => {
  const { db, store } = harness();
  const event = await store.createFromSource({
    verifiedUid: OWNER_UID,
    sourceEntityType: "expense",
    sourceEntityId: "expense-1",
    source: expense(),
  });
  assert.strictEqual(event.id, "temporary-event-1");
  assert.strictEqual(event.ownerUid, OWNER_UID);
  assert.strictEqual(event.version, 1);
  assert.strictEqual(validateCanonicalCalendarEvent(event), true);
  assert.deepStrictEqual(db.read("calendar_events", event.id), event);
});

await test("trusted canonical lifecycle timestamps are server-owned and separate from source lifecycle", async () => {
  const { store } = harness({ times: ["2026-09-01T10:00:00Z"] });
  const event = await store.createFromSource({
    verifiedUid: OWNER_UID,
    sourceEntityType: "expense",
    sourceEntityId: "expense-lifecycle",
    source: expense({
      createdAt: timestamp("2020-01-01T00:00:00Z"),
      updatedAt: timestamp("2020-01-02T00:00:00Z"),
      ownerUid: "FORGED_OWNER_FIELD",
    }),
  });
  assert.strictEqual(event.createdAt, "2026-09-01T10:00:00.000Z");
  assert.strictEqual(event.updatedAt, "2026-09-01T10:00:00.000Z");
  assert.strictEqual(event.sourceCreatedAt, "2020-01-01T00:00:00.000Z");
  assert.strictEqual(event.sourceUpdatedAt, "2020-01-02T00:00:00.000Z");
  assert.strictEqual(event.ownerUid, OWNER_UID);
  assert.ok(!JSON.stringify(event).includes("FORGED_OWNER_FIELD"));
});

await test("read/list return only the verified owner's canonical events", async () => {
  const { store } = harness({ ids: ["owner-event", "other-event"] });
  const ownerEvent = await store.createFromSource({ verifiedUid: OWNER_UID, sourceEntityType: "expense", sourceEntityId: "e-owner", source: expense() });
  await store.createFromSource({ verifiedUid: OTHER_UID, sourceEntityType: "expense", sourceEntityId: "e-other", source: expense({ uid: OTHER_UID }) });
  assert.strictEqual((await store.readOwnedEvent({ verifiedUid: OWNER_UID, canonicalEventId: ownerEvent.id })).id, "owner-event");
  assert.deepStrictEqual((await store.listForOwner({ verifiedUid: OWNER_UID })).map((event) => event.id), ["owner-event"]);
  await rejects("canonical_event_not_found", store.readOwnedEvent({ verifiedUid: OWNER_UID, canonicalEventId: "other-event" }));
});

await test("forged or missing source ownership is rejected before persistence", async () => {
  const { db, store } = harness();
  await rejects("invalid_source_projection", store.createFromSource({
    verifiedUid: OWNER_UID,
    sourceEntityType: "expense",
    sourceEntityId: "forged",
    source: expense({ uid: OTHER_UID, ownerUid: OWNER_UID }),
  }));
  const missingUid = expense();
  delete missingUid.uid;
  await rejects("invalid_source_projection", store.createFromSource({
    verifiedUid: OWNER_UID,
    sourceEntityType: "expense",
    sourceEntityId: "missing-owner",
    source: missingUid,
  }));
  assert.strictEqual(db.read("calendar_events", "temporary-event-1"), undefined);
});

await test("malformed stored canonical events, including missing ownerUid, are rejected", async () => {
  const { db, store } = harness();
  const event = await store.createFromSource({ verifiedUid: OWNER_UID, sourceEntityType: "expense", sourceEntityId: "valid", source: expense() });
  const missingOwner = { ...event };
  delete missingOwner.ownerUid;
  db.seed("calendar_events", event.id, missingOwner);
  await rejects("invalid_stored_canonical_event", store.readOwnedEvent({ verifiedUid: OWNER_UID, canonicalEventId: event.id }));
  db.seed("calendar_events", event.id, { ...event, end: event.start });
  await rejects("invalid_stored_canonical_event", store.readOwnedEvent({ verifiedUid: OWNER_UID, canonicalEventId: event.id }));
});

await test("update increments version, preserves createdAt, and uses a new trusted updatedAt", async () => {
  const { store } = harness({ times: ["2026-08-30T00:00:00Z", "2026-08-31T00:00:00Z"] });
  const created = await store.createFromSource({ verifiedUid: OWNER_UID, sourceEntityType: "journey", sourceEntityId: "journey-1", source: journey() });
  const updated = await store.updateFromSource({
    verifiedUid: OWNER_UID,
    canonicalEventId: created.id,
    expectedVersion: 1,
    source: journey({ title: "Reached Butterworth", date: "2026-08-27", updatedAt: timestamp("2026-08-27T12:00:00Z") }),
  });
  assert.strictEqual(updated.version, 2);
  assert.strictEqual(updated.createdAt, created.createdAt);
  assert.strictEqual(updated.updatedAt, "2026-08-31T00:00:00.000Z");
  assert.strictEqual(updated.title, "Reached Butterworth");
  assert.strictEqual(updated.start.date, "2026-08-27");
});

await test("stale expectedVersion is rejected without overwriting the newer event", async () => {
  const { db, store } = harness({ times: ["2026-08-30T00:00:00Z", "2026-08-31T00:00:00Z", "2026-09-01T00:00:00Z"] });
  const created = await store.createFromSource({ verifiedUid: OWNER_UID, sourceEntityType: "journey", sourceEntityId: "journey-stale", source: journey() });
  const current = await store.updateFromSource({ verifiedUid: OWNER_UID, canonicalEventId: created.id, expectedVersion: 1, source: journey({ title: "Current title" }) });
  await rejects("stale_canonical_event_version", store.updateFromSource({
    verifiedUid: OWNER_UID,
    canonicalEventId: created.id,
    expectedVersion: 1,
    source: journey({ title: "Stale overwrite" }),
  }));
  assert.deepStrictEqual(db.read("calendar_events", created.id), current);
});

await test("malformed source dates are rejected and never persisted", async () => {
  const { db, store } = harness();
  await rejects("invalid_source_projection", store.createFromSource({
    verifiedUid: OWNER_UID,
    sourceEntityType: "journal",
    sourceEntityId: "journal-invalid",
    source: journal({ entryDate: "2026-02-30" }),
  }));
  assert.strictEqual(db.read("calendar_events", "temporary-event-1"), undefined);
});

await test("Expense, Journal, and Journey adapter outputs all satisfy the canonical store", async () => {
  const { store } = harness({ ids: ["expense-event", "journal-event", "journey-event"] });
  const events = [
    await store.createFromSource({ verifiedUid: OWNER_UID, sourceEntityType: "expense", sourceEntityId: "expense-ok", source: expense() }),
    await store.createFromSource({ verifiedUid: OWNER_UID, sourceEntityType: "journal", sourceEntityId: "journal-ok", source: journal() }),
    await store.createFromSource({ verifiedUid: OWNER_UID, sourceEntityType: "journey", sourceEntityId: "journey-ok", source: journey() }),
  ];
  assert.deepStrictEqual(events.map((event) => event.sourceEntityType), ["expense", "journal", "journey"]);
  events.forEach((event) => assert.strictEqual(validateCanonicalCalendarEvent(event), true));
});

await test("canonical persistence maintains every source privacy boundary", async () => {
  const { store } = harness({ ids: ["expense-private", "journal-private", "journey-private"] });
  const events = [
    await store.createFromSource({ verifiedUid: OWNER_UID, sourceEntityType: "expense", sourceEntityId: "expense-private-source", source: expense() }),
    await store.createFromSource({ verifiedUid: OWNER_UID, sourceEntityType: "journal", sourceEntityId: "journal-private-source", source: journal() }),
    await store.createFromSource({ verifiedUid: OWNER_UID, sourceEntityType: "journey", sourceEntityId: "journey-private-source", source: journey() }),
  ];
  const serialized = JSON.stringify(events);
  for (const forbidden of [
    "42.5", "EXPENSE_PRIVATE_NOTE", "PRIVATE_JOURNAL_TITLE", "PRIVATE_JOURNAL_BODY",
    "PRIVATE_MOOD", "PRIVATE_TAG", "PRIVATE_JOURNAL_LOCATION",
    "PRIVATE_JOURNEY_DESCRIPTION", "PRIVATE_JOURNEY_LOCATION",
  ]) {
    assert.ok(!serialized.includes(forbidden), `private source value persisted: ${forbidden}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
