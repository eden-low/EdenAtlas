// Deterministic tests for the anime-airing-check WRAPPER — env checks, Admin init, and the
// verified-deploy-context-based dry-run default (Part 2 fix: request-shape "authentication" and
// the manual bearer-token HTTP mode from an earlier version of this file are both GONE — see that
// file's own header comment for why). The actual scheduling/delivery LOGIC is tested
// independently in backend/netlify/functions/__tests__/airing-check-core.test.js against
// runAiringCheck() directly. Run with: node backend/netlify/functions/__tests__/anime-airing-check.test.js
// (or `npm run test:functions`).

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

function baseEnv(overrides = {}) {
  return {
    FIREBASE_PROJECT_ID: "lfj-profolio",
    FIREBASE_SERVICE_ACCOUNT: '{"project_id":"lfj-profolio"}',
    ...overrides,
  };
}

const PRODUCTION_CTX = { context: "production", branch: "main", expectedStagingProjectId: null };
const STAGING_CTX = { context: "branch-deploy", branch: "staging", expectedStagingProjectId: "edenatlas-staging" };
const PREVIEW_CTX = { context: "deploy-preview", branch: "pr-42", expectedStagingProjectId: "edenatlas-staging" };
const DEV_CTX = { context: "dev", branch: null, expectedStagingProjectId: null };
const UNKNOWN_CTX = { context: null, branch: null, expectedStagingProjectId: null };

const SCHEDULED_EVENT = { body: JSON.stringify({ next_run: "2026-08-01T13:00:00.000Z" }) };

// A recording stub for runAiringCheck-shaped calls — this file never exercises the real
// scheduling logic, only what the wrapper decides and passes to it (dryRun in particular).
function makeDeps({ env, buildContext, hasIsolatedStagingBackend = false } = {}) {
  const calls = { getDueFollows: 0, runAiringCheckOptions: [] };
  return {
    calls,
    env: env || baseEnv(),
    now: () => new Date("2026-08-01T12:00:00.000Z"),
    ensureFirebaseAdmin: async () => {},
    buildContext: buildContext || PRODUCTION_CTX,
    hasIsolatedStagingBackend,
    // Minimal core-shaped deps — sufficient for runAiringCheck() to complete with zero due
    // follows (checked=0), so these tests stay focused on the WRAPPER's own dry-run-default
    // resolution, not the core logic (already covered by airing-check-core.test.js). The actual
    // `dryRun` value the wrapper computed is captured indirectly via getDueFollows always running
    // (reads happen either way) plus a direct read of the JSON response body's own `dryRun` field.
    getDueFollows: async () => { calls.getDueFollows++; return []; },
    refreshSnapshot: async () => {},
    wasAlreadyNotified: async () => false,
    recordNotified: async () => {},
    getSubscriptionsForUid: async () => [],
    deleteSubscription: async () => {},
    sendPush: async () => {},
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

  await test("this Function has no auth-header-shaped code path at all — a request carrying an Authorization header is simply ignored, never inspected", async () => {
    const deps = makeDeps();
    const res = await createHandler(deps)({ body: null, headers: { authorization: "Bearer some-random-token-that-is-never-checked" } });
    assert.strictEqual(res.statusCode, 200); // runs regardless — there is no auth gate to fail
    assert.strictEqual(deps.calls.getDueFollows, 1);
  });

  await test("an event with no body, no headers, nothing at all still runs — there is no request-shape gate of any kind", async () => {
    const deps = makeDeps();
    const res = await createHandler(deps)({});
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(deps.calls.getDueFollows, 1);
  });

  // ---- Dry-run default, purely a function of the VERIFIED deploy context ----

  await test("Production context: real (non-dry) run, regardless of the request body's next_run value or absence", async () => {
    const deps = makeDeps({ buildContext: PRODUCTION_CTX });
    const res = await createHandler(deps)(SCHEDULED_EVENT);
    assert.strictEqual(JSON.parse(res.body).dryRun, false);

    const deps2 = makeDeps({ buildContext: PRODUCTION_CTX });
    const res2 = await createHandler(deps2)({}); // no next_run at all — still real, context decides
    assert.strictEqual(JSON.parse(res2.body).dryRun, false);
  });

  await test("Pre-production (staging branch deploy) with no real-send opt-in defaults to enforced dry-run", async () => {
    const deps = makeDeps({ buildContext: STAGING_CTX, hasIsolatedStagingBackend: true });
    const res = await createHandler(deps)(SCHEDULED_EVENT);
    assert.strictEqual(JSON.parse(res.body).dryRun, true);
  });

  await test("Pre-production (Deploy Preview) with no real-send opt-in defaults to enforced dry-run", async () => {
    const deps = makeDeps({ buildContext: PREVIEW_CTX, hasIsolatedStagingBackend: true });
    const res = await createHandler(deps)(SCHEDULED_EVENT);
    assert.strictEqual(JSON.parse(res.body).dryRun, true);
  });

  await test("next_run being present in the request body NEVER flips pre-production into a real run by itself — the exact regression this pass fixes", async () => {
    const deps = makeDeps({ buildContext: STAGING_CTX, hasIsolatedStagingBackend: true });
    const res = await createHandler(deps)({ body: JSON.stringify({ next_run: "2026-08-01T13:00:00.000Z" }) });
    assert.strictEqual(JSON.parse(res.body).dryRun, true, "next_run must never enable a real send in pre-production");
  });

  await test("Pre-production WITH STAGING_ALLOW_REAL_SEND=1 AND isolated staging credentials confirmed performs a real run", async () => {
    const deps = makeDeps({
      env: baseEnv({ STAGING_ALLOW_REAL_SEND: "1" }),
      buildContext: STAGING_CTX,
      hasIsolatedStagingBackend: true,
    });
    const res = await createHandler(deps)(SCHEDULED_EVENT);
    assert.strictEqual(JSON.parse(res.body).dryRun, false);
  });

  await test("Pre-production WITH STAGING_ALLOW_REAL_SEND=1 but WITHOUT confirmed isolated staging credentials still stays dry-run — the opt-in alone is never sufficient", async () => {
    const deps = makeDeps({
      env: baseEnv({ STAGING_ALLOW_REAL_SEND: "1" }),
      buildContext: PREVIEW_CTX,
      hasIsolatedStagingBackend: false, // e.g. a Deploy Preview sharing/lacking a real staging project
    });
    const res = await createHandler(deps)(SCHEDULED_EVENT);
    assert.strictEqual(JSON.parse(res.body).dryRun, true);
  });

  await test("STAGING_ALLOW_REAL_SEND has zero effect in Production — Production is already real, opting in changes nothing", async () => {
    const deps = makeDeps({ env: baseEnv({ STAGING_ALLOW_REAL_SEND: "1" }), buildContext: PRODUCTION_CTX });
    const res = await createHandler(deps)(SCHEDULED_EVENT);
    assert.strictEqual(JSON.parse(res.body).dryRun, false);
  });

  await test("STAGING_ALLOW_REAL_SEND has zero effect in Dev — Dev always stays dry-run, no opt-in exists for it", async () => {
    const deps = makeDeps({ env: baseEnv({ STAGING_ALLOW_REAL_SEND: "1", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" }), buildContext: DEV_CTX, hasIsolatedStagingBackend: false });
    const res = await createHandler(deps)(SCHEDULED_EVENT);
    assert.strictEqual(JSON.parse(res.body).dryRun, true);
  });

  await test("Dev context (local invocation, mocks/emulator) always defaults to dry-run", async () => {
    const deps = makeDeps({ buildContext: DEV_CTX });
    const res = await createHandler(deps)(SCHEDULED_EVENT);
    assert.strictEqual(JSON.parse(res.body).dryRun, true);
  });

  await test("Unknown/missing deploy context defaults to dry-run (defense in depth — in practice ensureFirebaseAdmin() would already have failed closed for this role per Gap 1)", async () => {
    const deps = makeDeps({ buildContext: UNKNOWN_CTX });
    const res = await createHandler(deps)(SCHEDULED_EVENT);
    assert.strictEqual(JSON.parse(res.body).dryRun, true);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    failures.forEach(({ name, err }) => console.error(`\n[FAILED] ${name}\n${err.stack || err}`));
    process.exit(1);
  }
})();
