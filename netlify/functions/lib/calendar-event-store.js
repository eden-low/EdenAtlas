// Server-owned canonical Calendar persistence boundary.
//
// The store accepts source records plus a verified Firebase UID, never a browser-supplied
// canonical event. It runs the Phase 3B.3 adapters, validates through the Phase 3B.1 contract,
// owns canonical lifecycle timestamps/versioning, and writes only calendar_events documents.
// Provider synchronization, mappings, queues, cursors, conflict handling, and HMAC identity are
// intentionally absent.

const {
  CalendarEventValidationError,
  normalizeCanonicalCalendarEvent,
} = require("./calendar-event-model.js");
const {
  CalendarEventAdapterError,
  adaptExpenseToCalendarEvent,
  adaptJournalToCalendarEvent,
  adaptJourneyToCalendarEvent,
} = require("./calendar-event-adapters.js");

const CALENDAR_EVENTS_COLLECTION = "calendar_events";
const ID_RE = /^[^\s/]+$/u;

const SOURCE_ADAPTERS = Object.freeze({
  expense: adaptExpenseToCalendarEvent,
  journal: adaptJournalToCalendarEvent,
  journey: adaptJourneyToCalendarEvent,
});

class CalendarEventStoreError extends Error {
  constructor(code, statusCode = 500) {
    super(code);
    this.name = "CalendarEventStoreError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, statusCode) {
  throw new CalendarEventStoreError(code, statusCode);
}

function validIdentifier(value, maxChars) {
  return typeof value === "string" && value.length > 0 && value.length <= maxChars && ID_RE.test(value);
}

function requireVerifiedUid(value) {
  if (!validIdentifier(value, 128)) fail("invalid_verified_uid", 401);
  return value;
}

function requireCanonicalId(value) {
  if (!validIdentifier(value, 128)) fail("invalid_canonical_event_id", 400);
  return value;
}

function requireSourceEntityId(value) {
  if (!validIdentifier(value, 1024)) fail("invalid_source_entity_id", 400);
  return value;
}

function requireExpectedVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail("invalid_expected_version", 400);
  return value;
}

function trustedNowIso(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail("invalid_server_clock", 500);
  }
  return value.toISOString();
}

function normalizeProjection(project) {
  try {
    return normalizeCanonicalCalendarEvent(project);
  } catch (err) {
    if (err instanceof CalendarEventAdapterError || err instanceof CalendarEventValidationError) {
      fail("invalid_source_projection", 400);
    }
    throw err;
  }
}

function normalizeStored(snapshot, verifiedUid) {
  if (!snapshot || !snapshot.exists) fail("canonical_event_not_found", 404);
  let event;
  try {
    event = normalizeCanonicalCalendarEvent(snapshot.data());
  } catch {
    fail("invalid_stored_canonical_event", 500);
  }
  if (event.id !== snapshot.id) fail("invalid_stored_canonical_event", 500);
  if (event.ownerUid !== verifiedUid) fail("canonical_event_not_found", 404);
  return event;
}

function createCalendarEventStore({ db, now, generateId }) {
  if (!db || typeof db.collection !== "function" || typeof db.runTransaction !== "function") {
    throw new TypeError("calendar_event_store_requires_db");
  }
  if (typeof now !== "function" || typeof generateId !== "function") {
    throw new TypeError("calendar_event_store_requires_server_dependencies");
  }

  const collection = db.collection(CALENDAR_EVENTS_COLLECTION);

  function projectSource({ verifiedUid, sourceEntityType, sourceEntityId, source, id, projectedAt }) {
    const adapter = SOURCE_ADAPTERS[sourceEntityType];
    if (!adapter) fail("invalid_source_entity_type", 400);
    try {
      return normalizeProjection(adapter(source, {
        id,
        ownerUid: verifiedUid,
        sourceEntityId,
        projectedAt,
      }));
    } catch (err) {
      if (err instanceof CalendarEventStoreError) throw err;
      if (err instanceof CalendarEventAdapterError || err instanceof CalendarEventValidationError) {
        fail("invalid_source_projection", 400);
      }
      throw err;
    }
  }

  async function createFromSource({ verifiedUid, sourceEntityType, sourceEntityId, source }) {
    const uid = requireVerifiedUid(verifiedUid);
    const sourceId = requireSourceEntityId(sourceEntityId);
    const id = requireCanonicalId(generateId());
    const projectedAt = trustedNowIso(now);
    const event = projectSource({
      verifiedUid: uid,
      sourceEntityType,
      sourceEntityId: sourceId,
      source,
      id,
      projectedAt,
    });
    if (event.version !== 1 || event.createdAt !== projectedAt || event.updatedAt !== projectedAt) {
      fail("invalid_initial_canonical_lifecycle", 500);
    }

    const ref = collection.doc(id);
    await db.runTransaction(async (transaction) => {
      const existing = await transaction.get(ref);
      if (existing && existing.exists) fail("temporary_canonical_id_collision", 409);
      transaction.set(ref, event);
    });
    return event;
  }

  async function readOwnedEvent({ verifiedUid, canonicalEventId }) {
    const uid = requireVerifiedUid(verifiedUid);
    const id = requireCanonicalId(canonicalEventId);
    return normalizeStored(await collection.doc(id).get(), uid);
  }

  async function readOwnedSourceReference({ verifiedUid, canonicalEventId }) {
    const event = await readOwnedEvent({ verifiedUid, canonicalEventId });
    return {
      canonicalEventId: event.id,
      sourceEntityType: event.sourceEntityType,
      sourceEntityId: event.sourceEntityId,
      version: event.version,
    };
  }

  async function listForOwner({ verifiedUid }) {
    const uid = requireVerifiedUid(verifiedUid);
    const snapshot = await collection.where("ownerUid", "==", uid).get();
    const events = (snapshot && Array.isArray(snapshot.docs) ? snapshot.docs : [])
      .map((docSnapshot) => normalizeStored(docSnapshot, uid));
    return events.sort((left, right) => {
      const leftStart = left.start.date || left.start.dateTime;
      const rightStart = right.start.date || right.start.dateTime;
      return leftStart.localeCompare(rightStart) || left.id.localeCompare(right.id);
    });
  }

  async function updateFromSource({ verifiedUid, canonicalEventId, expectedVersion, source }) {
    const uid = requireVerifiedUid(verifiedUid);
    const id = requireCanonicalId(canonicalEventId);
    const expected = requireExpectedVersion(expectedVersion);
    const updatedAt = trustedNowIso(now);
    const ref = collection.doc(id);

    return db.runTransaction(async (transaction) => {
      const stored = normalizeStored(await transaction.get(ref), uid);
      if (stored.deletedAt !== null) fail("canonical_event_deleted", 409);
      if (stored.version !== expected) fail("stale_canonical_event_version", 409);

      const projected = projectSource({
        verifiedUid: uid,
        sourceEntityType: stored.sourceEntityType,
        sourceEntityId: stored.sourceEntityId,
        source,
        id: stored.id,
        projectedAt: updatedAt,
      });
      const updated = normalizeProjection({
        ...projected,
        createdAt: stored.createdAt,
        updatedAt,
        version: stored.version + 1,
      });
      transaction.set(ref, updated);
      return updated;
    });
  }

  return {
    createFromSource,
    readOwnedEvent,
    readOwnedSourceReference,
    listForOwner,
    updateFromSource,
  };
}

module.exports = {
  CALENDAR_EVENTS_COLLECTION,
  CalendarEventStoreError,
  createCalendarEventStore,
};
