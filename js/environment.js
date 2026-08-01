// EdenAtlas — explicit, testable environment detection.
//
// Why this exists: prior passes decided Production vs. everything-else purely from
// `location.hostname === "edenatlas.netlify.app"`. That's fine as a last-resort fallback, but it
// is not "explicit and testable" the way a security-adjacent decision (which Firebase project to
// talk to, whether to show a "not Production" banner, whether Discover writes are safe to allow)
// should be — a hostname string can't be unit-tested against the actual deploy contexts Netlify
// produces (production / deploy-preview / branch-deploy), and a copy-pasted staging domain typo
// would silently fall through to "production" with no test able to catch it.
//
// The real fix: `scripts/generate-build-info.js` runs at BUILD time (part of `npm run build`,
// same stage as generate-deploy-origin.js) and snapshots Netlify's own build-time environment
// variables (CONTEXT, BRANCH, URL, DEPLOY_PRIME_URL) into a small, non-secret, GITIGNORED file,
// `js/build-info.generated.js` (same "regenerated on every build, never hand-edited, never
// committed" pattern as netlify/functions/lib/deploy-origin.generated.json). A fresh checkout
// with no build run yet simply doesn't have this file — the plain classic <script> tag that
// loads it 404s harmlessly, and getEnvironment() below already treats a missing/undefined
// window.__EDEN_BUILD__ as ENV.DEVELOPMENT, so nothing breaks either way. Every page loads that
// file's values through `getEnvironment()` below. `resolveEnvironment()` itself is a PURE
// function of explicit inputs — no globals, no hostname sniffing — so it can be unit-tested with
// fixture inputs covering every real Netlify context, not just guessed at.
//
// This module is never the actual read/write security boundary (that's always Firestore/Storage
// rules re-checking uid/Owner-email server-side) — it only gates UI-level concerns: which
// Firebase config to load (see firebase-init.js), whether to show a "You are not in Production"
// banner, and whether Discover's own write calls are safe to run against whatever Firebase
// project this build is actually configured for (see isStagingWithoutIsolatedBackend() below).

export const ENV = Object.freeze({
  PRODUCTION: "production",
  STAGING: "staging",
  DEPLOY_PREVIEW: "deploy-preview",
  DEVELOPMENT: "development",
});

const PRODUCTION_HOST = "edenatlas.netlify.app";

// Pure — takes exactly what it needs, nothing read from `window`/`location` here. netlifyContext
// is Netlify's own build-time `CONTEXT` value: "production", "deploy-preview", or
// "branch-deploy" (see https://docs.netlify.com/configure-builds/environment-variables/
// #build-metadata). `branch` is Netlify's `BRANCH`. `hostname` is provided by the caller (real
// callers pass `location.hostname`; tests pass a fixture string) and is used ONLY as a
// last-resort fallback for contexts where no build ran at all (a plain static file server with
// no `npm run build` step) — never as the primary signal.
export function resolveEnvironment({ netlifyContext, branch, hostname } = {}) {
  if (netlifyContext === "production") return ENV.PRODUCTION;
  if (netlifyContext === "branch-deploy" && branch === "staging") return ENV.STAGING;
  if (netlifyContext === "deploy-preview") return ENV.DEPLOY_PREVIEW;
  if (netlifyContext === "branch-deploy") return ENV.DEPLOY_PREVIEW; // any other branch deploy: preview-like, never staging
  if (hostname === PRODUCTION_HOST) return ENV.PRODUCTION; // fallback safety net only, e.g. no build ever ran
  return ENV.DEVELOPMENT;
}

let cachedBuildInfo; // undefined = not looked up yet, null = looked up, none found
function readBuildInfo() {
  if (cachedBuildInfo !== undefined) return cachedBuildInfo;
  cachedBuildInfo = (typeof window !== "undefined" && window.__EDEN_BUILD__) || null;
  return cachedBuildInfo;
}

// Exposed for tests that want to force a fresh read after mutating window.__EDEN_BUILD__.
export function _resetBuildInfoCacheForTests() {
  cachedBuildInfo = undefined;
}

export function getBuildInfo() {
  return readBuildInfo();
}

export function getEnvironment() {
  const build = readBuildInfo();
  return resolveEnvironment({
    netlifyContext: build && build.context,
    branch: build && build.branch,
    hostname: typeof location !== "undefined" ? location.hostname : undefined,
  });
}

export function isProduction() {
  return getEnvironment() === ENV.PRODUCTION;
}

export function isStaging() {
  return getEnvironment() === ENV.STAGING;
}

export function isNonProduction() {
  return getEnvironment() !== ENV.PRODUCTION;
}

// True when this build resolves to Staging but has no dedicated staging Firebase project
// configured (see firebase-init.js's getFirebaseConfig()) — i.e. a Staging deploy that would
// otherwise be talking to the SAME Firestore/Storage project as Production. Callers (currently
// Discover's follow/status/remove/notification-subscribe writes — see discover.js) use this to
// fail closed on writes rather than silently letting a staging smoke test mutate production data.
// This is deliberately NOT "isStaging() alone" — once a real staging Firebase project is
// configured (STAGING_FIREBASE_* build env vars set), this flips to false automatically and
// staging becomes a normal, fully writable, isolated environment.
export function isStagingWithoutIsolatedBackend(currentProjectId, productionProjectId) {
  return isStaging() && currentProjectId === productionProjectId;
}

// Phase 1 safeguard: "Add an obvious non-Production indicator in staging." One shared
// implementation, called from both auth-guard.js (every protected page) and login.html's own
// inline module (the one page that intentionally doesn't load auth-guard.js — see that file's
// header comment) rather than duplicating the DOM/CSS in both places. Appended to <html>
// directly (a sibling of <body>) so it's visible even during the pre-auth-resolve window while
// body still carries auth-check-pending's opacity:0, same reasoning as js/splash.js's overlay
// and styles.css's html::before pulse mark.
export function mountNonProductionBanner(doc = document) {
  if (!isNonProduction() || doc.getElementById("eden-env-banner")) return null;
  const env = getEnvironment();
  const label = env === ENV.STAGING ? "STAGING" : env === ENV.DEPLOY_PREVIEW ? "DEPLOY PREVIEW" : "DEVELOPMENT";
  const bar = doc.createElement("div");
  bar.id = "eden-env-banner";
  bar.setAttribute("role", "status");
  bar.style.cssText =
    "position:fixed;top:0;left:0;right:0;z-index:99999;background:#f59e0b;color:#111827;" +
    "font:700 11px/1.7 ui-monospace,monospace;text-align:center;letter-spacing:.06em;padding:3px 10px;" +
    "pointer-events:none;";
  bar.textContent = `⚠ ${label} — this is not the live Production site.`;
  doc.documentElement.appendChild(bar);
  return bar;
}
