// Google redirects the browser here directly, so this endpoint intentionally has no Firebase
// Bearer-header requirement. Its authorization boundary is the short-lived, transactionally
// consumed OAuth state created only after a verified Firebase-authenticated start request.

const { FirebaseConfigError } = require("./lib/firebase-admin");
const {
  GOOGLE_CALENDAR_CONNECTIONS_COLLECTION,
  TOKEN_ENCRYPTION_VERSION,
  GoogleCalendarOAuthError,
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

function safeFailureCode(err) {
  if (!(err instanceof GoogleCalendarOAuthError)) return "connection_failed";
  if ([
    "oauth_state_invalid", "oauth_state_tampered", "oauth_state_wrong_environment",
    "oauth_state_wrong_redirect_uri", "oauth_state_wrong_uid", "oauth_state_replayed", "oauth_state_expired",
  ].includes(err.code)) return "state_rejected";
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
    try {
      const consumed = await consumeOAuthState({
        db: deps.getDb(),
        state: query.state,
        expectedEnvironment: config.environment,
        expectedRedirectUri: config.redirectUri,
        masterKeyRaw: config.masterKeyRaw,
        now,
      });
      // UID is exclusively the signed, server-stored state binding. A callback-supplied uid is
      // never needed by Google and is rejected even if it happens to match.
      if (Object.prototype.hasOwnProperty.call(query, "uid")) {
        throw new GoogleCalendarOAuthError("oauth_state_wrong_uid");
      }
      if (query.error) throw new GoogleCalendarOAuthError("authorization_denied");
      const tokenResult = await exchangeAuthorizationCode({
        fetchImpl: deps.fetchImpl,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri: config.redirectUri,
        code: query.code,
      });
      refreshToken = tokenResult.refreshToken;
      const encryptedRefreshToken = encryptRefreshToken({
        refreshToken,
        uid: consumed.uid,
        masterKeyRaw: config.masterKeyRaw,
        randomBytesImpl: deps.randomBytesImpl,
      });
      await deps.getDb().collection(GOOGLE_CALENDAR_CONNECTIONS_COLLECTION).doc(consumed.uid).set({
        uid: consumed.uid,
        provider: "google_calendar",
        status: "connected",
        grantedScopes: tokenResult.grantedScopes,
        encryptedRefreshToken,
        tokenEncryptionVersion: TOKEN_ENCRYPTION_VERSION,
        connectedAt: now,
        updatedAt: now,
        reconnectRequired: false,
        lastErrorCode: null,
      });
      refreshToken = null;
      return redirectResponse(calendarReturnUrl(config.redirectUri, "connected"));
    } catch (err) {
      if (refreshToken) await revokeOAuthToken({ fetchImpl: deps.fetchImpl, token: refreshToken });
      const safeCode = safeFailureCode(err);
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
