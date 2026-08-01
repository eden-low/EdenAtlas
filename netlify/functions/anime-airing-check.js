// EdenAtlas Discover — scheduled airing-reminder delivery (Phase 4, Owner-only).
//
// This file is now a deliberately THIN wrapper (Gap 3 fix) — the actual scheduling/delivery
// logic lives in netlify/functions/lib/airing-check-core.js's runAiringCheck(deps, options),
// which is independently unit/integration-testable with an injected clock and fully mocked
// Firestore/AniList/FCM deps (see netlify/functions/__tests__/airing-check-core.test.js). This
// split exists specifically because Netlify Scheduled Functions only run automatically on a
// PUBLISHED/production-context deploy — a Deploy Preview or the `staging` branch deploy
// structurally cannot prove "the cron fires" the way this repo's other automated tests prove
// everything else. What CAN be proven on Staging (and in this environment, with zero network
// access) is that the underlying logic — schedule calculation, dedup, subscription cleanup,
// project isolation — is correct; the cron wiring itself can only be confirmed after the
// eventual real Production deploy (see the completion report).
//
// Two ways this Function is invoked:
//   1. Netlify's own scheduler (netlify.toml's `[functions."anime-airing-check"] schedule`) —
//      recognized via looksLikeScheduledInvocation() below (Netlify's documented scheduled-
//      invocation body shape, `{"next_run": "<ISO8601>"}`). Always runs the real logic, never
//      dry-run. NOTE: this repo's own understanding is that Netlify does not expose a scheduled
//      Function's ordinary endpoint to arbitrary public HTTP callers once `schedule` is
//      configured — this check is a defense-in-depth SECOND layer, not assumed to be the only
//      thing standing between this Function and the public internet, and its exact request shape
//      has not been independently verified against a live Netlify deployment in this environment
//      (called out explicitly, not silently assumed correct).
//   2. A manual invocation (staging verification, local `netlify functions:invoke`, or Netlify's
//      dashboard "Trigger function" button if it doesn't match #1's shape) — requires the EXACT
//      same Owner-only Firebase ID-token authorization every other Discover Function already uses
//      (see anilist.js's identical comment). Only this authenticated path may set `dryRun: true`
//      (JSON body `{"dryRun":true}` or `?dryRun=1`) — see lib/airing-check-core.js for what
//      dry-run actually skips. No unauthenticated public HTTP path exists for this Function at
//      all; a request matching neither #1 nor #2 is rejected.

const { runAiringCheck } = require("./lib/airing-check-core");
const { FirebaseConfigError } = require("./lib/firebase-admin");

const OWNER_EMAIL = "jjun8647@gmail.com"; // duplicated per this repo's established convention — see anilist.js's identical comment

const REQUIRED_ENV = ["FIREBASE_PROJECT_ID", "FIREBASE_SERVICE_ACCOUNT"];

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}

function getHeader(event, name) {
  const headers = (event && event.headers) || {};
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

// See this file's header comment — best-effort, documented as unverified against a live
// deployment. `next_run` is the one field Netlify's own docs describe the scheduled invocation
// body as carrying; any other shape (including no body at all) falls through to requiring Owner
// authentication instead.
function looksLikeScheduledInvocation(event) {
  if (!event || typeof event.body !== "string" || !event.body) return false;
  try {
    const parsed = JSON.parse(event.body);
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.next_run === "string";
  } catch {
    return false;
  }
}

function parseDryRunFlag(event) {
  const qp = event && event.queryStringParameters;
  if (qp && (qp.dryRun === "1" || qp.dryRun === "true")) return true;
  if (event && typeof event.body === "string" && event.body) {
    try {
      const parsed = JSON.parse(event.body);
      if (parsed && parsed.dryRun === true) return true;
    } catch {
      // Malformed body on the manual path just means dryRun stays false — never a hard error,
      // since the body might legitimately be empty for a plain manual trigger.
    }
  }
  return false;
}

function logAuthStageFailure(stage, err) {
  console.error(`[anime-airing-check] auth stage failed: stage=${stage} code=${(err && err.code) || "no_code"}`);
}

// `deps` is fully injectable — see netlify/functions/__tests__/anime-airing-check.test.js (this
// wrapper's own concerns: env, invocation-source gating, dryRun parsing) and
// netlify/functions/__tests__/airing-check-core.test.js (the actual scheduling logic, tested
// directly against runAiringCheck(), independent of this file entirely).
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

    let dryRun = false;

    if (!looksLikeScheduledInvocation(event)) {
      // Manual path — require the exact same Owner-only authorization every other Discover
      // Function uses (two independent signals, AND not OR — see anilist.js's identical comment).
      const authHeader = getHeader(event, "authorization") || "";
      const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
      if (!match) {
        return jsonResponse(401, { ok: false, error: "missing_bearer_token" });
      }
      let decoded;
      try {
        decoded = await deps.verifyIdToken(match[1]);
      } catch (err) {
        if (err instanceof FirebaseConfigError) {
          logAuthStageFailure(err.stage, err);
          return jsonResponse(500, { ok: false, error: "not_configured" });
        }
        logAuthStageFailure("token_verification", err);
        return jsonResponse(401, { ok: false, error: "invalid_or_expired_token" });
      }
      if (!decoded || !decoded.uid) {
        logAuthStageFailure("token_verification", null);
        return jsonResponse(401, { ok: false, error: "invalid_or_expired_token" });
      }

      let userDoc;
      try {
        userDoc = await deps.getUserDoc(decoded.uid);
      } catch (err) {
        console.error("[anime-airing-check] users/{uid} read failed:", err && err.code);
        return jsonResponse(500, { ok: false, error: "profile_lookup_failed" });
      }
      const isOwnerCaller = !!userDoc && userDoc.role === "owner" && decoded.email === OWNER_EMAIL && userDoc.email === OWNER_EMAIL;
      if (!isOwnerCaller) {
        return jsonResponse(403, { ok: false, error: "owner_only" });
      }

      dryRun = parseDryRunFlag(event);
    }
    // else: recognized as Netlify's own scheduled invocation — runs the real logic, dryRun stays false.

    const result = await runAiringCheck(deps, { dryRun });
    return jsonResponse(result.ok ? 200 : 500, result);
  };
}

// ---- Production wiring ----

function buildProductionDeps() {
  const { initializeApp, cert, getApps, getApp } = require("firebase-admin/app");
  const { getAuth } = require("firebase-admin/auth");
  const { getFirestore, FieldValue } = require("firebase-admin/firestore");
  const { getMessaging } = require("firebase-admin/messaging");
  const { initializeFirebaseAdmin } = require("./lib/firebase-admin");
  const { readGeneratedBuildContext } = require("./lib/build-context");
  let app = null;

  function ensureApp() {
    if (app) return app;
    // buildContext: Gap 1 (Staging/Production Firebase Admin isolation) — see
    // lib/firebase-admin.js's assertProjectMatchesBuildContext(). This Function is the one place
    // in the app where that guard matters MOST: a scheduled process runs unattended, with no
    // browser-side isStagingWritesUnsafe() check anywhere in its path at all.
    app = initializeFirebaseAdmin({
      getApps, getApp, initializeApp, cert,
      projectId: process.env.FIREBASE_PROJECT_ID,
      serviceAccountRaw: process.env.FIREBASE_SERVICE_ACCOUNT,
      buildContext: readGeneratedBuildContext(),
    });
    return app;
  }

  return {
    env: process.env,
    now: () => new Date(),
    ensureFirebaseAdmin: async () => { ensureApp(); },
    verifyIdToken: (token) => getAuth(ensureApp()).verifyIdToken(token, true),
    getUserDoc: async (uid) => {
      const snap = await getFirestore(ensureApp()).collection("users").doc(uid).get();
      return snap.exists ? snap.data() : null;
    },

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
