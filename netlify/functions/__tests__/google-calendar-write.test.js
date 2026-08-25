"use strict";

const assert = require("node:assert");
const {
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_CALENDAR_SCOPE,
  GOOGLE_CALENDAR_APP_CREATED_SCOPE,
  GOOGLE_CALENDAR_CAPABILITY_READONLY,
  GOOGLE_CALENDAR_CAPABILITY_WRITE_AUTHORIZED,
  GOOGLE_CALENDAR_OUTBOUND_POLICY,
  encryptRefreshToken,
} = require("../lib/google-calendar-oauth");
const { CalendarEventStoreError } = require("../lib/calendar-event-store");
const {
  adaptExpenseToCalendarEvent,
  adaptJournalToCalendarEvent,
  adaptJourneyToCalendarEvent,
} = require("../lib/calendar-event-adapters");
const {
  EDENATLAS_CALENDAR_NAME,
  SYNC_COLLECTION,
  parseManualCreateRequest,
  deterministicGoogleEventId,
  buildGoogleEventPayload,
  providerPayloadHash,
  markerMatches,
  acquireMapping,
  completeMapping,
} = require("../lib/google-calendar-write");
const { createHandler } = require("../google-calendar-create-event");

const UID = "verified-owner";
const OTHER_UID = "other-owner";
const ORIGIN = "https://staging--edenatlas.netlify.app";
const MASTER_KEY = Buffer.alloc(32, 23).toString("base64");
const IDENTITY_KEY = "phase-3b7-provider-identity-key-at-least-32-bytes";
const CANONICAL_ID = "0123456789ABCDEFGHIJKLMNOPQRSTUV0123456789ABCDEFGHIJ";
const CALENDAR_ID = "edenatlas-secondary@group.calendar.google.com";
const NOW = new Date("2026-08-25T12:00:00.000Z");
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  - ${name}`);
    console.log(`        ${err && err.stack ? err.stack : err}`);
  }
}

function canonicalEvent(overrides = {}) {
  return {
    id: CANONICAL_ID,
    schemaVersion: 1,
    ownerUid: UID,
    origin: "edenatlas",
    sourceEntityType: "expense",
    sourceEntityId: "private-expense-document-id",
    title: "Expense",
    summary: null,
    start: { type: "date", date: "2026-08-25", dateTime: null },
    end: { type: "date", date: "2026-08-26", dateTime: null },
    allDay: true,
    timeZone: null,
    status: "confirmed",
    deletedAt: null,
    deletionOrigin: null,
    sourceCreatedAt: "2026-08-25T10:00:00.000Z",
    sourceUpdatedAt: null,
    createdAt: "2026-08-25T10:00:00.000Z",
    updatedAt: "2026-08-25T10:00:00.000Z",
    version: 1,
    sync: { direction: "none", state: "local_only", lastSyncedAt: null },
    ...overrides,
  };
}

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function fakeDb(seed = {}) {
  const records = new Map();
  for (const [key, value] of Object.entries(seed)) records.set(key, clone(value));
  function ref(collectionName, id) {
    const key = `${collectionName}/${id}`;
    return {
      key,
      async get() { return snapshot(records.get(key)); },
      async set(value, options) {
        const next = options && options.merge ? { ...(records.get(key) || {}), ...clone(value) } : clone(value);
        records.set(key, next);
      },
    };
  }
  function snapshot(value) {
    return { exists: value !== undefined, data: () => clone(value) };
  }
  return {
    records,
    collection(name) { return { doc: (id) => ref(name, id) }; },
    async runTransaction(fn) {
      return fn({
        get: async (documentRef) => snapshot(records.get(documentRef.key)),
        set: (documentRef, value, options) => {
          const next = options && options.merge
            ? { ...(records.get(documentRef.key) || {}), ...clone(value) } : clone(value);
          records.set(documentRef.key, next);
        },
      });
    },
  };
}

function response(status, payload) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body,
  };
}

function writeConnection(overrides = {}) {
  return {
    uid: UID,
    ownerUid: UID,
    provider: "google_calendar",
    status: "connected",
    reconnectRequired: false,
    grantedScopes: [GOOGLE_CALENDAR_SCOPE, GOOGLE_CALENDAR_APP_CREATED_SCOPE],
    capabilityStatus: GOOGLE_CALENDAR_CAPABILITY_WRITE_AUTHORIZED,
    outboundCalendarPolicy: GOOGLE_CALENDAR_OUTBOUND_POLICY,
    outboundCalendarId: null,
    calendarProvisioningState: "not_created",
    encryptedRefreshToken: encryptRefreshToken({
      refreshToken: "server-refresh-token",
      uid: UID,
      masterKeyRaw: MASTER_KEY,
      randomBytesImpl: () => Buffer.alloc(12, 4),
    }),
    ...overrides,
  };
}

function post(body, overrides = {}) {
  return {
    httpMethod: "POST",
    headers: { origin: ORIGIN, authorization: "Bearer firebase-id-token", "content-type": "application/json" },
    body: JSON.stringify(body),
    ...overrides,
  };
}

function bodyOf(result) { return JSON.parse(result.body); }

function harness(options = {}) {
  const event = options.event || canonicalEvent();
  const connection = options.connection === undefined ? writeConnection() : options.connection;
  const db = fakeDb({
    ...(connection ? { [`google_calendar_connections/${UID}`]: connection } : {}),
    [`calendar_events/${event.id}`]: event,
  });
  const observed = { tokenCalls: 0, calendarCreates: 0, gets: 0, inserts: 0, writes: [], urls: [] };
  let providerPayload = options.existingProviderEvent || null;
  let firstGet404 = options.firstGet404 !== false;
  let insertTimedOut = options.insertTimedOut === true;
  const fetchImpl = async (url, request) => {
    if (url === GOOGLE_TOKEN_ENDPOINT) {
      observed.tokenCalls += 1;
      return response(200, {
        access_token: "transient-access-token",
        token_type: "Bearer",
        scope: options.tokenScope || `${GOOGLE_CALENDAR_SCOPE} ${GOOGLE_CALENDAR_APP_CREATED_SCOPE}`,
      });
    }
    observed.urls.push(url);
    if (url.endsWith("/calendar/v3/calendars")) {
      observed.calendarCreates += 1;
      observed.writes.push({ url, method: request.method, body: JSON.parse(request.body) });
      if (options.provisioningFailure) return response(500, {});
      return response(200, { id: options.createdCalendarId || CALENDAR_ID, summary: EDENATLAS_CALENDAR_NAME });
    }
    if (request.method === "GET") {
      observed.gets += 1;
      if (firstGet404) {
        firstGet404 = false;
        return response(404, {});
      }
      return providerPayload ? response(200, providerPayload) : response(404, {});
    }
    if (request.method === "POST") {
      observed.inserts += 1;
      providerPayload = JSON.parse(request.body);
      observed.writes.push({ url, method: request.method, body: providerPayload });
      if (insertTimedOut) {
        insertTimedOut = false;
        throw new Error("simulated timeout after provider commit");
      }
      return response(200, providerPayload);
    }
    throw new Error(`unexpected provider request: ${request.method} ${url}`);
  };
  const deps = {
    env: { ALLOWED_ORIGIN: ORIGIN },
    getOAuthConfig: () => ({ clientId: "client", clientSecret: "secret", masterKeyRaw: MASTER_KEY }),
    ensureFirebaseAdmin: async () => {},
    verifyIdToken: options.verifyIdToken || (async () => ({ uid: UID })),
    getDb: () => db,
    getCanonicalStore: () => ({
      readOwnedEvent: async ({ verifiedUid, canonicalEventId }) => {
        if (options.storeError) throw options.storeError;
        if (verifiedUid !== event.ownerUid || canonicalEventId !== event.id) {
          throw new CalendarEventStoreError("canonical_event_not_found", 404);
        }
        return clone(event);
      },
    }),
    getProviderIdentityKey: () => IDENTITY_KEY,
    checkBurst: () => ({ allowed: true }),
    now: () => new Date(NOW),
    fetchImpl,
  };
  return { handler: createHandler(deps), observed, db, event, getProviderPayload: () => providerPayload };
}

async function run() {
  console.log("\nGoogle Calendar manual write tests");

  await test("request accepts only an opaque canonical handle and rejects all browser provider/source/payload fields", () => {
    assert.strictEqual(parseManualCreateRequest(JSON.stringify({ canonicalEventHandle: CANONICAL_ID })).value.canonicalEventHandle, CANONICAL_ID);
    for (const field of ["ownerUid", "sourceEntityId", "sourceEntityType", "calendarId", "googleCalendarId",
      "googleEventId", "title", "description", "dates", "attendees", "urls", "recurrence", "meetData", "scope"]) {
      const parsed = parseManualCreateRequest(JSON.stringify({ canonicalEventHandle: CANONICAL_ID, [field]: "attacker" }));
      assert.strictEqual(parsed.error, "unknown_field", field);
    }
  });

  await test("deterministic provider identity is stable, partitioned, opaque, lowercase base32hex, and Google-valid", () => {
    const args = { serverIdentityKey: IDENTITY_KEY, ownerUid: UID, canonicalEventId: CANONICAL_ID, googleCalendarId: CALENDAR_ID };
    const id = deterministicGoogleEventId(args);
    assert.strictEqual(id, deterministicGoogleEventId(args));
    assert.match(id, /^[0-9a-v]{52}$/);
    assert.notStrictEqual(id, deterministicGoogleEventId({ ...args, canonicalEventId: `1${CANONICAL_ID.slice(1)}` }));
    assert.notStrictEqual(id, deterministicGoogleEventId({ ...args, googleCalendarId: `other-${CALENDAR_ID}` }));
    assert.ok(!id.includes(UID) && !id.includes("expense") && !id.includes(CANONICAL_ID));
  });

  await test("approved payload maps all-day and timed boundaries while excluding source-private data", () => {
    const eventId = deterministicGoogleEventId({
      serverIdentityKey: IDENTITY_KEY, ownerUid: UID, canonicalEventId: CANONICAL_ID, googleCalendarId: CALENDAR_ID,
    });
    const allDay = buildGoogleEventPayload(canonicalEvent({ summary: "Approved canonical summary" }), eventId);
    assert.deepStrictEqual(allDay.start, { date: "2026-08-25" });
    assert.deepStrictEqual(allDay.end, { date: "2026-08-26" });
    assert.strictEqual(allDay.description, "Approved canonical summary");
    assert.deepStrictEqual(allDay.extendedProperties.private, {
      edenAtlasVersion: "1", edenAtlasCanonicalId: CANONICAL_ID, edenAtlasSourceType: "expense",
    });
    const serialized = JSON.stringify(allDay);
    for (const privateValue of ["private-expense-document-id", "amount", "category", "note", "journal body",
      "journey description", "location", "visibility", UID, "attendees", "recurrence", "hangoutLink"]) {
      assert.ok(!serialized.includes(privateValue), privateValue);
    }
    const timed = buildGoogleEventPayload(canonicalEvent({
      allDay: false,
      timeZone: "Asia/Kuala_Lumpur",
      start: { type: "dateTime", date: null, dateTime: "2026-08-25T09:00:00+08:00" },
      end: { type: "dateTime", date: null, dateTime: "2026-08-25T10:00:00+08:00" },
    }), eventId);
    assert.deepStrictEqual(timed.start, { dateTime: "2026-08-25T09:00:00+08:00", timeZone: "Asia/Kuala_Lumpur" });
  });

  await test("Expense, Journal, and Journey adapters cannot carry their private source fields into Google", () => {
    const context = (sourceEntityId) => ({
      id: CANONICAL_ID, ownerUid: UID, sourceEntityId, projectedAt: "2026-08-25T12:00:00.000Z",
    });
    const sources = [
      [adaptExpenseToCalendarEvent, {
        uid: UID, amount: 987.65, category: "bills", note: "PRIVATE EXPENSE NOTE",
        date: "2026-08-25", createdAt: "2026-08-25T10:00:00.000Z",
      }, "expense-private-id", ["987.65", "bills", "PRIVATE EXPENSE NOTE", "expense-private-id"]],
      [adaptJournalToCalendarEvent, {
        uid: UID, entryDate: "2026-08-25", title: "PRIVATE JOURNAL TITLE",
        content: "PRIVATE JOURNAL BODY", mood: "PRIVATE MOOD", createdAt: "2026-08-25T10:00:00.000Z",
      }, "journal-private-id", ["PRIVATE JOURNAL TITLE", "PRIVATE JOURNAL BODY", "PRIVATE MOOD", "journal-private-id"]],
      [adaptJourneyToCalendarEvent, {
        uid: UID, date: "2026-08-25", title: "Safe journey title",
        description: "PRIVATE JOURNEY DESCRIPTION", locationName: "PRIVATE LOCATION", visibility: "private",
      }, "journey-private-id", ["PRIVATE JOURNEY DESCRIPTION", "PRIVATE LOCATION", "visibility", "journey-private-id"]],
    ];
    for (const [adapt, source, sourceId, forbidden] of sources) {
      const event = adapt(source, context(sourceId));
      const eventId = deterministicGoogleEventId({
        serverIdentityKey: IDENTITY_KEY, ownerUid: UID, canonicalEventId: CANONICAL_ID, googleCalendarId: CALENDAR_ID,
      });
      const serialized = JSON.stringify(buildGoogleEventPayload(event, eventId));
      for (const value of forbidden) assert.ok(!serialized.includes(value), value);
    }
  });

  await test("readonly, reconnect-required, cross-user, and tombstoned requests cannot reach Google", async () => {
    const readonly = harness({ connection: writeConnection({
      grantedScopes: [GOOGLE_CALENDAR_SCOPE], capabilityStatus: GOOGLE_CALENDAR_CAPABILITY_READONLY,
    }) });
    assert.strictEqual((await readonly.handler(post({ canonicalEventHandle: CANONICAL_ID }))).statusCode, 409);
    assert.strictEqual(readonly.observed.tokenCalls, 0);
    const reconnect = harness({ connection: writeConnection({ status: "reconnect_required", reconnectRequired: true }) });
    assert.strictEqual((await reconnect.handler(post({ canonicalEventHandle: CANONICAL_ID }))).statusCode, 409);
    assert.strictEqual(reconnect.observed.tokenCalls, 0);
    const crossUser = harness({ storeError: new CalendarEventStoreError("canonical_event_not_found", 404) });
    assert.strictEqual((await crossUser.handler(post({ canonicalEventHandle: CANONICAL_ID }))).statusCode, 404);
    assert.strictEqual(crossUser.observed.tokenCalls, 0);
    const tombstoned = harness({ event: canonicalEvent({
      deletedAt: "2026-08-25T11:00:00.000Z", deletionOrigin: "edenatlas", updatedAt: "2026-08-25T11:00:00.000Z", version: 2,
    }) });
    assert.strictEqual((await tombstoned.handler(post({ canonicalEventHandle: CANONICAL_ID }))).statusCode, 409);
    assert.strictEqual(tombstoned.observed.tokenCalls, 0);
  });

  await test("Firebase revocation and a down-scoped refreshed token fail before any Calendar API write", async () => {
    const revoked = harness({ verifyIdToken: async () => {
      const err = new Error("revoked");
      err.code = "auth/id-token-revoked";
      throw err;
    } });
    const revokedResult = await revoked.handler(post({ canonicalEventHandle: CANONICAL_ID }));
    assert.strictEqual(revokedResult.statusCode, 401);
    assert.strictEqual(revoked.observed.tokenCalls, 0);
    const downScoped = harness({ tokenScope: GOOGLE_CALENDAR_SCOPE });
    const downScopedResult = await downScoped.handler(post({ canonicalEventHandle: CANONICAL_ID }));
    assert.strictEqual(downScopedResult.statusCode, 401);
    assert.strictEqual(bodyOf(downScopedResult).connectionStatus, "reconnect_required");
    assert.strictEqual(downScoped.observed.calendarCreates, 0);
    assert.strictEqual(downScoped.observed.inserts, 0);
  });

  await test("legacy Phase 3B.6 ownership is migrated before the first provider call", async () => {
    const h = harness({ connection: writeConnection({ ownerUid: undefined }) });
    const result = await h.handler(post({ canonicalEventHandle: CANONICAL_ID }));
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(h.db.records.get(`google_calendar_connections/${UID}`).ownerUid, UID);
  });

  await test("first create provisions one named secondary calendar and inserts exactly one event", async () => {
    const h = harness();
    const result = await h.handler(post({ canonicalEventHandle: CANONICAL_ID }));
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(bodyOf(result).createState, "created");
    assert.strictEqual(h.observed.calendarCreates, 1);
    assert.strictEqual(h.observed.inserts, 1);
    assert.deepStrictEqual(h.observed.writes[0].body, { summary: EDENATLAS_CALENDAR_NAME });
    assert.ok(h.observed.urls.every((url) => url.startsWith("https://www.googleapis.com/calendar/v3/")));
    assert.ok(h.observed.urls.every((url) => !url.includes("/calendars/primary/")));
    const connection = h.db.records.get(`google_calendar_connections/${UID}`);
    assert.strictEqual(connection.outboundCalendarId, CALENDAR_ID);
    assert.strictEqual(connection.calendarProvisioningState, "created");
    const mapping = [...h.db.records.entries()].find(([key]) => key.startsWith(`${SYNC_COLLECTION}/`))[1];
    assert.strictEqual(mapping.state, "synced");
    assert.strictEqual(mapping.provider, "google");
    assert.strictEqual(mapping.providerOrigin, "edenatlas_created");
    assert.strictEqual(mapping.ownerUid, UID);
    assert.strictEqual(mapping.lastSyncedCanonicalVersion, 1);
    assert.match(mapping.payloadHash, /^sha256:[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(bodyOf(result)).includes(CALENDAR_ID));
  });

  await test("persisted EdenAtlas calendar and matching event are reused on retry without duplicate", async () => {
    const h = harness();
    let result = await h.handler(post({ canonicalEventHandle: CANONICAL_ID }));
    assert.strictEqual(result.statusCode, 200);
    const firstPayload = h.getProviderPayload();
    h.observed.calendarCreates = 0;
    h.observed.inserts = 0;
    h.observed.gets = 0;
    const retryHarness = harness({
      connection: h.db.records.get(`google_calendar_connections/${UID}`),
      existingProviderEvent: firstPayload,
      firstGet404: false,
    });
    for (const [key, value] of h.db.records) retryHarness.db.records.set(key, clone(value));
    result = await retryHarness.handler(post({ canonicalEventHandle: CANONICAL_ID }));
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(bodyOf(result).createState, "already_created");
    assert.strictEqual(retryHarness.observed.calendarCreates, 0);
    assert.strictEqual(retryHarness.observed.gets, 1);
    assert.strictEqual(retryHarness.observed.inserts, 0);
  });

  await test("insert timeout reconciles by deterministic get and never creates a second event", async () => {
    const h = harness({ insertTimedOut: true });
    const result = await h.handler(post({ canonicalEventHandle: CANONICAL_ID }));
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(bodyOf(result).createState, "already_created");
    assert.strictEqual(h.observed.inserts, 1);
    assert.strictEqual(h.observed.gets, 2);
  });

  await test("matching ID with marker mismatch fails closed and is never overwritten", async () => {
    const expectedId = deterministicGoogleEventId({
      serverIdentityKey: IDENTITY_KEY, ownerUid: UID, canonicalEventId: CANONICAL_ID, googleCalendarId: CALENDAR_ID,
    });
    const wrong = buildGoogleEventPayload(canonicalEvent(), expectedId);
    wrong.extendedProperties.private.edenAtlasCanonicalId = `1${CANONICAL_ID.slice(1)}`;
    const h = harness({
      connection: writeConnection({ outboundCalendarId: CALENDAR_ID, calendarProvisioningState: "created" }),
      existingProviderEvent: wrong,
      firstGet404: false,
    });
    const result = await h.handler(post({ canonicalEventHandle: CANONICAL_ID }));
    assert.strictEqual(result.statusCode, 409);
    assert.strictEqual(bodyOf(result).error, "provider_identity_conflict");
    assert.strictEqual(h.observed.inserts, 0);
  });

  await test("primary and arbitrary stored calendars fail closed before event writes", async () => {
    const primary = harness({ connection: writeConnection({ outboundCalendarId: "primary", calendarProvisioningState: "created" }) });
    assert.strictEqual((await primary.handler(post({ canonicalEventHandle: CANONICAL_ID }))).statusCode, 409);
    assert.strictEqual(primary.observed.inserts, 0);
    const invalid = harness({ connection: writeConnection({ outboundCalendarId: "browser-picked@example.com", calendarProvisioningState: "not_created" }) });
    assert.strictEqual((await invalid.handler(post({ canonicalEventHandle: CANONICAL_ID }))).statusCode, 409);
    assert.strictEqual(invalid.observed.inserts, 0);
  });

  await test("provisioning failure is safe and does not fall back to Primary or insert an event", async () => {
    const h = harness({ provisioningFailure: true });
    const result = await h.handler(post({ canonicalEventHandle: CANONICAL_ID }));
    assert.strictEqual(result.statusCode, 503);
    assert.strictEqual(h.observed.calendarCreates, 1);
    assert.strictEqual(h.observed.inserts, 0);
    assert.strictEqual(h.db.records.get(`google_calendar_connections/${UID}`).calendarProvisioningState, "failed");
    assert.ok(h.observed.urls.every((url) => !url.includes("primary")));
  });

  await test("mapping lease rejects concurrent create and version check refuses a stale success", async () => {
    const db = fakeDb({ [`calendar_events/${CANONICAL_ID}`]: canonicalEvent() });
    const event = canonicalEvent();
    const googleEventId = deterministicGoogleEventId({
      serverIdentityKey: IDENTITY_KEY, ownerUid: UID, canonicalEventId: CANONICAL_ID, googleCalendarId: CALENDAR_ID,
    });
    const first = await acquireMapping({
      db, verifiedUid: UID, canonicalEvent: event, googleCalendarId: CALENDAR_ID,
      googleEventId, now: NOW, leaseId: "lease-one",
    });
    const second = await acquireMapping({
      db, verifiedUid: UID, canonicalEvent: event, googleCalendarId: CALENDAR_ID,
      googleEventId, now: NOW, leaseId: "lease-two",
    });
    assert.strictEqual(first.acquired, true);
    assert.strictEqual(second.acquired, false);
    db.records.set(`calendar_events/${CANONICAL_ID}`, canonicalEvent({ version: 2, updatedAt: "2026-08-25T12:00:00.000Z" }));
    const completed = await completeMapping({
      db, ref: first.ref, verifiedUid: UID, canonicalEvent: event,
      payloadHash: providerPayloadHash(buildGoogleEventPayload(event, googleEventId)), now: NOW, leaseId: "lease-one",
    });
    assert.strictEqual(completed, false);
    const mapping = db.records.get(`${SYNC_COLLECTION}/${googleEventId}`);
    assert.strictEqual(mapping.state, "failed");
    assert.strictEqual(mapping.lastErrorCode, "canonical_version_changed");
    assert.strictEqual(mapping.payloadHash, null);
    assert.strictEqual(mapping.lastSyncedCanonicalVersion, null);
  });

  await test("no update/delete/calendar-primary operation exists in the manual write transport", () => {
    const source = require("node:fs").readFileSync(require("node:path").resolve(__dirname, "../lib/google-calendar-write.js"), "utf8");
    assert.ok(!/method:\s*["'](?:PATCH|PUT|DELETE)["']/.test(source));
    assert.ok(!source.includes("calendars/primary/events"));
    assert.ok(!source.includes("syncToken"));
    assert.ok(!source.includes("setInterval"));
    assert.strictEqual(markerMatches({ extendedProperties: { private: {
      edenAtlasVersion: "1", edenAtlasCanonicalId: CANONICAL_ID, edenAtlasSourceType: "expense",
    } } }, CANONICAL_ID, "expense"), true);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

run().catch((err) => {
  console.error("[google-calendar-write.test.js] unexpected failure:", err);
  process.exitCode = 1;
});
