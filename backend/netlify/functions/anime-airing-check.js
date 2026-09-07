// EdenAtlas Discover — scheduled airing-reminder delivery (Phase 4, Owner-only).
//
// This file is a deliberately THIN, SCHEDULED-ONLY wrapper — the actual scheduling/delivery
// logic lives in backend/netlify/functions/lib/airing-check-core.js's runAiringCheck(deps, options),
// independently unit/integration-testable with an injected clock and fully mocked Firestore/
// AniList/FCM deps (see backend/netlify/functions/__tests__/airing-check-core.test.js).
//
// Invocation model (revised — request-shape "authentication" removed):
//   Netlify Scheduled Functions cannot be invoked through their normal deployed URL by an
//   arbitrary caller at all — Netlify's own routing only reaches this code via (a) its internal
//   cron trigger on a published deploy, (b) the "Run now" control in the Netlify UI on a preview/
//   branch deploy, or (c) `netlify functions:invoke` locally. None of these require or benefit
//   from an application-level bearer token, and the request body's `next_run` field (present on a
//   real cron trigger) is scheduling METADATA, not a credential — an earlier version of this file
//   used `next_run`'s presence/shape as a security signal ("looks like the real scheduler, skip
//   auth") and separately exposed a manual Owner-bearer-token HTTP mode in this SAME function.
//   Both are gone: there is no request-shape check anywhere below, and no alternate manual-auth
//   code path in this file at all — see the completion report for why a genuinely-needed manual
//   Owner-authenticated trigger would have to be its own SEPARATE Function with its own tests,
//   not bolted onto this one.
//
// What actually decides real-vs-dry-run now is the VERIFIED DEPLOY CONTEXT (the same
// backend/netlify/functions/lib/firebase-admin.js policy every other Function's Admin initialization
// already enforces — see that file's resolveDeployRole()/enforceDeployContextPolicy()), never
// anything in the request itself:
//   - PRODUCTION (context=="production", branch==main): real sends/writes are allowed.
//   - PRE_PRODUCTION (any Deploy Preview or branch deploy, including `staging`): defaults to
//     ENFORCED dry-run — real sends are only possible when BOTH an explicit opt-in flag
//     (STAGING_ALLOW_REAL_SEND=1/true) is set AND ensureFirebaseAdmin() has already proven valid,
//     isolated staging Firebase credentials are configured (Gap 1 — a pre-production build with
//     no real staging project fails closed before this file's own logic ever runs).
//   - DEV / anything else: always dry-run, unconditionally, no opt-in exists. "Local invocation
//     must use mocks/emulators and default to dry-run" — DEV role itself already requires
//     FIRESTORE_EMULATOR_HOST to get past ensureFirebaseAdmin() at all (see lib/firebase-admin.js).
//
// Responsibilities (Requirement list, Phase 4 — unchanged):
//   7. Obtain future airing time from AniList — never invented, never guessed, never from Qwen.
//   8. Store only the minimum schedule snapshot needed (nextEpisodeSnapshot: {episode, airingAt}).
//   9. This IS the "server-side scheduled process [that] refreshes due schedules and sends
//      reminders."
//  10. Store a deterministic delivery key (anime_notification_log/{uid}_{anilistId}_{episode}) so
//      the same episode is never notified twice, even across overlapping/retried runs.
//  11. Handle expired/invalid subscriptions safely — a token rejected by FCM as
//      not-registered/invalid is deleted from push_subscriptions, never retried forever.

const { runAiringCheck } = require("./lib/airing-check-core");
const { FirebaseConfigError, resolveDeployRole, DEPLOY_ROLE } = require("./lib/firebase-admin");

const REQUIRED_ENV = ["FIREBASE_PROJECT_ID", "FIREBASE_SERVICE_ACCOUNT"];

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}

// The ONLY thing this file reads out of the invocation payload at all — purely for observability
// (so a log line can note which scheduled run this was), NEVER for any conditional/security
// decision. Malformed/absent bodies are silently fine; this never affects behavior either way.
function extractNextRunForLogging(event) {
  if (!event || typeof event.body !== "string" || !event.body) return null;
  try {
    const parsed = JSON.parse(event.body);
    return parsed && typeof parsed.next_run === "string" ? parsed.next_run : null;
  } catch {
    return null;
  }
}

// The real decision: verified deploy role, never anything from the request. `hasIsolatedStaging`
// is passed in by the caller (true only once ensureFirebaseAdmin() has already succeeded for a
// PRE_PRODUCTION role, which per Gap 1's policy is only possible when real, isolated staging
// credentials are configured — so this function never needs to re-derive that itself).
function resolveDryRun({ buildContext, env, hasIsolatedStaging }) {
  const role = resolveDeployRole(buildContext);
  if (role === DEPLOY_ROLE.PRODUCTION) return false;
  if (role === DEPLOY_ROLE.PRE_PRODUCTION) {
    const optedIntoRealSend = env.STAGING_ALLOW_REAL_SEND === "1" || env.STAGING_ALLOW_REAL_SEND === "true";
    return !(optedIntoRealSend && hasIsolatedStaging);
  }
  return true; // DEV, or anything else — always dry-run, no opt-in
}

// `deps` is fully injectable — see backend/netlify/functions/__tests__/anime-airing-check.test.js (this
// wrapper's own concerns: env, dry-run-default resolution) and backend/netlify/functions/__tests__/
// airing-check-core.test.js (the actual scheduling logic, tested directly against
// runAiringCheck(), independent of this file entirely).
function createHandler(deps) {
  return async function handler(event) {
    const env = deps.env || process.env;
    const missing = REQUIRED_ENV.filter((k) => !env[k]);
    if (missing.length) {
      console.error("[anime-airing-check] missing required environment variables:", missing.join(","));
      return jsonResponse(500, { ok: false, error: "not_configured" });
    }

    try {
      await deps.ensureFirebaseAdmin();
    } catch (err) {
      const stage = err instanceof FirebaseConfigError ? err.stage : "admin_initialization";
      console.error(`[anime-airing-check] Firebase Admin init failed: stage=${stage} code=${(err && err.code) || "no_code"}`);
      return jsonResponse(500, { ok: false, error: "not_configured" });
    }

    const nextRun = extractNextRunForLogging(event);
    if (nextRun) console.log(`[anime-airing-check] scheduled invocation, next_run=${nextRun}`);

    const dryRun = resolveDryRun({
      buildContext: deps.buildContext,
      env,
      hasIsolatedStaging: !!deps.hasIsolatedStagingBackend,
    });
    if (dryRun) console.log("[anime-airing-check] running in dry-run mode (no real sends/writes)");

    const result = await runAiringCheck(deps, { dryRun });
    return jsonResponse(result.ok ? 200 : 500, result);
  };
}

// ---- Production wiring ----

function buildProductionDeps() {
  const { initializeApp, cert, getApps, getApp } = require("firebase-admin/app");
  const { getFirestore, FieldValue } = require("firebase-admin/firestore");
  const { getMessaging } = require("firebase-admin/messaging");
  const { initializeFirebaseAdmin } = require("./lib/firebase-admin");
  const { readGeneratedBuildContext, isStagingBuildContext } = require("./lib/build-context");
  let app = null;

  const buildContext = readGeneratedBuildContext();

  function ensureApp() {
    if (app) return app;
    // Gap 1's deploy-context policy (production/pre-production/dev/unknown) is enforced inside
    // initializeFirebaseAdmin() itself — this Function is the one place in the app where that
    // guard matters MOST: a scheduled process runs unattended, with no browser-side write-guard
    // anywhere in its path at all.
    app = initializeFirebaseAdmin({
      getApps, getApp, initializeApp, cert,
      projectId: process.env.FIREBASE_PROJECT_ID,
      serviceAccountRaw: process.env.FIREBASE_SERVICE_ACCOUNT,
      buildContext,
    });
    return app;
  }

  return {
    env: process.env,
    now: () => new Date(),
    ensureFirebaseAdmin: async () => { ensureApp(); },
    buildContext,
    // True only for the literal `staging` branch deploy with STAGING_FIREBASE_PROJECT_ID set —
    // used solely to decide whether the STAGING_ALLOW_REAL_SEND opt-in is even meaningful (see
    // resolveDryRun() above). A Deploy Preview or any other branch deploy could ALSO have a valid
    // staging project configured (Gap 1 already allows that for reads/writes generally), but the
    // real-send opt-in is intentionally scoped to the one stable, deliberately-provisioned
    // `staging` deploy — never an ad-hoc preview, which is not something the Owner necessarily
    // controls the lifecycle of.
    hasIsolatedStagingBackend: isStagingBuildContext(buildContext) && !!(buildContext && buildContext.expectedStagingProjectId),

    getDueFollows: async () => {
      const snap = await getFirestore(ensureApp()).collection("followed_anime").where("notifyOnAiring", "==", true).get();
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
    refreshSnapshot: async (id, fields) =>
      getFirestore(ensureApp()).collection("followed_anime").doc(id).update({
        ...fields,
        scheduleRefreshedAt: FieldValue.serverTimestamp(),
      }),
    wasAlreadyNotified: async (dedupeKey) => {
      const snap = await getFirestore(ensureApp()).collection("anime_notification_log").doc(dedupeKey).get();
      return snap.exists;
    },
    recordNotified: async (dedupeKey, fields) =>
      getFirestore(ensureApp()).collection("anime_notification_log").doc(dedupeKey).set({
        ...fields,
        sentAt: FieldValue.serverTimestamp(),
      }),
    getSubscriptionsForUid: async (uid) => {
      const snap = await getFirestore(ensureApp()).collection("push_subscriptions").where("uid", "==", uid).get();
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
    deleteSubscription: async (id) => getFirestore(ensureApp()).collection("push_subscriptions").doc(id).delete(),

    // Data-only payload (no top-level `notification` field) — see service-worker.js's
    // onBackgroundMessage comment for why: this keeps FCM from auto-displaying anything, so the
    // service worker's own handler is the single place that decides notification appearance and
    // click-target routing.
    sendPush: async (token, data) => getMessaging(ensureApp()).send({ token, data }),

    fetchImpl: undefined, // use global fetch
  };
}

exports.handler = createHandler(buildProductionDeps());
exports.createHandler = createHandler; // test-only export, same convention as every other Function
