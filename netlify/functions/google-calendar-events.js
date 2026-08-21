// Authenticated, on-demand Google Calendar read. Events and access tokens are never persisted.

const { FirebaseConfigError } = require("./lib/firebase-admin");
const {
  GOOGLE_CALENDAR_CONNECTIONS_COLLECTION,
  decryptRefreshToken,
  encryptedTokenEnvelopeIsValid,
} = require("./lib/google-calendar-oauth");
const {
  GoogleCalendarReadError,
  parseEventsRequest,
  hasExactReadOnlyScope,
  refreshGoogleAccessToken,
  listPrimaryCalendarEvents,
} = require("./lib/google-calendar-events");
const {
  jsonResponse,
  checkPostRequest,
  authenticateFirebaseUser,
} = require("./lib/google-calendar-http");

const BURST_PREFIX = "google-calendar-events:";

function connectionResponse(connectionStatus) {
  return {
    ok: true,
    connectionStatus,
    events: [],
    ...(connectionStatus === "reconnect_required" ? { reconnectRequired: true } : {}),
  };
}

async function markReconnectRequired(connectionRef, now, lastErrorCode) {
  await connectionRef.set({
    status: "reconnect_required",
    reconnectRequired: true,
    lastErrorCode,
    updatedAt: now,
  }, { merge: true });
}

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
      console.error(`[google-calendar-events] unavailable: stage=${stage}`);
      return jsonResponse(503, { ok: false, error: "google_calendar_not_configured" }, responseHeaders);
    }

    const authResult = await authenticateFirebaseUser(event, deps, responseHeaders);
    if (authResult.response) return authResult.response;
    const uid = authResult.decoded.uid;

    const parsed = parseEventsRequest(event.body);
    if (parsed.error) return jsonResponse(400, { ok: false, error: parsed.error }, responseHeaders);

    const now = deps.now ? deps.now() : new Date();
    const burst = deps.checkBurst(`${BURST_PREFIX}${uid}`, now.getTime());
    if (!burst.allowed) {
      return jsonResponse(429, { ok: false, error: "rate_limited", retryAfterMs: burst.retryAfterMs }, {
        ...responseHeaders,
        "Retry-After": String(Math.ceil(burst.retryAfterMs / 1000)),
      });
    }

    let connectionRef;
    let connection;
    try {
      connectionRef = deps.getDb().collection(GOOGLE_CALENDAR_CONNECTIONS_COLLECTION).doc(uid);
      const snapshot = await connectionRef.get();
      if (!snapshot || !snapshot.exists) return jsonResponse(200, connectionResponse("disconnected"), responseHeaders);
      connection = snapshot.data() || {};
    } catch {
      return jsonResponse(500, { ok: false, error: "google_calendar_connection_failed" }, responseHeaders);
    }

    if (connection.status !== "connected" || connection.reconnectRequired === true) {
      return jsonResponse(200, connectionResponse("reconnect_required"), responseHeaders);
    }
    if (!hasExactReadOnlyScope(connection.grantedScopes)) {
      try {
        await markReconnectRequired(connectionRef, now, "unexpected_scope_set");
      } catch {
        return jsonResponse(500, { ok: false, error: "google_calendar_connection_failed" }, responseHeaders);
      }
      return jsonResponse(200, connectionResponse("reconnect_required"), responseHeaders);
    }
    if (!encryptedTokenEnvelopeIsValid(connection.encryptedRefreshToken)) {
      return jsonResponse(500, { ok: false, error: "google_calendar_connection_invalid" }, responseHeaders);
    }

    let refreshToken = null;
    let accessToken = null;
    try {
      refreshToken = decryptRefreshToken({
        encryptedToken: connection.encryptedRefreshToken,
        uid,
        masterKeyRaw: config.masterKeyRaw,
      });
      accessToken = await refreshGoogleAccessToken({
        fetchImpl: deps.fetchImpl,
        config,
        refreshToken,
      });

      let result;
      try {
        result = await listPrimaryCalendarEvents({
          fetchImpl: deps.fetchImpl,
          accessToken,
          start: parsed.value.start,
          end: parsed.value.end,
        });
      } catch (err) {
        if (!(err instanceof GoogleCalendarReadError) || err.code !== "calendar_api_unauthorized") throw err;
        accessToken = await refreshGoogleAccessToken({
          fetchImpl: deps.fetchImpl,
          config,
          refreshToken,
        });
        try {
          result = await listPrimaryCalendarEvents({
            fetchImpl: deps.fetchImpl,
            accessToken,
            start: parsed.value.start,
            end: parsed.value.end,
          });
        } catch (retryErr) {
          if (retryErr instanceof GoogleCalendarReadError && retryErr.code === "calendar_api_unauthorized") {
            throw new GoogleCalendarReadError("calendar_api_unauthorized", 401, { reconnectRequired: true });
          }
          throw retryErr;
        }
      }

      return jsonResponse(200, {
        ok: true,
        connectionStatus: "connected",
        events: result.events,
        truncated: result.truncated,
      }, responseHeaders);
    } catch (err) {
      const safeError = err instanceof GoogleCalendarReadError ? err : null;
      if (safeError && safeError.reconnectRequired) {
        const lastErrorCode = safeError.code === "reconnect_required"
          ? "refresh_token_rejected"
          : safeError.code === "unexpected_scope_set"
            ? "unexpected_scope_set"
            : "calendar_api_unauthorized";
        try {
          await markReconnectRequired(connectionRef, now, lastErrorCode);
        } catch {
          return jsonResponse(500, { ok: false, error: "google_calendar_connection_failed" }, responseHeaders);
        }
        return jsonResponse(200, connectionResponse("reconnect_required"), responseHeaders);
      }
      const code = safeError ? safeError.code : "calendar_read_failed";
      const statusCode = safeError ? safeError.statusCode : 500;
      console.error(`[google-calendar-events] read failed: code=${code}`);
      return jsonResponse(statusCode, { ok: false, error: code }, responseHeaders);
    } finally {
      refreshToken = null;
      accessToken = null;
    }
  };
}

const { buildGoogleCalendarDeps } = require("./lib/google-calendar-runtime");
exports.handler = createHandler(buildGoogleCalendarDeps());
exports.createHandler = createHandler;
exports.connectionResponse = connectionResponse;
