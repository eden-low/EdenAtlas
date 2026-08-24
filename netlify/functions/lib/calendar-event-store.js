// Server-owned canonical Calendar persistence and reconciliation boundary.
//
// Source records are projected only through the Phase 3B.3 adapters. Canonical identity, payload
// hash, migration metadata, versioning, and tombstones are owned here. Provider synchronization,
// mappings, queues, cursors, and conflict handling remain intentionally absent.

const {
  CalendarEventValidationError,
  isValidRfc3339Timestamp,
  normalizeCanonicalCalendarEvent,
} = require("./calendar-event-model.js");
const {
  CalendarEventAdapterError,
  adaptExpenseToCalendarEvent,
  adaptJournalToCalendarEvent,
  adaptJourneyToCalendarEvent,
} = require("./calendar-event-adapters.js");
const {
  CALENDAR_IDENTITY_SCHEME,
  CALENDAR_IDENTITY_VERSION,
  DEFAULT_CALENDAR_INSTANCE_KEY,
  isDeterministicCalendarEventId,
  isTemporaryCalendarEventId,
} = require("./calendar-event-identity.js");

const CALENDAR_EVENTS_COLLECTION = "calendar_events";
const CALENDAR_STORE_METADATA_FIELD = "_calendarStore";
const ID_RE = /^[^\s/]+$/u;
const PAYLOAD_HASH_RE = /^sha256:[0-9a-f]{64}$/u;
const STORE_METADATA_FIELDS = Object.freeze([
  "identityScheme", "identityVersion", "instanceKey", "payloadHash", "migration",
]);
const MIGRATION_FIELDS = Object.freeze(["state", "peerEventId", "migratedAt"]);
const MIGRATION_STATES = Object.freeze(["legacy", "native", "migrated", "redirect"]);

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

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
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

function requireInstanceKey(value) {
  if (!validIdentifier(value, 256)) fail("invalid_instance_key", 400);
  return value;
}

function requireExpectedVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail("invalid_expected_version", 400);
  return value;
}

function trustedNowIso(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail("invalid_server_clock", 500);
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

function canonicalFromDocument(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) fail("invalid_stored_canonical_event", 500);
  const canonical = { ...data };
  delete canonical[CALENDAR_STORE_METADATA_FIELD];
  try {
    return normalizeCanonicalCalendarEvent(canonical);
  } catch {
    fail("invalid_stored_canonical_event", 500);
  }
}

function migrationMetadata(state, peerEventId = null, migratedAt = null) {
  return { state, peerEventId, migratedAt };
}

function storeMetadata({ instanceKey, payloadHash, migration }) {
  return {
    identityScheme: CALENDAR_IDENTITY_SCHEME,
    identityVersion: CALENDAR_IDENTITY_VERSION,
    instanceKey,
    payloadHash,
    migration,
  };
}

function canonicalDocument(event, metadata) {
  return { ...event, [CALENDAR_STORE_METADATA_FIELD]: metadata };
}

function createCalendarEventStore({ db, now, identity }) {
  if (!db || typeof db.collection !== "function" || typeof db.runTransaction !== "function") {
    throw new TypeError("calendar_event_store_requires_db");
  }
  if (!identity || typeof identity.eventId !== "function" || typeof identity.payloadHash !== "function"
      || typeof now !== "function") {
    throw new TypeError("calendar_event_store_requires_server_dependencies");
  }

  const collection = db.collection(CALENDAR_EVENTS_COLLECTION);

  function deterministicId({ verifiedUid, sourceEntityType, sourceEntityId, instanceKey }) {
    try {
      return requireCanonicalId(identity.eventId({
        ownerUid: verifiedUid,
        sourceEntityType,
        sourceEntityId,
        instanceKey,
      }));
    } catch (err) {
      if (err instanceof CalendarEventStoreError) throw err;
      fail("canonical_identity_failed", 500);
    }
  }

  function hashFor(event) {
    try {
      const hash = identity.payloadHash(event);
      if (!PAYLOAD_HASH_RE.test(hash)) fail("invalid_provider_payload_hash", 500);
      return hash;
    } catch (err) {
      if (err instanceof CalendarEventStoreError) throw err;
      fail("provider_payload_hash_failed", 500);
    }
  }

  function normalizeMetadata(raw, event, snapshotId) {
    if (raw === undefined) {
      if (!isTemporaryCalendarEventId(snapshotId)) fail("missing_calendar_store_metadata", 500);
      return storeMetadata({
        instanceKey: DEFAULT_CALENDAR_INSTANCE_KEY,
        payloadHash: hashFor(event),
        migration: migrationMetadata("legacy"),
      });
    }
    if (!exactKeys(raw, STORE_METADATA_FIELDS) || !exactKeys(raw.migration, MIGRATION_FIELDS)
        || raw.identityScheme !== CALENDAR_IDENTITY_SCHEME
        || raw.identityVersion !== CALENDAR_IDENTITY_VERSION
        || !validIdentifier(raw.instanceKey, 256)
        || !PAYLOAD_HASH_RE.test(raw.payloadHash)
        || !MIGRATION_STATES.includes(raw.migration.state)) {
      fail("invalid_calendar_store_metadata", 500);
    }
    const { state, peerEventId, migratedAt } = raw.migration;
    const deterministic = isDeterministicCalendarEventId(snapshotId);
    const temporary = isTemporaryCalendarEventId(snapshotId);
    if ((state === "native" && (!deterministic || peerEventId !== null || migratedAt !== null))
        || (state === "legacy" && (!temporary || peerEventId !== null || migratedAt !== null))
        || (state === "migrated" && (!deterministic || !isTemporaryCalendarEventId(peerEventId)
          || !isValidRfc3339Timestamp(migratedAt)))
        || (state === "redirect" && (!temporary || !isDeterministicCalendarEventId(peerEventId)
          || !isValidRfc3339Timestamp(migratedAt)))) {
      fail("invalid_calendar_migration_metadata", 500);
    }
    const expectedId = deterministicId({
      verifiedUid: event.ownerUid,
      sourceEntityType: event.sourceEntityType,
      sourceEntityId: event.sourceEntityId,
      instanceKey: raw.instanceKey,
    });
    if ((deterministic && snapshotId !== expectedId) || (state === "redirect" && peerEventId !== expectedId)) {
      fail("canonical_identity_mismatch", 500);
    }
    if (raw.payloadHash !== hashFor(event)) fail("provider_payload_hash_mismatch", 500);
    return raw;
  }

  function normalizeStored(snapshot, verifiedUid) {
    if (!snapshot || !snapshot.exists) fail("canonical_event_not_found", 404);
    const data = snapshot.data();
    const event = canonicalFromDocument(data);
    if (event.id !== snapshot.id) fail("invalid_stored_canonical_event", 500);
    if (event.ownerUid !== verifiedUid) fail("canonical_event_not_found", 404);
    return {
      event,
      metadata: normalizeMetadata(data[CALENDAR_STORE_METADATA_FIELD], event, snapshot.id),
      snapshot,
    };
  }

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

  function sourceQuery(verifiedUid, sourceEntityType, sourceEntityId) {
    return collection
      .where("ownerUid", "==", verifiedUid)
      .where("sourceEntityType", "==", sourceEntityType)
      .where("sourceEntityId", "==", sourceEntityId);
  }

  async function createFromSource({
    verifiedUid,
    sourceEntityType,
    sourceEntityId,
    source,
    instanceKey = DEFAULT_CALENDAR_INSTANCE_KEY,
  }) {
    const uid = requireVerifiedUid(verifiedUid);
    const sourceId = requireSourceEntityId(sourceEntityId);
    const instance = requireInstanceKey(instanceKey);
    if (!SOURCE_ADAPTERS[sourceEntityType]) fail("invalid_source_entity_type", 400);
    const id = deterministicId({ verifiedUid: uid, sourceEntityType, sourceEntityId: sourceId, instanceKey: instance });
    const projectedAt = trustedNowIso(now);
    const projected = projectSource({
      verifiedUid: uid,
      sourceEntityType,
      sourceEntityId: sourceId,
      source,
      id,
      projectedAt,
    });
    const targetRef = collection.doc(id);
    const matchingQuery = sourceQuery(uid, sourceEntityType, sourceId);

    return db.runTransaction(async (transaction) => {
      const targetSnapshot = await transaction.get(targetRef);
      const matches = await transaction.get(matchingQuery);
      // Validate every logical-source match, not only legacy IDs. This fails closed if the
      // configured identity key changes and an older deterministic ID no longer verifies; a key
      // rotation can therefore never silently fork one source into a second canonical event.
      const matchingRecords = (matches && Array.isArray(matches.docs) ? matches.docs : [])
        .map((snapshot) => normalizeStored(snapshot, uid));
      const temporaryRecords = matchingRecords
        .filter((record) => isTemporaryCalendarEventId(record.event.id)
          && record.metadata.instanceKey === instance);
      const activeTemporary = temporaryRecords.filter((record) => record.metadata.migration.state !== "redirect");
      if (activeTemporary.length > 1) fail("ambiguous_temporary_canonical_events", 409);
      const legacy = activeTemporary[0] || null;

      if (targetSnapshot && targetSnapshot.exists) {
        const target = normalizeStored(targetSnapshot, uid);
        if (target.event.sourceEntityType !== sourceEntityType || target.event.sourceEntityId !== sourceId
            || target.metadata.instanceKey !== instance) {
          fail("canonical_identity_collision", 409);
        }
        if (legacy) {
          const migratedAt = projectedAt;
          const targetMetadata = storeMetadata({
            instanceKey: instance,
            payloadHash: target.metadata.payloadHash,
            migration: migrationMetadata("migrated", legacy.event.id, migratedAt),
          });
          const redirectMetadata = storeMetadata({
            instanceKey: instance,
            payloadHash: legacy.metadata.payloadHash,
            migration: migrationMetadata("redirect", target.event.id, migratedAt),
          });
          transaction.set(targetRef, canonicalDocument(target.event, targetMetadata));
          transaction.set(legacy.snapshot.ref, canonicalDocument(legacy.event, redirectMetadata));
        }
        return target.event;
      }

      let event = projected;
      let metadata;
      if (legacy) {
        event = normalizeProjection({
          ...legacy.event,
          id,
          updatedAt: projectedAt,
          version: legacy.event.version + 1,
        });
        metadata = storeMetadata({
          instanceKey: instance,
          payloadHash: hashFor(event),
          migration: migrationMetadata("migrated", legacy.event.id, projectedAt),
        });
        const redirectMetadata = storeMetadata({
          instanceKey: instance,
          payloadHash: legacy.metadata.payloadHash,
          migration: migrationMetadata("redirect", id, projectedAt),
        });
        transaction.set(legacy.snapshot.ref, canonicalDocument(legacy.event, redirectMetadata));
      } else {
        if (event.version !== 1 || event.createdAt !== projectedAt || event.updatedAt !== projectedAt) {
          fail("invalid_initial_canonical_lifecycle", 500);
        }
        metadata = storeMetadata({
          instanceKey: instance,
          payloadHash: hashFor(event),
          migration: migrationMetadata("native"),
        });
      }
      transaction.set(targetRef, canonicalDocument(event, metadata));
      return event;
    });
  }

  async function readOwnedRecord({ verifiedUid, canonicalEventId }) {
    const uid = requireVerifiedUid(verifiedUid);
    const id = requireCanonicalId(canonicalEventId);
    const record = normalizeStored(await collection.doc(id).get(), uid);
    if (record.metadata.migration.state !== "redirect") return record;
    const target = normalizeStored(await collection.doc(record.metadata.migration.peerEventId).get(), uid);
    if (target.event.sourceEntityType !== record.event.sourceEntityType
        || target.event.sourceEntityId !== record.event.sourceEntityId
        || target.metadata.instanceKey !== record.metadata.instanceKey) {
      fail("invalid_calendar_migration_link", 500);
    }
    return target;
  }

  async function readOwnedEvent(args) {
    return (await readOwnedRecord(args)).event;
  }

  async function readOwnedSourceReference(args) {
    const record = await readOwnedRecord(args);
    return {
      canonicalEventId: record.event.id,
      sourceEntityType: record.event.sourceEntityType,
      sourceEntityId: record.event.sourceEntityId,
      instanceKey: record.metadata.instanceKey,
      version: record.event.version,
    };
  }

  async function listForOwner({ verifiedUid }) {
    const uid = requireVerifiedUid(verifiedUid);
    const snapshot = await collection.where("ownerUid", "==", uid).get();
    const events = (snapshot && Array.isArray(snapshot.docs) ? snapshot.docs : [])
      .map((docSnapshot) => normalizeStored(docSnapshot, uid))
      .filter((record) => record.metadata.migration.state !== "redirect" && record.event.deletedAt === null)
      .map((record) => record.event);
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
      if (stored.metadata.migration.state === "redirect") fail("canonical_event_migrated", 409);
      if (stored.metadata.migration.state === "legacy") fail("temporary_canonical_event_requires_migration", 409);
      if (stored.event.deletedAt !== null) fail("canonical_event_deleted", 409);
      if (stored.event.version !== expected) fail("stale_canonical_event_version", 409);

      const projected = projectSource({
        verifiedUid: uid,
        sourceEntityType: stored.event.sourceEntityType,
        sourceEntityId: stored.event.sourceEntityId,
        source,
        id: stored.event.id,
        projectedAt: updatedAt,
      });
      const updated = normalizeProjection({
        ...projected,
        createdAt: stored.event.createdAt,
        updatedAt,
        version: stored.event.version + 1,
        sync: stored.event.sync,
      });
      const metadata = storeMetadata({
        instanceKey: stored.metadata.instanceKey,
        payloadHash: hashFor(updated),
        migration: stored.metadata.migration,
      });
      transaction.set(ref, canonicalDocument(updated, metadata));
      return updated;
    });
  }

  async function tombstoneOwnedEvent({ verifiedUid, canonicalEventId, expectedVersion }) {
    const uid = requireVerifiedUid(verifiedUid);
    const expected = requireExpectedVersion(expectedVersion);
    const resolved = await readOwnedRecord({ verifiedUid: uid, canonicalEventId });
    const deletedAt = trustedNowIso(now);

    // A source may already have been hard-deleted before the explicit tombstone request arrives.
    // A legacy 3B.4 record still contains the verified canonical source tuple, so migrate and
    // tombstone it atomically without pretending that a failed source read proved deletion.
    if (resolved.metadata.migration.state === "legacy") {
      const deterministicEventId = deterministicId({
        verifiedUid: uid,
        sourceEntityType: resolved.event.sourceEntityType,
        sourceEntityId: resolved.event.sourceEntityId,
        instanceKey: resolved.metadata.instanceKey,
      });
      const legacyRef = collection.doc(resolved.event.id);
      const targetRef = collection.doc(deterministicEventId);
      return db.runTransaction(async (transaction) => {
        const legacy = normalizeStored(await transaction.get(legacyRef), uid);
        const targetSnapshot = await transaction.get(targetRef);
        if (targetSnapshot && targetSnapshot.exists) fail("temporary_canonical_event_requires_migration", 409);
        if (legacy.event.deletedAt === null && legacy.event.version !== expected) {
          fail("stale_canonical_event_version", 409);
        }
        const tombstone = normalizeProjection({
          ...legacy.event,
          id: deterministicEventId,
          deletedAt: legacy.event.deletedAt || deletedAt,
          deletionOrigin: legacy.event.deletionOrigin || "edenatlas",
          updatedAt: deletedAt,
          version: legacy.event.version + 1,
        });
        const targetMetadata = storeMetadata({
          instanceKey: legacy.metadata.instanceKey,
          payloadHash: hashFor(tombstone),
          migration: migrationMetadata("migrated", legacy.event.id, deletedAt),
        });
        const redirectMetadata = storeMetadata({
          instanceKey: legacy.metadata.instanceKey,
          payloadHash: legacy.metadata.payloadHash,
          migration: migrationMetadata("redirect", deterministicEventId, deletedAt),
        });
        transaction.set(targetRef, canonicalDocument(tombstone, targetMetadata));
        transaction.set(legacyRef, canonicalDocument(legacy.event, redirectMetadata));
        return tombstone;
      });
    }

    const ref = collection.doc(resolved.event.id);
    return db.runTransaction(async (transaction) => {
      const stored = normalizeStored(await transaction.get(ref), uid);
      if (stored.event.deletedAt !== null) return stored.event;
      if (stored.event.version !== expected) fail("stale_canonical_event_version", 409);
      const tombstone = normalizeProjection({
        ...stored.event,
        deletedAt,
        deletionOrigin: "edenatlas",
        updatedAt: deletedAt,
        version: stored.event.version + 1,
      });
      const metadata = storeMetadata({
        instanceKey: stored.metadata.instanceKey,
        payloadHash: hashFor(tombstone),
        migration: stored.metadata.migration,
      });
      transaction.set(ref, canonicalDocument(tombstone, metadata));
      return tombstone;
    });
  }

  return {
    createFromSource,
    readOwnedEvent,
    readOwnedSourceReference,
    listForOwner,
    updateFromSource,
    tombstoneOwnedEvent,
  };
}

module.exports = {
  CALENDAR_EVENTS_COLLECTION,
  CALENDAR_STORE_METADATA_FIELD,
  CalendarEventStoreError,
  createCalendarEventStore,
};
