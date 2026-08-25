const assert = require("node:assert");
const {
  GOOGLE_CALENDAR_SCOPE,
  GOOGLE_CALENDAR_APP_CREATED_SCOPE,
  GOOGLE_CALENDAR_READ_INTENT,
  GOOGLE_CALENDAR_WRITE_INTENT,
  GOOGLE_CALENDAR_CAPABILITY_READONLY,
  GOOGLE_CALENDAR_CAPABILITY_WRITE_CONSENT_REQUIRED,
  GOOGLE_CALENDAR_CAPABILITY_WRITE_AUTHORIZED,
  GOOGLE_CALENDAR_OUTBOUND_POLICY,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_CALENDAR_CONNECTIONS_COLLECTION,
  GOOGLE_CALENDAR_OAUTH_STATES_COLLECTION,
  createOAuthState,
  encryptRefreshToken,
} = require("../lib/google-calendar-oauth");
const { createHandler: createStartHandler } = require("../google-calendar-oauth-start");
const {
  createHandler: createCallbackHandler,
  retainedOutboundState,
} = require("../google-calendar-oauth-callback");
const { createHandler: createStatusHandler } = require("../google-calendar-status");
const { resolveCalendarEnvironment, readOAuthConfig } = require("../lib/google-calendar-runtime");

const ORIGIN = "https://staging--edenatlas.netlify.app";
const REDIRECT_URI = `${ORIGIN}/.netlify/functions/google-calendar-oauth-callback`;
const MASTER_KEY = Buffer.alloc(32, 5).toString("base64");
const VERIFIED_UID = "verified-calendar-user";
const NOW = new Date("2026-08-21T10:00:00.000Z");
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  - ${name}`);
    console.log(`        ${err && err.stack ? err.stack : err}`);
  }
}

function config() {
  return {
    clientId: "calendar-client-id",
    clientSecret: "calendar-client-secret",
    redirectUri: REDIRECT_URI,
    masterKeyRaw: MASTER_KEY,
    environment: "staging",
  };
}

function postEvent(overrides = {}) {
  return {
    httpMethod: "POST",
    headers: { origin: ORIGIN, authorization: "Bearer valid-firebase-token", "content-type": "application/json" },
    body: "{}",
    ...overrides,
  };
}

function bodyOf(response) {
  return JSON.parse(response.body);
}

function baseDeps(overrides = {}) {
  return {
    env: { ALLOWED_ORIGIN: ORIGIN },
    getOAuthConfig: config,
    ensureFirebaseAdmin: async () => {},
    verifyIdToken: async () => ({ uid: VERIFIED_UID }),
    getDb: () => { throw new Error("unexpected db use"); },
    checkBurst: () => ({ allowed: true }),
    now: () => new Date(NOW),
    randomBytesImpl: undefined,
    fetchImpl: undefined,
    ...overrides,
  };
}

function readonlyConnection(overrides = {}) {
  return {
    uid: VERIFIED_UID,
    provider: "google_calendar",
    status: "connected",
    grantedScopes: [GOOGLE_CALENDAR_SCOPE],
    capabilityStatus: GOOGLE_CALENDAR_CAPABILITY_READONLY,
    encryptedRefreshToken: encryptRefreshToken({
      refreshToken: "existing-readonly-refresh-token",
      uid: VERIFIED_UID,
      masterKeyRaw: MASTER_KEY,
      randomBytesImpl: () => Buffer.alloc(12, 3),
    }),
    connectedAt: NOW,
    updatedAt: NOW,
    reconnectRequired: false,
    ...overrides,
  };
}

async function run() {
  await test("OAuth reconnect preserves only a validated server-owned secondary calendar state", () => {
    const calendarId = "edenatlas-secondary@group.calendar.google.com";
    assert.deepStrictEqual(retainedOutboundState({
      outboundCalendarPolicy: GOOGLE_CALENDAR_OUTBOUND_POLICY,
      outboundCalendarId: calendarId,
      calendarProvisioningState: "reconnect_required",
    }), { outboundCalendarId: calendarId, calendarProvisioningState: "created" });
    assert.deepStrictEqual(retainedOutboundState({
      outboundCalendarPolicy: GOOGLE_CALENDAR_OUTBOUND_POLICY,
      outboundCalendarId: null,
      calendarProvisioningState: "provisioning",
    }), { outboundCalendarId: null, calendarProvisioningState: "failed" });
    for (const invalid of [
      { outboundCalendarPolicy: GOOGLE_CALENDAR_OUTBOUND_POLICY, outboundCalendarId: "primary", calendarProvisioningState: "created" },
      { outboundCalendarPolicy: "browser_selected", outboundCalendarId: calendarId, calendarProvisioningState: "created" },
      null,
    ]) {
      assert.deepStrictEqual(retainedOutboundState(invalid), {
        outboundCalendarId: null, calendarProvisioningState: "not_created",
      });
    }
  });
  await test("Calendar OAuth enables only Production, stable Staging, and local development contexts", () => {
    assert.strictEqual(resolveCalendarEnvironment({ context: "production", branch: "main" }), "production");
    assert.strictEqual(resolveCalendarEnvironment({ context: "branch-deploy", branch: "staging" }), "staging");
    assert.strictEqual(resolveCalendarEnvironment({ context: "dev", branch: null }), "development");
    assert.strictEqual(resolveCalendarEnvironment({ context: "deploy-preview", branch: "feature" }), null);
    assert.strictEqual(resolveCalendarEnvironment({ context: "branch-deploy", branch: "feature" }), null);
  });

  await test("OAuth configuration binds the callback to an allowed exact deployment origin", () => {
    const env = {
      ALLOWED_ORIGIN: ORIGIN,
      DEPLOY_PRIME_URL: ORIGIN,
      GOOGLE_CALENDAR_CLIENT_ID: "client",
      GOOGLE_CALENDAR_CLIENT_SECRET: "secret",
      GOOGLE_CALENDAR_REDIRECT_URI: REDIRECT_URI,
      GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY: MASTER_KEY,
    };
    assert.strictEqual(readOAuthConfig(env, "staging").redirectUri, REDIRECT_URI);
    assert.throws(() => readOAuthConfig({
      ...env,
      GOOGLE_CALENDAR_REDIRECT_URI: "https://attacker.example/.netlify/functions/google-calendar-oauth-callback",
    }, "staging"));
    assert.throws(() => readOAuthConfig({
      ...env,
      GOOGLE_CALENDAR_REDIRECT_URI: `${ORIGIN}/wrong-callback`,
    }, "staging"));
  });

  await test("OAuth start rejects unsupported methods and invalid origins", async () => {
    const handler = createStartHandler(baseDeps());
    assert.strictEqual((await handler(postEvent({ httpMethod: "GET" }))).statusCode, 405);
    assert.strictEqual((await handler(postEvent({ headers: { origin: "https://attacker.example" } }))).statusCode, 403);
  });

  await test("OAuth start rejects missing and invalid Firebase authentication", async () => {
    let handler = createStartHandler(baseDeps());
    assert.strictEqual((await handler(postEvent({ headers: { origin: ORIGIN } }))).statusCode, 401);
    handler = createStartHandler(baseDeps({ verifyIdToken: async () => { throw new Error("invalid"); } }));
    assert.strictEqual((await handler(postEvent())).statusCode, 401);
  });

  await test("client uid override is rejected before any state write", async () => {
    let writes = 0;
    const handler = createStartHandler(baseDeps({
      getDb: () => ({ collection: () => ({ doc: () => ({ set: async () => { writes++; } }) }) }),
    }));
    const response = await handler(postEvent({ body: JSON.stringify({ uid: "attacker" }) }));
    assert.strictEqual(response.statusCode, 400);
    assert.strictEqual(bodyOf(response).error, "unknown_field");
    assert.strictEqual(writes, 0);
  });

  await test("OAuth start persists hashed state for verified uid and returns only a consent URL", async () => {
    const observed = {};
    const handler = createStartHandler(baseDeps({
      randomBytesImpl: () => Buffer.alloc(32, 4),
      getDb: () => ({
        collection: (name) => {
          observed.collection = name;
          return { doc: (id) => ({ set: async (record) => { observed.id = id; observed.record = record; } }) };
        },
      }),
    }));
    const response = await handler(postEvent());
    const payload = bodyOf(response);
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(observed.collection, GOOGLE_CALENDAR_OAUTH_STATES_COLLECTION);
    assert.strictEqual(observed.record.uid, VERIFIED_UID);
    assert.ok(!Object.prototype.hasOwnProperty.call(observed.record, "state"));
    const authUrl = new URL(payload.authorizationUrl);
    assert.strictEqual(authUrl.searchParams.get("scope"), GOOGLE_CALENDAR_SCOPE);
    assert.deepStrictEqual(Object.keys(payload).sort(), ["authorizationUrl", "expiresAt", "ok"]);
    assert.ok(!response.body.includes("calendar-client-secret"));
    assert.ok(!response.body.includes(MASTER_KEY));
  });

  await test("write capability requires the explicit enable_sync action for an owned read-only connection", async () => {
    const observed = { docUids: [], connectionWrites: [], stateRecords: [], fetchCalls: 0 };
    const connection = readonlyConnection();
    const connectionRef = { kind: "connection" };
    const stateRef = { kind: "state" };
    const db = {
      collection: (name) => {
        if (name === GOOGLE_CALENDAR_CONNECTIONS_COLLECTION) {
          return { doc: (uid) => { observed.docUids.push(uid); return connectionRef; } };
        }
        assert.strictEqual(name, GOOGLE_CALENDAR_OAUTH_STATES_COLLECTION);
        return { doc: () => stateRef };
      },
      runTransaction: async (callback) => callback({
        get: async (ref) => {
          assert.strictEqual(ref, connectionRef);
          return { exists: true, data: () => connection };
        },
        set: (ref, value, options) => {
          if (ref === stateRef) observed.stateRecords.push(value);
          else {
            assert.strictEqual(ref, connectionRef);
            observed.connectionWrites.push({ value, options });
            Object.assign(connection, value);
          }
        },
      }),
    };
    const handler = createStartHandler(baseDeps({
      randomBytesImpl: () => Buffer.alloc(32, 11),
      fetchImpl: async () => { observed.fetchCalls++; throw new Error("must not call provider"); },
      getDb: () => db,
    }));

    const response = await handler(postEvent({ body: JSON.stringify({ action: "enable_sync" }) }));
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(observed.docUids, [VERIFIED_UID]);
    assert.strictEqual(observed.stateRecords[0].authorizationIntent, GOOGLE_CALENDAR_WRITE_INTENT);
    assert.strictEqual(observed.connectionWrites[0].value.capabilityStatus, GOOGLE_CALENDAR_CAPABILITY_WRITE_CONSENT_REQUIRED);
    assert.deepStrictEqual(new URL(bodyOf(response).authorizationUrl).searchParams.get("scope").split(" "), [
      GOOGLE_CALENDAR_SCOPE,
      GOOGLE_CALENDAR_APP_CREATED_SCOPE,
    ]);
    assert.strictEqual(observed.fetchCalls, 0);
  });

  await test("browser scope input and unauthorized write upgrades are rejected", async () => {
    let stateWrites = 0;
    let selectedUid = null;
    const connectionRef = { kind: "connection" };
    const handler = createStartHandler(baseDeps({
      getDb: () => ({
        collection: (name) => ({
          doc: (uid) => {
            if (name === GOOGLE_CALENDAR_CONNECTIONS_COLLECTION) {
              selectedUid = uid;
              return connectionRef;
            }
            return { kind: "state" };
          },
        }),
        runTransaction: async (callback) => callback({
          get: async (ref) => { assert.strictEqual(ref, connectionRef); return { exists: false }; },
          set: () => { stateWrites++; },
        }),
      }),
    }));
    const arbitraryScope = await handler(postEvent({
      body: JSON.stringify({ action: "enable_sync", scope: "https://www.googleapis.com/auth/calendar" }),
    }));
    assert.strictEqual(arbitraryScope.statusCode, 400);
    assert.strictEqual(bodyOf(arbitraryScope).error, "unknown_field");
    const disconnectedUpgrade = await handler(postEvent({ body: JSON.stringify({ action: "enable_sync" }) }));
    assert.strictEqual(disconnectedUpgrade.statusCode, 409);
    assert.strictEqual(bodyOf(disconnectedUpgrade).error, "google_calendar_reconnect_required");
    assert.strictEqual(selectedUid, VERIFIED_UID);
    assert.strictEqual(stateWrites, 0);
  });

  await test("callback rejects unsupported method and an exact redirect URI mismatch", async () => {
    const handler = createCallbackHandler(baseDeps());
    assert.strictEqual((await handler({ httpMethod: "POST" })).statusCode, 405);
    const mismatch = await handler({
      httpMethod: "GET",
      rawUrl: `${ORIGIN}/.netlify/functions/wrong-callback?state=x`,
      queryStringParameters: {},
    });
    assert.strictEqual(mismatch.statusCode, 400);
    assert.strictEqual(bodyOf(mismatch).error, "redirect_uri_mismatch");
  });

  await test("callback consumes state once and stores only encrypted refresh credentials", async () => {
    const state = createOAuthState({
      uid: VERIFIED_UID,
      environment: "staging",
      redirectUri: REDIRECT_URI,
      authorizationIntent: GOOGLE_CALENDAR_READ_INTENT,
      masterKeyRaw: MASTER_KEY,
      now: NOW,
      randomBytesImpl: () => Buffer.alloc(32, 6),
    });
    const stateRecord = { ...state.record };
    const observed = { tokenCalls: 0, connectionWrites: [] };
    const db = {
      collection(name) {
        if (name === GOOGLE_CALENDAR_OAUTH_STATES_COLLECTION) {
          return { doc: () => ({ stateRef: true }) };
        }
        assert.strictEqual(name, GOOGLE_CALENDAR_CONNECTIONS_COLLECTION);
        return { doc: (uid) => ({
          get: async () => ({ exists: false, data: () => undefined }),
          set: async (record) => observed.connectionWrites.push({ uid, record }),
        }) };
      },
      async runTransaction(callback) {
        return callback({
          get: async () => ({ exists: true, data: () => stateRecord }),
          update: (_ref, update) => Object.assign(stateRecord, update),
        });
      },
    };
    const handler = createCallbackHandler(baseDeps({
      getDb: () => db,
      randomBytesImpl: () => Buffer.alloc(12, 8),
      fetchImpl: async (_url, options) => {
        observed.tokenCalls++;
        assert.strictEqual(new URLSearchParams(options.body).get("code"), "one-time-auth-code");
        return {
          ok: true,
          json: async () => ({
            access_token: "transient-access-token",
            refresh_token: "plaintext-refresh-token",
            scope: GOOGLE_CALENDAR_SCOPE,
          }),
        };
      },
    }));
    const event = {
      httpMethod: "GET",
      rawUrl: `${REDIRECT_URI}?code=one-time-auth-code&state=${state.state}`,
      queryStringParameters: { code: "one-time-auth-code", state: state.state },
    };
    const first = await handler(event);
    assert.strictEqual(first.statusCode, 303);
    assert.strictEqual(new URL(first.headers.Location).searchParams.get("googleCalendar"), "connected");
    assert.strictEqual(observed.connectionWrites.length, 1);
    assert.strictEqual(observed.connectionWrites[0].uid, VERIFIED_UID);
    const persisted = JSON.stringify(observed.connectionWrites[0].record);
    assert.ok(!persisted.includes("plaintext-refresh-token"));
    assert.ok(!persisted.includes("transient-access-token"));
    assert.ok(!first.body.includes("one-time-auth-code"));
    assert.ok(!first.body.includes("token"));

    const replay = await handler(event);
    assert.strictEqual(replay.statusCode, 303);
    assert.strictEqual(new URL(replay.headers.Location).searchParams.get("googleCalendar"), "state_rejected");
    assert.strictEqual(observed.tokenCalls, 1);
    assert.strictEqual(observed.connectionWrites.length, 1);
  });

  await test("successful explicit re-consent records write authorization without a Calendar API call", async () => {
    const state = createOAuthState({
      uid: VERIFIED_UID,
      environment: "staging",
      redirectUri: REDIRECT_URI,
      authorizationIntent: GOOGLE_CALENDAR_WRITE_INTENT,
      masterKeyRaw: MASTER_KEY,
      now: NOW,
      randomBytesImpl: () => Buffer.alloc(32, 12),
    });
    const stateRecord = { ...state.record };
    const existing = readonlyConnection({ capabilityStatus: GOOGLE_CALENDAR_CAPABILITY_WRITE_CONSENT_REQUIRED });
    const observed = { providerCalls: [], connectionWrites: [] };
    const connectionRef = {
      get: async () => ({ exists: true, data: () => existing }),
      set: async (record) => observed.connectionWrites.push(record),
    };
    const db = {
      collection(name) {
        if (name === GOOGLE_CALENDAR_OAUTH_STATES_COLLECTION) return { doc: () => ({ stateRef: true }) };
        assert.strictEqual(name, GOOGLE_CALENDAR_CONNECTIONS_COLLECTION);
        return { doc: (uid) => { assert.strictEqual(uid, VERIFIED_UID); return connectionRef; } };
      },
      async runTransaction(callback) {
        return callback({
          get: async () => ({ exists: true, data: () => stateRecord }),
          update: (_ref, update) => Object.assign(stateRecord, update),
        });
      },
    };
    const handler = createCallbackHandler(baseDeps({
      getDb: () => db,
      randomBytesImpl: () => Buffer.alloc(12, 13),
      fetchImpl: async (url) => {
        observed.providerCalls.push(url);
        assert.strictEqual(url, GOOGLE_TOKEN_ENDPOINT);
        return {
          ok: true,
          json: async () => ({
            access_token: "transient-write-access-token",
            refresh_token: "new-write-refresh-token",
            scope: `${GOOGLE_CALENDAR_SCOPE} ${GOOGLE_CALENDAR_APP_CREATED_SCOPE}`,
          }),
        };
      },
    }));
    const response = await handler({
      httpMethod: "GET",
      rawUrl: `${REDIRECT_URI}?code=write-code&state=${state.state}`,
      queryStringParameters: { code: "write-code", state: state.state },
    });
    assert.strictEqual(new URL(response.headers.Location).searchParams.get("googleCalendar"), "sync_permission_enabled");
    assert.deepStrictEqual(observed.providerCalls, [GOOGLE_TOKEN_ENDPOINT]);
    assert.strictEqual(observed.connectionWrites.length, 1);
    const persisted = observed.connectionWrites[0];
    assert.strictEqual(persisted.capabilityStatus, GOOGLE_CALENDAR_CAPABILITY_WRITE_AUTHORIZED);
    assert.strictEqual(persisted.outboundCalendarPolicy, GOOGLE_CALENDAR_OUTBOUND_POLICY);
    assert.strictEqual(persisted.outboundCalendarId, null);
    assert.deepStrictEqual(persisted.grantedScopes, [GOOGLE_CALENDAR_APP_CREATED_SCOPE, GOOGLE_CALENDAR_SCOPE].sort());
    assert.ok(!JSON.stringify(persisted).includes("new-write-refresh-token"));
    assert.ok(observed.providerCalls.every((url) => !String(url).includes("/calendar/v3/")));
  });

  await test("declining write re-consent leaves the read-only token and capability intact", async () => {
    const state = createOAuthState({
      uid: VERIFIED_UID,
      environment: "staging",
      redirectUri: REDIRECT_URI,
      authorizationIntent: GOOGLE_CALENDAR_WRITE_INTENT,
      masterKeyRaw: MASTER_KEY,
      now: NOW,
      randomBytesImpl: () => Buffer.alloc(32, 14),
    });
    const stateRecord = { ...state.record };
    const connection = readonlyConnection({ capabilityStatus: GOOGLE_CALENDAR_CAPABILITY_WRITE_CONSENT_REQUIRED });
    const before = JSON.stringify(connection);
    let tokenCalls = 0;
    let connectionWrites = 0;
    const db = {
      collection: (name) => name === GOOGLE_CALENDAR_OAUTH_STATES_COLLECTION
        ? { doc: () => ({ stateRef: true }) }
        : { doc: () => ({ set: async () => { connectionWrites++; } }) },
      runTransaction: async (callback) => callback({
        get: async () => ({ exists: true, data: () => stateRecord }),
        update: (_ref, update) => Object.assign(stateRecord, update),
      }),
    };
    const handler = createCallbackHandler(baseDeps({
      getDb: () => db,
      fetchImpl: async () => { tokenCalls++; throw new Error("must not exchange"); },
    }));
    const response = await handler({
      httpMethod: "GET",
      rawUrl: `${REDIRECT_URI}?error=access_denied&state=${state.state}`,
      queryStringParameters: { error: "access_denied", state: state.state },
    });
    assert.strictEqual(new URL(response.headers.Location).searchParams.get("googleCalendar"), "sync_permission_declined");
    assert.strictEqual(tokenCalls, 0);
    assert.strictEqual(connectionWrites, 0);
    assert.strictEqual(JSON.stringify(connection), before);
    assert.deepStrictEqual(connection.grantedScopes, [GOOGLE_CALENDAR_SCOPE]);
  });

  await test("callback rejects a client-supplied uid even when state is otherwise valid", async () => {
    const state = createOAuthState({
      uid: VERIFIED_UID,
      environment: "staging",
      redirectUri: REDIRECT_URI,
      authorizationIntent: GOOGLE_CALENDAR_READ_INTENT,
      masterKeyRaw: MASTER_KEY,
      now: NOW,
      randomBytesImpl: () => Buffer.alloc(32, 7),
    });
    const record = { ...state.record };
    let tokenCalls = 0;
    const db = {
      collection: () => ({ doc: () => ({}) }),
      runTransaction: async (callback) => callback({
        get: async () => ({ exists: true, data: () => record }),
        update: (_ref, update) => Object.assign(record, update),
      }),
    };
    const handler = createCallbackHandler(baseDeps({
      getDb: () => db,
      fetchImpl: async () => { tokenCalls++; throw new Error("must not exchange"); },
    }));
    const response = await handler({
      httpMethod: "GET",
      rawUrl: `${REDIRECT_URI}?code=code&state=${state.state}&uid=attacker`,
      queryStringParameters: { code: "code", state: state.state, uid: "attacker" },
    });
    assert.strictEqual(response.statusCode, 303);
    assert.strictEqual(new URL(response.headers.Location).searchParams.get("googleCalendar"), "state_rejected");
    assert.strictEqual(tokenCalls, 0);
  });

  await test("status uses verified uid, rejects body uid, and never returns encrypted credentials", async () => {
    const encryptedRefreshToken = encryptRefreshToken({
      refreshToken: "status-test-refresh-token",
      uid: VERIFIED_UID,
      masterKeyRaw: MASTER_KEY,
      randomBytesImpl: () => Buffer.alloc(12, 2),
    });
    const observed = {};
    const handler = createStatusHandler(baseDeps({
      getDb: () => ({
        collection: (name) => {
          observed.collection = name;
          return { doc: (uid) => {
            observed.uid = uid;
            return { get: async () => ({
              exists: true,
              data: () => ({
                status: "connected",
                grantedScopes: [GOOGLE_CALENDAR_SCOPE],
                encryptedRefreshToken,
                connectedAt: NOW,
                updatedAt: NOW,
              }),
            }) };
          } };
        },
      }),
    }));
    const override = await handler(postEvent({ body: JSON.stringify({ uid: "attacker" }) }));
    assert.strictEqual(override.statusCode, 400);
    const response = await handler(postEvent());
    const body = bodyOf(response);
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(observed.collection, GOOGLE_CALENDAR_CONNECTIONS_COLLECTION);
    assert.strictEqual(observed.uid, VERIFIED_UID);
    assert.strictEqual(body.connectionStatus, "connected");
    assert.strictEqual(body.capabilityStatus, GOOGLE_CALENDAR_CAPABILITY_READONLY);
    assert.strictEqual(body.calendarProvisioningState, "not_created");
    assert.ok(!Object.prototype.hasOwnProperty.call(body, "status"));
    assert.ok(!Object.prototype.hasOwnProperty.call(body, "grantedScopes"));
    assert.ok(!response.body.includes(encryptedRefreshToken.ciphertext));
    assert.ok(!response.body.includes("encryptedRefreshToken"));
  });

  await test("write-consent-required and reconnect status are deterministic and sanitized", async () => {
    const connection = readonlyConnection({ capabilityStatus: GOOGLE_CALENDAR_CAPABILITY_WRITE_CONSENT_REQUIRED });
    const createStatus = (record) => createStatusHandler(baseDeps({
      getDb: () => ({
        collection: () => ({
          doc: (uid) => {
            assert.strictEqual(uid, VERIFIED_UID);
            return { get: async () => ({ exists: true, data: () => record }) };
          },
        }),
      }),
    }));
    const first = bodyOf(await createStatus(connection)(postEvent()));
    const second = bodyOf(await createStatus(connection)(postEvent()));
    assert.strictEqual(first.connectionStatus, "connected");
    assert.strictEqual(first.capabilityStatus, GOOGLE_CALENDAR_CAPABILITY_WRITE_CONSENT_REQUIRED);
    assert.deepStrictEqual(first, second);

    const invalid = readonlyConnection({ reconnectRequired: true, lastErrorCode: "provider-secret-detail" });
    const reconnect = bodyOf(await createStatus(invalid)(postEvent()));
    assert.strictEqual(reconnect.connectionStatus, "reconnect_required");
    assert.strictEqual(reconnect.capabilityStatus, null);
    assert.ok(!JSON.stringify(reconnect).includes("provider-secret-detail"));
    assert.ok(!Object.prototype.hasOwnProperty.call(reconnect, "grantedScopes"));
  });

  await test("calendar provisioning status exposes only sanitized state, never the persisted destination", async () => {
    const encryptedRefreshToken = encryptRefreshToken({
      refreshToken: "status-write-refresh-token",
      uid: VERIFIED_UID,
      masterKeyRaw: MASTER_KEY,
      randomBytesImpl: () => Buffer.alloc(12, 8),
    });
    const calendarId = "private-secondary-id@group.calendar.google.com";
    const connection = {
      ...readonlyConnection(),
      ownerUid: VERIFIED_UID,
      grantedScopes: [GOOGLE_CALENDAR_SCOPE, GOOGLE_CALENDAR_APP_CREATED_SCOPE],
      capabilityStatus: GOOGLE_CALENDAR_CAPABILITY_WRITE_AUTHORIZED,
      outboundCalendarPolicy: GOOGLE_CALENDAR_OUTBOUND_POLICY,
      outboundCalendarId: calendarId,
      calendarProvisioningState: "created",
      encryptedRefreshToken,
    };
    const handler = createStatusHandler(baseDeps({
      getDb: () => ({ collection: () => ({ doc: () => ({
        get: async () => ({ exists: true, data: () => connection }),
      }) }) }),
    }));
    const response = await handler(postEvent());
    const body = bodyOf(response);
    assert.strictEqual(body.calendarProvisioningState, "created");
    assert.ok(!response.body.includes(calendarId));
    assert.ok(!response.body.includes(encryptedRefreshToken.ciphertext));
    assert.deepStrictEqual(Object.keys(body).sort(), [
      "calendarProvisioningState", "capabilityStatus", "connectedAt", "connectionStatus", "ok", "updatedAt",
    ]);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

run().catch((err) => {
  console.error("[google-calendar-functions.test.js] unexpected failure:", err);
  process.exitCode = 1;
});
