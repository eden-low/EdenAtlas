const assert = require("node:assert");
const {
  CALENDAR_STORE_METADATA_FIELD,
  CalendarEventStoreError,
  createCalendarEventStore,
} = require("../lib/calendar-event-store.js");
const {
  DEFAULT_CALENDAR_INSTANCE_KEY,
  createCalendarEventIdentity,
  isDeterministicCalendarEventId,
} = require("../lib/calendar-event-identity.js");
const { adaptExpenseToCalendarEvent } = require("../lib/calendar-event-adapters.js");
const { validateCanonicalCalendarEvent } = require("../lib/calendar-event-model.js");

const OWNER_UID = "owner-uid";
const OTHER_UID = "other-uid";
const IDENTITY_KEY = "phase-3b5-store-test-key-at-least-32-bytes";

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

function createMockDb() {
  const collections = new Map();
  let transactionTail = Promise.resolve();
  function records(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }
  function documentSnapshot(ref) {
    const value = records(ref.collectionName).get(ref.id);
    return { id: ref.id, ref, exists: value !== undefined, data: () => value };
  }
  function documentRef(collectionName, id) {
    const ref = { kind: "document", collectionName, id };
    ref.get = async () => documentSnapshot(ref);
    return ref;
  }
  function queryRef(collectionName, filters = []) {
    return {
      kind: "query",
      collectionName,
      filters,
      where(field, op, value) {
        assert.strictEqual(op, "==");
        return queryRef(collectionName, [...filters, { field, value }]);
      },
      async get() {
        return {
          docs: [...records(collectionName).keys()]
            .map((id) => documentSnapshot(documentRef(collectionName, id)))
            .filter((snapshot) => filters.every(({ field, value }) => snapshot.data()[field] === value)),
        };
      },
    };
  }
  function collection(name) {
    const query = queryRef(name);
    return { ...query, doc: (id) => documentRef(name, id) };
  }
  async function executeTransaction(callback) {
    const writes = [];
    const transaction = {
      get: (reference) => reference.get(),
      set: (reference, data) => writes.push({ reference, data }),
    };
    const result = await callback(transaction);
    for (const { reference, data } of writes) {
      records(reference.collectionName).set(reference.id, structuredClone(data));
    }
    return result;
  }
  function runTransaction(callback) {
    const operation = transactionTail.then(() => executeTransaction(callback));
    transactionTail = operation.catch(() => undefined);
    return operation;
  }
  return {
    collection,
    runTransaction,
    seed(name, id, data) { records(name).set(id, structuredClone(data)); },
    read(name, id) { return records(name).get(id); },
    count(name) { return records(name).size; },
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

function harness({ times = ["2026-08-30T00:00:00Z"] } = {}) {
  const db = createMockDb();
  const identity = createCalendarEventIdentity(IDENTITY_KEY);
  let timeIndex = 0;
  const store = createCalendarEventStore({
    db,
    identity,
    now: () => new Date(times[Math.min(timeIndex++, times.length - 1)]),
  });
  return { db, identity, store };
}

function canonicalOnly(document) {
  const event = { ...document };
  delete event[CALENDAR_STORE_METADATA_FIELD];
  return event;
}

async function rejects(code, promise) {
  await assert.rejects(promise, (err) => err instanceof CalendarEventStoreError && err.code === code);
}

function deterministicId(identity, ownerUid, sourceEntityType, sourceEntityId, instanceKey = DEFAULT_CALENDAR_INSTANCE_KEY) {
  return identity.eventId({ ownerUid, sourceEntityType, sourceEntityId, instanceKey });
}

function legacyExpenseEvent(id, sourceEntityId, overrides = {}) {
  return {
    ...adaptExpenseToCalendarEvent(expense(), {
      id,
      ownerUid: OWNER_UID,
      sourceEntityId,
      projectedAt: "2026-08-28T00:00:00Z",
    }),
    ...overrides,
  };
}

async function run() {
  await test("create persists one deterministic canonical event with version 1 and private metadata", async () => {
    const { db, identity, store } = harness();
    const event = await store.createFromSource({
      verifiedUid: OWNER_UID, sourceEntityType: "expense", sourceEntityId: "expense-1", source: expense(),
    });
    assert.strictEqual(event.id, deterministicId(identity, OWNER_UID, "expense", "expense-1"));
    assert.strictEqual(isDeterministicCalendarEventId(event.id), true);
    assert.strictEqual(event.version, 1);
    assert.strictEqual(validateCanonicalCalendarEvent(event), true);
    const document = db.read("calendar_events", event.id);
    assert.deepStrictEqual(canonicalOnly(document), event);
    assert.strictEqual(document[CALENDAR_STORE_METADATA_FIELD].instanceKey, "single");
    assert.match(document[CALENDAR_STORE_METADATA_FIELD].payloadHash, /^sha256:[0-9a-f]{64}$/u);
    assert.strictEqual(document[CALENDAR_STORE_METADATA_FIELD].migration.state, "native");
    assert.ok(!JSON.stringify(document).includes(IDENTITY_KEY));
  });

  await test("trusted lifecycle timestamps remain separate from source lifecycle and forged ownership", async () => {
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

  await test("read/list enforce verified-owner isolation", async () => {
    const { store } = harness();
    const ownerEvent = await store.createFromSource({
      verifiedUid: OWNER_UID, sourceEntityType: "expense", sourceEntityId: "e-owner", source: expense(),
    });
    const otherEvent = await store.createFromSource({
      verifiedUid: OTHER_UID,
      sourceEntityType: "expense",
      sourceEntityId: "e-other",
      source: expense({ uid: OTHER_UID }),
    });
    assert.strictEqual((await store.readOwnedEvent({ verifiedUid: OWNER_UID, canonicalEventId: ownerEvent.id })).id, ownerEvent.id);
    assert.deepStrictEqual((await store.listForOwner({ verifiedUid: OWNER_UID })).map((event) => event.id), [ownerEvent.id]);
    await rejects("canonical_event_not_found", store.readOwnedEvent({
      verifiedUid: OWNER_UID, canonicalEventId: otherEvent.id,
    }));
  });

  await test("forged/missing source ownership and malformed sources never persist", async () => {
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
      verifiedUid: OWNER_UID, sourceEntityType: "expense", sourceEntityId: "missing", source: missingUid,
    }));
    await rejects("invalid_source_projection", store.createFromSource({
      verifiedUid: OWNER_UID,
      sourceEntityType: "journal",
      sourceEntityId: "bad-date",
      source: journal({ entryDate: "2026-02-30" }),
    }));
    assert.strictEqual(db.count("calendar_events"), 0);
  });

  await test("update increments version and payload hash changes only for provider-relevant changes", async () => {
    const { db, store } = harness({
      times: ["2026-08-30T00:00:00Z", "2026-08-31T00:00:00Z", "2026-09-01T00:00:00Z"],
    });
    const created = await store.createFromSource({
      verifiedUid: OWNER_UID, sourceEntityType: "expense", sourceEntityId: "expense-update", source: expense(),
    });
    const beforeHash = db.read("calendar_events", created.id)[CALENDAR_STORE_METADATA_FIELD].payloadHash;
    const privateUpdate = await store.updateFromSource({
      verifiedUid: OWNER_UID,
      canonicalEventId: created.id,
      expectedVersion: 1,
      source: expense({ amount: 900, note: "different", updatedAt: timestamp("2026-08-31T01:00:00Z") }),
    });
    assert.strictEqual(privateUpdate.version, 2);
    assert.strictEqual(db.read("calendar_events", created.id)[CALENDAR_STORE_METADATA_FIELD].payloadHash, beforeHash);
    const dateUpdate = await store.updateFromSource({
      verifiedUid: OWNER_UID,
      canonicalEventId: created.id,
      expectedVersion: 2,
      source: expense({ date: "2026-08-25", updatedAt: timestamp("2026-09-01T01:00:00Z") }),
    });
    assert.strictEqual(dateUpdate.version, 3);
    assert.notStrictEqual(db.read("calendar_events", created.id)[CALENDAR_STORE_METADATA_FIELD].payloadHash, beforeHash);
  });

  await test("stale expectedVersion is rejected without overwriting", async () => {
    const { db, store } = harness({
      times: ["2026-08-30T00:00:00Z", "2026-08-31T00:00:00Z", "2026-09-01T00:00:00Z"],
    });
    const created = await store.createFromSource({
      verifiedUid: OWNER_UID, sourceEntityType: "journey", sourceEntityId: "journey-stale", source: journey(),
    });
    const current = await store.updateFromSource({
      verifiedUid: OWNER_UID,
      canonicalEventId: created.id,
      expectedVersion: 1,
      source: journey({ title: "Current title" }),
    });
    const before = structuredClone(db.read("calendar_events", created.id));
    await rejects("stale_canonical_event_version", store.updateFromSource({
      verifiedUid: OWNER_UID,
      canonicalEventId: created.id,
      expectedVersion: 1,
      source: journey({ title: "Stale overwrite" }),
    }));
    assert.strictEqual(current.version, 2);
    assert.deepStrictEqual(db.read("calendar_events", created.id), before);
  });

  await test("all source adapters satisfy the store and preserve privacy boundaries", async () => {
    const { store } = harness();
    const events = [
      await store.createFromSource({ verifiedUid: OWNER_UID, sourceEntityType: "expense", sourceEntityId: "expense-ok", source: expense() }),
      await store.createFromSource({ verifiedUid: OWNER_UID, sourceEntityType: "journal", sourceEntityId: "journal-ok", source: journal() }),
      await store.createFromSource({ verifiedUid: OWNER_UID, sourceEntityType: "journey", sourceEntityId: "journey-ok", source: journey() }),
    ];
    events.forEach((event) => assert.strictEqual(validateCanonicalCalendarEvent(event), true));
    const serialized = JSON.stringify(events);
    for (const forbidden of [
      "42.5", "EXPENSE_PRIVATE_NOTE", "PRIVATE_JOURNAL_TITLE", "PRIVATE_JOURNAL_BODY",
      "PRIVATE_MOOD", "PRIVATE_TAG", "PRIVATE_JOURNAL_LOCATION",
      "PRIVATE_JOURNEY_DESCRIPTION", "PRIVATE_JOURNEY_LOCATION",
    ]) {
      assert.ok(!serialized.includes(forbidden), `private source value persisted: ${forbidden}`);
    }
  });

  await test("repeated, concurrent, and timeout-retried projection creates one event", async () => {
    const { db, store } = harness();
    const args = {
      verifiedUid: OWNER_UID, sourceEntityType: "expense", sourceEntityId: "expense-idempotent", source: expense(),
    };
    const first = await store.createFromSource(args);
    const repeated = await store.createFromSource({ ...args, source: expense({ amount: 999, date: "2026-09-01" }) });
    assert.strictEqual(repeated.id, first.id);
    assert.strictEqual(db.count("calendar_events"), 1);

    const concurrentArgs = {
      verifiedUid: OWNER_UID, sourceEntityType: "journal", sourceEntityId: "journal-concurrent", source: journal(),
    };
    const concurrent = await Promise.all([
      store.createFromSource(concurrentArgs),
      store.createFromSource(concurrentArgs),
      store.createFromSource(concurrentArgs),
    ]);
    assert.strictEqual(new Set(concurrent.map((event) => event.id)).size, 1);
    assert.strictEqual(db.count("calendar_events"), 2);

    // Simulate a client losing the successful response and retrying the whole operation.
    const retry = await store.createFromSource(args);
    assert.strictEqual(retry.id, first.id);
    assert.strictEqual(db.count("calendar_events"), 2);
  });

  await test("tombstone preserves identity/lifecycle, disappears from active list, and repeats idempotently", async () => {
    const { db, store } = harness({ times: ["2026-08-30T00:00:00Z", "2026-09-02T00:00:00Z", "2026-09-03T00:00:00Z"] });
    const created = await store.createFromSource({
      verifiedUid: OWNER_UID, sourceEntityType: "journal", sourceEntityId: "journal-delete", source: journal(),
    });
    const beforeHash = db.read("calendar_events", created.id)[CALENDAR_STORE_METADATA_FIELD].payloadHash;
    const deleted = await store.tombstoneOwnedEvent({
      verifiedUid: OWNER_UID, canonicalEventId: created.id, expectedVersion: 1,
    });
    assert.strictEqual(deleted.id, created.id);
    assert.strictEqual(deleted.ownerUid, OWNER_UID);
    assert.strictEqual(deleted.sourceEntityType, "journal");
    assert.strictEqual(deleted.sourceEntityId, "journal-delete");
    assert.strictEqual(deleted.version, 2);
    assert.strictEqual(deleted.deletedAt, "2026-09-02T00:00:00.000Z");
    assert.strictEqual(deleted.deletionOrigin, "edenatlas");
    assert.strictEqual(db.read("calendar_events", created.id)[CALENDAR_STORE_METADATA_FIELD].payloadHash, beforeHash);
    assert.deepStrictEqual(await store.listForOwner({ verifiedUid: OWNER_UID }), []);
    assert.strictEqual((await store.readOwnedEvent({ verifiedUid: OWNER_UID, canonicalEventId: created.id })).id, created.id);

    const repeated = await store.tombstoneOwnedEvent({
      verifiedUid: OWNER_UID, canonicalEventId: created.id, expectedVersion: 1,
    });
    assert.deepStrictEqual(repeated, deleted);
    assert.strictEqual(repeated.version, 2);
  });

  await test("a Phase 3B.4 temporary record migrates atomically without deletion or active duplication", async () => {
    const { db, identity, store } = harness({ times: ["2026-09-04T00:00:00Z"] });
    const temporaryId = "ce_0123456789abcdef0123456789abcdef";
    const sourceEntityId = "expense-legacy";
    const legacy = legacyExpenseEvent(temporaryId, sourceEntityId);
    db.seed("calendar_events", temporaryId, legacy);

    const migrated = await store.createFromSource({
      verifiedUid: OWNER_UID, sourceEntityType: "expense", sourceEntityId, source: expense(),
    });
    const expectedId = deterministicId(identity, OWNER_UID, "expense", sourceEntityId);
    assert.strictEqual(migrated.id, expectedId);
    assert.strictEqual(migrated.ownerUid, OWNER_UID);
    assert.strictEqual(migrated.createdAt, legacy.createdAt);
    assert.strictEqual(migrated.version, legacy.version + 1);
    assert.strictEqual(db.count("calendar_events"), 2);
    assert.strictEqual(db.read("calendar_events", temporaryId)[CALENDAR_STORE_METADATA_FIELD].migration.state, "redirect");
    assert.strictEqual(db.read("calendar_events", expectedId)[CALENDAR_STORE_METADATA_FIELD].migration.state, "migrated");
    assert.deepStrictEqual((await store.listForOwner({ verifiedUid: OWNER_UID })).map((event) => event.id), [expectedId]);
    assert.strictEqual((await store.readOwnedEvent({ verifiedUid: OWNER_UID, canonicalEventId: temporaryId })).id, expectedId);

    const retry = await store.createFromSource({
      verifiedUid: OWNER_UID, sourceEntityType: "expense", sourceEntityId, source: expense({ amount: 999 }),
    });
    assert.strictEqual(retry.id, expectedId);
    assert.strictEqual(db.count("calendar_events"), 2);
  });

  await test("an explicit delete migrates and tombstones a legacy event even after its source disappeared", async () => {
    const { db, identity, store } = harness({
      times: ["2026-09-05T00:00:00Z", "2026-09-06T00:00:00Z"],
    });
    const temporaryId = "ce_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const sourceEntityId = "hard-deleted-expense";
    const legacy = legacyExpenseEvent(temporaryId, sourceEntityId);
    db.seed("calendar_events", temporaryId, legacy);

    const tombstone = await store.tombstoneOwnedEvent({
      verifiedUid: OWNER_UID, canonicalEventId: temporaryId, expectedVersion: 1,
    });
    const deterministicEventId = deterministicId(identity, OWNER_UID, "expense", sourceEntityId);
    assert.strictEqual(tombstone.id, deterministicEventId);
    assert.strictEqual(tombstone.deletedAt, "2026-09-05T00:00:00.000Z");
    assert.strictEqual(tombstone.deletionOrigin, "edenatlas");
    assert.strictEqual(tombstone.version, 2);
    assert.strictEqual(db.count("calendar_events"), 2);
    assert.strictEqual(db.read("calendar_events", temporaryId)[CALENDAR_STORE_METADATA_FIELD].migration.state, "redirect");
    assert.strictEqual(db.read("calendar_events", deterministicEventId)[CALENDAR_STORE_METADATA_FIELD].migration.state, "migrated");
    assert.deepStrictEqual(await store.listForOwner({ verifiedUid: OWNER_UID }), []);

    const repeated = await store.tombstoneOwnedEvent({
      verifiedUid: OWNER_UID, canonicalEventId: temporaryId, expectedVersion: 1,
    });
    assert.deepStrictEqual(repeated, tombstone);
    assert.strictEqual(db.count("calendar_events"), 2);
  });

  await test("migration and deterministic records remain owner-isolated", async () => {
    const { db, store } = harness();
    const temporaryId = "ce_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    db.seed("calendar_events", temporaryId, legacyExpenseEvent(temporaryId, "private-source"));
    await rejects("canonical_event_not_found", store.readOwnedEvent({
      verifiedUid: OTHER_UID, canonicalEventId: temporaryId,
    }));
    await rejects("invalid_source_projection", store.createFromSource({
      verifiedUid: OTHER_UID,
      sourceEntityType: "expense",
      sourceEntityId: "private-source",
      source: expense(),
    }));
    assert.strictEqual(db.count("calendar_events"), 1);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
