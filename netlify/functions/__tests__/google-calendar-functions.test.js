const assert = require("node:assert");
const {
  GOOGLE_CALENDAR_SCOPE,
  GOOGLE_CALENDAR_CONNECTIONS_COLLECTION,
  GOOGLE_CALENDAR_OAUTH_STATES_COLLECTION,
  createOAuthState,
  encryptRefreshToken,
} = require("../lib/google-calendar-oauth");
const { createHandler: createStartHandler } = require("../google-calendar-oauth-start");
const { createHandler: createCallbackHandler } = require("../google-calendar-oauth-callback");
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

async function run() {
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
        return { doc: (uid) => ({ set: async (record) => observed.connectionWrites.push({ uid, record }) }) };
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

  await test("callback rejects a client-supplied uid even when state is otherwise valid", async () => {
    const state = createOAuthState({
      uid: VERIFIED_UID,
      environment: "staging",
      redirectUri: REDIRECT_URI,
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
    assert.ok(!Object.prototype.hasOwnProperty.call(body, "status"));
    assert.ok(!response.body.includes(encryptedRefreshToken.ciphertext));
    assert.ok(!response.body.includes("encryptedRefreshToken"));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

run().catch((err) => {
  console.error("[google-calendar-functions.test.js] unexpected failure:", err);
  process.exitCode = 1;
});
