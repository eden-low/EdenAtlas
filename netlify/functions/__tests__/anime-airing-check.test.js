// Deterministic tests for the anime-airing-check WRAPPER — env checks, Admin init, invocation-
// source gating (Netlify's scheduler vs. a manual Owner-authenticated call), and dryRun-flag
// parsing/passthrough. The actual scheduling/delivery LOGIC is tested independently in
// netlify/functions/__tests__/airing-check-core.test.js against runAiringCheck() directly — see
// this file's own header comment for why the two were split (Gap 3, Staging/Production isolation
// follow-up). Run with: node netlify/functions/__tests__/anime-airing-check.test.js (or
// `npm run test:functions`). Mirrors weather.test.js/anilist.test.js's own createHandler(deps)
// testing style.

const assert = require("node:assert");

const { createHandler } = require("../anime-airing-check.js");
const { FirebaseConfigError } = require("../lib/firebase-admin.js");

let pass = 0;
let fail = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, err });
    console.log(`FAIL  - ${name}`);
    console.log(`        ${err.message}`);
  }
}

const OWNER_UID = "owner-uid-1";
const OWNER_EMAIL = "jjun8647@gmail.com";
const FRIEND_UID = "friend-uid-1";
const FRIEND_EMAIL = "friend@example.com";

function baseEnv(overrides = {}) {
  return {
    FIREBASE_PROJECT_ID: "lfj-profolio",
    FIREBASE_SERVICE_ACCOUNT: '{"project_id":"lfj-profolio"}',
    ...overrides,
  };
}

const SCHEDULED_EVENT = { body: JSON.stringify({ next_run: "2026-08-01T13:00:00.000Z" }) };

function ownerEvent({ body, query } = {}) {
  return {
    headers: { authorization: "Bearer valid-owner-token" },
    body: body !== undefined ? body : null,
    queryStringParameters: query || null,
  };
}

// A recording stub for runAiringCheck-shaped calls — this file never exercises the real
// scheduling logic, only what the wrapper passes to it.
function makeDeps({ env, verifyIdToken, getUserDoc, runAiringCheckResult } = {}) {
  const calls = { getDueFollows: 0, sendPush: 0 };
  return {
    calls,
    env: env || baseEnv(),
    now: () => new Date("2026-08-01T12:00:00.000Z"),
    ensureFirebaseAdmin: async () => {},
    verifyIdToken: verifyIdToken || (async () => ({ uid: OWNER_UID, email: OWNER_EMAIL })),
    getUserDoc: getUserDoc || (async (uid) => (uid === OWNER_UID ? { role: "owner", email: OWNER_EMAIL } : { role: "friend", email: FRIEND_EMAIL })),
    // Minimal core-shaped deps — sufficient for runAiringCheck() to complete with zero due
    // follows (checked=0), so these tests stay focused on the WRAPPER's own gating, not the core
    // logic (already covered by airing-check-core.test.js).
    getDueFollows: async () => { calls.getDueFollows++; return []; },
    refreshSnapshot: async () => {},
    wasAlreadyNotified: async () => false,
    recordNotified: async () => {},
    getSubscriptionsForUid: async () => [],
    deleteSubscription: async () => {},
    sendPush: async () => { calls.sendPush++; },
    fetchImpl: undefined,
  };
}

(async () => {
  await test("missing required env fails closed with 500, never touches Firestore", async () => {
    const deps = makeDeps({ env: {} });
    const res = await createHandler(deps)(SCHEDULED_EVENT);
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(JSON.parse(res.body).error, "not_configured");
    assert.strictEqual(deps.calls.getDueFollows, 0);
  });

  await test("Firebase Admin init failure (FirebaseConfigError) maps to 500 not_configured, never crashes", async () => {
    const deps = makeDeps();
    deps.ensureFirebaseAdmin = async () => { throw new FirebaseConfigError("bad key", "admin_initialization", "config/invalid-private-key"); };
    const res = await createHandler(deps)(SCHEDULED_EVENT);
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(JSON.parse(res.body).error, "not_configured");
  });

  // ---- Invocation-source gating ----

  await test("a request shaped like Netlify's scheduled invocation ({next_run}) runs without any Authorization header", async () => {
    const deps = makeDeps();
    const res = await createHandler(deps)(SCHEDULED_EVENT);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(deps.calls.getDueFollows, 1);
  });

  await test("a request with no recognizable scheduled shape AND no Authorization header is rejected 401, never runs the core logic", async () => {
    const deps = makeDeps();
    const res = await createHandler(deps)({ body: null, headers: {} });
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(JSON.parse(res.body).error, "missing_bearer_token");
    assert.strictEqual(deps.calls.getDueFollows, 0);
  });

  await test("a plain empty/malformed body with no Authorization header is also rejected — never treated as 'probably the scheduler'", async () => {
    const deps = makeDeps();
    const res1 = await createHandler(deps)({ body: "", headers: {} });
    assert.strictEqual(res1.statusCode, 401);
    const res2 = await createHandler(deps)({ body: "not json", headers: {} });
    assert.strictEqual(res2.statusCode, 401);
    const res3 = await createHandler(deps)({ body: JSON.stringify({ some: "other shape" }), headers: {} });
    assert.strictEqual(res3.statusCode, 401);
  });

  await test("an authenticated Owner manual call runs the core logic", async () => {
    const deps = makeDeps();
    const res = await createHandler(deps)(ownerEvent());
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(deps.calls.getDueFollows, 1);
  });

  await test("a Friend (or any non-Owner) authenticated call is rejected 403 owner_only, never runs the core logic", async () => {
    const deps = makeDeps({
      verifyIdToken: async () => ({ uid: FRIEND_UID, email: FRIEND_EMAIL }),
    });
    const res = await createHandler(deps)(ownerEvent());
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(JSON.parse(res.body).error, "owner_only");
    assert.strictEqual(deps.calls.getDueFollows, 0);
  });

  await test("an invalid/expired token on the manual path is rejected 401, never runs the core logic", async () => {
    const deps = makeDeps({ verifyIdToken: async () => { throw new Error("invalid token"); } });
    const res = await createHandler(deps)(ownerEvent());
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(deps.calls.getDueFollows, 0);
  });

  await test("a FirebaseConfigError thrown from verifyIdToken on the manual path is 500, never misreported as 401", async () => {
    const deps = makeDeps({
      verifyIdToken: async () => { throw new FirebaseConfigError("bad key", "admin_initialization", "config/invalid-private-key"); },
    });
    const res = await createHandler(deps)(ownerEvent());
    assert.strictEqual(res.statusCode, 500);
  });

  await test("Owner email must match on BOTH the verified token AND the stored users/{uid} doc (AND, not OR) — same convention as every other Discover Function", async () => {
    // Token claims Owner's uid+email, but the stored doc's role/email don't confirm it.
    const deps1 = makeDeps({ getUserDoc: async () => ({ role: "friend", email: OWNER_EMAIL }) });
    assert.strictEqual((await createHandler(deps1)(ownerEvent())).statusCode, 403);
    const deps2 = makeDeps({ getUserDoc: async () => ({ role: "owner", email: "someone-else@example.com" }) });
    assert.strictEqual((await createHandler(deps2)(ownerEvent())).statusCode, 403);
  });

  // ---- dryRun parsing (Gap 3) — only meaningful/honored on the authenticated manual path ----

  await test("dryRun:true in a JSON body on the authenticated manual path is passed through to the core logic", async () => {
    const deps = makeDeps();
    const res = await createHandler(deps)(ownerEvent({ body: JSON.stringify({ dryRun: true }) }));
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(body.dryRun, true);
  });

  await test("?dryRun=1 query string on the authenticated manual path is also honored", async () => {
    const deps = makeDeps();
    const res = await createHandler(deps)(ownerEvent({ query: { dryRun: "1" } }));
    assert.strictEqual(JSON.parse(res.body).dryRun, true);
  });

  await test("no dryRun flag on the authenticated manual path defaults to a real (non-dry) run", async () => {
    const deps = makeDeps();
    const res = await createHandler(deps)(ownerEvent());
    assert.strictEqual(JSON.parse(res.body).dryRun, false);
  });

  await test("the scheduled-invocation path can never be dry-run, even if its body somehow also contained a dryRun-shaped field", async () => {
    // Netlify's own scheduler controls this request's body entirely — even in a hypothetical
    // future where its shape grew a same-named field, the scheduled path must never honor it,
    // since dryRun is scoped to the authenticated manual path's parsing logic only.
    const deps = makeDeps();
    const res = await createHandler(deps)({ body: JSON.stringify({ next_run: "2026-08-01T13:00:00.000Z", dryRun: true }) });
    assert.strictEqual(JSON.parse(res.body).dryRun, false);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    failures.forEach(({ name, err }) => console.error(`\n[FAILED] ${name}\n${err.stack || err}`));
    process.exit(1);
  }
})();
