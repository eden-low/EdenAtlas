// EdenAtlas Atlas Assistant — usage guards.
//
// Two layers, deliberately not conflated:
//
// 1. `checkAndIncrementDailyUsage` — the REAL, durable per-Owner limiter. Backed by a Firestore
//    Admin transaction against `ai_usage/{uid}_{yyyy-mm-dd}`, so it is consistent across cold
//    starts and concurrent Function invocations (unlike a plain in-memory counter, which resets
//    every cold start and is invisible to any other concurrently-running instance). This is the
//    thing that actually stops runaway Qwen spend.
// 2. `checkBurst` — an in-memory, per-instance, best-effort guard against a tight click-spam
//    burst within the same warm Function instance. It is explicitly NOT durable: a cold start
//    resets it, and a burst spread across two concurrently-invoked instances would see two
//    independent counters. It exists only to reject an obvious rapid-fire burst cheaply,
//    without paying for a Firestore transaction on every single request; it is never the sole
//    protection layer, and must not be described as one — the daily transaction above is.

const DAILY_LIMIT = 50; // requests/day for the one Owner account this endpoint ever serves
const BURST_LIMIT = 5;
const BURST_WINDOW_MS = 60_000;

const burstState = new Map(); // uid -> timestamps[] (module-scope: reset on every cold start)

function checkBurst(uid, now = Date.now()) {
  const recent = (burstState.get(uid) || []).filter((t) => now - t < BURST_WINDOW_MS);
  if (recent.length >= BURST_LIMIT) {
    burstState.set(uid, recent);
    return { allowed: false, retryAfterMs: BURST_WINDOW_MS - (now - recent[0]) };
  }
  recent.push(now);
  burstState.set(uid, recent);
  return { allowed: true };
}

// Only for deterministic tests — production code never calls this.
function _resetBurstStateForTests() {
  burstState.clear();
}

// `collectionName` (Discover AI pass) lets a caller land its daily counter in a DIFFERENT
// Firestore collection than the Atlas Assistant's own `ai_usage` — defaults to `"ai_usage"`
// unchanged, so assistant.js's existing call site (which never passes this option) keeps hitting
// exactly the collection/doc-id shape it always has, with the exact same DAILY_LIMIT=50 default,
// byte-for-byte. This is what lets backend/netlify/functions/discover-ai.js maintain two ADDITIONAL,
// fully independent daily pools (`ai_usage_discover_translate`, `ai_usage_discover_recommend`)
// without the three ever sharing a counter, while changing zero behavior for the Assistant's own
// pool. None of these collection names have an explicit firestore.rules entry (verified by
// reading the file, not assumed) — Firestore's Security Rules default-deny any path with no
// matching `match` block, so client access to any `ai_usage*` collection is already closed
// without a rules change, for the original collection and every new one alike.
async function checkAndIncrementDailyUsage(db, uid, { limit = DAILY_LIMIT, now = new Date(), collectionName = "ai_usage" } = {}) {
  const dayKey = now.toISOString().slice(0, 10);
  const ref = db.collection(collectionName).doc(`${uid}_${dayKey}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? Number(snap.data().count || 0) : 0;
    if (current >= limit) {
      return { allowed: false, count: current, limit, dayKey };
    }
    tx.set(ref, { uid, day: dayKey, count: current + 1, updatedAt: now.toISOString() }, { merge: true });
    return { allowed: true, count: current + 1, limit, dayKey };
  });
}

module.exports = {
  checkBurst,
  checkAndIncrementDailyUsage,
  _resetBurstStateForTests,
  DAILY_LIMIT,
  BURST_LIMIT,
  BURST_WINDOW_MS,
};
