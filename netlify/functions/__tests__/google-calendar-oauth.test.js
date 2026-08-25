const assert = require("node:assert");
const crypto = require("node:crypto");
const {
  GOOGLE_CALENDAR_SCOPE,
  GOOGLE_CALENDAR_APP_CREATED_SCOPE,
  GOOGLE_CALENDAR_READ_INTENT,
  GOOGLE_CALENDAR_WRITE_INTENT,
  GOOGLE_CALENDAR_CAPABILITY_READONLY,
  GOOGLE_CALENDAR_CAPABILITY_WRITE_AUTHORIZED,
  STATE_TTL_MS,
  GoogleCalendarOAuthError,
  createOAuthState,
  verifyOAuthStateRecord,
  consumeOAuthState,
  buildAuthorizationUrl,
  parseOAuthStartRequest,
  exchangeAuthorizationCode,
  encryptRefreshToken,
  decryptRefreshToken,
  sha256Hex,
} = require("../lib/google-calendar-oauth");

const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
const UID = "verified-firebase-uid";
const REDIRECT_URI = "https://staging--edenatlas.netlify.app/.netlify/functions/google-calendar-oauth-callback";
const NOW = new Date("2026-08-21T08:00:00.000Z");
const FIXED_STATE_BYTES = Buffer.alloc(32, 3);
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

function expectOAuthError(fn, code) {
  assert.throws(fn, (err) => err instanceof GoogleCalendarOAuthError && err.code === code);
}

function pending(overrides = {}) {
  return createOAuthState({
    uid: UID,
    environment: "staging",
    redirectUri: REDIRECT_URI,
    authorizationIntent: GOOGLE_CALENDAR_READ_INTENT,
    masterKeyRaw: MASTER_KEY,
    now: NOW,
    randomBytesImpl: () => Buffer.from(FIXED_STATE_BYTES),
    ...overrides,
  });
}

async function run() {
  await test("state is 256-bit random material stored only by SHA-256 hash", () => {
    const value = pending();
    assert.match(value.state, /^[A-Za-z0-9_-]{43}$/);
    assert.strictEqual(value.stateHash, sha256Hex(value.state));
    assert.ok(!JSON.stringify(value.record).includes(value.state));
    assert.strictEqual(value.record.uid, UID);
    assert.strictEqual(value.record.environment, "staging");
    assert.strictEqual(value.record.redirectUri, REDIRECT_URI);
    assert.strictEqual(value.record.authorizationIntent, GOOGLE_CALENDAR_READ_INTENT);
    assert.strictEqual(value.record.expiresAt.getTime() - value.record.createdAt.getTime(), STATE_TTL_MS);
  });

  await test("valid state is bound to uid, environment, redirect URI and timestamps", () => {
    const value = pending();
    assert.deepStrictEqual(verifyOAuthStateRecord({
      state: value.state,
      record: value.record,
      expectedEnvironment: "staging",
      expectedRedirectUri: REDIRECT_URI,
      masterKeyRaw: MASTER_KEY,
      now: new Date(NOW.getTime() + 1000),
    }), { uid: UID, stateHash: value.stateHash, authorizationIntent: GOOGLE_CALENDAR_READ_INTENT });
  });

  await test("tampered state and tampered uid are rejected", () => {
    const value = pending();
    expectOAuthError(() => verifyOAuthStateRecord({
      state: `${value.state.slice(0, -1)}A`,
      record: value.record,
      expectedEnvironment: "staging",
      expectedRedirectUri: REDIRECT_URI,
      masterKeyRaw: MASTER_KEY,
      now: NOW,
    }), "oauth_state_tampered");
    expectOAuthError(() => verifyOAuthStateRecord({
      state: value.state,
      record: { ...value.record, authorizationIntent: GOOGLE_CALENDAR_WRITE_INTENT },
      expectedEnvironment: "staging",
      expectedRedirectUri: REDIRECT_URI,
      masterKeyRaw: MASTER_KEY,
      now: NOW,
    }), "oauth_state_tampered");
    expectOAuthError(() => verifyOAuthStateRecord({
      state: value.state,
      record: { ...value.record, uid: "attacker-uid" },
      expectedEnvironment: "staging",
      expectedRedirectUri: REDIRECT_URI,
      masterKeyRaw: MASTER_KEY,
      now: NOW,
    }), "oauth_state_tampered");
  });

  await test("environment and exact redirect URI bindings are enforced", () => {
    const value = pending();
    expectOAuthError(() => verifyOAuthStateRecord({
      state: value.state,
      record: value.record,
      expectedEnvironment: "production",
      expectedRedirectUri: REDIRECT_URI,
      masterKeyRaw: MASTER_KEY,
      now: NOW,
    }), "oauth_state_wrong_environment");
    expectOAuthError(() => verifyOAuthStateRecord({
      state: value.state,
      record: value.record,
      expectedEnvironment: "staging",
      expectedRedirectUri: `${REDIRECT_URI}/`,
      masterKeyRaw: MASTER_KEY,
      now: NOW,
    }), "oauth_state_wrong_redirect_uri");
  });

  await test("expired and consumed state are rejected", () => {
    const value = pending();
    expectOAuthError(() => verifyOAuthStateRecord({
      state: value.state,
      record: value.record,
      expectedEnvironment: "staging",
      expectedRedirectUri: REDIRECT_URI,
      masterKeyRaw: MASTER_KEY,
      now: new Date(NOW.getTime() + STATE_TTL_MS),
    }), "oauth_state_expired");
    expectOAuthError(() => verifyOAuthStateRecord({
      state: value.state,
      record: { ...value.record, consumedAt: NOW },
      expectedEnvironment: "staging",
      expectedRedirectUri: REDIRECT_URI,
      masterKeyRaw: MASTER_KEY,
      now: NOW,
    }), "oauth_state_replayed");
  });

  await test("transactional consumption marks state before it can be reused", async () => {
    const value = pending();
    const stored = { ...value.record };
    const updates = [];
    const ref = { id: value.stateHash };
    const db = {
      collection: () => ({ doc: (id) => { assert.strictEqual(id, value.stateHash); return ref; } }),
      runTransaction: async (callback) => callback({
        get: async () => ({ exists: true, data: () => stored }),
        update: (_ref, update) => { updates.push(update); Object.assign(stored, update); },
      }),
    };
    const first = await consumeOAuthState({
      db, state: value.state, expectedEnvironment: "staging", expectedRedirectUri: REDIRECT_URI,
      masterKeyRaw: MASTER_KEY, now: NOW,
    });
    assert.strictEqual(first.uid, UID);
    assert.strictEqual(updates.length, 1);
    await assert.rejects(() => consumeOAuthState({
      db, state: value.state, expectedEnvironment: "staging", expectedRedirectUri: REDIRECT_URI,
      masterKeyRaw: MASTER_KEY, now: NOW,
    }), (err) => err instanceof GoogleCalendarOAuthError && err.code === "oauth_state_replayed");
  });

  await test("authorization URL requests only the explicit read-only event scope", () => {
    const value = pending();
    const url = new URL(buildAuthorizationUrl({
      clientId: "staging-client",
      redirectUri: REDIRECT_URI,
      state: value.state,
      authorizationIntent: GOOGLE_CALENDAR_READ_INTENT,
      scope: "https://www.googleapis.com/auth/calendar",
    }));
    assert.strictEqual(url.origin, "https://accounts.google.com");
    assert.strictEqual(url.searchParams.get("scope"), GOOGLE_CALENDAR_SCOPE);
    assert.strictEqual(url.searchParams.get("access_type"), "offline");
    assert.strictEqual(url.searchParams.get("prompt"), "consent");
    assert.strictEqual(url.searchParams.get("state"), value.state);
    assert.ok(!url.toString().includes("calendar.events.owned"));
    assert.ok(!url.toString().includes("auth/calendar%20"));
  });

  await test("write re-consent has a fixed minimal scope set and browser scope input is rejected", () => {
    const value = pending({ authorizationIntent: GOOGLE_CALENDAR_WRITE_INTENT });
    const url = new URL(buildAuthorizationUrl({
      clientId: "staging-client",
      redirectUri: REDIRECT_URI,
      state: value.state,
      authorizationIntent: GOOGLE_CALENDAR_WRITE_INTENT,
      scope: "https://www.googleapis.com/auth/calendar",
    }));
    assert.deepStrictEqual(url.searchParams.get("scope").split(" "), [
      GOOGLE_CALENDAR_SCOPE,
      GOOGLE_CALENDAR_APP_CREATED_SCOPE,
    ]);
    assert.strictEqual(parseOAuthStartRequest(JSON.stringify({ scope: "https://www.googleapis.com/auth/calendar" })).error, "unknown_field");
    assert.strictEqual(parseOAuthStartRequest(JSON.stringify({ action: "calendar.events" })).error, "invalid_authorization_action");
    assert.strictEqual(
      parseOAuthStartRequest(JSON.stringify({ action: "enable_sync" })).value.authorizationIntent,
      GOOGLE_CALENDAR_WRITE_INTENT,
    );
  });

  await test("token exchange returns refresh material and scopes only, never the access token", async () => {
    const result = await exchangeAuthorizationCode({
      fetchImpl: async (_url, options) => {
        assert.strictEqual(new URLSearchParams(options.body).get("code"), "one-time-code");
        return {
          ok: true,
          json: async () => ({
            access_token: "browser-must-never-see-this-access-token",
            refresh_token: "server-refresh-token",
            scope: GOOGLE_CALENDAR_SCOPE,
          }),
        };
      },
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: REDIRECT_URI,
      code: "one-time-code",
      authorizationIntent: GOOGLE_CALENDAR_READ_INTENT,
    });
    assert.deepStrictEqual(Object.keys(result).sort(), ["capability", "grantedScopes", "refreshToken"]);
    assert.strictEqual(result.capability, GOOGLE_CALENDAR_CAPABILITY_READONLY);
    assert.strictEqual(result.refreshToken, "server-refresh-token");
    assert.ok(!JSON.stringify(result).includes("browser-must-never-see"));
  });

  await test("write exchange requires exactly the approved read plus app-created scopes", async () => {
    const exchangeWithScope = (scope) => exchangeAuthorizationCode({
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ refresh_token: "write-refresh-token", scope }),
      }),
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: REDIRECT_URI,
      code: "one-time-code",
      authorizationIntent: GOOGLE_CALENDAR_WRITE_INTENT,
    });
    const accepted = await exchangeWithScope(`${GOOGLE_CALENDAR_SCOPE} ${GOOGLE_CALENDAR_APP_CREATED_SCOPE}`);
    assert.strictEqual(accepted.capability, GOOGLE_CALENDAR_CAPABILITY_WRITE_AUTHORIZED);
    await assert.rejects(
      () => exchangeWithScope(GOOGLE_CALENDAR_SCOPE),
      (err) => err instanceof GoogleCalendarOAuthError && err.code === "required_scope_not_granted",
    );
    await assert.rejects(
      () => exchangeWithScope(`${GOOGLE_CALENDAR_SCOPE} ${GOOGLE_CALENDAR_APP_CREATED_SCOPE} https://www.googleapis.com/auth/calendar`),
      (err) => err instanceof GoogleCalendarOAuthError && err.code === "required_scope_not_granted",
    );
  });

  await test("AES-256-GCM round-trips and binds ciphertext to the Firebase uid", () => {
    const plaintext = "sensitive-refresh-token-value";
    const encrypted = encryptRefreshToken({
      refreshToken: plaintext,
      uid: UID,
      masterKeyRaw: MASTER_KEY,
      randomBytesImpl: () => Buffer.alloc(12, 9),
    });
    assert.strictEqual(encrypted.version, 1);
    assert.strictEqual(encrypted.algorithm, "A256GCM");
    assert.ok(!JSON.stringify(encrypted).includes(plaintext));
    assert.strictEqual(decryptRefreshToken({ encryptedToken: encrypted, uid: UID, masterKeyRaw: MASTER_KEY }), plaintext);
    expectOAuthError(() => decryptRefreshToken({ encryptedToken: encrypted, uid: "other-uid", masterKeyRaw: MASTER_KEY }), "token_decryption_failed");
    expectOAuthError(() => decryptRefreshToken({
      encryptedToken: { ...encrypted, ciphertext: Buffer.from("tampered").toString("base64") },
      uid: UID,
      masterKeyRaw: MASTER_KEY,
    }), "token_decryption_failed");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

run().catch((err) => {
  console.error("[google-calendar-oauth.test.js] unexpected failure:", err);
  process.exitCode = 1;
});
