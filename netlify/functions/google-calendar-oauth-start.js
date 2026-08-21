// Starts the separate, incremental Google Calendar consent flow. This does not modify Firebase
// login and never accepts a uid or OAuth scope from the browser.

const { FirebaseConfigError } = require("./lib/firebase-admin");
const {
  createOAuthState,
  buildAuthorizationUrl,
  GOOGLE_CALENDAR_OAUTH_STATES_COLLECTION,
} = require("./lib/google-calendar-oauth");
const {
  jsonResponse,
  checkPostRequest,
  parseEmptyObjectBody,
  authenticateFirebaseUser,
} = require("./lib/google-calendar-http");

const BURST_PREFIX = "google-calendar-oauth-start:";

function createHandler(deps) {
  return async function handler(event) {
    const env = deps.env || process.env;
    const requestCheck = checkPostRequest(event, env);
    if (requestCheck.handled) return requestCheck.response;
    const responseHeaders = requestCheck.headers;

    let config;
    try {
      config = deps.getOAuthConfig();
      await deps.ensureFirebaseAdmin();
    } catch (err) {
      const stage = err instanceof FirebaseConfigError ? err.stage : ((err && err.code) || "configuration");
      console.error(`[google-calendar-oauth-start] unavailable: stage=${stage}`);
      return jsonResponse(503, { ok: false, error: "google_calendar_not_configured" }, responseHeaders);
    }

    const authResult = await authenticateFirebaseUser(event, deps, responseHeaders);
    if (authResult.response) return authResult.response;
    const uid = authResult.decoded.uid;

    const parsed = parseEmptyObjectBody(event.body);
    if (parsed.error) return jsonResponse(400, { ok: false, error: parsed.error }, responseHeaders);

    const now = deps.now ? deps.now() : new Date();
    const burst = deps.checkBurst(`${BURST_PREFIX}${uid}`, now.getTime());
    if (!burst.allowed) {
      return jsonResponse(429, { ok: false, error: "rate_limited", retryAfterMs: burst.retryAfterMs }, {
        ...responseHeaders,
        "Retry-After": String(Math.ceil(burst.retryAfterMs / 1000)),
      });
    }

    try {
      const pending = createOAuthState({
        uid,
        environment: config.environment,
        redirectUri: config.redirectUri,
        masterKeyRaw: config.masterKeyRaw,
        now,
        randomBytesImpl: deps.randomBytesImpl,
      });
      await deps.getDb()
        .collection(GOOGLE_CALENDAR_OAUTH_STATES_COLLECTION)
        .doc(pending.stateHash)
        .set(pending.record);
      const authorizationUrl = buildAuthorizationUrl({
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        state: pending.state,
      });
      return jsonResponse(200, {
        ok: true,
        authorizationUrl,
        expiresAt: pending.record.expiresAt.toISOString(),
      }, responseHeaders);
    } catch (err) {
      console.error(`[google-calendar-oauth-start] start failed: code=${(err && err.code) || "internal"}`);
      return jsonResponse(500, { ok: false, error: "google_calendar_oauth_start_failed" }, responseHeaders);
    }
  };
}

const { buildGoogleCalendarDeps } = require("./lib/google-calendar-runtime");
exports.handler = createHandler(buildGoogleCalendarDeps());
exports.createHandler = createHandler;
