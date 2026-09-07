// Owner-only Expense Screenshot AI. This endpoint returns validated suggestions only: it never
// imports Assistant retrieval/tools, never writes an Expense, receipt, AI result, or other user
// content to Firestore, and never writes an image to Storage. The browser's existing Finance form
// remains the explicit confirmation boundary.
//
// Narrow persistence policy: "no Expense, receipt, or user-content Firestore writes; operational
// rate-limit metadata write is allowed." The sole allowed write is the atomic daily counter in
// ai_usage_expense_receipt. Its document key is built by lib/rate-limit.js exclusively from the
// Firebase-verified uid passed below plus the server-derived UTC date; neither its path nor its
// metadata can be influenced by the request body, receipt image, or model output.

const { FirebaseConfigError } = require("./lib/firebase-admin");
const { readGeneratedDeployOrigins } = require("./lib/deploy-origin");
const {
  ReceiptValidationError,
  validateImageDataUrl,
} = require("./lib/expense-receipt-validation");
const { QwenVisionError, callQwenReceiptVision } = require("./lib/qwen-vision");

const OWNER_EMAIL = "jjun8647@gmail.com";
const REQUIRED_ENV = [
  "FIREBASE_PROJECT_ID", "FIREBASE_SERVICE_ACCOUNT", "ALLOWED_ORIGIN",
  "DASHSCOPE_API_KEY", "QWEN_VISION_MODEL", "QWEN_BASE_URL",
];
const LOCAL_DEV_ORIGINS = [
  "http://localhost:8888", "http://127.0.0.1:8888",
  "http://localhost:3000", "http://127.0.0.1:3000",
  "http://localhost:8000", "http://127.0.0.1:8000",
];
// A 2 MiB image expands to about 2.80M Base64 characters. Keep a small JSON/Data-URL allowance
// while remaining far below Netlify's request ceiling.
const MAX_BODY_BYTES = 2_850_000;
const BURST_KEY_PREFIX = "expense-receipt:";
const DAILY_LIMIT = 10;
const DAILY_COLLECTION = "ai_usage_expense_receipt";

function jsonResponse(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
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
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function resolveAllowedOrigins(env) {
  const configured = String(env.ALLOWED_ORIGIN || "")
    .split(",")
    .map(normalizeExactOrigin)
    .filter(Boolean);
  const generated = [env.DEPLOY_PRIME_URL, env.DEPLOY_URL].map(normalizeExactOrigin).filter(Boolean);
  return new Set([...configured, ...generated, ...LOCAL_DEV_ORIGINS]);
}

function getHeader(event, name) {
  const headers = event.headers || {};
  const lower = name.toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === lower);
  return key ? headers[key] : undefined;
}

function parseRequestBody(raw) {
  if (typeof raw !== "string" || !raw.length) return { error: "empty_request_body" };
  if (raw.length > MAX_BODY_BYTES) return { error: "request_too_large" };
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return { error: "invalid_json" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid_json" };
  if (Object.keys(body).length !== 1 || !Object.prototype.hasOwnProperty.call(body, "imageDataUrl")) {
    return { error: "unknown_field" };
  }
  if (typeof body.imageDataUrl !== "string") return { error: "invalid_image_payload" };
  return { value: body.imageDataUrl };
}

function logAuthFailure(stage, err) {
  console.error(`[expense-receipt-ai] auth stage failed: stage=${stage} code=${(err && err.code) || "no_code"}`);
}

function createHandler(deps) {
  return async function handler(event) {
    const env = deps.env || process.env;
    const missing = REQUIRED_ENV.filter((key) => !env[key]);
    if (missing.length) {
      console.error("[expense-receipt-ai] missing required environment variables:", missing.join(","));
      return jsonResponse(500, { ok: false, error: "expense_receipt_ai_not_configured" });
    }

    try {
      await deps.ensureFirebaseAdmin();
    } catch (err) {
      logAuthFailure(err instanceof FirebaseConfigError ? err.stage : "admin_initialization", err);
      return jsonResponse(500, { ok: false, error: "expense_receipt_ai_not_configured" });
    }

    const method = event.httpMethod;
    const origin = getHeader(event, "origin");
    const originOk = !!origin && resolveAllowedOrigins(env).has(origin);
    if (method === "OPTIONS") {
      return originOk
        ? { statusCode: 204, headers: { ...corsHeaders(origin), "Cache-Control": "no-store" }, body: "" }
        : jsonResponse(403, { ok: false, error: "origin_not_allowed" });
    }
    if (method !== "POST") {
      return jsonResponse(405, { ok: false, error: "method_not_allowed" }, { Allow: "POST, OPTIONS" });
    }
    if (!originOk) return jsonResponse(403, { ok: false, error: "origin_not_allowed" });
    const baseHeaders = corsHeaders(origin);

    const authHeader = getHeader(event, "authorization") || "";
    const bearer = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (!bearer) return jsonResponse(401, { ok: false, error: "missing_bearer_token" }, baseHeaders);

    let decoded;
    try {
      decoded = await deps.verifyIdToken(bearer[1]);
    } catch (err) {
      if (err instanceof FirebaseConfigError) {
        logAuthFailure(err.stage, err);
        return jsonResponse(500, { ok: false, error: "expense_receipt_ai_not_configured" }, baseHeaders);
      }
      logAuthFailure("token_verification", err);
      return jsonResponse(401, { ok: false, error: "invalid_or_expired_token" }, baseHeaders);
    }
    if (!decoded || !decoded.uid) {
      logAuthFailure("token_verification", null);
      return jsonResponse(401, { ok: false, error: "invalid_or_expired_token" }, baseHeaders);
    }

    let userDoc;
    try {
      userDoc = await deps.getUserDoc(decoded.uid);
    } catch (err) {
      console.error(`[expense-receipt-ai] profile lookup failed: code=${(err && err.code) || "no_code"}`);
      return jsonResponse(500, { ok: false, error: "profile_lookup_failed" }, baseHeaders);
    }
    const isOwner = !!userDoc && userDoc.role === "owner"
      && decoded.email === OWNER_EMAIL && userDoc.email === OWNER_EMAIL;
    if (!isOwner) return jsonResponse(403, { ok: false, error: "owner_only" }, baseHeaders);

    const parsed = parseRequestBody(event.body);
    if (parsed.error) return jsonResponse(400, { ok: false, error: parsed.error }, baseHeaders);

    let image;
    try {
      image = validateImageDataUrl(parsed.value);
    } catch (err) {
      if (err instanceof ReceiptValidationError) {
        return jsonResponse(400, { ok: false, error: err.code }, baseHeaders);
      }
      return jsonResponse(400, { ok: false, error: "invalid_image_payload" }, baseHeaders);
    }

    const now = deps.now ? deps.now() : new Date();
    const burst = deps.checkBurst(`${BURST_KEY_PREFIX}${decoded.uid}`, now.getTime());
    if (!burst.allowed) {
      return jsonResponse(429, { ok: false, error: "rate_limited", retryAfterMs: burst.retryAfterMs }, {
        ...baseHeaders,
        "Retry-After": String(Math.ceil(burst.retryAfterMs / 1000)),
      });
    }

    // The only permitted Firestore mutation in this endpoint: an atomic operational quota
    // increment. DAILY_COLLECTION is a server constant, decoded.uid came from verifyIdToken(),
    // and `now` is the server clock. checkAndIncrementDailyUsage derives the document id as
    // `${uid}_${now.toISOString().slice(0, 10)}` and stores only uid/day/count/updatedAt metadata.
    let db;
    try {
      db = deps.getDb();
      const daily = await deps.checkDaily(db, decoded.uid, {
        now,
        limit: DAILY_LIMIT,
        collectionName: DAILY_COLLECTION,
      });
      if (!daily.allowed) {
        return jsonResponse(429, { ok: false, error: "rate_limited", scope: "daily", limit: daily.limit }, baseHeaders);
      }
    } catch (err) {
      console.error(`[expense-receipt-ai] rate limiter failed: code=${(err && err.code) || "no_code"}`);
      return jsonResponse(500, { ok: false, error: "expense_receipt_ai_internal_error" }, baseHeaders);
    }

    try {
      const suggestions = await deps.callVision({
        baseUrl: env.QWEN_BASE_URL,
        apiKey: env.DASHSCOPE_API_KEY,
        model: env.QWEN_VISION_MODEL,
        imageDataUrl: image.dataUrl,
        fetchImpl: deps.fetchImpl,
      });
      return jsonResponse(200, { ok: true, suggestions }, baseHeaders);
    } catch (err) {
      if (err instanceof QwenVisionError) {
        console.error(`[expense-receipt-ai] vision dependency failed: code=${err.code} status=${err.status || "none"}`);
        const status = err.code === "qwen_vision_timeout" ? 504 : 502;
        return jsonResponse(status, { ok: false, error: "expense_receipt_ai_upstream_error" }, baseHeaders);
      }
      console.error(`[expense-receipt-ai] unexpected failure: code=${(err && err.code) || "no_code"}`);
      return jsonResponse(500, { ok: false, error: "expense_receipt_ai_internal_error" }, baseHeaders);
    }
  };
}

function buildProductionDeps() {
  const { initializeApp, cert, getApps, getApp } = require("firebase-admin/app");
  const { getAuth } = require("firebase-admin/auth");
  const { getFirestore } = require("firebase-admin/firestore");
  const { initializeFirebaseAdmin } = require("./lib/firebase-admin");
  const { readGeneratedBuildContext } = require("./lib/build-context");
  const { checkBurst, checkAndIncrementDailyUsage } = require("./lib/rate-limit");
  let app = null;

  function ensureApp() {
    if (app) return app;
    app = initializeFirebaseAdmin({
      getApps,
      getApp,
      initializeApp,
      cert,
      projectId: process.env.FIREBASE_PROJECT_ID,
      serviceAccountRaw: process.env.FIREBASE_SERVICE_ACCOUNT,
      buildContext: readGeneratedBuildContext(),
    });
    return app;
  }

  const generatedDeployOrigins = readGeneratedDeployOrigins();
  const env = {
    ...process.env,
    DEPLOY_PRIME_URL: process.env.DEPLOY_PRIME_URL || generatedDeployOrigins.deployPrimeUrl || undefined,
    DEPLOY_URL: process.env.DEPLOY_URL || generatedDeployOrigins.deployUrl || undefined,
  };

  return {
    env,
    now: () => new Date(),
    ensureFirebaseAdmin: async () => { ensureApp(); },
    // checkRevoked=true is mandatory for this endpoint.
    verifyIdToken: (token) => getAuth(ensureApp()).verifyIdToken(token, true),
    getUserDoc: async (uid) => {
      const snap = await getFirestore(ensureApp()).collection("users").doc(uid).get();
      return snap.exists ? snap.data() : null;
    },
    getDb: () => getFirestore(ensureApp()),
    checkBurst,
    checkDaily: checkAndIncrementDailyUsage,
    callVision: callQwenReceiptVision,
    fetchImpl: undefined,
  };
}

exports.handler = createHandler(buildProductionDeps());
exports.createHandler = createHandler;
exports.parseRequestBody = parseRequestBody;
exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
exports.DAILY_LIMIT = DAILY_LIMIT;
exports.DAILY_COLLECTION = DAILY_COLLECTION;
