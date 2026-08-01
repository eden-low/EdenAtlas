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
const OUT_PATH = path.join(ROOT, "js", "build-info.generated.js");
// Gap 2 fix: js/fcm-config.generated.js — a SEPARATE output file, deliberately a plain classic
// script setting `self.__EDEN_FCM_CONFIG__` (not `window.__EDEN_FCM_CONFIG__`) so the EXACT SAME
// generated file can be `importScripts()`-ed synchronously by service-worker.js (a worker has no
// `window`, only `self`) — in a normal browser tab `self === window`, so nothing here would need
// to change if a page ever wanted to read it too. Written by this SAME script (not a separate
// generator) specifically so there is exactly ONE build-time decision of "which Firebase project
// is this build using" — duplicating that decision into a second, independent resolver risked the
// two disagreeing (e.g. one correctly picking Staging, the other silently falling back to
// Production) with no test able to catch the drift.
const FCM_CONFIG_OUT_PATH = path.join(ROOT, "js", "fcm-config.generated.js");

function rawOrNull(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// Duplicated from firebase-init.js on purpose (same "public client config, safe to duplicate at a
// runtime boundary that can't import a browser ES module" convention already used for
// PRODUCTION_PROJECT_ID in netlify/functions/lib/firebase-admin.js) — this script runs under
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

function isStagingBuild(context, branch) {
  return context === "branch-deploy" && branch === "staging";
}

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

  // Gap 2 fix: the SAME resolution firebase-init.js's browser code already does (Staging + a
  // fully-configured staging project -> staging config, else Production config — see that
  // file's own `stagingOverride` logic) computed HERE instead, once, and handed to
  // service-worker.js via a synchronously-importable file — see FCM_CONFIG_OUT_PATH's own
  // comment above for why this can't just be a second independent resolver.
  const useStagingConfig = isStagingBuild(context, branch) && !!stagingFirebaseConfig;
  const resolvedFirebaseConfig = useStagingConfig ? stagingFirebaseConfig : PRODUCTION_FIREBASE_CONFIG;
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

module.exports = { generate, OUT_PATH, FCM_CONFIG_OUT_PATH, PRODUCTION_FIREBASE_CONFIG, isStagingBuild };
