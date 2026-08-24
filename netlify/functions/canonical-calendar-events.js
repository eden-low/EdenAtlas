// Authenticated server boundary for canonical EdenAtlas Calendar projections.
//
// The browser can request a projection/list operation, but cannot submit a UID, ownerUid,
// Firestore path, raw canonical event, or provider field. Source documents are loaded by this
// Function from an allowlisted collection and checked against the verified Firebase UID before
// the server-owned calendar_events repository is called.

const { FirebaseConfigError } = require("./lib/firebase-admin");
const { CalendarEventStoreError } = require("./lib/calendar-event-store");
const { CalendarEventIdentityError } = require("./lib/calendar-event-identity");
const {
  jsonResponse,
  checkPostRequest,
  authenticateFirebaseUser,
} = require("./lib/google-calendar-http");

const SOURCE_COLLECTIONS = Object.freeze({
  expense: "expenses",
  journal: "journals",
  journey: "life_events",
});
const ID_RE = /^[^\s/]+$/u;
const MAX_BODY_CHARS = 2048;

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validId(value, maxChars) {
  return typeof value === "string" && value.length > 0 && value.length <= maxChars && ID_RE.test(value);
}

function parseCanonicalCalendarRequest(raw) {
  if (typeof raw !== "string" || !raw || raw.length > MAX_BODY_CHARS) {
    return { error: "invalid_request_body" };
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return { error: "invalid_json" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid_json" };

  if (body.action === "list") {
    return exactKeys(body, ["action"]) ? { value: body } : { error: "unknown_field" };
  }
  if (body.action === "project_source") {
    if (!exactKeys(body, ["action", "sourceEntityType", "sourceEntityId"])) {
      return { error: "unknown_field" };
    }
    if (!SOURCE_COLLECTIONS[body.sourceEntityType]) return { error: "invalid_source_entity_type" };
    if (!validId(body.sourceEntityId, 1024)) return { error: "invalid_source_entity_id" };
    return { value: body };
  }
  if (body.action === "refresh_projection") {
    if (!exactKeys(body, ["action", "canonicalEventId", "expectedVersion"])) {
      return { error: "unknown_field" };
    }
    if (!validId(body.canonicalEventId, 128)) return { error: "invalid_canonical_event_id" };
    if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) {
      return { error: "invalid_expected_version" };
    }
    return { value: body };
  }
  if (body.action === "tombstone") {
    if (!exactKeys(body, ["action", "canonicalEventId", "expectedVersion"])) {
      return { error: "unknown_field" };
    }
    if (!validId(body.canonicalEventId, 128)) return { error: "invalid_canonical_event_id" };
    if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) {
      return { error: "invalid_expected_version" };
    }
    return { value: body };
  }
  return { error: "invalid_action" };
}

async function loadOwnedSource(db, verifiedUid, sourceEntityType, sourceEntityId) {
  const collectionName = SOURCE_COLLECTIONS[sourceEntityType];
  if (!collectionName || !validId(sourceEntityId, 1024)) {
    throw new CalendarEventStoreError("invalid_source_reference", 400);
  }
  const snapshot = await db.collection(collectionName).doc(sourceEntityId).get();
  if (!snapshot || !snapshot.exists) throw new CalendarEventStoreError("source_not_found", 404);
  const source = snapshot.data();
  if (!source || typeof source !== "object" || Array.isArray(source) || typeof source.uid !== "string") {
    throw new CalendarEventStoreError("invalid_source_record", 400);
  }
  // Return the same not-found response for a real cross-user document and an absent ID, so this
  // endpoint cannot be used to probe whether another user's source document exists.
  if (source.uid !== verifiedUid) throw new CalendarEventStoreError("source_not_found", 404);
  return source;
}

function createHandler(deps) {
  return async function handler(event) {
    const requestCheck = checkPostRequest(event, deps.env || process.env);
    if (requestCheck.handled) return requestCheck.response;
    const responseHeaders = requestCheck.headers;

    try {
      await deps.ensureFirebaseAdmin();
    } catch (err) {
      const stage = err instanceof FirebaseConfigError ? err.stage : ((err && err.code) || "configuration");
      console.error(`[canonical-calendar-events] unavailable: stage=${stage}`);
      return jsonResponse(503, { ok: false, error: "canonical_calendar_not_configured" }, responseHeaders);
    }

    const authResult = await authenticateFirebaseUser(event, deps, responseHeaders);
    if (authResult.response) return authResult.response;
    const verifiedUid = authResult.decoded.uid;

    const parsed = parseCanonicalCalendarRequest(event.body);
    if (parsed.error) return jsonResponse(400, { ok: false, error: parsed.error }, responseHeaders);

    try {
      const store = deps.getStore();
      if (parsed.value.action === "list") {
        const events = await store.listForOwner({ verifiedUid });
        return jsonResponse(200, { ok: true, events }, responseHeaders);
      }

      if (parsed.value.action === "project_source") {
        const source = await loadOwnedSource(
          deps.getDb(),
          verifiedUid,
          parsed.value.sourceEntityType,
          parsed.value.sourceEntityId
        );
        const canonicalEvent = await store.createFromSource({
          verifiedUid,
          sourceEntityType: parsed.value.sourceEntityType,
          sourceEntityId: parsed.value.sourceEntityId,
          source,
        });
        return jsonResponse(201, { ok: true, event: canonicalEvent }, responseHeaders);
      }

      if (parsed.value.action === "tombstone") {
        // This explicit operation is the only Phase 3B.5 source-deletion signal. A failed or
        // missing source read never reaches it and is never inferred to mean deletion.
        const canonicalEvent = await store.tombstoneOwnedEvent({
          verifiedUid,
          canonicalEventId: parsed.value.canonicalEventId,
          expectedVersion: parsed.value.expectedVersion,
        });
        return jsonResponse(200, { ok: true, event: canonicalEvent }, responseHeaders);
      }

      const reference = await store.readOwnedSourceReference({
        verifiedUid,
        canonicalEventId: parsed.value.canonicalEventId,
      });
      const source = await loadOwnedSource(
        deps.getDb(),
        verifiedUid,
        reference.sourceEntityType,
        reference.sourceEntityId
      );
      const canonicalEvent = await store.updateFromSource({
        verifiedUid,
        canonicalEventId: reference.canonicalEventId,
        expectedVersion: parsed.value.expectedVersion,
        source,
      });
      return jsonResponse(200, { ok: true, event: canonicalEvent }, responseHeaders);
    } catch (err) {
      if (err instanceof CalendarEventIdentityError) {
        return jsonResponse(503, { ok: false, error: "canonical_identity_not_configured" }, responseHeaders);
      }
      if (err instanceof CalendarEventStoreError) {
        return jsonResponse(err.statusCode, { ok: false, error: err.code }, responseHeaders);
      }
      console.error(`[canonical-calendar-events] operation failed: code=${(err && err.code) || "no_code"}`);
      return jsonResponse(500, { ok: false, error: "canonical_calendar_failed" }, responseHeaders);
    }
  };
}

const { buildCanonicalCalendarDeps } = require("./lib/canonical-calendar-runtime");
exports.handler = createHandler(buildCanonicalCalendarDeps());
exports.createHandler = createHandler;
exports.parseCanonicalCalendarRequest = parseCanonicalCalendarRequest;
exports.loadOwnedSource = loadOwnedSource;
