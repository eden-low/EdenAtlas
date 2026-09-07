// Shared AniList GraphQL transport for both the proven Owner-only proxy (anilist.js) and
// Discover AI's server-side acquisition path. Operation construction and response sanitization
// remain in anilist-operations.js; this module owns only the fixed endpoint/HTTP contract and
// safe upstream-failure classification. Calls are never retried.

const ANILIST_ENDPOINT = "https://graphql.anilist.co";
const DEFAULT_TIMEOUT_MS = 8000;

class AniListUpstreamError extends Error {
  constructor(code, { status } = {}) {
    super(`anilist_${code}`);
    this.name = "AniListUpstreamError";
    this.code = code;
    this.status = Number.isInteger(status) ? status : null;
  }
}

function failureStageFor(code) {
  if (code === "timeout" || code === "network") return "request";
  if (code === "rate_limited" || code === "http") return "http";
  if (code === "graphql") return "graphql";
  return "response";
}

function safeAniListFailureMetadata(err) {
  return {
    stage: failureStageFor(err && err.code),
    code: (err && err.code) || "unknown",
    status: err && Number.isInteger(err.status) ? err.status : null,
  };
}

async function callAniList({ fetchImpl, query, variables, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") throw new AniListUpstreamError("network");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await doFetch(ANILIST_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === "AbortError") throw new AniListUpstreamError("timeout");
    throw new AniListUpstreamError("network");
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new AniListUpstreamError(res.status === 429 ? "rate_limited" : "http", { status: res.status });
  }

  const payload = await res.json().catch(() => null);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AniListUpstreamError("malformed", { status: res.status });
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new AniListUpstreamError("graphql", { status: res.status });
  }
  if (!payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) {
    throw new AniListUpstreamError("malformed", { status: res.status });
  }
  return payload.data;
}

module.exports = {
  ANILIST_ENDPOINT,
  DEFAULT_TIMEOUT_MS,
  AniListUpstreamError,
  safeAniListFailureMetadata,
  callAniList,
};
