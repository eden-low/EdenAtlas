// Starts the separate, incremental Google Calendar consent flow. This does not modify Firebase
// login and never accepts a uid or OAuth scope from the browser.

const { FirebaseConfigError } = require("./lib/firebase-admin");
const {
  createOAuthState,
  buildAuthorizationUrl,
  parseOAuthStartRequest,
  connectionCapability,
  connectionIsUsable,
  GOOGLE_CALENDAR_WRITE_INTENT,
  GOOGLE_CALENDAR_CAPABILITY_READONLY,
  GOOGLE_CALENDAR_CAPABILITY_WRITE_CONSENT_REQUIRED,
  GOOGLE_CALENDAR_CAPABILITY_WRITE_AUTHORIZED,
  GOOGLE_CALENDAR_CONNECTIONS_COLLECTION,
  GOOGLE_CALENDAR_OAUTH_STATES_COLLECTION,
  GoogleCalendarOAuthError,
} = require("./lib/google-calendar-oauth");
const {
  jsonResponse,
  checkPostRequest,
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

    const parsed = parseOAuthStartRequest(event.body);
    if (parsed.error) return jsonResponse(400, { ok: false, error: parsed.error }, responseHeaders);
    const authorizationIntent = parsed.value.authorizationIntent;

    const now = deps.now ? deps.now() : new Date();
    const burst = deps.checkBurst(`${BURST_PREFIX}${uid}`, now.getTime());
    if (!burst.allowed) {
      return jsonResponse(429, { ok: false, error: "rate_limited", retryAfterMs: burst.retryAfterMs }, {
        ...responseHeaders,
        "Retry-After": String(Math.ceil(burst.retryAfterMs / 1000)),
      });
    }

    try {
      const db = deps.getDb();
      const pending = createOAuthState({
        uid,
        environment: config.environment,
        redirectUri: config.redirectUri,
        authorizationIntent,
        masterKeyRaw: config.masterKeyRaw,
        now,
        randomBytesImpl: deps.randomBytesImpl,
      });
      const stateRef = db
        .collection(GOOGLE_CALENDAR_OAUTH_STATES_COLLECTION)
        .doc(pending.stateHash);
      if (authorizationIntent === GOOGLE_CALENDAR_WRITE_INTENT) {
        const connectionRef = db.collection(GOOGLE_CALENDAR_CONNECTIONS_COLLECTION).doc(uid);
        await db.runTransaction(async (transaction) => {
          const snapshot = await transaction.get(connectionRef);
          const connection = snapshot && snapshot.exists ? (snapshot.data() || {}) : null;
          const capability = connectionCapability(connection);
          if (!connectionIsUsable(connection)) {
            throw new GoogleCalendarOAuthError("google_calendar_reconnect_required", 409);
          }
          if (capability === GOOGLE_CALENDAR_CAPABILITY_WRITE_AUTHORIZED) {
            throw new GoogleCalendarOAuthError("google_calendar_write_already_authorized", 409);
          }
          if (![GOOGLE_CALENDAR_CAPABILITY_READONLY, GOOGLE_CALENDAR_CAPABILITY_WRITE_CONSENT_REQUIRED]
            .includes(capability)) {
            throw new GoogleCalendarOAuthError("google_calendar_write_upgrade_not_allowed", 409);
          }
          transaction.set(stateRef, pending.record);
          transaction.set(connectionRef, {
            capabilityStatus: GOOGLE_CALENDAR_CAPABILITY_WRITE_CONSENT_REQUIRED,
            writeConsentRequestedAt: now,
            updatedAt: now,
          }, { merge: true });
        });
      } else {
        await stateRef.set(pending.record);
      }
      const authorizationUrl = buildAuthorizationUrl({
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        state: pending.state,
        authorizationIntent,
      });
      return jsonResponse(200, {
        ok: true,
        authorizationUrl,
        expiresAt: pending.record.expiresAt.toISOString(),
      }, responseHeaders);
    } catch (err) {
      if (err instanceof GoogleCalendarOAuthError && err.statusCode === 409) {
        return jsonResponse(409, { ok: false, error: err.code }, responseHeaders);
      }
      console.error(`[google-calendar-oauth-start] start failed: code=${(err && err.code) || "internal"}`);
      return jsonResponse(500, { ok: false, error: "google_calendar_oauth_start_failed" }, responseHeaders);
    }
  };
}

const { buildGoogleCalendarDeps } = require("./lib/google-calendar-runtime");
exports.handler = createHandler(buildGoogleCalendarDeps());
exports.createHandler = createHandler;
