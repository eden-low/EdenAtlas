// Google redirects the browser here directly, so this endpoint intentionally has no Firebase
// Bearer-header requirement. Its authorization boundary is the short-lived, transactionally
// consumed OAuth state created only after a verified Firebase-authenticated start request.

const { FirebaseConfigError } = require("./lib/firebase-admin");
const {
  GOOGLE_CALENDAR_CONNECTIONS_COLLECTION,
  GOOGLE_CALENDAR_WRITE_INTENT,
  GOOGLE_CALENDAR_CAPABILITY_READONLY,
  GOOGLE_CALENDAR_CAPABILITY_WRITE_CONSENT_REQUIRED,
  GOOGLE_CALENDAR_CAPABILITY_WRITE_AUTHORIZED,
  GOOGLE_CALENDAR_OUTBOUND_POLICY,
  TOKEN_ENCRYPTION_VERSION,
  GoogleCalendarOAuthError,
  connectionCapability,
  connectionIsUsable,
  consumeOAuthState,
  exchangeAuthorizationCode,
  encryptRefreshToken,
  revokeOAuthToken,
} = require("./lib/google-calendar-oauth");
const { jsonResponse, requestBaseUrl, redirectResponse } = require("./lib/google-calendar-http");

function calendarReturnUrl(redirectUri, result) {
  const url = new URL("/calendar.html", new URL(redirectUri).origin);
  url.searchParams.set("googleCalendar", result);
  return url.toString();
}

function safeFailureCode(err, authorizationIntent = null) {
  if (!(err instanceof GoogleCalendarOAuthError)) return "connection_failed";
  if ([
    "oauth_state_invalid", "oauth_state_tampered", "oauth_state_wrong_environment",
    "oauth_state_wrong_redirect_uri", "oauth_state_wrong_uid", "oauth_state_replayed", "oauth_state_expired",
  ].includes(err.code)) return "state_rejected";
  if (authorizationIntent === GOOGLE_CALENDAR_WRITE_INTENT) {
    if (err.code === "authorization_denied") return "sync_permission_declined";
    if (err.code === "required_scope_not_granted") return "sync_scope_rejected";
    if (err.code === "refresh_token_missing") return "sync_reconsent_required";
    if (err.code === "write_upgrade_not_allowed") return "sync_reconsent_required";
  }
  if (err.code === "authorization_denied") return "connection_declined";
  if (err.code === "required_scope_not_granted") return "scope_rejected";
  if (err.code === "refresh_token_missing") return "reconnect_required";
  return "connection_failed";
}

function createHandler(deps) {
  return async function handler(event) {
    if (event.httpMethod !== "GET") {
      return jsonResponse(405, { ok: false, error: "method_not_allowed" }, { Allow: "GET" });
    }

    let config;
    try {
      config = deps.getOAuthConfig();
      await deps.ensureFirebaseAdmin();
    } catch (err) {
      const stage = err instanceof FirebaseConfigError ? err.stage : ((err && err.code) || "configuration");
      console.error(`[google-calendar-oauth-callback] unavailable: stage=${stage}`);
      return jsonResponse(503, { ok: false, error: "google_calendar_not_configured" });
    }

    if (requestBaseUrl(event) !== config.redirectUri) {
      return jsonResponse(400, { ok: false, error: "redirect_uri_mismatch" });
    }

    const query = event.queryStringParameters || {};
    const now = deps.now ? deps.now() : new Date();
    let refreshToken = null;
    let authorizationIntent = null;
    try {
      const consumed = await consumeOAuthState({
        db: deps.getDb(),
        state: query.state,
        expectedEnvironment: config.environment,
        expectedRedirectUri: config.redirectUri,
        masterKeyRaw: config.masterKeyRaw,
        now,
      });
      authorizationIntent = consumed.authorizationIntent;
      // UID is exclusively the signed, server-stored state binding. A callback-supplied uid is
      // never needed by Google and is rejected even if it happens to match.
      if (Object.prototype.hasOwnProperty.call(query, "uid")) {
        throw new GoogleCalendarOAuthError("oauth_state_wrong_uid");
      }
      if (query.error) throw new GoogleCalendarOAuthError("authorization_denied");
      const connectionRef = deps.getDb().collection(GOOGLE_CALENDAR_CONNECTIONS_COLLECTION).doc(consumed.uid);
      let existingConnection = null;
      if (authorizationIntent === GOOGLE_CALENDAR_WRITE_INTENT) {
        const existingSnapshot = await connectionRef.get();
        existingConnection = existingSnapshot && existingSnapshot.exists ? (existingSnapshot.data() || {}) : null;
        const existingCapability = connectionCapability(existingConnection);
        if (!connectionIsUsable(existingConnection)
            || ![GOOGLE_CALENDAR_CAPABILITY_READONLY, GOOGLE_CALENDAR_CAPABILITY_WRITE_CONSENT_REQUIRED]
              .includes(existingCapability)) {
          throw new GoogleCalendarOAuthError("write_upgrade_not_allowed", 409);
        }
      }
      const tokenResult = await exchangeAuthorizationCode({
        fetchImpl: deps.fetchImpl,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri: config.redirectUri,
        code: query.code,
        authorizationIntent,
      });
      refreshToken = tokenResult.refreshToken;
      const encryptedRefreshToken = encryptRefreshToken({
        refreshToken,
        uid: consumed.uid,
        masterKeyRaw: config.masterKeyRaw,
        randomBytesImpl: deps.randomBytesImpl,
      });
      const writeAuthorized = tokenResult.capability === GOOGLE_CALENDAR_CAPABILITY_WRITE_AUTHORIZED;
      await connectionRef.set({
        uid: consumed.uid,
        provider: "google_calendar",
        status: "connected",
        grantedScopes: tokenResult.grantedScopes,
        capabilityStatus: tokenResult.capability,
        outboundCalendarPolicy: GOOGLE_CALENDAR_OUTBOUND_POLICY,
        outboundCalendarId: null,
        encryptedRefreshToken,
        tokenEncryptionVersion: TOKEN_ENCRYPTION_VERSION,
        connectedAt: existingConnection && existingConnection.connectedAt ? existingConnection.connectedAt : now,
        writeAuthorizedAt: writeAuthorized ? now : null,
        updatedAt: now,
        reconnectRequired: false,
        lastErrorCode: null,
      });
      refreshToken = null;
      return redirectResponse(calendarReturnUrl(
        config.redirectUri,
        writeAuthorized ? "sync_permission_enabled" : "connected",
      ));
    } catch (err) {
      if (refreshToken) await revokeOAuthToken({ fetchImpl: deps.fetchImpl, token: refreshToken });
      const safeCode = safeFailureCode(err, authorizationIntent);
      console.error(`[google-calendar-oauth-callback] connection rejected: code=${safeCode}`);
      return redirectResponse(calendarReturnUrl(config.redirectUri, safeCode));
    }
  };
}

const { buildGoogleCalendarDeps } = require("./lib/google-calendar-runtime");
exports.handler = createHandler(buildGoogleCalendarDeps());
exports.createHandler = createHandler;
exports.calendarReturnUrl = calendarReturnUrl;
exports.safeFailureCode = safeFailureCode;
