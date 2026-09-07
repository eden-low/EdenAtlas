// EdenAtlas Discover AI — short-lived, in-memory-only cache for the `recommend` operation.
//
// v1 deliberately has NO cache for `translate_description` at all (see discover-ai.js's own
// header comment) — the brief is explicit that translation caching for this pass is
// client-side localStorage only, no Firestore, and (by the same "don't invent an unrequested
// persistence layer" reasoning) no server-side cache either. This module exists solely for
// `recommend`, whose brief DOES call for a Function-level cache: "Function-level cache TTL: 20
// minutes, keyed by uid + locale + history fingerprint + recommendation policy version... cache
// is in-memory only for v1."
//
// Module-scope, so (like lib/anilist-cache.js's `store` and lib/rate-limit.js's `burstState`) it
// resets on every cold start — never a persistent store, never Firestore. Unbounded entry count
// is acceptable here (unlike anilist-cache.js's MAX_ENTRIES) because the key space is small and
// self-bounding: one entry per (uid, locale, history-fingerprint) tuple, and this Function only
// ever serves one Owner.

const RECOMMEND_CACHE_TTL_MS = 20 * 60 * 1000; // 20 minutes, per the brief

const store = new Map(); // key -> { value, expiresAt }

function getCachedRecommendation(key, now = Date.now()) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= now) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

function setCachedRecommendation(key, value, now = Date.now()) {
  store.set(key, { value, expiresAt: now + RECOMMEND_CACHE_TTL_MS });
}

// Only for deterministic tests — production code never calls this.
function _resetDiscoverAiCacheForTests() {
  store.clear();
}

module.exports = {
  getCachedRecommendation,
  setCachedRecommendation,
  _resetDiscoverAiCacheForTests,
  RECOMMEND_CACHE_TTL_MS,
};
