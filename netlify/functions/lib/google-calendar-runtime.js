const { initializeApp, cert, getApps, getApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const { initializeFirebaseAdmin } = require("./firebase-admin");
const { readGeneratedBuildContext, isStagingBuildContext } = require("./build-context");
const { withGeneratedDeployOrigins, normalizeExactOrigin } = require("./google-calendar-http");
const { parseMasterKey, validateHttpsOrLocalRedirect } = require("./google-calendar-oauth");
const { checkBurst } = require("./rate-limit");
const { createCalendarEventStore } = require("./calendar-event-store");
const { createCalendarEventIdentity } = require("./calendar-event-identity");

const REQUIRED_OAUTH_ENV = [
  "GOOGLE_CALENDAR_CLIENT_ID",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  "GOOGLE_CALENDAR_REDIRECT_URI",
  "GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY",
];
const GOOGLE_CALENDAR_CALLBACK_PATH = "/.netlify/functions/google-calendar-oauth-callback";

function resolveCalendarEnvironment(buildContext) {
  if (buildContext && buildContext.context === "production" && buildContext.branch === "main") return "production";
  if (isStagingBuildContext(buildContext)) return "staging";
  if (buildContext && buildContext.context === "dev") return "development";
  return null;
}

function readOAuthConfig(env, environment) {
  const missing = REQUIRED_OAUTH_ENV.filter((key) => typeof env[key] !== "string" || !env[key].trim());
  if (missing.length || !environment) {
    const err = new Error("google_calendar_not_configured");
    err.code = "google_calendar_not_configured";
    throw err;
  }
  const redirectUri = validateHttpsOrLocalRedirect(env.GOOGLE_CALENDAR_REDIRECT_URI.trim());
  const redirect = new URL(redirectUri);
  const isLoopback = redirect.hostname === "localhost" || redirect.hostname === "127.0.0.1" || redirect.hostname === "[::1]";
  const productionOrigins = String(env.ALLOWED_ORIGIN || "").split(",").map(normalizeExactOrigin).filter(Boolean);
  const stagingOrigins = [env.DEPLOY_PRIME_URL, env.DEPLOY_URL].map(normalizeExactOrigin).filter(Boolean);
  const originMatchesDeploy = environment === "production"
    ? productionOrigins.includes(redirect.origin)
    : environment === "staging"
      ? stagingOrigins.includes(redirect.origin)
      : isLoopback;
  if (redirect.pathname !== GOOGLE_CALENDAR_CALLBACK_PATH
      || !originMatchesDeploy
      || (environment === "development" ? !isLoopback : redirect.protocol !== "https:")) {
    const err = new Error("google_calendar_not_configured");
    err.code = "google_calendar_not_configured";
    throw err;
  }
  parseMasterKey(env.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY);
  return {
    clientId: env.GOOGLE_CALENDAR_CLIENT_ID.trim(),
    clientSecret: env.GOOGLE_CALENDAR_CLIENT_SECRET.trim(),
    redirectUri,
    masterKeyRaw: env.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY.trim(),
    environment,
  };
}

function buildGoogleCalendarDeps() {
  const buildContext = readGeneratedBuildContext();
  const environment = resolveCalendarEnvironment(buildContext);
  const env = withGeneratedDeployOrigins(process.env);
  let app = null;
  let canonicalStore = null;

  function ensureApp() {
    if (app) return app;
    app = initializeFirebaseAdmin({
      getApps,
      getApp,
      initializeApp,
      cert,
      projectId: process.env.FIREBASE_PROJECT_ID,
      serviceAccountRaw: process.env.FIREBASE_SERVICE_ACCOUNT,
      buildContext,
    });
    return app;
  }

  return {
    env,
    now: () => new Date(),
    ensureFirebaseAdmin: async () => { ensureApp(); },
    verifyIdToken: (token) => getAuth(ensureApp()).verifyIdToken(token, true),
    getDb: () => getFirestore(ensureApp()),
    getCanonicalStore: () => {
      if (!canonicalStore) {
        canonicalStore = createCalendarEventStore({
          db: getFirestore(ensureApp()),
          now: () => new Date(),
          identity: createCalendarEventIdentity(env.CALENDAR_IDENTITY_KEY),
        });
      }
      return canonicalStore;
    },
    getProviderIdentityKey: () => env.CALENDAR_IDENTITY_KEY,
    getOAuthConfig: () => readOAuthConfig(env, environment),
    checkBurst,
    fetchImpl: undefined,
  };
}

module.exports = {
  REQUIRED_OAUTH_ENV,
  GOOGLE_CALENDAR_CALLBACK_PATH,
  resolveCalendarEnvironment,
  readOAuthConfig,
  buildGoogleCalendarDeps,
};
