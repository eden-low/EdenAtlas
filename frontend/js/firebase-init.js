// Shared Firebase setup, imported by any page that needs auth/data (currently gallery.js;
// future phases like notes/dashboard widgets will reuse this same module).
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, setPersistence, browserLocalPersistence, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { getFirestore, connectFirestoreEmulator } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { getStorage, connectStorageEmulator } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-storage.js";
import { ENV, getBuildInfo, getEnvironment, isPreProduction, selectFirebaseConfig } from "./environment.js";

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

// Tier-1 authenticated E2E is deliberately a real Firebase Auth/Firestore/Storage flow against
// local emulators, never an authorization bypass. The marker is generated only in the temporary
// E2E site (it is not a tracked/deployed build-info value), and every field is pinned here rather
// than accepted from a caller. Even if someone manually defines window.__EDEN_E2E__ on a deployed
// page, the hostname + explicit DEV/DEVELOPMENT checks throw before Firebase initializes.
const LOCAL_E2E_PROJECT_ID = "demo-edenatlas-e2e";
const LOCAL_E2E_OWNER_EMAIL = "owner@edenatlas-e2e.invalid";
const LOCAL_E2E_TOPOLOGY = Object.freeze({
  auth: Object.freeze({ host: "127.0.0.1", port: 9099 }),
  firestore: Object.freeze({ host: "127.0.0.1", port: 8080 }),
  storage: Object.freeze({ host: "127.0.0.1", port: 9199 }),
});

function readLocalE2EConfig() {
  const marker = typeof window !== "undefined" ? window.__EDEN_E2E__ : null;
  if (!marker) return null;

  const environment = getEnvironment();
  const hostname = typeof location !== "undefined" ? location.hostname : "";
  const isLoopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  const isLocalEnvironment = environment === ENV.DEV || environment === ENV.DEVELOPMENT;
  const hasExactMarker = Object.keys(marker).sort().join(",") === "enabled,projectId"
    && marker.enabled === true
    && marker.projectId === LOCAL_E2E_PROJECT_ID;

  if (!isLoopback || !isLocalEnvironment || !hasExactMarker) {
    throw new Error("Local E2E Firebase configuration rejected outside the pinned demo/loopback environment");
  }

  return Object.freeze({
    projectId: LOCAL_E2E_PROJECT_ID,
    ownerEmail: LOCAL_E2E_OWNER_EMAIL,
    topology: LOCAL_E2E_TOPOLOGY,
  });
}

const buildInfo = getBuildInfo();
const preProdOverride = isPreProduction() && buildInfo && buildInfo.stagingFirebaseConfig;
const localE2EConfig = readLocalE2EConfig();
const firebaseConfig = localE2EConfig
  ? Object.freeze({
      apiKey: "demo-only-not-a-live-key",
      authDomain: "127.0.0.1",
      projectId: LOCAL_E2E_PROJECT_ID,
      storageBucket: `${LOCAL_E2E_PROJECT_ID}.appspot.com`,
      messagingSenderId: "0",
      appId: "1:0:web:demo-edenatlas-e2e",
    })
  : selectFirebaseConfig({
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
export const db = getFirestore(app);
export const storage = getStorage(app);

if (localE2EConfig) {
  connectAuthEmulator(
    auth,
    `http://${localE2EConfig.topology.auth.host}:${localE2EConfig.topology.auth.port}`,
    { disableWarnings: true }
  );
  connectFirestoreEmulator(
    db,
    localE2EConfig.topology.firestore.host,
    localE2EConfig.topology.firestore.port
  );
  connectStorageEmulator(
    storage,
    localE2EConfig.topology.storage.host,
    localE2EConfig.topology.storage.port
  );
}

// Read-only diagnostics for the local Playwright preflight. Null in every normal deployment.
export const LOCAL_E2E_RUNTIME = localE2EConfig
  ? Object.freeze({ projectId: localE2EConfig.projectId, topology: localE2EConfig.topology })
  : null;

// Explicit rather than relying on the SDK default so the PWA (standalone launch,
// no browser chrome) reliably keeps the session across relaunches.
setPersistence(auth, browserLocalPersistence).catch(console.error);
export const googleProvider = new GoogleAuthProvider();

// The single site owner — always allowed to write, and the only role that sees admin UI
// (System Logs, Whitelist Management). Everyone else is either an approved friend (own
// private data space, granted via the `friends` Firestore collection — see firestore.rules)
// or a plain viewer (read-only, public content only).
const PRODUCT_OWNER_EMAIL = "jjun8647@gmail.com";
export const OWNER_EMAIL = localE2EConfig ? LOCAL_E2E_OWNER_EMAIL : PRODUCT_OWNER_EMAIL;

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
