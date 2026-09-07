#!/usr/bin/env node
// EdenAtlas — build-time environment snapshot for js/environment.js.
//
// Same pattern and same reasoning as scripts/generate-deploy-origin.js (read that file's header
// first): Netlify's CONTEXT/BRANCH/URL/DEPLOY_PRIME_URL variables are only real during the BUILD
// step, not inside a deployed Function or, more importantly here, inside a static page's own
// runtime (a static HTML/JS file has no server-side "process.env" at all — it's just bytes
// served from a CDN). The only way a page can know "am I Production, Staging, or a Deploy
// Preview" without falling back to fragile hostname sniffing is for the BUILD to write that
// answer down somewhere the page can read synchronously. This script writes it into
// js/build-info.generated.js, a plain classic (non-module) script every protected page loads as
// the first line of <head> — see js/environment.js's header comment for how it's consumed.
//
// FIREBASE_VAPID_PUBLIC_KEY (Phase 4 — opt-in airing push reminders) is also snapshotted here:
// it's a PUBLIC key by design (the whole point of a VAPID key pair is that the public half is
// safe to ship to any browser — same category of "public by design" as firebase-init.js's own
// Firebase Web apiKey, already documented there). When unset, discover.js's push-notification UI
// stays in its "not yet configured" disabled state (see js/push-notifications.js) — this script
// never invents a placeholder value.
//
// Run: `node scripts/generate-build-info.js` (also what `npm run build` runs).

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(ROOT, "frontend", "js", "build-info.generated.js");
// Gap 2 fix: js/fcm-config.generated.js — a SEPARATE output file, deliberately a plain classic
// script setting `self.__EDEN_FCM_CONFIG__` (not `window.__EDEN_FCM_CONFIG__`) so the EXACT SAME
// generated file can be `importScripts()`-ed synchronously by service-worker.js (a worker has no
// `window`, only `self`) — in a normal browser tab `self === window`, so nothing here would need
// to change if a page ever wanted to read it too. Written by this SAME script (not a separate
// generator) specifically so there is exactly ONE build-time decision of "which Firebase project
// is this build using" — duplicating that decision into a second, independent resolver risked the
// two disagreeing (e.g. one correctly picking Staging, the other silently falling back to
// Production) with no test able to catch the drift.
const FCM_CONFIG_OUT_PATH = path.join(ROOT, "frontend", "js", "fcm-config.generated.js");

function rawOrNull(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// Duplicated from firebase-init.js on purpose (same "public client config, safe to duplicate at a
// runtime boundary that can't import a browser ES module" convention already used for
// PRODUCTION_PROJECT_ID in backend/netlify/functions/lib/firebase-admin.js) — this script runs under
// plain Node at build time and can't `import` firebase-init.js's ES module either.
const PRODUCTION_FIREBASE_CONFIG = {
  apiKey: "AIzaSyBLJmKmn4Nwc2Ad3CG_KoPAn96HSfuvvU8",
  authDomain: "lfj-profolio.firebaseapp.com",
  projectId: "lfj-profolio",
  storageBucket: "lfj-profolio.firebasestorage.app",
  messagingSenderId: "173360347563",
  appId: "1:173360347563:web:961b3118bce0a8232c3aee",
};

// Optional dedicated Firebase project for Staging (Phase 1 safeguard #2: "Prefer a separate
// Firebase staging project"). Every one of these six must be set for this to activate at all —
// a partially-set group (e.g. project ID but no app ID) is treated as "not configured," never
// used half-populated, so firebase-init.js can't ever initialize with a broken mixed config.
// None of these six are secret — they're the same category of "public client config" as this
// repo's existing production apiKey (see firebase-init.js's own comment on that). Until a real
// staging project exists and these are set in Netlify, this stays null and Staging deploys
// share Production's Firebase project — js/environment.js's isStagingWithoutIsolatedBackend()
// is what makes that safe (see discover.js's write guard).
function readStagingFirebaseConfig() {
  const cfg = {
    apiKey: rawOrNull(process.env.STAGING_FIREBASE_API_KEY),
    authDomain: rawOrNull(process.env.STAGING_FIREBASE_AUTH_DOMAIN),
    projectId: rawOrNull(process.env.STAGING_FIREBASE_PROJECT_ID),
    storageBucket: rawOrNull(process.env.STAGING_FIREBASE_STORAGE_BUCKET),
    messagingSenderId: rawOrNull(process.env.STAGING_FIREBASE_MESSAGING_SENDER_ID),
    appId: rawOrNull(process.env.STAGING_FIREBASE_APP_ID),
  };
  return Object.values(cfg).every(Boolean) ? cfg : null;
}

// Deploy-context policy fix: broadened from "only the literal `staging` branch" to EVERY
// pre-production context (any Deploy Preview, any branch deploy) — mirrors js/environment.js's
// isPreProduction() and backend/netlify/functions/lib/firebase-admin.js's resolveDeployRole() exactly, so
// the browser's push-notification config can never disagree with the rest of the app's deploy-
// context classification. An earlier version of this function only recognized the literal
// `staging` branch, which left every OTHER Deploy Preview/branch deploy silently using
// Production's Firebase config for push notifications too.
function isPreProductionBuild(context) {
  return context === "deploy-preview" || context === "branch-deploy";
}

// "Never silently fall back from staging/preview to Production Firebase" — applies here too, not
// just to firebase-init.js's runtime resolution (duplicated from that file's own
// PREPRODUCTION_PLACEHOLDER_CONFIG on purpose; this script can't import a browser ES module).
// Used only when isPreProductionBuild() is true AND no staging project is configured — Production
// builds and genuinely-configured pre-production builds never see this value.
const PREPRODUCTION_PLACEHOLDER_CONFIG = {
  apiKey: "unconfigured-preproduction-build",
  authDomain: "eden-preproduction-not-configured.firebaseapp.com",
  projectId: "eden-preproduction-not-configured",
  storageBucket: "eden-preproduction-not-configured.firebasestorage.app",
  messagingSenderId: "0",
  appId: "1:0:web:unconfigured",
};

const DEVELOPMENT_PLACEHOLDER_CONFIG = {
  apiKey: "unconfigured-development-build",
  authDomain: "eden-development-not-configured.firebaseapp.com",
  projectId: "eden-development-not-configured",
  storageBucket: "eden-development-not-configured.firebasestorage.app",
  messagingSenderId: "0",
  appId: "1:0:web:unconfigured-development",
};

function generate() {
  const context = rawOrNull(process.env.CONTEXT) || "development";
  const branch = rawOrNull(process.env.BRANCH);
  const stagingFirebaseConfig = readStagingFirebaseConfig();
  const vapidPublicKey = rawOrNull(process.env.FIREBASE_VAPID_PUBLIC_KEY);

  const info = {
    // CONTEXT: "production" | "deploy-preview" | "branch-deploy" (Netlify build metadata —
    // https://docs.netlify.com/configure-builds/environment-variables/#build-metadata). BRANCH
    // is what lets js/environment.js's resolveEnvironment() distinguish the stable `staging`
    // branch-deploy from any other ad-hoc branch deploy.
    context,
    branch,
    url: rawOrNull(process.env.URL),
    deployPrimeUrl: rawOrNull(process.env.DEPLOY_PRIME_URL),
    vapidPublicKey,
    stagingFirebaseConfig,
    builtAt: new Date().toISOString(),
  };

  const contents =
    "// GENERATED by scripts/generate-build-info.js at build time — do not hand-edit.\n" +
    "// See js/environment.js and js/build-info.generated.js's own tracked-default header comment\n" +
    "// for why this is a plain classic script, not JSON or an ES module.\n" +
    `window.__EDEN_BUILD__ = ${JSON.stringify(info, null, 2)};\n`;

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, contents, "utf8");
  console.log(
    `generate-build-info: wrote ${path.relative(ROOT, OUT_PATH)} ` +
    `(context=${info.context}, branch=${info.branch || "null"}, vapidPublicKey=${info.vapidPublicKey ? "set" : "unset"}, ` +
    `stagingFirebaseConfig=${info.stagingFirebaseConfig ? "set" : "unset"})`
  );

  // Gap 2 fix (now aligned with the deploy-context policy): the SAME resolution firebase-init.js's
  // browser code already does (any pre-production context + a fully-configured staging project ->
  // staging config; pre-production with NO staging project configured -> an inert placeholder,
  // NEVER Production's real config; only a verified Production context ever gets Production's
  // config) computed HERE instead, once, and handed to service-worker.js via a synchronously-
  // importable file — see FCM_CONFIG_OUT_PATH's own comment above for why this can't just be a
  // second independent resolver.
  const isProduction = context === "production" && branch === "main";
  const isPreProd = isPreProductionBuild(context);
  const useStagingConfig = isPreProd && !!stagingFirebaseConfig;
  const resolvedFirebaseConfig = useStagingConfig
    ? stagingFirebaseConfig
    : isPreProd
      ? PREPRODUCTION_PLACEHOLDER_CONFIG
      : isProduction
        ? PRODUCTION_FIREBASE_CONFIG
        : DEVELOPMENT_PLACEHOLDER_CONFIG;
  const fcmConfig = { firebaseConfig: resolvedFirebaseConfig, vapidPublicKey };
  const fcmContents =
    "// GENERATED by scripts/generate-build-info.js at build time — do not hand-edit.\n" +
    "// Public Firebase Web config + public VAPID key ONLY (see that script's header comment for\n" +
    "// the exact allowlist and why nothing secret can ever end up here) — read by\n" +
    "// service-worker.js via importScripts() for its FCM background-message handler.\n" +
    `self.__EDEN_FCM_CONFIG__ = ${JSON.stringify(fcmConfig, null, 2)};\n`;
  fs.mkdirSync(path.dirname(FCM_CONFIG_OUT_PATH), { recursive: true });
  fs.writeFileSync(FCM_CONFIG_OUT_PATH, fcmContents, "utf8");
  console.log(
    `generate-build-info: wrote ${path.relative(ROOT, FCM_CONFIG_OUT_PATH)} ` +
    `(projectId=${resolvedFirebaseConfig.projectId}, usingStagingConfig=${useStagingConfig})`
  );

  return info;
}

if (require.main === module) {
  generate();
}

module.exports = {
  generate, OUT_PATH, FCM_CONFIG_OUT_PATH, PRODUCTION_FIREBASE_CONFIG,
  PREPRODUCTION_PLACEHOLDER_CONFIG, DEVELOPMENT_PLACEHOLDER_CONFIG, isPreProductionBuild,
};
