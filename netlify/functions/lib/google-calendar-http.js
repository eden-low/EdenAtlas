const { readGeneratedDeployOrigins } = require("./deploy-origin");

const LOCAL_DEV_ORIGINS = [
  "http://localhost:8888", "http://127.0.0.1:8888",
  "http://localhost:3000", "http://127.0.0.1:3000",
  "http://localhost:8000", "http://127.0.0.1:8000",
];

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

function getHeader(event, name) {
  const headers = event.headers || {};
  const lower = name.toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === lower);
  return key ? headers[key] : undefined;
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

function parseEmptyObjectBody(raw) {
  if (raw == null || raw === "") return { value: {} };
  if (typeof raw !== "string" || raw.length > 256) return { error: "invalid_request_body" };
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return { error: "invalid_json" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid_json" };
  if (Object.keys(body).length) return { error: "unknown_field" };
  return { value: body };
}

function checkPostRequest(event, env) {
  const method = event.httpMethod;
  const origin = getHeader(event, "origin");
  const originOk = !!origin && resolveAllowedOrigins(env).has(origin);
  if (method === "OPTIONS") {
    return {
      handled: true,
      response: originOk
        ? { statusCode: 204, headers: { ...corsHeaders(origin), "Cache-Control": "no-store" }, body: "" }
        : jsonResponse(403, { ok: false, error: "origin_not_allowed" }),
    };
  }
  if (method !== "POST") {
    return {
      handled: true,
      response: jsonResponse(405, { ok: false, error: "method_not_allowed" }, { Allow: "POST, OPTIONS" }),
    };
  }
  if (!originOk) {
    return { handled: true, response: jsonResponse(403, { ok: false, error: "origin_not_allowed" }) };
  }
  return { handled: false, origin, headers: corsHeaders(origin) };
}

async function authenticateFirebaseUser(event, deps, responseHeaders) {
  const authHeader = getHeader(event, "authorization") || "";
  const bearer = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!bearer) {
    return { response: jsonResponse(401, { ok: false, error: "missing_bearer_token" }, responseHeaders) };
  }
  try {
    const decoded = await deps.verifyIdToken(bearer[1]);
    if (!decoded || typeof decoded.uid !== "string" || !decoded.uid) throw new Error("invalid decoded token");
    return { decoded };
  } catch {
    return { response: jsonResponse(401, { ok: false, error: "invalid_or_expired_token" }, responseHeaders) };
  }
}

function requestBaseUrl(event) {
  if (typeof event.rawUrl === "string") {
    try {
      const parsed = new URL(event.rawUrl);
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return null;
    }
  }
  return null;
}

function redirectResponse(location) {
  return {
    statusCode: 303,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
    body: "",
  };
}

function withGeneratedDeployOrigins(env = process.env) {
  const generated = readGeneratedDeployOrigins();
  return {
    ...env,
    DEPLOY_PRIME_URL: env.DEPLOY_PRIME_URL || generated.deployPrimeUrl || undefined,
    DEPLOY_URL: env.DEPLOY_URL || generated.deployUrl || undefined,
  };
}

module.exports = {
  LOCAL_DEV_ORIGINS,
  jsonResponse,
  corsHeaders,
  getHeader,
  normalizeExactOrigin,
  resolveAllowedOrigins,
  parseEmptyObjectBody,
  checkPostRequest,
  authenticateFirebaseUser,
  requestBaseUrl,
  redirectResponse,
  withGeneratedDeployOrigins,
};
