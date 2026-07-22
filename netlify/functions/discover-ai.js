// EdenAtlas Discover AI — Owner-only, Qwen-powered Chinese translation + "For You" anime
// recommendations. A THIRD, entirely separate Netlify Function alongside assistant.js (personal
// data) and anilist.js (AniList proxy) — never folded into either.
//
// Production route: /.netlify/functions/discover-ai (source lives at
// netlify/functions/discover-ai.js, structurally excluded from the static publish output by
// scripts/build-site.js — see netlify.toml).
//
// Trust boundary (deliberately narrower than the Atlas Assistant's): this Function may read only
// (1) the verified Owner's own `followed_anime` documents, (2) public AniList data fetched
// server-side through the SAME allowlisted operation builders/sanitizers lib/anilist-operations.js
// already exports (never re-implemented, never weakened — isAdult:false and the excluded-genre
// policy are enforced by the exact same `sanitizeMediaListItem`/`sanitizeMediaDetail` functions
// anilist.js itself uses), (3) its own server-only rate-limit documents, and (4) Qwen. It never
// `require()`s lib/tools.js (the Atlas Assistant's personal-data tool allowlist) and has no code
// path to Journal/Memories/Finance/Calendar/Profile/photos or any other collection — this is a
// structural fact (no import exists), not a runtime check.
//
// Owner-only authorization reuses the EXACT three-signal approach assistant.js/anilist.js already
// established: a server-verified Firebase ID token's own email AND the stored users/{uid} doc's
// role/email fields must all agree with the hardcoded OWNER_EMAIL constant, checked BEFORE any
// AniList call, followed_anime read, or Qwen call.
//
// Qwen output handling: this pass does NOT rely on `response_format: {type:"json_object"}` —
// whether the configured QWEN_MODEL supports that OpenAI-compatible field was not verified for
// this deployment, so the system stays strictly-parsed-and-validated regardless of whether the
// model happens to honor a plain-JSON-only instruction on its own. See
// lib/discover-ai-operations.js's parseStrictJsonValue()/parseTranslateResponse()/
// parseRecommendResponse() for the actual defense: a fenced-code-block-aware, brace-balanced JSON
// extraction followed by a strict shape check, never `eval`, never a best-effort partial parse.

const {
  TRANSLATION_POLICY_VERSION,
  RECOMMENDATION_POLICY_VERSION,
  CANDIDATE_PAGE_SIZE,
  DiscoverAiValidationError,
  QwenOutputError,
  canonicalizeDescription,
  sourceHashOf,
  validateTranslateArgs,
  buildTranslateMessages,
  parseTranslateResponse,
  validateRecommendArgs,
  boundFollowedHistory,
  historyFingerprint,
  recommendCacheKey,
  buildCandidatePool,
  buildRecommendMessages,
  parseRecommendResponse,
  selectValidRecommendations,
} = require("./lib/discover-ai-operations");
const { OPERATIONS, sanitizeMediaDetail } = require("./lib/anilist-operations");
const { callAniList, AniListUpstreamError, safeAniListFailureMetadata } = require("./lib/anilist-transport");
const { getCachedRecommendation, setCachedRecommendation } = require("./lib/discover-ai-cache");
const { checkAndIncrementDailyUsage } = require("./lib/rate-limit");
const { callQwenChatCompletions, QwenError } = require("./lib/qwen");
const { FirebaseConfigError } = require("./lib/firebase-admin");
const { readGeneratedDeployOrigins } = require("./lib/deploy-origin");

// Duplicated from firebase-init.js/assistant.js/anilist.js on purpose — see anilist.js's identical
// comment: this Function can't import a browser ES module, and re-deriving "who is the Owner" from
// two independent hardcoded sources (this constant + users/{uid}.role) is deliberate
// defense-in-depth, not an oversight.
const OWNER_EMAIL = "jjun8647@gmail.com";

const REQUIRED_ENV = [
  "FIREBASE_PROJECT_ID", "FIREBASE_SERVICE_ACCOUNT", "ALLOWED_ORIGIN",
  "DASHSCOPE_API_KEY", "QWEN_MODEL", "QWEN_BASE_URL",
];

// Same local-dev allowlist every other Function in this repo documents and duplicates.
const LOCAL_DEV_ORIGINS = [
  "http://localhost:8888", "http://127.0.0.1:8888",
  "http://localhost:3000", "http://127.0.0.1:3000",
  "http://localhost:8000", "http://127.0.0.1:8000",
];

const ANILIST_TIMEOUT_MS = 8000; // matches anilist.js's own UPSTREAM_TIMEOUT_MS
const MAX_BODY_BYTES = 500; // {"operation":"...","args":{"anilistId":123}} — generous, still tiny
const ALLOWED_OPERATIONS = ["translate_description", "recommend"];

const TRANSLATE_BURST_KEY_PREFIX = "discover-translate:";
const TRANSLATE_DAILY_LIMIT = 20;
const TRANSLATE_DAILY_COLLECTION = "ai_usage_discover_translate";

const RECOMMEND_BURST_KEY_PREFIX = "discover-recommend:";
const RECOMMEND_DAILY_LIMIT = 10;
const RECOMMEND_DAILY_COLLECTION = "ai_usage_discover_recommend";

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

// Identical logic to anilist.js's own normalizeExactOrigin()/resolveAllowedOrigins() — duplicated
// rather than extracted into a shared module, per this repo's established per-Function
// duplication convention (see CLAUDE.md's "Nav links" / per-file-duplication notes elsewhere in
// this codebase). Exact-origin Set membership only — never a suffix/prefix/*.netlify.app match.
function normalizeExactOrigin(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") return null;
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
    .map((s) => s.trim())
    .filter(Boolean);
  const deployOrigins = [normalizeExactOrigin(env.DEPLOY_PRIME_URL), normalizeExactOrigin(env.DEPLOY_URL)]
    .filter(Boolean);
  return new Set([...configured, ...deployOrigins, ...LOCAL_DEV_ORIGINS]);
}

function getHeader(event, name) {
  const headers = event.headers || {};
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

function safeJsonParse(str) {
  try {
    return { ok: true, value: JSON.parse(str) };
  } catch {
    return { ok: false };
  }
}

// Only two top-level keys ever accepted — `operation` (a fixed allowlisted name) and `args`. The
// browser can never submit arbitrary synopsis text, a candidate list, or a raw prompt: the ONLY
// per-operation fields accepted are validated separately by validateTranslateArgs()/
// validateRecommendArgs() (lib/discover-ai-operations.js), which themselves reject any unknown
// field via rejectUnknownKeys-equivalent logic.
function parseRequestBody(raw) {
  if (typeof raw !== "string" || raw.length === 0) return { error: "empty_request_body" };
  if (raw.length > MAX_BODY_BYTES) return { error: "request_too_large" };
  const parsed = safeJsonParse(raw);
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {
    return { error: "invalid_json" };
  }
  const body = parsed.value;
  const extraTopLevel = Object.keys(body).filter((k) => k !== "operation" && k !== "args");
  if (extraTopLevel.length) return { error: "unknown_field" };
  if (typeof body.operation !== "string" || !ALLOWED_OPERATIONS.includes(body.operation)) {
    return { error: "unknown_operation" };
  }
  if (body.args !== undefined && (typeof body.args !== "object" || body.args === null || Array.isArray(body.args))) {
    return { error: "invalid_args" };
  }
  return { value: { operation: body.operation, args: body.args || {} } };
}

// Extracts and defensively validates `message.content` out of a raw Qwen chat-completion
// response envelope — the envelope shape itself (choices[0].message) is trusted (it's Qwen's own
// OpenAI-compatible API contract, already handled by callQwenChatCompletions()), but the CONTENT
// string inside it is untrusted model output, parsed strictly by the caller.
function extractQwenContent(resp) {
  const choice = resp && resp.choices && resp.choices[0];
  const msg = choice && choice.message;
  if (!msg || typeof msg.content !== "string" || !msg.content.trim()) {
    throw new QwenOutputError("qwen_empty_response");
  }
  return msg.content;
}

function logAuthStageFailure(stage, err) {
  const code = (err && err.code) || "no_code";
  console.error(`[discover-ai] auth stage failed: stage=${stage} code=${code}`);
}

// `deps` is fully injectable so this handler is unit-testable without firebase-admin, a real
// AniList/Qwen endpoint, or network access — see netlify/functions/__tests__/discover-ai.test.js.
function createHandler(deps) {
  return async function handler(event) {
    const env = deps.env || process.env;
    const method = event.httpMethod;

    // 1. Fail closed on missing configuration, before anything else — including which Qwen/
    // Firebase variable is missing is never revealed to the caller, only logged as a name (never
    // a value) server-side.
    const missing = REQUIRED_ENV.filter((k) => !env[k]);
    if (missing.length) {
      console.error("[discover-ai] missing required environment variables:", missing.join(","));
      return jsonResponse(500, { ok: false, error: "discover_ai_not_configured" });
    }

    // 2. Firebase Admin initialization boundary — deliberately separate from token verification,
    // reusing the exact pattern assistant.js/anilist.js already established.
    try {
      await deps.ensureFirebaseAdmin();
    } catch (err) {
      logAuthStageFailure(err instanceof FirebaseConfigError ? err.stage : "admin_initialization", err);
      return jsonResponse(500, { ok: false, error: "discover_ai_not_configured" });
    }

    const allowedOrigins = resolveAllowedOrigins(env);
    const origin = getHeader(event, "origin");
    const originOk = !!origin && allowedOrigins.has(origin);

    if (method === "OPTIONS") {
      return originOk
        ? { statusCode: 204, headers: corsHeaders(origin), body: "" }
        : jsonResponse(403, { ok: false, error: "origin_not_allowed" });
    }
    if (method !== "POST") {
      return jsonResponse(405, { ok: false, error: "method_not_allowed" }, { Allow: "POST, OPTIONS" });
    }
    if (!originOk) {
      return jsonResponse(403, { ok: false, error: "origin_not_allowed" });
    }
    const baseHeaders = corsHeaders(origin);

    // 3. Authenticate — derive uid from a server-verified Firebase ID token only.
    const authHeader = getHeader(event, "authorization") || "";
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (!match) {
      return jsonResponse(401, { ok: false, error: "missing_bearer_token" }, baseHeaders);
    }
    let decoded;
    try {
      decoded = await deps.verifyIdToken(match[1]);
    } catch (err) {
      if (err instanceof FirebaseConfigError) {
        logAuthStageFailure(err.stage, err);
        return jsonResponse(500, { ok: false, error: "discover_ai_not_configured" }, baseHeaders);
      }
      logAuthStageFailure("token_verification", err);
      return jsonResponse(401, { ok: false, error: "invalid_or_expired_token" }, baseHeaders);
    }
    if (!decoded || !decoded.uid) {
      logAuthStageFailure("token_verification", null);
      return jsonResponse(401, { ok: false, error: "invalid_or_expired_token" }, baseHeaders);
    }
    const uid = decoded.uid;

    // 4. Authorize — Owner only, before ANY AniList call, Firestore read (beyond this one
    // users/{uid} lookup), or Qwen call. Two independent signals that must BOTH agree (AND, never
    // OR — see assistant.js's/anilist.js's identical comment for why an OR here is a real gap).
    let userDoc;
    try {
      userDoc = await deps.getUserDoc(uid);
    } catch (err) {
      console.error("[discover-ai] users/{uid} read failed:", err && err.code);
      return jsonResponse(500, { ok: false, error: "profile_lookup_failed" }, baseHeaders);
    }
    const isOwner = !!userDoc && userDoc.role === "owner" && decoded.email === OWNER_EMAIL && userDoc.email === OWNER_EMAIL;
    if (!isOwner) {
      return jsonResponse(403, { ok: false, error: "owner_only" }, baseHeaders);
    }

    // 5. Parse + validate the top-level request shape (operation allowlist, no unknown fields).
    const parsedBody = parseRequestBody(event.body);
    if (parsedBody.error) {
      return jsonResponse(400, { ok: false, error: parsedBody.error }, baseHeaders);
    }
    const { operation, args } = parsedBody.value;
    const now = deps.now ? deps.now() : new Date();

    let db;
    try {
      db = deps.getDb();
    } catch (err) {
      console.error("[discover-ai] Firestore Admin unavailable:", err && err.message);
      return jsonResponse(500, { ok: false, error: "discover_ai_not_configured" }, baseHeaders);
    }

    try {
      if (operation === "translate_description") {
        return await handleTranslate({ deps, args, uid, db, now, baseHeaders });
      }
      return await handleRecommend({ deps, args, uid, db, now, baseHeaders });
    } catch (err) {
      if (err instanceof DiscoverAiValidationError) {
        return jsonResponse(400, { ok: false, error: err.code }, baseHeaders);
      }
      if (err instanceof QwenError || err instanceof QwenOutputError) {
        console.error("[discover-ai] Qwen call failed:", err.message);
        return jsonResponse(502, { ok: false, error: "discover_ai_upstream_error" }, baseHeaders);
      }
      if (err instanceof AniListUpstreamError) {
        const meta = safeAniListFailureMetadata(err);
        const status = meta.status === null ? "" : ` upstream_status=${meta.status}`;
        console.error(`[discover-ai] AniList call failed: operation=${operation} stage=${meta.stage} code=${meta.code}${status}`);
        if (err.code === "timeout") return jsonResponse(504, { ok: false, error: "anilist_upstream_timeout" }, baseHeaders);
        return jsonResponse(502, { ok: false, error: "anilist_upstream_error" }, baseHeaders);
      }
      console.error("[discover-ai] unexpected error:", err && err.message);
      return jsonResponse(500, { ok: false, error: "discover_ai_internal_error" }, baseHeaders);
    }
  };
}

// ---- translate_description ------------------------------------------------------------------

async function handleTranslate({ deps, args, uid, db, now, baseHeaders }) {
  const { anilistId } = validateTranslateArgs(args);

  const burst = deps.checkBurst(`${TRANSLATE_BURST_KEY_PREFIX}${uid}`, now.getTime());
  if (!burst.allowed) {
    return jsonResponse(
      429,
      { ok: false, error: "rate_limited", retryAfterMs: burst.retryAfterMs },
      { ...baseHeaders, "Retry-After": String(Math.ceil(burst.retryAfterMs / 1000)) }
    );
  }

  // Server-fetches the description by id — the browser NEVER supplies synopsis/prompt text. Reuses
  // lib/anilist-operations.js's OPERATIONS.details unchanged: the exact same isAdult:false +
  // excluded-genre sanitizer every other AniList surface in this app uses, never re-implemented or
  // weakened here.
  const detailsReq = OPERATIONS.details.buildRequest({ id: anilistId });
  const raw = await callAniList({ fetchImpl: deps.fetchImpl, ...detailsReq, timeoutMs: ANILIST_TIMEOUT_MS });
  const sanitized = sanitizeMediaDetail(raw && raw.Media);
  if (!sanitized) {
    // Genuinely missing OR filtered out by isAdult/excluded-genre — an adult/excluded title must
    // never be translated (there is nothing safe to hand to Qwen), and this Function must never
    // reveal WHICH of the two happened (same controlled "not found" shape either way, matching
    // anilist.js's own details operation's { result: null } precedent).
    return jsonResponse(200, { ok: true, anilistId, translatedText: null, reason: "not_found" }, baseHeaders);
  }

  const canonical = canonicalizeDescription(sanitized.description);
  if (!canonical) {
    return jsonResponse(200, { ok: true, anilistId, translatedText: null, reason: "no_description" }, baseHeaders);
  }
  const sourceHash = sourceHashOf(canonical);

  // Only NOW — once we know a real Qwen call is about to happen — does the durable daily quota
  // get consumed. A request that resolves to "not_found"/"no_description" never touches this.
  const daily = await checkAndIncrementDailyUsage(db, uid, {
    now,
    limit: TRANSLATE_DAILY_LIMIT,
    collectionName: TRANSLATE_DAILY_COLLECTION,
  });
  if (!daily.allowed) {
    return jsonResponse(429, { ok: false, error: "rate_limited", scope: "daily", limit: daily.limit }, baseHeaders);
  }

  const messages = buildTranslateMessages(canonical);
  const resp = await callQwenChatCompletions({
    baseUrl: deps.env.QWEN_BASE_URL,
    apiKey: deps.env.DASHSCOPE_API_KEY,
    model: deps.env.QWEN_MODEL,
    messages,
    fetchImpl: deps.fetchImpl,
  });
  const translatedText = parseTranslateResponse(extractQwenContent(resp));

  return jsonResponse(
    200,
    {
      ok: true,
      anilistId,
      sourceLang: "en",
      targetLang: "zh-CN",
      translatedText,
      sourceHash,
      cached: false, // this Function has no server-side translation cache in v1 — see header comment
      policyVersion: TRANSLATION_POLICY_VERSION,
    },
    baseHeaders
  );
}

// ---- recommend --------------------------------------------------------------------------------

async function fetchFollowedAnime(db, uid) {
  const snap = await db.collection("followed_anime").where("uid", "==", uid).get();
  const out = [];
  snap.forEach((doc) => {
    const d = doc.data();
    out.push({
      anilistId: d.anilistId,
      status: d.status,
      title: d.title,
      updatedAtMillis: d.updatedAt && typeof d.updatedAt.toMillis === "function" ? d.updatedAt.toMillis() : 0,
    });
  });
  return out;
}

async function handleRecommend({ deps, args, uid, db, now, baseHeaders }) {
  const { locale, force } = validateRecommendArgs(args);

  const burst = deps.checkBurst(`${RECOMMEND_BURST_KEY_PREFIX}${uid}`, now.getTime());
  if (!burst.allowed) {
    return jsonResponse(
      429,
      { ok: false, error: "rate_limited", retryAfterMs: burst.retryAfterMs },
      { ...baseHeaders, "Retry-After": String(Math.ceil(burst.retryAfterMs / 1000)) }
    );
  }

  // Read ONLY the verified Owner's own followed_anime — a single where("uid","==",uid) query,
  // the same index-free, provably-scoped shape every other collection in this app uses.
  const followed = await fetchFollowedAnime(db, uid);
  const generatedAt = now.toISOString();
  if (followed.length === 0) {
    // No Qwen call, no AniList call, no daily-quota increment — there is nothing to recommend from.
    return jsonResponse(200, { ok: true, generatedAt, basedOnCount: 0, recommendations: [], reason: "insufficient_history", cached: false }, baseHeaders);
  }

  const followedIds = new Set(followed.map((f) => f.anilistId));
  const bounded = boundFollowedHistory(followed);
  const fingerprint = historyFingerprint(bounded);
  const cacheKey = recommendCacheKey({ uid, locale, fingerprint });

  if (!force) {
    const cached = deps.getCachedRecommendation(cacheKey, now.getTime());
    if (cached) {
      return jsonResponse(200, { ...cached, cached: true }, baseHeaders);
    }
  }

  // Bounded candidate gathering: up to CANDIDATE_PAGE_SIZE (20) This Season + up to 20 Trending,
  // deduplicated by id, excluding everything already followed (regardless of status — a dropped
  // title is never re-suggested). Reuses OPERATIONS.browse's own query/variable builder unchanged
  // — the exact same isAdult:false + genre_not_in policy every other browse call in this app uses.
  const thisSeasonReq = OPERATIONS.browse.buildRequest({ mode: "this_season", page: 1, perPage: CANDIDATE_PAGE_SIZE }, { now });
  const trendingReq = OPERATIONS.browse.buildRequest({ mode: "trending", page: 1, perPage: CANDIDATE_PAGE_SIZE }, { now });
  const [thisSeasonData, trendingData] = await Promise.all([
    callAniList({ fetchImpl: deps.fetchImpl, ...thisSeasonReq, timeoutMs: ANILIST_TIMEOUT_MS }),
    callAniList({ fetchImpl: deps.fetchImpl, ...trendingReq, timeoutMs: ANILIST_TIMEOUT_MS }),
  ]);
  const thisSeasonItems = (thisSeasonData && thisSeasonData.Page && thisSeasonData.Page.media) || [];
  const trendingItems = (trendingData && trendingData.Page && trendingData.Page.media) || [];
  const candidateMap = buildCandidatePool([thisSeasonItems, trendingItems], followedIds);

  if (candidateMap.size === 0) {
    return jsonResponse(200, { ok: true, generatedAt, basedOnCount: bounded.length, recommendations: [], reason: "no_candidates", cached: false }, baseHeaders);
  }

  // Only now — once a real Qwen call is about to happen — does the durable daily quota get
  // consumed. Empty history, a cache hit, and an empty candidate pool all skip this entirely.
  const daily = await checkAndIncrementDailyUsage(db, uid, {
    now,
    limit: RECOMMEND_DAILY_LIMIT,
    collectionName: RECOMMEND_DAILY_COLLECTION,
  });
  if (!daily.allowed) {
    return jsonResponse(429, { ok: false, error: "rate_limited", scope: "daily", limit: daily.limit }, baseHeaders);
  }

  const messages = buildRecommendMessages({ historyItems: bounded, candidateMap, locale });
  const resp = await callQwenChatCompletions({
    baseUrl: deps.env.QWEN_BASE_URL,
    apiKey: deps.env.DASHSCOPE_API_KEY,
    model: deps.env.QWEN_MODEL,
    messages,
    fetchImpl: deps.fetchImpl,
  });
  const rawItems = parseRecommendResponse(extractQwenContent(resp));
  // THE enforcement point: every returned `anime` object comes only from candidateMap's own
  // already-sanitized entry; anything hallucinated, followed, filtered, or duplicated is dropped.
  const recommendations = selectValidRecommendations(rawItems, candidateMap);

  const result = {
    ok: true,
    generatedAt,
    basedOnCount: bounded.length,
    recommendations,
    cached: false,
    policyVersion: RECOMMENDATION_POLICY_VERSION,
    ...(recommendations.length === 0 ? { reason: "no_valid_recommendations" } : {}),
  };
  deps.setCachedRecommendation(cacheKey, result, now.getTime());
  return jsonResponse(200, result, baseHeaders);
}

// ---- Production wiring (firebase-admin only loaded/initialized here, never in the handler
// factory above, so tests never need it installed to exercise business logic) ----

function buildProductionDeps() {
  const { initializeApp, cert, getApps, getApp } = require("firebase-admin/app");
  const { getAuth } = require("firebase-admin/auth");
  const { getFirestore } = require("firebase-admin/firestore");
  const { initializeFirebaseAdmin } = require("./lib/firebase-admin");
  let app = null; // memoized ONLY on success — see anilist.js's/assistant.js's ensureApp() comment

  function ensureApp() {
    if (app) return app;
    app = initializeFirebaseAdmin({
      getApps,
      getApp,
      initializeApp,
      cert,
      projectId: process.env.FIREBASE_PROJECT_ID,
      serviceAccountRaw: process.env.FIREBASE_SERVICE_ACCOUNT,
    });
    return app;
  }

  // Same build-time Deploy Preview origin snapshot anilist.js already reads — DEPLOY_PRIME_URL/
  // DEPLOY_URL are not in process.env at Function runtime (see lib/deploy-origin.js's header
  // comment), so this Function needs the identical fallback to allow a Deploy Preview origin
  // through CORS.
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
    verifyIdToken: (token) => getAuth(ensureApp()).verifyIdToken(token, true),
    getUserDoc: async (uid) => {
      const snap = await getFirestore(ensureApp()).collection("users").doc(uid).get();
      return snap.exists ? snap.data() : null;
    },
    getDb: () => getFirestore(ensureApp()),
    checkBurst: require("./lib/rate-limit").checkBurst,
    getCachedRecommendation,
    setCachedRecommendation,
    fetchImpl: undefined, // use global fetch — for BOTH AniList and Qwen calls
  };
}

exports.handler = createHandler(buildProductionDeps());
exports.createHandler = createHandler; // exported for tests only
