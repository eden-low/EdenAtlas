// Phase 3B.7: server-only, manual creation in an EdenAtlas-created secondary calendar.
// This module intentionally contains no update/delete/list/scheduled synchronization behavior.

const crypto = require("node:crypto");
const { normalizeCanonicalCalendarEvent } = require("./calendar-event-model");

const GOOGLE_CALENDAR_API_ORIGIN = "https://www.googleapis.com";
const EDENATLAS_CALENDAR_NAME = "EdenAtlas";
const SYNC_COLLECTION = "calendar_event_sync";
const PROVIDER = "google";
const PROVIDER_ORIGIN = "edenatlas_created";
const EVENT_ID_NAMESPACE = "ea-google:v1";
const PROVIDER_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const LEASE_MS = 30_000;
const SOURCE_TYPES = new Set(["expense", "journal", "journey"]);

class GoogleCalendarWriteError extends Error {
  constructor(code, statusCode = 502, options = {}) {
    super(code);
    this.name = "GoogleCalendarWriteError";
    this.code = code;
    this.statusCode = statusCode;
    this.reconnectRequired = options.reconnectRequired === true;
    this.ambiguous = options.ambiguous === true;
  }
}

function fail(code, statusCode = 502, options) {
  throw new GoogleCalendarWriteError(code, statusCode, options);
}

function parseManualCreateRequest(raw) {
  if (typeof raw !== "string" || !raw || Buffer.byteLength(raw, "utf8") > 512) {
    return { error: "invalid_request_body" };
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return { error: "invalid_json" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid_json" };
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "canonicalEventHandle") return { error: "unknown_field" };
  if (typeof body.canonicalEventHandle !== "string"
      || !/^[0-9A-V]{52}$/.test(body.canonicalEventHandle)) {
    return { error: "invalid_canonical_event_handle" };
  }
  return { value: { canonicalEventHandle: body.canonicalEventHandle } };
}

function base32hexLower(buffer) {
  const alphabet = "0123456789abcdefghijklmnopqrstuv";
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= bits === 0 ? 0 : (1 << bits) - 1;
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function deterministicGoogleEventId({ serverIdentityKey, ownerUid, canonicalEventId, googleCalendarId }) {
  if (typeof serverIdentityKey !== "string" || serverIdentityKey.length < 32) {
    fail("provider_identity_not_configured", 503);
  }
  for (const [name, value] of Object.entries({ ownerUid, canonicalEventId, googleCalendarId })) {
    if (typeof value !== "string" || !value || /[\r\n]/.test(value)) fail(`invalid_${name}`, 500);
  }
  const input = `${EVENT_ID_NAMESPACE}|${ownerUid}|${canonicalEventId}|${googleCalendarId}`;
  return base32hexLower(crypto.createHmac("sha256", serverIdentityKey).update(input, "utf8").digest());
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function providerPayloadHash(payload) {
  return `sha256:${crypto.createHash("sha256").update(stableJson(payload), "utf8").digest("hex")}`;
}

function buildGoogleEventPayload(rawEvent, googleEventId) {
  const event = normalizeCanonicalCalendarEvent(rawEvent);
  if (event.origin !== "edenatlas" || !SOURCE_TYPES.has(event.sourceEntityType)) {
    fail("canonical_event_not_outbound_eligible", 409);
  }
  if (event.deletedAt !== null || event.status === "cancelled") fail("canonical_event_deleted", 409);
  if (typeof googleEventId !== "string" || !/^[0-9a-v]{52}$/.test(googleEventId)) {
    fail("invalid_google_event_id", 500);
  }
  const payload = {
    id: googleEventId,
    summary: event.title,
    start: event.allDay
      ? { date: event.start.date }
      : { dateTime: event.start.dateTime, timeZone: event.timeZone },
    end: event.allDay
      ? { date: event.end.date }
      : { dateTime: event.end.dateTime, timeZone: event.timeZone },
    status: event.status,
    extendedProperties: {
      private: {
        edenAtlasVersion: "1",
        edenAtlasCanonicalId: event.id,
        edenAtlasSourceType: event.sourceEntityType,
      },
    },
  };
  if (event.summary) payload.description = event.summary;
  return payload;
}

function markerMatches(raw, canonicalEventId, sourceEntityType) {
  const privateProps = raw && raw.extendedProperties && raw.extendedProperties.private;
  if (!privateProps || typeof privateProps !== "object" || Array.isArray(privateProps)) return false;
  const keys = Object.keys(privateProps).sort();
  const expected = ["edenAtlasCanonicalId", "edenAtlasSourceType", "edenAtlasVersion"].sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index])
    && privateProps.edenAtlasVersion === "1"
    && privateProps.edenAtlasCanonicalId === canonicalEventId
    && privateProps.edenAtlasSourceType === sourceEntityType;
}

function providerPayloadMatches(raw, expected) {
  if (!raw || raw.id !== expected.id || raw.summary !== expected.summary
      || (raw.description || "") !== (expected.description || "")
      || raw.status !== expected.status) return false;
  return stableJson(raw.start) === stableJson(expected.start)
    && stableJson(raw.end) === stableJson(expected.end)
    && markerMatches(raw, expected.extendedProperties.private.edenAtlasCanonicalId,
      expected.extendedProperties.private.edenAtlasSourceType);
}

async function readBoundedJson(response) {
  const declared = Number(response && response.headers && response.headers.get
    ? response.headers.get("content-length") : NaN);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) fail("calendar_invalid_response");
  let text;
  try {
    text = await response.text();
  } catch {
    fail("calendar_invalid_response");
  }
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    fail("calendar_invalid_response");
  }
  try {
    return JSON.parse(text);
  } catch {
    fail("calendar_invalid_response");
  }
}

function calendarApiError(status, { allow404 = false } = {}) {
  if (status === 404 && allow404) return null;
  if (status === 401) return new GoogleCalendarWriteError("calendar_api_unauthorized", 401, { reconnectRequired: true });
  if (status === 403) return new GoogleCalendarWriteError("calendar_access_denied", 403, { reconnectRequired: true });
  if (status === 409) return new GoogleCalendarWriteError("provider_event_exists", 409);
  if (status === 429) return new GoogleCalendarWriteError("calendar_rate_limited", 429);
  if (status >= 500) return new GoogleCalendarWriteError("calendar_provider_unavailable", 503);
  return new GoogleCalendarWriteError("calendar_provider_rejected", 502);
}

async function providerFetch(fetchImpl, url, options, { allow404 = false, ambiguous = false } = {}) {
  if (!url.startsWith(`${GOOGLE_CALENDAR_API_ORIGIN}/calendar/v3/`)) fail("invalid_provider_host", 500);
  let response;
  try {
    response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  } catch {
    fail(ambiguous ? "calendar_create_outcome_unknown" : "calendar_provider_unavailable", 503, { ambiguous });
  }
  if (!response) fail("calendar_provider_unavailable", 503);
  if (response.status === 404 && allow404) return { found: false, value: null };
  if (!response.ok) throw calendarApiError(response.status, { allow404 });
  return { found: true, value: await readBoundedJson(response) };
}

async function createSecondaryCalendar({ fetchImpl = fetch, accessToken }) {
  const result = await providerFetch(fetchImpl, `${GOOGLE_CALENDAR_API_ORIGIN}/calendar/v3/calendars`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ summary: EDENATLAS_CALENDAR_NAME }),
  }, { ambiguous: true });
  const id = result.value && result.value.id;
  if (typeof id !== "string" || !id || id.length > 1024 || id === "primary") fail("calendar_invalid_response");
  return id;
}

function eventUrl(calendarId, eventId = null) {
  if (!calendarId || calendarId === "primary") fail("primary_calendar_forbidden", 409);
  const base = `${GOOGLE_CALENDAR_API_ORIGIN}/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  return eventId ? `${base}/${encodeURIComponent(eventId)}?fields=id,summary,description,start,end,status,extendedProperties`
    : `${base}?sendUpdates=none&fields=id,summary,description,start,end,status,extendedProperties`;
}

async function getGoogleEvent({ fetchImpl = fetch, accessToken, googleCalendarId, googleEventId }) {
  return providerFetch(fetchImpl, eventUrl(googleCalendarId, googleEventId), {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  }, { allow404: true });
}

async function insertGoogleEvent({ fetchImpl = fetch, accessToken, googleCalendarId, payload }) {
  return providerFetch(fetchImpl, eventUrl(googleCalendarId), {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, { ambiguous: true });
}

function isUnexpiredLease(record, now) {
  const raw = record && record.operationLeaseExpiresAt;
  const expiry = raw instanceof Date ? raw : raw && typeof raw.toDate === "function" ? raw.toDate() : new Date(0);
  return Number.isFinite(expiry.getTime()) && expiry.getTime() > now.getTime();
}

async function acquireMapping({ db, verifiedUid, canonicalEvent, googleCalendarId, googleEventId, now, leaseId }) {
  const ref = db.collection(SYNC_COLLECTION).doc(googleEventId);
  const acquired = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const existing = snapshot && snapshot.exists ? (snapshot.data() || {}) : null;
    if (existing) {
      if (existing.ownerUid !== verifiedUid
          || existing.canonicalEventId !== canonicalEvent.id
          || existing.provider !== PROVIDER
          || existing.googleCalendarId !== googleCalendarId
          || existing.googleEventId !== googleEventId
          || existing.providerOrigin !== PROVIDER_ORIGIN) fail("provider_mapping_conflict", 409);
      if (isUnexpiredLease(existing, now)) return false;
    }
    const createdAt = existing && existing.createdAt ? existing.createdAt : now;
    transaction.set(ref, {
      ownerUid: verifiedUid,
      canonicalEventId: canonicalEvent.id,
      provider: PROVIDER,
      googleCalendarId,
      googleEventId,
      providerOrigin: PROVIDER_ORIGIN,
      payloadHash: existing && existing.payloadHash ? existing.payloadHash : null,
      lastSyncedCanonicalVersion: existing && existing.lastSyncedCanonicalVersion
        ? existing.lastSyncedCanonicalVersion : null,
      state: "pending_create",
      lastAttemptAt: now,
      lastSyncedAt: existing && existing.lastSyncedAt ? existing.lastSyncedAt : null,
      retryCount: Number.isSafeInteger(existing && existing.retryCount) ? existing.retryCount + 1 : 0,
      lastErrorCode: null,
      createdAt,
      updatedAt: now,
      operationLeaseId: leaseId,
      operationLeaseExpiresAt: new Date(now.getTime() + LEASE_MS),
    });
    return true;
  });
  return { ref, acquired };
}

async function markMapping({ ref, state, code, now, leaseId }) {
  await ref.set({
    state,
    lastErrorCode: code,
    updatedAt: now,
    operationLeaseId: null,
    operationLeaseExpiresAt: null,
  }, { merge: true });
}

async function completeMapping({ db, ref, verifiedUid, canonicalEvent, payloadHash, now, leaseId }) {
  const canonicalRef = db.collection("calendar_events").doc(canonicalEvent.id);
  return db.runTransaction(async (transaction) => {
    const [mappingSnapshot, canonicalSnapshot] = await Promise.all([
      transaction.get(ref), transaction.get(canonicalRef),
    ]);
    const mapping = mappingSnapshot && mappingSnapshot.exists ? (mappingSnapshot.data() || {}) : null;
    const current = canonicalSnapshot && canonicalSnapshot.exists ? (canonicalSnapshot.data() || {}) : null;
    if (!mapping || mapping.ownerUid !== verifiedUid || mapping.operationLeaseId !== leaseId) {
      fail("provider_mapping_conflict", 409);
    }
    if (!current || current.ownerUid !== verifiedUid || current.id !== canonicalEvent.id
        || current.deletedAt !== null || current.version !== canonicalEvent.version) {
      transaction.set(ref, {
        state: "failed",
        lastErrorCode: "canonical_version_changed",
        updatedAt: now,
        operationLeaseId: null,
        operationLeaseExpiresAt: null,
      }, { merge: true });
      return false;
    }
    transaction.set(ref, {
      payloadHash,
      lastSyncedCanonicalVersion: canonicalEvent.version,
      state: "synced",
      lastSyncedAt: now,
      lastErrorCode: null,
      updatedAt: now,
      operationLeaseId: null,
      operationLeaseExpiresAt: null,
    }, { merge: true });
    return true;
  });
}

module.exports = {
  GOOGLE_CALENDAR_API_ORIGIN,
  EDENATLAS_CALENDAR_NAME,
  SYNC_COLLECTION,
  PROVIDER_ORIGIN,
  EVENT_ID_NAMESPACE,
  GoogleCalendarWriteError,
  parseManualCreateRequest,
  base32hexLower,
  deterministicGoogleEventId,
  buildGoogleEventPayload,
  providerPayloadHash,
  markerMatches,
  providerPayloadMatches,
  createSecondaryCalendar,
  getGoogleEvent,
  insertGoogleEvent,
  acquireMapping,
  markMapping,
  completeMapping,
};
