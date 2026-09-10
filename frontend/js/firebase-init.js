// Shared Firebase setup, imported by any page that needs auth/data (currently gallery.js;
// future phases like notes/dashboard widgets will reuse this same module).
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-storage.js";
import { getBuildInfo, getEnvironment, isPreProduction, selectFirebaseConfig } from "./environment.js";

// authDomain controls where Firebase's OAuth handler page (/__/auth/handler) lives. The default,
// {project}.firebaseapp.com, is a third-party origin relative to this site — on iOS, a
// home-screen-installed ("standalone") PWA uses a storage partition that does not reliably
// survive a round trip through a different top-level origin, which is why signInWithRedirect
// used to strand standalone users on Google's page with no way back (see login.html). Pointing
// authDomain at this site's own production host instead — with netlify.toml proxying
// /__/auth/* through to the real Firebase handler — keeps the whole OAuth handshake same-origin
// from the browser's point of view, which fixes that. This only works when actually served from
// that host (the proxy rule is Netlify-only), so every other context (localhost, `file://`,
// Netlify deploy previews) falls back to the original Firebase-hosted authDomain, where the
// proxy doesn't exist but the default flow still works. Requires this host to be listed under
// Firebase Console -> Authentication -> Settings -> Authorized domains, and
// `https://edenatlas.netlify.app/__/auth/handler` to be an Authorized redirect URI on the
// matching Google Cloud OAuth 2.0 Client ID — both are manual console steps, not code.
const PRODUCTION_HOST = "edenatlas.netlify.app";
const DEFAULT_AUTH_DOMAIN = "lfj-profolio.firebaseapp.com";
const authDomain =
  typeof location !== "undefined" && location.hostname === PRODUCTION_HOST
    ? PRODUCTION_HOST
    : DEFAULT_AUTH_DOMAIN;

const PRODUCTION_PROJECT_ID = "lfj-profolio";
const productionFirebaseConfig = {
  apiKey: "AIzaSyBLJmKmn4Nwc2Ad3CG_KoPAn96HSfuvvU8",
  authDomain,
  projectId: PRODUCTION_PROJECT_ID,
  storageBucket: "lfj-profolio.firebasestorage.app",
  messagingSenderId: "173360347563",
  appId: "1:173360347563:web:961b3118bce0a8232c3aee",
};

// Deploy-context policy follow-up: "Prefer a separate Firebase staging project," now applied to
// every PRE-PRODUCTION deploy (js/environment.js's isPreProduction() — the literal `staging`
// branch AND every other Deploy Preview/branch deploy, never guessed from hostname), not just the
// literal `staging` branch as an earlier version of this file checked. Activates ONLY when
// scripts/generate-build-info.js found all six STAGING_FIREBASE_* env vars set — see that
// script's readStagingFirebaseConfig() for why a partial set never activates.
//
// "Never silently fall back from staging/preview to Production Firebase": when pre-production has
// NO staging override configured, this now initializes against an INERT, deliberately-invalid
// placeholder project — never Production's real config — so a misconfigured pre-production
// deploy's Firebase calls fail loudly (wrong-project errors) instead of quietly reading/writing
// real Production data merely because a Google sign-in happens to succeed against it. isOwner()/
// firestore.rules would normally be the safety net for OTHER users, but the Owner's own account
// is exactly the one identity that always passes those checks, so this app-level check is the
// real boundary here.
const PREPRODUCTION_PLACEHOLDER_CONFIG = {
  apiKey: "unconfigured-preproduction-build",
  authDomain: "eden-preproduction-not-configured.firebaseapp.com",
  projectId: "eden-preproduction-not-configured",
  storageBucket: "eden-preproduction-not-configured.firebasestorage.app",
  messagingSenderId: "0",
  appId: "1:0:web:unconfigured",
};

// Local/unknown builds have no browser-emulator wiring today. Fail closed against a distinct
// inert project instead of silently initializing the Production SDK while local Functions are
// intentionally emulator-only.
const DEVELOPMENT_PLACEHOLDER_CONFIG = {
  apiKey: "unconfigured-development-build",
  authDomain: "eden-development-not-configured.firebaseapp.com",
  projectId: "eden-development-not-configured",
  storageBucket: "eden-development-not-configured.firebasestorage.app",
  messagingSenderId: "0",
  appId: "1:0:web:unconfigured-development",
};

const buildInfo = getBuildInfo();
const preProdOverride = isPreProduction() && buildInfo && buildInfo.stagingFirebaseConfig;
const firebaseConfig = selectFirebaseConfig({
  environment: getEnvironment(),
  productionConfig: productionFirebaseConfig,
  stagingConfig: preProdOverride,
  preProductionPlaceholderConfig: PREPRODUCTION_PLACEHOLDER_CONFIG,
  developmentPlaceholderConfig: DEVELOPMENT_PLACEHOLDER_CONFIG,
});

// Exported so callers (Discover's follow/status/remove/notification writes; any future module
// that wants the same guard) can decide whether it's safe to write, without each one having to
// re-derive "is this pre-production without its own isolated project" itself.
export const ACTIVE_PROJECT_ID = firebaseConfig.projectId;
export function isUsingIsolatedStagingBackend() {
  return isPreProduction() && !!preProdOverride;
}
// True whenever this is ANY pre-production deploy not confirmed to be using its own isolated
// Firebase project — deliberately NOT a project-id string comparison (the old implementation
// compared ACTIVE_PROJECT_ID against Production's id, which silently stopped catching the unsafe
// case the moment the fallback stopped being literally Production's config, e.g. the placeholder
// above) — this is why the check is a direct function of isUsingIsolatedStagingBackend() instead.
export function isStagingWritesUnsafe() {
  return isPreProduction() && !isUsingIsolatedStagingBackend();
}

const app = initializeApp(firebaseConfig);
// Exported (Phase 4) so js/push-notifications.js can call getMessaging(app), and so it can hand
// the SAME config this page is actually using (Production or a configured Staging project) to
// service-worker.js via postMessage — the service worker has no module scope of its own and
// can't import this file, so this is the only way it learns which Firebase project to initialize
// for background push. Not a secret (see the comment on firebaseConfig.apiKey above).
export { app, firebaseConfig };

export const auth = getAuth(app);
// Explicit rather than relying on the SDK default so the PWA (standalone launch,
// no browser chrome) reliably keeps the session across relaunches.
setPersistence(auth, browserLocalPersistence).catch(console.error);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);
export const storage = getStorage(app);

// The single site owner — always allowed to write, and the only role that sees admin UI
// (System Logs, Whitelist Management). Everyone else is either an approved friend (own
// private data space, granted via the `friends` Firestore collection — see firestore.rules)
// or a plain viewer (read-only, public content only).
export const OWNER_EMAIL = "jjun8647@gmail.com";

export function isOwner(user) {
  return !!user
    && user.emailVerified === true
    && user.email?.toLowerCase() === OWNER_EMAIL;
}

// Role is decided once at login time (see login.html) and cached here — real enforcement is
// always the Firestore/Storage rules re-checking `friends` fresh, this is UI gating only.
export const USER_MODE_KEY = "lfj:userMode";

export function getUserMode() {
  return localStorage.getItem(USER_MODE_KEY) || "VIEWER";
}

export function canParticipate() {
  if (auth.currentUser?.emailVerified !== true) return false;
  const mode = getUserMode();
  return mode === "OWNER" || mode === "FRIEND";
}
