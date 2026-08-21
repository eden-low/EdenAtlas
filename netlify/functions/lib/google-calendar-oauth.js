// Phase 3A.1 Google Calendar OAuth primitives.
//
// This module deliberately contains no Calendar event calls. It owns the two credential-bearing
// operations required by the OAuth foundation: exchanging a one-time authorization code and
// encrypting the resulting refresh token. Access tokens are never persisted or returned.

const crypto = require("node:crypto");

const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
const GOOGLE_CALENDAR_CONNECTIONS_COLLECTION = "google_calendar_connections";
const GOOGLE_CALENDAR_OAUTH_STATES_COLLECTION = "google_calendar_oauth_states";
const STATE_VERSION = 1;
const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_DELETE_AFTER_MS = 24 * 60 * 60 * 1000;
const TOKEN_ENCRYPTION_VERSION = 1;
const TOKEN_ALGORITHM = "A256GCM";

class GoogleCalendarOAuthError extends Error {
  constructor(code, statusCode = 400) {
    super(code);
    this.name = "GoogleCalendarOAuthError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function parseMasterKey(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new GoogleCalendarOAuthError("invalid_token_encryption_key", 500);
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) {
    throw new GoogleCalendarOAuthError("invalid_token_encryption_key", 500);
  }
  return key;
}

function deriveKey(masterKey, purpose) {
  return Buffer.from(crypto.hkdfSync(
    "sha256",
    masterKey,
    Buffer.from("EdenAtlas Google Calendar OAuth v1", "utf8"),
    Buffer.from(purpose, "utf8"),
    32,
  ));
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function validOpaqueState(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function toDate(value) {
  if (value instanceof Date) return value;
  if (value && typeof value.toDate === "function") return value.toDate();
  if (typeof value === "string" || typeof value === "number") return new Date(value);
  return new Date(NaN);
}

function validateHttpsOrLocalRedirect(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new GoogleCalendarOAuthError("invalid_redirect_uri", 500);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.username || url.password || url.hash || url.search || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new GoogleCalendarOAuthError("invalid_redirect_uri", 500);
  }
  return url.toString();
}

function stateBindingPayload(record, stateHash) {
  return JSON.stringify([
    STATE_VERSION,
    stateHash,
    record.uid,
    record.environment,
    record.redirectUri,
    toDate(record.createdAt).toISOString(),
    toDate(record.expiresAt).toISOString(),
  ]);
}

function stateBindingMac(record, stateHash, masterKey) {
  return crypto
    .createHmac("sha256", deriveKey(masterKey, "oauth-state-binding"))
    .update(stateBindingPayload(record, stateHash), "utf8")
    .digest("base64url");
}

function safeEqualText(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createOAuthState({ uid, environment, redirectUri, masterKeyRaw, now = new Date(), randomBytesImpl = crypto.randomBytes }) {
  if (typeof uid !== "string" || !uid || uid.length > 128) {
    throw new GoogleCalendarOAuthError("invalid_uid", 500);
  }
  if (!new Set(["production", "staging", "development"]).has(environment)) {
    throw new GoogleCalendarOAuthError("invalid_environment", 500);
  }
  const exactRedirectUri = validateHttpsOrLocalRedirect(redirectUri);
  const masterKey = parseMasterKey(masterKeyRaw);
  const createdAt = toDate(now);
  if (!Number.isFinite(createdAt.getTime())) throw new GoogleCalendarOAuthError("invalid_server_time", 500);

  const random = randomBytesImpl(32);
  if (!Buffer.isBuffer(random) || random.length !== 32) {
    throw new GoogleCalendarOAuthError("state_generation_failed", 500);
  }
  const state = random.toString("base64url");
  const stateHash = sha256Hex(state);
  const record = {
    stateVersion: STATE_VERSION,
    uid,
    environment,
    redirectUri: exactRedirectUri,
    createdAt,
    expiresAt: new Date(createdAt.getTime() + STATE_TTL_MS),
    deleteAfter: new Date(createdAt.getTime() + STATE_DELETE_AFTER_MS),
    consumedAt: null,
  };
  record.bindingMac = stateBindingMac(record, stateHash, masterKey);
  return { state, stateHash, record };
}

function verifyOAuthStateRecord({ state, record, expectedEnvironment, expectedRedirectUri, masterKeyRaw, now = new Date() }) {
  if (!validOpaqueState(state)) throw new GoogleCalendarOAuthError("oauth_state_invalid");
  if (!record || typeof record !== "object") throw new GoogleCalendarOAuthError("oauth_state_invalid");
  const stateHash = sha256Hex(state);
  const createdAt = toDate(record.createdAt);
  const expiresAt = toDate(record.expiresAt);
  const currentTime = toDate(now);
  if (record.stateVersion !== STATE_VERSION
      || typeof record.uid !== "string" || !record.uid
      || typeof record.environment !== "string"
      || typeof record.redirectUri !== "string"
      || !Number.isFinite(createdAt.getTime())
      || !Number.isFinite(expiresAt.getTime())
      || !Number.isFinite(currentTime.getTime())) {
    throw new GoogleCalendarOAuthError("oauth_state_invalid");
  }

  let expectedMac;
  try {
    expectedMac = stateBindingMac(record, stateHash, parseMasterKey(masterKeyRaw));
  } catch (err) {
    if (err instanceof GoogleCalendarOAuthError && err.statusCode === 500) throw err;
    throw new GoogleCalendarOAuthError("oauth_state_invalid");
  }
  if (!safeEqualText(record.bindingMac, expectedMac)) {
    throw new GoogleCalendarOAuthError("oauth_state_tampered");
  }
  if (record.environment !== expectedEnvironment) {
    throw new GoogleCalendarOAuthError("oauth_state_wrong_environment");
  }
  if (record.redirectUri !== validateHttpsOrLocalRedirect(expectedRedirectUri)) {
    throw new GoogleCalendarOAuthError("oauth_state_wrong_redirect_uri");
  }
  if (record.consumedAt) throw new GoogleCalendarOAuthError("oauth_state_replayed");
  if (createdAt.getTime() > currentTime.getTime() + 30_000) {
    throw new GoogleCalendarOAuthError("oauth_state_invalid");
  }
  if (expiresAt.getTime() <= currentTime.getTime()) {
    throw new GoogleCalendarOAuthError("oauth_state_expired");
  }
  return { uid: record.uid, stateHash };
}

async function consumeOAuthState({ db, state, expectedEnvironment, expectedRedirectUri, masterKeyRaw, now = new Date() }) {
  if (!validOpaqueState(state)) throw new GoogleCalendarOAuthError("oauth_state_invalid");
  const stateHash = sha256Hex(state);
  const ref = db.collection(GOOGLE_CALENDAR_OAUTH_STATES_COLLECTION).doc(stateHash);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) throw new GoogleCalendarOAuthError("oauth_state_invalid");
    const verified = verifyOAuthStateRecord({
      state,
      record: snapshot.data(),
      expectedEnvironment,
      expectedRedirectUri,
      masterKeyRaw,
      now,
    });
    transaction.update(ref, { consumedAt: toDate(now), updatedAt: toDate(now) });
    return verified;
  });
}

function buildAuthorizationUrl({ clientId, redirectUri, state }) {
  if (typeof clientId !== "string" || !clientId.trim() || !validOpaqueState(state)) {
    throw new GoogleCalendarOAuthError("oauth_not_configured", 500);
  }
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", clientId.trim());
  url.searchParams.set("redirect_uri", validateHttpsOrLocalRedirect(redirectUri));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_CALENDAR_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

function normalizeGrantedScopes(raw) {
  return [...new Set(String(raw || "").split(/\s+/).filter(Boolean))].sort();
}

async function exchangeAuthorizationCode({ fetchImpl = fetch, clientId, clientSecret, redirectUri, code }) {
  if (typeof code !== "string" || !code || code.length > 4096) {
    throw new GoogleCalendarOAuthError("authorization_code_invalid");
  }
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: validateHttpsOrLocalRedirect(redirectUri),
    grant_type: "authorization_code",
  });
  let response;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GoogleCalendarOAuthError("token_exchange_failed", 502);
  }
  if (!response || !response.ok) throw new GoogleCalendarOAuthError("token_exchange_failed", 502);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new GoogleCalendarOAuthError("token_exchange_failed", 502);
  }
  const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : "";
  const grantedScopes = normalizeGrantedScopes(payload.scope);
  if (!refreshToken) throw new GoogleCalendarOAuthError("refresh_token_missing", 502);
  if (!grantedScopes.includes(GOOGLE_CALENDAR_SCOPE)) {
    throw new GoogleCalendarOAuthError("required_scope_not_granted", 403);
  }
  return { refreshToken, grantedScopes };
}

async function revokeOAuthToken({ fetchImpl = fetch, token }) {
  if (typeof token !== "string" || !token) return false;
  try {
    const response = await fetchImpl("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    return !!response && response.ok;
  } catch {
    return false;
  }
}

function tokenAad(uid) {
  if (typeof uid !== "string" || !uid) throw new GoogleCalendarOAuthError("invalid_uid", 500);
  return Buffer.from(`EdenAtlas:google-calendar:refresh-token:v${TOKEN_ENCRYPTION_VERSION}:uid:${uid}`, "utf8");
}

function encryptRefreshToken({ refreshToken, uid, masterKeyRaw, randomBytesImpl = crypto.randomBytes }) {
  if (typeof refreshToken !== "string" || !refreshToken) {
    throw new GoogleCalendarOAuthError("refresh_token_missing", 500);
  }
  const masterKey = parseMasterKey(masterKeyRaw);
  const iv = randomBytesImpl(12);
  if (!Buffer.isBuffer(iv) || iv.length !== 12) throw new GoogleCalendarOAuthError("token_encryption_failed", 500);
  try {
    const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(masterKey, "refresh-token-encryption"), iv);
    cipher.setAAD(tokenAad(uid));
    const ciphertext = Buffer.concat([cipher.update(refreshToken, "utf8"), cipher.final()]);
    return {
      version: TOKEN_ENCRYPTION_VERSION,
      algorithm: TOKEN_ALGORITHM,
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    };
  } catch (err) {
    if (err instanceof GoogleCalendarOAuthError) throw err;
    throw new GoogleCalendarOAuthError("token_encryption_failed", 500);
  }
}

function canonicalBase64Buffer(value) {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const buffer = Buffer.from(value, "base64");
  return buffer.toString("base64") === value ? buffer : null;
}

function encryptedTokenEnvelopeIsValid(value) {
  if (!value || value.version !== TOKEN_ENCRYPTION_VERSION || value.algorithm !== TOKEN_ALGORITHM) return false;
  const iv = canonicalBase64Buffer(value.iv);
  const ciphertext = canonicalBase64Buffer(value.ciphertext);
  const authTag = canonicalBase64Buffer(value.authTag);
  return !!iv && iv.length === 12 && !!ciphertext && ciphertext.length > 0 && !!authTag && authTag.length === 16;
}

function decryptRefreshToken({ encryptedToken, uid, masterKeyRaw }) {
  if (!encryptedTokenEnvelopeIsValid(encryptedToken)) {
    throw new GoogleCalendarOAuthError("token_decryption_failed", 500);
  }
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      deriveKey(parseMasterKey(masterKeyRaw), "refresh-token-encryption"),
      Buffer.from(encryptedToken.iv, "base64"),
    );
    decipher.setAAD(tokenAad(uid));
    decipher.setAuthTag(Buffer.from(encryptedToken.authTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedToken.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (err) {
    if (err instanceof GoogleCalendarOAuthError && err.code === "invalid_token_encryption_key") throw err;
    throw new GoogleCalendarOAuthError("token_decryption_failed", 500);
  }
}

module.exports = {
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_CALENDAR_SCOPE,
  GOOGLE_CALENDAR_CONNECTIONS_COLLECTION,
  GOOGLE_CALENDAR_OAUTH_STATES_COLLECTION,
  STATE_TTL_MS,
  TOKEN_ENCRYPTION_VERSION,
  GoogleCalendarOAuthError,
  createOAuthState,
  verifyOAuthStateRecord,
  consumeOAuthState,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  revokeOAuthToken,
  encryptRefreshToken,
  decryptRefreshToken,
  encryptedTokenEnvelopeIsValid,
  normalizeGrantedScopes,
  parseMasterKey,
  sha256Hex,
  validateHttpsOrLocalRedirect,
};
