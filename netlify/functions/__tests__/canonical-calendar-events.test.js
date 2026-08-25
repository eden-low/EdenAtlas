const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { CalendarEventStoreError } = require("../lib/calendar-event-store.js");
const { CalendarEventIdentityError } = require("../lib/calendar-event-identity.js");
const {
  createHandler,
  parseCanonicalCalendarRequest,
} = require("../canonical-calendar-events.js");

const UID = "verified-owner";
const OTHER_UID = "other-user";
const ORIGIN = "https://staging--edenatlas.netlify.app";

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

function sourceSnapshot(value) {
  return { exists: value !== undefined, data: () => value };
}

function createHarness(options = {}) {
  const observed = {
    sourceReads: [],
    listCalls: [],
    createCalls: [],
    referenceCalls: [],
    updateCalls: [],
    tombstoneCalls: [],
  };
  const sources = options.sources || {
    expenses: { "expense-1": { uid: UID, date: "2026-08-24" } },
    journals: { "journal-1": { uid: UID, entryDate: "2026-08-25" } },
    life_events: { "journey-1": { uid: UID, date: "2026-08-26", title: "Journey" } },
  };
  const store = options.store || {
    async listForOwner(args) {
      observed.listCalls.push(args);
      return [{ id: "owned-event", ownerUid: args.verifiedUid }];
    },
    async createFromSource(args) {
      observed.createCalls.push(args);
      return { id: "server-event", ownerUid: args.verifiedUid, sourceEntityType: args.sourceEntityType };
    },
    async readOwnedSourceReference(args) {
      observed.referenceCalls.push(args);
      return {
        canonicalEventId: args.canonicalEventId,
        sourceEntityType: "journal",
        sourceEntityId: "journal-1",
        version: 2,
      };
    },
    async updateFromSource(args) {
      observed.updateCalls.push(args);
      return { id: args.canonicalEventId, ownerUid: args.verifiedUid, version: args.expectedVersion + 1 };
    },
    async tombstoneOwnedEvent(args) {
      observed.tombstoneCalls.push(args);
      return {
        id: args.canonicalEventId,
        ownerUid: args.verifiedUid,
        version: args.expectedVersion + 1,
        deletedAt: "2026-09-01T00:00:00Z",
        deletionOrigin: "edenatlas",
      };
    },
  };
  const db = {
    collection(name) {
      return {
        doc(id) {
          observed.sourceReads.push({ collection: name, id });
          return { get: async () => sourceSnapshot(sources[name] && sources[name][id]) };
        },
      };
    },
  };
  const deps = {
    env: { ALLOWED_ORIGIN: ORIGIN },
    ensureFirebaseAdmin: options.ensureFirebaseAdmin || (async () => {}),
    verifyIdToken: options.verifyIdToken || (async () => ({ uid: UID })),
    getDb: () => db,
    getStore: options.getStore || (() => store),
  };
  return { handler: createHandler(deps), observed };
}

function post(body, overrides = {}) {
  return {
    httpMethod: "POST",
    headers: { origin: ORIGIN, authorization: "Bearer firebase-token" },
    body: JSON.stringify(body),
    ...overrides,
  };
}

function bodyOf(response) {
  return JSON.parse(response.body);
}

async function run() {
  await test("missing, invalid, and revoked Firebase tokens are rejected", async () => {
    let harness = createHarness();
    let response = await harness.handler(post({ action: "list" }, { headers: { origin: ORIGIN } }));
    assert.strictEqual(response.statusCode, 401);
    harness = createHarness({ verifyIdToken: async () => { throw new Error("invalid"); } });
    response = await harness.handler(post({ action: "list" }));
    assert.strictEqual(response.statusCode, 401);
    harness = createHarness({ verifyIdToken: async () => { const err = new Error("revoked"); err.code = "auth/id-token-revoked"; throw err; } });
    response = await harness.handler(post({ action: "list" }));
    assert.strictEqual(response.statusCode, 401);
  });

  await test("list derives owner exclusively from the verified token", async () => {
    const { handler, observed } = createHarness();
    const response = await handler(post({ action: "list" }));
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(observed.listCalls, [{ verifiedUid: UID }]);
    assert.deepStrictEqual(bodyOf(response).events, [{ id: "owned-event", ownerUid: UID }]);
  });

  await test("forged uid/ownerUid, raw paths, raw events, and browser timestamps are rejected", async () => {
    const bodies = [
      { action: "list", uid: OTHER_UID },
      { action: "list", ownerUid: OTHER_UID },
      { action: "project_source", sourceEntityType: "expense", sourceEntityId: "expense-1", path: "expenses/expense-1" },
      { action: "project_source", sourceEntityType: "expense", sourceEntityId: "expense-1", event: { title: "injected" } },
      { action: "project_source", sourceEntityType: "expense", sourceEntityId: "expense-1", createdAt: "2000-01-01T00:00:00Z" },
      { action: "project_source", sourceEntityType: "expense", sourceEntityId: "expense-1", instanceKey: "attacker" },
      { action: "list", serverIdentityKey: "attacker-controlled-secret" },
    ];
    for (const request of bodies) {
      const { handler, observed } = createHarness();
      const response = await handler(post(request));
      assert.strictEqual(response.statusCode, 400);
      assert.strictEqual(bodyOf(response).error, "unknown_field");
      assert.deepStrictEqual(observed.sourceReads, []);
      assert.deepStrictEqual(observed.createCalls, []);
    }
  });

  await test("project_source loads only the allowlisted source document and verifies its owner", async () => {
    const { handler, observed } = createHarness();
    const response = await handler(post({ action: "project_source", sourceEntityType: "expense", sourceEntityId: "expense-1" }));
    assert.strictEqual(response.statusCode, 201);
    assert.deepStrictEqual(observed.sourceReads, [{ collection: "expenses", id: "expense-1" }]);
    assert.strictEqual(observed.createCalls.length, 1);
    assert.strictEqual(observed.createCalls[0].verifiedUid, UID);
    assert.strictEqual(observed.createCalls[0].source.uid, UID);
    assert.strictEqual(bodyOf(response).event.ownerUid, UID);
  });

  await test("prepare_manual_create returns only an opaque canonical handle", async () => {
    const { handler, observed } = createHarness();
    const response = await handler(post({
      action: "prepare_manual_create", sourceEntityType: "expense", sourceEntityId: "expense-1",
    }));
    assert.strictEqual(response.statusCode, 201);
    assert.deepStrictEqual(bodyOf(response), { ok: true, canonicalEventHandle: "server-event" });
    assert.strictEqual(observed.createCalls.length, 1);
  });

  await test("cross-user source IDs return not-found and never reach persistence", async () => {
    const sources = { expenses: { "other-expense": { uid: OTHER_UID, date: "2026-08-24" } } };
    const { handler, observed } = createHarness({ sources });
    const response = await handler(post({ action: "project_source", sourceEntityType: "expense", sourceEntityId: "other-expense" }));
    assert.strictEqual(response.statusCode, 404);
    assert.deepStrictEqual(observed.tombstoneCalls, []);
    assert.strictEqual(bodyOf(response).error, "source_not_found");
    assert.deepStrictEqual(observed.createCalls, []);
  });

  await test("missing and malformed source records are rejected before the adapter/store", async () => {
    let harness = createHarness({ sources: { journals: {} } });
    let response = await harness.handler(post({ action: "project_source", sourceEntityType: "journal", sourceEntityId: "missing" }));
    assert.strictEqual(response.statusCode, 404);
    assert.deepStrictEqual(harness.observed.tombstoneCalls, []);
    harness = createHarness({ sources: { journals: { malformed: { entryDate: "2026-08-24" } } } });
    response = await harness.handler(post({ action: "project_source", sourceEntityType: "journal", sourceEntityId: "malformed" }));
    assert.strictEqual(response.statusCode, 400);
    assert.strictEqual(bodyOf(response).error, "invalid_source_record");
    assert.deepStrictEqual(harness.observed.tombstoneCalls, []);
  });

  await test("refresh_projection uses the owned stored mapping, not browser-supplied source identity", async () => {
    const { handler, observed } = createHarness();
    const response = await handler(post({ action: "refresh_projection", canonicalEventId: "server-event", expectedVersion: 2 }));
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(observed.referenceCalls, [{ verifiedUid: UID, canonicalEventId: "server-event" }]);
    assert.deepStrictEqual(observed.sourceReads, [{ collection: "journals", id: "journal-1" }]);
    assert.strictEqual(observed.updateCalls[0].expectedVersion, 2);
    assert.strictEqual(observed.updateCalls[0].source.uid, UID);
  });

  await test("explicit tombstone derives owner from auth and does not read or accept source identity", async () => {
    const { handler, observed } = createHarness();
    const response = await handler(post({
      action: "tombstone", canonicalEventId: "server-event", expectedVersion: 2,
    }));
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(observed.tombstoneCalls, [{
      verifiedUid: UID, canonicalEventId: "server-event", expectedVersion: 2,
    }]);
    assert.deepStrictEqual(observed.sourceReads, []);
    assert.strictEqual(bodyOf(response).event.deletionOrigin, "edenatlas");
  });

  await test("invalid source types, path-shaped IDs, and versions fail before Firestore", async () => {
    const requests = [
      { action: "project_source", sourceEntityType: "google_event", sourceEntityId: "g1" },
      { action: "project_source", sourceEntityType: "expense", sourceEntityId: "../expense-1" },
      { action: "refresh_projection", canonicalEventId: "events/server-event", expectedVersion: 1 },
      { action: "refresh_projection", canonicalEventId: "server-event", expectedVersion: 0 },
      { action: "tombstone", canonicalEventId: "events/server-event", expectedVersion: 1 },
      { action: "tombstone", canonicalEventId: "server-event", expectedVersion: 0 },
    ];
    for (const request of requests) {
      const { handler, observed } = createHarness();
      const response = await handler(post(request));
      assert.strictEqual(response.statusCode, 400);
      assert.deepStrictEqual(observed.sourceReads, []);
    }
  });

  await test("store ownership/version failures are returned as sanitized deterministic errors", async () => {
    const store = {
      listForOwner: async () => { throw new CalendarEventStoreError("canonical_event_not_found", 404); },
    };
    const { handler } = createHarness({ store });
    const response = await handler(post({ action: "list" }));
    assert.deepStrictEqual(bodyOf(response), { ok: false, error: "canonical_event_not_found" });
    assert.strictEqual(response.statusCode, 404);
  });

  await test("identity configuration failures are safe and never expose the server key", async () => {
    const secret = "SUPER_SECRET_CALENDAR_IDENTITY_KEY";
    let harness = createHarness({
      getStore: () => { throw new CalendarEventIdentityError("calendar_identity_key_unavailable"); },
    });
    let response = await harness.handler(post({ action: "list" }));
    assert.strictEqual(response.statusCode, 503);
    assert.deepStrictEqual(bodyOf(response), { ok: false, error: "canonical_identity_not_configured" });
    assert.ok(!response.body.includes(secret));

    harness = createHarness({ getStore: () => { throw new Error(secret); } });
    response = await harness.handler(post({ action: "list" }));
    assert.strictEqual(response.statusCode, 500);
    assert.ok(!response.body.includes(secret));
  });

  await test("unsupported methods and origins fail closed", async () => {
    const { handler } = createHarness();
    let response = await handler(post({ action: "list" }, { httpMethod: "GET" }));
    assert.strictEqual(response.statusCode, 405);
    response = await handler(post({ action: "list" }, { headers: { origin: "https://attacker.invalid", authorization: "Bearer token" } }));
    assert.strictEqual(response.statusCode, 403);
  });

  await test("request parser accepts only the five minimal operation contracts", () => {
    assert.deepStrictEqual(parseCanonicalCalendarRequest(JSON.stringify({ action: "list" })).value, { action: "list" });
    assert.strictEqual(parseCanonicalCalendarRequest(JSON.stringify({ action: "project_source", sourceEntityType: "journey", sourceEntityId: "j1" })).value.sourceEntityId, "j1");
    assert.strictEqual(parseCanonicalCalendarRequest(JSON.stringify({ action: "prepare_manual_create", sourceEntityType: "expense", sourceEntityId: "e1" })).value.sourceEntityId, "e1");
    assert.strictEqual(parseCanonicalCalendarRequest(JSON.stringify({ action: "refresh_projection", canonicalEventId: "c1", expectedVersion: 1 })).value.expectedVersion, 1);
    assert.strictEqual(parseCanonicalCalendarRequest(JSON.stringify({ action: "tombstone", canonicalEventId: "c1", expectedVersion: 1 })).value.expectedVersion, 1);
  });

  await test("production runtime verifies revocation and contains no OAuth/provider/sync behavior", () => {
    const runtime = fs.readFileSync(path.resolve(__dirname, "../lib/canonical-calendar-runtime.js"), "utf8");
    const handler = fs.readFileSync(path.resolve(__dirname, "../canonical-calendar-events.js"), "utf8");
    assert.match(runtime, /verifyIdToken\(token, true\)/);
    const combined = `${runtime}\n${handler}`;
    for (const forbidden of [
      "GOOGLE_CALENDAR_SCOPE", "calendar.events.insert", "calendar.events.update",
      "calendar.events.delete", "googleEventId", "externalEventId", "calendar_sync_jobs",
      "calendar_sync_cursors", "etag",
      "randomUUID",
    ]) {
      assert.ok(!combined.includes(forbidden), `forbidden canonical API behavior: ${forbidden}`);
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
