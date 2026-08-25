// Explicit, authenticated Phase 3B.7 operation: create one canonical event in the
// server-provisioned EdenAtlas secondary calendar. No update/delete/background path exists.

const crypto = require("node:crypto");
const { FirebaseConfigError } = require("./lib/firebase-admin");
const { CalendarEventStoreError } = require("./lib/calendar-event-store");
const { CalendarEventIdentityError } = require("./lib/calendar-event-identity");
const {
  GOOGLE_CALENDAR_CONNECTIONS_COLLECTION,
  GOOGLE_CALENDAR_CAPABILITY_WRITE_AUTHORIZED,
  GOOGLE_CALENDAR_OUTBOUND_POLICY,
  connectionCapability,
  decryptRefreshToken,
  encryptedTokenEnvelopeIsValid,
} = require("./lib/google-calendar-oauth");
const { GoogleCalendarReadError, refreshGoogleAccessToken } = require("./lib/google-calendar-events");
const {
  GoogleCalendarWriteError,
  parseManualCreateRequest,
  deterministicGoogleEventId,
  buildGoogleEventPayload,
  providerPayloadHash,
  providerPayloadMatches,
  markerMatches,
  createSecondaryCalendar,
  getGoogleEvent,
  insertGoogleEvent,
  acquireMapping,
  markMapping,
  completeMapping,
} = require("./lib/google-calendar-write");
const { jsonResponse, checkPostRequest, authenticateFirebaseUser } = require("./lib/google-calendar-http");

const BURST_PREFIX = "google-calendar-create-event:";
const CALENDAR_LEASE_MS = 30_000;

function asDate(value) {
  if (value instanceof Date) return value;
  if (value && typeof value.toDate === "function") return value.toDate();
  return new Date(0);
}

function validPersistedCalendarId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && value !== "primary";
}

function assertOwnedWriteConnection(connection, verifiedUid, expectedCalendarId = null) {
  if (!connection || connection.uid !== verifiedUid || connection.ownerUid !== verifiedUid) {
    throw new GoogleCalendarWriteError("google_calendar_connection_not_found", 404);
  }
  if (connection.status !== "connected" || connection.reconnectRequired === true) {
    throw new GoogleCalendarWriteError("reconnect_required", 409, { reconnectRequired: true });
  }
  if (connectionCapability(connection) !== GOOGLE_CALENDAR_CAPABILITY_WRITE_AUTHORIZED) {
    throw new GoogleCalendarWriteError("write_consent_required", 409);
  }
  if (connection.outboundCalendarPolicy !== GOOGLE_CALENDAR_OUTBOUND_POLICY) {
    throw new GoogleCalendarWriteError("outbound_calendar_policy_invalid", 409);
  }
  if (connection.outboundCalendarId === "primary") {
    throw new GoogleCalendarWriteError("primary_calendar_forbidden", 409);
  }
  if (expectedCalendarId !== null && connection.outboundCalendarId !== expectedCalendarId) {
    throw new GoogleCalendarWriteError("outbound_calendar_changed", 409);
  }
  return connection;
}

async function readOwnedConnection(connectionRef, verifiedUid, { migrateLegacyOwner = false, expectedCalendarId = null } = {}) {
  const snapshot = await connectionRef.get();
  if (!snapshot || !snapshot.exists) throw new GoogleCalendarWriteError("google_calendar_connection_not_found", 404);
  const data = snapshot.data() || {};
  if (migrateLegacyOwner && data.uid === verifiedUid && data.ownerUid == null) {
    await connectionRef.set({ ownerUid: verifiedUid }, { merge: true });
    return assertOwnedWriteConnection({ ...data, ownerUid: verifiedUid }, verifiedUid, expectedCalendarId);
  }
  return assertOwnedWriteConnection(data, verifiedUid, expectedCalendarId);
}

async function provisionCalendar({ db, connectionRef, verifiedUid, accessToken, fetchImpl, now, leaseId }) {
  const lease = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(connectionRef);
    const connection = assertOwnedWriteConnection(snapshot && snapshot.exists ? snapshot.data() : null, verifiedUid);
    if (validPersistedCalendarId(connection.outboundCalendarId)
        && connection.calendarProvisioningState === "created") {
      return { create: false, calendarId: connection.outboundCalendarId };
    }
    if (connection.outboundCalendarId != null) throw new GoogleCalendarWriteError("outbound_calendar_invalid", 409);
    if (connection.calendarProvisioningState === "failed") {
      throw new GoogleCalendarWriteError("calendar_provisioning_failed", 409);
    }
    const expiry = asDate(connection.calendarProvisioningLeaseExpiresAt);
    if (connection.calendarProvisioningState === "provisioning" && expiry.getTime() > now.getTime()) {
      throw new GoogleCalendarWriteError("calendar_provisioning_in_progress", 409);
    }
    transaction.set(connectionRef, {
      calendarProvisioningState: "provisioning",
      calendarProvisioningLeaseId: leaseId,
      calendarProvisioningLeaseExpiresAt: new Date(now.getTime() + CALENDAR_LEASE_MS),
      calendarProvisioningLastErrorCode: null,
      updatedAt: now,
    }, { merge: true });
    return { create: true, calendarId: null };
  });
  if (!lease.create) return lease.calendarId;

  try {
    await readOwnedConnection(connectionRef, verifiedUid);
    const calendarId = await createSecondaryCalendar({ fetchImpl, accessToken });
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(connectionRef);
      const connection = assertOwnedWriteConnection(snapshot && snapshot.exists ? snapshot.data() : null, verifiedUid);
      if (connection.calendarProvisioningLeaseId !== leaseId || connection.outboundCalendarId != null) {
        throw new GoogleCalendarWriteError("calendar_provisioning_conflict", 409);
      }
      transaction.set(connectionRef, {
        outboundCalendarId: calendarId,
        calendarProvisioningState: "created",
        calendarProvisioningLeaseId: null,
        calendarProvisioningLeaseExpiresAt: null,
        calendarProvisioningLastErrorCode: null,
        updatedAt: now,
      }, { merge: true });
    });
    return calendarId;
  } catch (err) {
    const code = err instanceof GoogleCalendarWriteError ? err.code : "calendar_provisioning_failed";
    try {
      await connectionRef.set({
        calendarProvisioningState: err && err.reconnectRequired ? "reconnect_required" : "failed",
        calendarProvisioningLeaseId: null,
        calendarProvisioningLeaseExpiresAt: null,
        calendarProvisioningLastErrorCode: code,
        updatedAt: now,
      }, { merge: true });
    } catch {
      // Preserve the original sanitized provider error.
    }
    throw err;
  }
}

async function reconcileOrInsert({ deps, connectionRef, verifiedUid, accessToken, calendarId, event, payload, mappingRef, now }) {
  await readOwnedConnection(connectionRef, verifiedUid, { expectedCalendarId: calendarId });
  let providerEvent = await getGoogleEvent({
    fetchImpl: deps.fetchImpl, accessToken, googleCalendarId: calendarId, googleEventId: payload.id,
  });
  let resultState = "already_created";
  if (!providerEvent.found) {
    await readOwnedConnection(connectionRef, verifiedUid, { expectedCalendarId: calendarId });
    try {
      providerEvent = await insertGoogleEvent({
        fetchImpl: deps.fetchImpl, accessToken, googleCalendarId: calendarId, payload,
      });
      resultState = "created";
    } catch (err) {
      if (!(err instanceof GoogleCalendarWriteError)
          || (!err.ambiguous && err.code !== "provider_event_exists")) throw err;
      await readOwnedConnection(connectionRef, verifiedUid, { expectedCalendarId: calendarId });
      providerEvent = await getGoogleEvent({
        fetchImpl: deps.fetchImpl, accessToken, googleCalendarId: calendarId, googleEventId: payload.id,
      });
      if (!providerEvent.found) {
        await markMapping({ ref: mappingRef, state: "failed", code: "calendar_create_outcome_unknown", now });
        throw new GoogleCalendarWriteError("calendar_create_outcome_unknown", 503);
      }
      resultState = "already_created";
    }
  }
  if (!markerMatches(providerEvent.value, event.id, event.sourceEntityType)) {
    await markMapping({ ref: mappingRef, state: "conflict", code: "provider_identity_conflict", now });
    throw new GoogleCalendarWriteError("provider_identity_conflict", 409);
  }
  if (!providerPayloadMatches(providerEvent.value, payload)) {
    await markMapping({ ref: mappingRef, state: "conflict", code: "provider_payload_conflict", now });
    throw new GoogleCalendarWriteError("provider_payload_conflict", 409);
  }
  return resultState;
}

async function markReconnectRequired(connectionRef, now, code) {
  await connectionRef.set({
    status: "reconnect_required",
    reconnectRequired: true,
    calendarProvisioningState: "reconnect_required",
    lastErrorCode: code,
    updatedAt: now,
  }, { merge: true });
}

function createHandler(deps) {
  return async function handler(request) {
    const requestCheck = checkPostRequest(request, deps.env || process.env);
    if (requestCheck.handled) return requestCheck.response;
    const headers = requestCheck.headers;
    let config;
    try {
      config = deps.getOAuthConfig();
      await deps.ensureFirebaseAdmin();
    } catch (err) {
      const stage = err instanceof FirebaseConfigError ? err.stage : ((err && err.code) || "configuration");
      console.error(`[google-calendar-create-event] unavailable: stage=${stage}`);
      return jsonResponse(503, { ok: false, error: "google_calendar_not_configured" }, headers);
    }
    const authResult = await authenticateFirebaseUser(request, deps, headers);
    if (authResult.response) return authResult.response;
    const verifiedUid = authResult.decoded.uid;
    const parsed = parseManualCreateRequest(request.body);
    if (parsed.error) return jsonResponse(400, { ok: false, error: parsed.error }, headers);
    const now = deps.now ? deps.now() : new Date();
    const burst = deps.checkBurst(`${BURST_PREFIX}${verifiedUid}`, now.getTime());
    if (!burst.allowed) {
      return jsonResponse(429, { ok: false, error: "rate_limited", retryAfterMs: burst.retryAfterMs }, {
        ...headers, "Retry-After": String(Math.ceil(burst.retryAfterMs / 1000)),
      });
    }

    const db = deps.getDb();
    const connectionRef = db.collection(GOOGLE_CALENDAR_CONNECTIONS_COLLECTION).doc(verifiedUid);
    let refreshToken = null;
    let accessToken = null;
    let mappingRef = null;
    let leaseId = null;
    try {
      const connection = await readOwnedConnection(connectionRef, verifiedUid, { migrateLegacyOwner: true });
      if (!encryptedTokenEnvelopeIsValid(connection.encryptedRefreshToken)) {
        throw new GoogleCalendarWriteError("google_calendar_connection_invalid", 500);
      }
      const event = await deps.getCanonicalStore().readOwnedEvent({
        verifiedUid, canonicalEventId: parsed.value.canonicalEventHandle,
      });
      if (event.deletedAt !== null) throw new GoogleCalendarWriteError("canonical_event_deleted", 409);

      refreshToken = decryptRefreshToken({
        encryptedToken: connection.encryptedRefreshToken,
        uid: verifiedUid,
        masterKeyRaw: config.masterKeyRaw,
      });
      accessToken = await refreshGoogleAccessToken({
        fetchImpl: deps.fetchImpl,
        config,
        refreshToken,
        requiredCapability: GOOGLE_CALENDAR_CAPABILITY_WRITE_AUTHORIZED,
      });
      const calendarLeaseId = crypto.randomBytes(16).toString("base64url");
      const calendarId = await provisionCalendar({
        db, connectionRef, verifiedUid, accessToken, fetchImpl: deps.fetchImpl, now, leaseId: calendarLeaseId,
      });
      if (!validPersistedCalendarId(calendarId)) throw new GoogleCalendarWriteError("outbound_calendar_invalid", 409);

      const googleEventId = deterministicGoogleEventId({
        serverIdentityKey: deps.getProviderIdentityKey(),
        ownerUid: verifiedUid,
        canonicalEventId: event.id,
        googleCalendarId: calendarId,
      });
      const payload = buildGoogleEventPayload(event, googleEventId);
      const payloadHash = providerPayloadHash(payload);
      leaseId = crypto.randomBytes(16).toString("base64url");
      const mapping = await acquireMapping({
        db, verifiedUid, canonicalEvent: event, googleCalendarId: calendarId,
        googleEventId, now, leaseId,
      });
      if (!mapping.acquired) throw new GoogleCalendarWriteError("create_in_progress", 409);
      mappingRef = mapping.ref;

      const createState = await reconcileOrInsert({
        deps, connectionRef, verifiedUid, accessToken, calendarId, event, payload, mappingRef, now,
      });
      const completed = await completeMapping({
        db, ref: mappingRef, verifiedUid, canonicalEvent: event, payloadHash, now, leaseId,
      });
      if (!completed) throw new GoogleCalendarWriteError("canonical_version_changed", 409);
      return jsonResponse(200, {
        ok: true,
        createState,
        calendarProvisioningState: "created",
        outboundCapabilityStatus: "write_authorized",
      }, headers);
    } catch (err) {
      const reconnect = (err instanceof GoogleCalendarWriteError && err.reconnectRequired)
        || (err instanceof GoogleCalendarReadError && err.reconnectRequired);
      const code = err instanceof GoogleCalendarWriteError || err instanceof GoogleCalendarReadError
        ? err.code
        : err instanceof CalendarEventStoreError ? err.code
          : err instanceof CalendarEventIdentityError ? "canonical_identity_not_configured"
            : "google_calendar_create_failed";
      const statusCode = err instanceof GoogleCalendarWriteError || err instanceof GoogleCalendarReadError
        ? err.statusCode
        : err instanceof CalendarEventStoreError ? err.statusCode
          : err instanceof CalendarEventIdentityError ? 503 : 500;
      if (reconnect) {
        try { await markReconnectRequired(connectionRef, now, code); } catch { /* sanitized response below */ }
      } else if (mappingRef && !["provider_identity_conflict", "provider_payload_conflict", "canonical_version_changed"].includes(code)) {
        try { await markMapping({ ref: mappingRef, state: "failed", code, now, leaseId }); } catch { /* preserve original */ }
      }
      if (statusCode >= 500) console.error(`[google-calendar-create-event] create failed: code=${code}`);
      return jsonResponse(statusCode, {
        ok: false,
        error: code,
        ...(reconnect ? { connectionStatus: "reconnect_required" } : {}),
      }, headers);
    } finally {
      refreshToken = null;
      accessToken = null;
    }
  };
}

const { buildGoogleCalendarDeps } = require("./lib/google-calendar-runtime");
exports.handler = createHandler(buildGoogleCalendarDeps());
exports.createHandler = createHandler;
exports.assertOwnedWriteConnection = assertOwnedWriteConnection;
exports.provisionCalendar = provisionCalendar;
