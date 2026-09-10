// Owner-only, server-mediated Career policy transition. Firestore Rules reject every browser
// write to the policy/version/transition fields. The endpoint has two deliberately separate
// operations: begin creates a server-random one-time capability; complete can only consume the
// matching active capability and can never create or reinterpret one.

const crypto = require("node:crypto");
const { readGeneratedDeployOrigins } = require("./lib/deploy-origin");

const OWNER_EMAIL = "jjun8647@gmail.com";
const CAREER_COLLECTIONS = Object.freeze([
  "career_experiences", "career_projects", "career_certificates", "career_awards",
]);
const VISIBILITIES = new Set(["private", "connections", "public"]);
const LOCK_TTL_MS = 2 * 60 * 1000;
const MAX_CAREER_ITEMS = 498;
const REQUIRED_ENV = ["FIREBASE_PROJECT_ID", "FIREBASE_SERVICE_ACCOUNT", "ALLOWED_ORIGIN"];
const LOCAL_DEV_ORIGINS = [
  "http://localhost:8888", "http://127.0.0.1:8888",
  "http://localhost:3000", "http://127.0.0.1:3000",
  "http://localhost:8000", "http://127.0.0.1:8000",
];

class PolicyTransitionError extends Error {
  constructor(code, statusCode = 409) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function jsonResponse(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders },
    body: JSON.stringify(body),
  };
}
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}
function normalizeExactOrigin(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return null;
  try {
    const parsed = new URL(rawUrl.trim());
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch { return null; }
}
function resolveAllowedOrigins(env) {
  return new Set([
    ...String(env.ALLOWED_ORIGIN || "").split(",").map(normalizeExactOrigin).filter(Boolean),
    ...[env.DEPLOY_PRIME_URL, env.DEPLOY_URL].map(normalizeExactOrigin).filter(Boolean),
    ...LOCAL_DEV_ORIGINS,
  ]);
}
function getHeader(event, name) {
  const headers = event.headers || {};
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}
function parseBody(raw) {
  let body;
  try { body = JSON.parse(raw); } catch { throw new PolicyTransitionError("invalid_json", 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new PolicyTransitionError("invalid_json", 400);
  if (body.action === "begin") {
    if (Object.keys(body).sort().join(",") !== "action,careerVisibility") {
      throw new PolicyTransitionError("unknown_field", 400);
    }
    if (!VISIBILITIES.has(body.careerVisibility)) throw new PolicyTransitionError("invalid_visibility", 400);
    return body;
  }
  if (body.action === "complete") {
    if (Object.keys(body).sort().join(",") !== "action,careerVisibility,transitionId,transitionSecret") {
      throw new PolicyTransitionError("unknown_field", 400);
    }
    if (!VISIBILITIES.has(body.careerVisibility)) throw new PolicyTransitionError("invalid_visibility", 400);
    if (typeof body.transitionId !== "string" || !/^[0-9a-f-]{36}$/.test(body.transitionId)) {
      throw new PolicyTransitionError("invalid_transition_id", 400);
    }
    if (typeof body.transitionSecret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.transitionSecret)) {
      throw new PolicyTransitionError("invalid_transition_secret", 400);
    }
    return body;
  }
  throw new PolicyTransitionError("invalid_action", 400);
}
function hashSecret(secret) { return crypto.createHash("sha256").update(secret, "utf8").digest("hex"); }
function hashEquals(left, right) {
  if (typeof left !== "string" || typeof right !== "string"
      || !/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
function millis(value) { return value && typeof value.toMillis === "function" ? value.toMillis() : NaN; }
function markerMatches(marker, { uid, transitionId, secretHash }) {
  return !!marker && marker.ownerUid === uid && marker.id === transitionId
    && hashEquals(marker.secretHash, secretHash);
}
function currentPolicy(data) {
  if (Number.isInteger(data.careerPolicyVersion) && data.careerPolicyVersion >= 1
      && VISIBILITIES.has(data.careerVisibility)) {
    return { visibility: data.careerVisibility, version: data.careerPolicyVersion };
  }
  // Canonical initialization is always private/v0 -> private/v1. Legacy profile visibility is
  // never imported as authority because doing so could broaden previously fail-closed snapshots.
  return { visibility: "private", version: 0 };
}
function snapshotMatchesPolicy(data, policy) {
  if (policy.version === 0) {
    return !("careerVisibility" in data) && !("careerPolicyVersion" in data);
  }
  return data.careerVisibility === policy.visibility && data.careerPolicyVersion === policy.version;
}
function generateServerCapability() {
  return {
    transitionId: crypto.randomUUID(),
    transitionSecret: crypto.randomBytes(32).toString("base64url"),
  };
}

async function beginPolicyTransition({ db, Timestamp, uid, targetVisibility, nowMs, generateCapability = generateServerCapability }) {
  const profileRef = db.collection("public_profiles").doc(uid);
  const capability = generateCapability();
  if (!capability || typeof capability.transitionId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(capability.transitionId)
      || typeof capability.transitionSecret !== "string"
      || !/^[A-Za-z0-9_-]{43}$/.test(capability.transitionSecret)) {
    throw new PolicyTransitionError("capability_generation_failed", 500);
  }
  const secretHash = hashSecret(capability.transitionSecret);
  let marker;

  await db.runTransaction(async (transaction) => {
    const profileSnapshot = await transaction.get(profileRef);
    const profile = profileSnapshot.exists ? profileSnapshot.data() : {};
    const active = profile.careerPolicyTransition;
    if (active) {
      const expiry = millis(active.expiresAt);
      // Malformed locks never become replaceable through guesswork. A well-formed expired lock may
      // be replaced, but its old capability cannot complete because complete requires the new ID.
      if (!Number.isFinite(expiry)) throw new PolicyTransitionError("transition_state_invalid");
      if (nowMs < expiry) throw new PolicyTransitionError("transition_in_progress");
    }
    const source = currentPolicy(profile);
    if (source.version === 0 && targetVisibility !== "private") {
      throw new PolicyTransitionError("career_policy_initialization_required");
    }
    if (source.version >= 1 && source.visibility === targetVisibility) {
      throw new PolicyTransitionError("policy_unchanged");
    }
    marker = {
      id: capability.transitionId,
      ownerUid: uid,
      secretHash,
      sourceVisibility: source.visibility,
      sourceVersion: source.version,
      targetVisibility,
      targetVersion: source.version + 1,
      createdAt: Timestamp.fromMillis(nowMs),
      expiresAt: Timestamp.fromMillis(nowMs + LOCK_TTL_MS),
    };
    transaction.set(profileRef, { uid, role: "owner", careerPolicyTransition: marker }, { merge: true });
  });

  return {
    transitionId: capability.transitionId,
    transitionSecret: capability.transitionSecret,
    sourceCareerVisibility: marker.sourceVisibility,
    sourceCareerPolicyVersion: marker.sourceVersion,
    targetCareerVisibility: marker.targetVisibility,
    expiresAt: marker.expiresAt,
  };
}

async function completePolicyTransition({ db, FieldValue, Timestamp, uid, targetVisibility, transitionId, transitionSecret, nowMs }) {
  const profileRef = db.collection("public_profiles").doc(uid);
  const userRef = db.collection("users").doc(uid);
  const secretHash = hashSecret(transitionSecret);
  let completedVersion;

  await db.runTransaction(async (transaction) => {
    const profileSnapshot = await transaction.get(profileRef);
    const profile = profileSnapshot.exists ? profileSnapshot.data() : {};
    const active = profile.careerPolicyTransition;
    if (!active) {
      if (markerMatches(profile.careerPolicyLastConsumed, { uid, transitionId, secretHash })) {
        throw new PolicyTransitionError("transition_already_consumed");
      }
      throw new PolicyTransitionError("transition_not_active");
    }
    if (!markerMatches(active, { uid, transitionId, secretHash })) {
      throw new PolicyTransitionError("transition_capability_mismatch");
    }
    if (active.targetVisibility !== targetVisibility) {
      throw new PolicyTransitionError("transition_target_mismatch");
    }
    const expiry = millis(active.expiresAt);
    if (!Number.isFinite(expiry) || nowMs >= expiry) throw new PolicyTransitionError("transition_expired");
    const source = currentPolicy(profile);
    if (source.visibility !== active.sourceVisibility || source.version !== active.sourceVersion
        || active.targetVersion !== active.sourceVersion + 1) {
      throw new PolicyTransitionError("transition_source_changed");
    }

    const itemSnapshots = [];
    for (const collectionName of CAREER_COLLECTIONS) {
      const querySnapshot = await transaction.get(db.collection(collectionName).where("uid", "==", uid));
      for (const documentSnapshot of querySnapshot.docs) {
        if (!snapshotMatchesPolicy(documentSnapshot.data(), source)) {
          throw new PolicyTransitionError("stale_career_snapshot");
        }
        itemSnapshots.push(documentSnapshot);
      }
    }
    if (itemSnapshots.length > MAX_CAREER_ITEMS) throw new PolicyTransitionError("career_policy_batch_limit", 400);

    const consumed = { ...active, consumedAt: Timestamp.fromMillis(nowMs) };
    transaction.set(userRef, { uid, careerVisibility: targetVisibility }, { merge: true });
    transaction.set(profileRef, {
      uid,
      role: "owner",
      careerVisibility: targetVisibility,
      careerPolicyVersion: active.targetVersion,
      careerPolicyTransition: FieldValue.delete(),
      careerPolicyLastConsumed: consumed,
    }, { merge: true });
    for (const item of itemSnapshots) {
      transaction.update(item.ref, {
        careerVisibility: targetVisibility,
        careerPolicyVersion: active.targetVersion,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    completedVersion = active.targetVersion;
  });

  return { careerVisibility: targetVisibility, careerPolicyVersion: completedVersion };
}

function createHandler(deps) {
  return async function handler(event) {
    const env = deps.env || process.env;
    const missing = REQUIRED_ENV.filter((key) => !env[key]);
    if (missing.length) return jsonResponse(500, { ok: false, error: "career_policy_not_configured" });
    try { await deps.ensureFirebaseAdmin(); } catch {
      return jsonResponse(500, { ok: false, error: "career_policy_not_configured" });
    }
    const origin = getHeader(event, "origin");
    const originOk = !!origin && resolveAllowedOrigins(env).has(origin);
    if (event.httpMethod === "OPTIONS") {
      return originOk
        ? { statusCode: 204, headers: { ...corsHeaders(origin), "Cache-Control": "no-store" }, body: "" }
        : jsonResponse(403, { ok: false, error: "origin_not_allowed" });
    }
    if (event.httpMethod !== "POST") return jsonResponse(405, { ok: false, error: "method_not_allowed" }, { Allow: "POST, OPTIONS" });
    if (!originOk) return jsonResponse(403, { ok: false, error: "origin_not_allowed" });
    const headers = corsHeaders(origin);
    const bearer = /^Bearer\s+(.+)$/i.exec((getHeader(event, "authorization") || "").trim());
    if (!bearer) return jsonResponse(401, { ok: false, error: "missing_bearer_token" }, headers);

    let decoded;
    try { decoded = await deps.verifyIdToken(bearer[1]); } catch {
      return jsonResponse(401, { ok: false, error: "invalid_or_expired_token" }, headers);
    }
    if (!decoded?.uid || decoded.email !== OWNER_EMAIL || decoded.email_verified !== true) {
      return jsonResponse(403, { ok: false, error: "owner_only" }, headers);
    }
    const userDoc = await deps.getUserDoc(decoded.uid).catch(() => null);
    if (!userDoc || userDoc.role !== "owner" || userDoc.email !== OWNER_EMAIL) {
      return jsonResponse(403, { ok: false, error: "owner_only" }, headers);
    }

    try {
      const body = parseBody(event.body);
      const common = { uid: decoded.uid, targetVisibility: body.careerVisibility, nowMs: deps.nowMs() };
      const result = body.action === "begin"
        ? await deps.beginTransition(common)
        : await deps.completeTransition({
          ...common,
          transitionId: body.transitionId,
          transitionSecret: body.transitionSecret,
        });
      return jsonResponse(200, { ok: true, ...result }, headers);
    } catch (error) {
      const known = error instanceof PolicyTransitionError;
      return jsonResponse(known ? error.statusCode : 500, {
        ok: false, error: known ? error.code : "career_policy_internal_error",
      }, headers);
    }
  };
}

function buildProductionDeps() {
  const { initializeApp, cert, getApps, getApp } = require("firebase-admin/app");
  const { getAuth } = require("firebase-admin/auth");
  const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
  const { initializeFirebaseAdmin } = require("./lib/firebase-admin");
  const { readGeneratedBuildContext } = require("./lib/build-context");
  let app;
  function ensureApp() {
    if (app) return app;
    app = initializeFirebaseAdmin({ getApps, getApp, initializeApp, cert,
      projectId: process.env.FIREBASE_PROJECT_ID,
      serviceAccountRaw: process.env.FIREBASE_SERVICE_ACCOUNT,
      buildContext: readGeneratedBuildContext(),
    });
    return app;
  }
  const generated = readGeneratedDeployOrigins();
  const env = { ...process.env,
    DEPLOY_PRIME_URL: process.env.DEPLOY_PRIME_URL || generated.deployPrimeUrl || undefined,
    DEPLOY_URL: process.env.DEPLOY_URL || generated.deployUrl || undefined,
  };
  const db = () => getFirestore(ensureApp());
  return {
    env,
    ensureFirebaseAdmin: async () => { ensureApp(); },
    verifyIdToken: (token) => getAuth(ensureApp()).verifyIdToken(token, true),
    getUserDoc: async (uid) => {
      const snap = await db().collection("users").doc(uid).get();
      return snap.exists ? snap.data() : null;
    },
    nowMs: () => Date.now(),
    beginTransition: (args) => beginPolicyTransition({ db: db(), Timestamp, ...args }),
    completeTransition: (args) => completePolicyTransition({ db: db(), FieldValue, Timestamp, ...args }),
  };
}

exports.handler = createHandler(buildProductionDeps());
exports.createHandler = createHandler;
exports.beginPolicyTransition = beginPolicyTransition;
exports.completePolicyTransition = completePolicyTransition;
exports.PolicyTransitionError = PolicyTransitionError;
exports.generateServerCapability = generateServerCapability;
exports.hashSecret = hashSecret;
exports.markerMatches = markerMatches;
exports.currentPolicy = currentPolicy;
exports.snapshotMatchesPolicy = snapshotMatchesPolicy;
exports.CAREER_COLLECTIONS = CAREER_COLLECTIONS;
exports.LOCK_TTL_MS = LOCK_TTL_MS;
