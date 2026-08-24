// Pure server-side identity and provider-payload hashing primitives for canonical Calendar events.
// No environment, Firestore, OAuth, network, or browser dependency belongs in this module.

const crypto = require("node:crypto");
const {
  CALENDAR_SOURCE_ENTITY_TYPES,
  normalizeCanonicalCalendarEvent,
} = require("./calendar-event-model.js");

const CALENDAR_IDENTITY_NAMESPACE = "ea-calendar:v1";
const CALENDAR_IDENTITY_VERSION = 1;
const CALENDAR_IDENTITY_SCHEME = "hmac-sha256-base32hex-v1";
const DEFAULT_CALENDAR_INSTANCE_KEY = "single";
const PROVIDER_PAYLOAD_HASH_SCHEME = "sha256";
const BASE32HEX_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUV";
const DETERMINISTIC_ID_RE = /^[0-9A-V]{52}$/u;
const TEMPORARY_ID_RE = /^ce_[0-9a-f]{32}$/iu;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/u;

class CalendarEventIdentityError extends Error {
  constructor(code) {
    super(code);
    this.name = "CalendarEventIdentityError";
    this.code = code;
  }
}

function fail(code) {
  throw new CalendarEventIdentityError(code);
}

function requireComponent(value, name, maxBytes) {
  if (typeof value !== "string" || !value || CONTROL_CHAR_RE.test(value)
      || Buffer.byteLength(value, "utf8") > maxBytes) {
    fail(`invalid_identity_${name}`);
  }
  return value;
}

// Length-prefix every UTF-8 component so embedded separators cannot make two source tuples share
// an HMAC input. Values are otherwise byte-preserving: source IDs are identities, not display text.
function lengthPrefixed(value) {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

function canonicalIdentityInput({ ownerUid, sourceEntityType, sourceEntityId, instanceKey }) {
  const owner = requireComponent(ownerUid, "owner_uid", 128);
  const sourceType = requireComponent(sourceEntityType, "source_entity_type", 32);
  if (!CALENDAR_SOURCE_ENTITY_TYPES.includes(sourceType)) fail("invalid_identity_source_entity_type");
  const sourceId = requireComponent(sourceEntityId, "source_entity_id", 1024);
  const instance = requireComponent(instanceKey, "instance_key", 256);
  return `${CALENDAR_IDENTITY_NAMESPACE}|${[owner, sourceType, sourceId, instance]
    .map(lengthPrefixed)
    .join("|")}`;
}

function base32hex(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32HEX_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
      value &= (1 << bits) - 1;
    }
  }
  if (bits > 0) output += BASE32HEX_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function stableJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  fail("invalid_stable_hash_value");
}

function providerPayload(event) {
  const canonical = normalizeCanonicalCalendarEvent(event);
  return {
    allDay: canonical.allDay,
    end: canonical.end,
    start: canonical.start,
    status: canonical.status,
    summary: canonical.summary,
    timeZone: canonical.timeZone,
    title: canonical.title,
  };
}

function providerPayloadHash(event) {
  const encoded = stableJson(providerPayload(event));
  return `${PROVIDER_PAYLOAD_HASH_SCHEME}:${crypto.createHash("sha256").update(encoded, "utf8").digest("hex")}`;
}

function identityKey(serverIdentityKey) {
  const key = Buffer.isBuffer(serverIdentityKey)
    ? Buffer.from(serverIdentityKey)
    : (typeof serverIdentityKey === "string" ? Buffer.from(serverIdentityKey, "utf8") : null);
  if (!key || key.length < 32) fail("calendar_identity_key_unavailable");
  return key;
}

function createCalendarEventIdentity(serverIdentityKey) {
  const key = identityKey(serverIdentityKey);
  return Object.freeze({
    eventId(parts) {
      const input = canonicalIdentityInput(parts);
      return base32hex(crypto.createHmac("sha256", key).update(input, "utf8").digest());
    },
    payloadHash: providerPayloadHash,
  });
}

function isDeterministicCalendarEventId(value) {
  return typeof value === "string" && DETERMINISTIC_ID_RE.test(value);
}

function isTemporaryCalendarEventId(value) {
  return typeof value === "string" && TEMPORARY_ID_RE.test(value);
}

module.exports = {
  CALENDAR_IDENTITY_NAMESPACE,
  CALENDAR_IDENTITY_VERSION,
  CALENDAR_IDENTITY_SCHEME,
  DEFAULT_CALENDAR_INSTANCE_KEY,
  PROVIDER_PAYLOAD_HASH_SCHEME,
  CalendarEventIdentityError,
  canonicalIdentityInput,
  base32hex,
  stableJson,
  providerPayload,
  providerPayloadHash,
  createCalendarEventIdentity,
  isDeterministicCalendarEventId,
  isTemporaryCalendarEventId,
};
