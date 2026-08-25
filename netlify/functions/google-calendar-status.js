// Returns connection metadata only. This endpoint never decrypts or serializes OAuth credentials.

const { FirebaseConfigError } = require("./lib/firebase-admin");
const {
  GOOGLE_CALENDAR_CONNECTIONS_COLLECTION,
  connectionCapability,
  connectionIsUsable,
} = require("./lib/google-calendar-oauth");
const {
  jsonResponse,
  checkPostRequest,
  parseEmptyObjectBody,
  authenticateFirebaseUser,
} = require("./lib/google-calendar-http");

function isoOrNull(value) {
  const date = value instanceof Date ? value : (value && typeof value.toDate === "function" ? value.toDate() : null);
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function sanitizeConnection(snapshot) {
  if (!snapshot || !snapshot.exists) return { connectionStatus: "disconnected", capabilityStatus: null };
  const data = snapshot.data() || {};
  const usable = connectionIsUsable(data);
  return {
    connectionStatus: usable ? "connected" : "reconnect_required",
    capabilityStatus: usable ? connectionCapability(data) : null,
    connectedAt: isoOrNull(data.connectedAt),
    updatedAt: isoOrNull(data.updatedAt),
  };
}

function createHandler(deps) {
  return async function handler(event) {
    const env = deps.env || process.env;
    const requestCheck = checkPostRequest(event, env);
    if (requestCheck.handled) return requestCheck.response;
    const responseHeaders = requestCheck.headers;

    try {
      deps.getOAuthConfig();
      await deps.ensureFirebaseAdmin();
    } catch (err) {
      const stage = err instanceof FirebaseConfigError ? err.stage : ((err && err.code) || "configuration");
      console.error(`[google-calendar-status] unavailable: stage=${stage}`);
      return jsonResponse(503, { ok: false, error: "google_calendar_not_configured" }, responseHeaders);
    }

    const authResult = await authenticateFirebaseUser(event, deps, responseHeaders);
    if (authResult.response) return authResult.response;
    const parsed = parseEmptyObjectBody(event.body);
    if (parsed.error) return jsonResponse(400, { ok: false, error: parsed.error }, responseHeaders);

    try {
      const snapshot = await deps.getDb()
        .collection(GOOGLE_CALENDAR_CONNECTIONS_COLLECTION)
        .doc(authResult.decoded.uid)
        .get();
      return jsonResponse(200, { ok: true, ...sanitizeConnection(snapshot) }, responseHeaders);
    } catch {
      return jsonResponse(500, { ok: false, error: "google_calendar_status_failed" }, responseHeaders);
    }
  };
}

const { buildGoogleCalendarDeps } = require("./lib/google-calendar-runtime");
exports.handler = createHandler(buildGoogleCalendarDeps());
exports.createHandler = createHandler;
exports.sanitizeConnection = sanitizeConnection;
