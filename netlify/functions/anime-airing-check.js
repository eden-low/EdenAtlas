// EdenAtlas Discover — scheduled airing-reminder delivery (Phase 4, Owner-only).
//
// Triggered by Netlify Scheduled Functions (see netlify.toml's `[functions."anime-airing-check"]
// schedule = "..."` block) — NOT by any browser request, so this file has no CORS/Origin check
// and no bearer-token verification the way anilist.js/discover-ai.js/assistant.js do: Netlify's
// scheduler invokes it directly, server-side, on its own cron. Authorization here means something
// different — this Function only ever reads/writes Firestore via the Admin SDK for docs whose
// `uid` already belongs to the app Owner (Discover's `followed_anime` has never had a non-Owner
// writer — see CLAUDE.md's "Discover is now strictly Owner-only" note), so there is no cross-user
// data risk to guard against at this layer.
//
// Responsibilities (Requirement list, Phase 4):
//   7. Obtain future airing time from AniList — never invented, never guessed, never from Qwen.
//   8. Store only the minimum schedule snapshot needed (nextEpisodeSnapshot: {episode, airingAt}).
//   9. This IS the "server-side scheduled process [that] refreshes due schedules and sends
//      reminders."
//  10. Store a deterministic delivery key (anime_notification_log/{uid}_{anilistId}_{episode}) so
//      the same episode is never notified twice, even across overlapping/retried runs.
//  11. Handle expired/invalid subscriptions safely — a token rejected by FCM as
//      not-registered/invalid is deleted from push_subscriptions, never retried forever.
//
// Missing schedule fields (nextAiringEpisode null/absent — a FINISHED, CANCELLED, or not-yet-
// scheduled series) are treated as UNKNOWN, never as "not airing" or an implicit zero: no
// notification fires, and nextEpisodeSnapshot is stored as null (explicitly "nothing scheduled
// right now"), distinct from never having been checked at all (scheduleRefreshedAt is the
// freshness signal for that).

const { OPERATIONS } = require("./lib/anilist-operations");
const { callAniList, AniListUpstreamError, safeAniListFailureMetadata } = require("./lib/anilist-transport");
const { FirebaseConfigError } = require("./lib/firebase-admin");

const REQUIRED_ENV = ["FIREBASE_PROJECT_ID", "FIREBASE_SERVICE_ACCOUNT"];
const BATCH_CHUNK_SIZE = 25; // matches lib/anilist-operations.js's own MAX_BATCH_IDS

// Tokens FCM will never accept again — safe to delete the subscription outright. Any other
// send() failure (a transient network blip, a rate limit) is logged and skipped THIS run; the
// subscription stays and is retried on the next scheduled invocation.
const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function nowEpochSeconds(now) {
  return Math.floor(now.getTime() / 1000);
}

// `deps` is fully injectable — see netlify/functions/__tests__/anime-airing-check.test.js.
// Production wiring is at the bottom of this file.
function createHandler(deps) {
  return async function handler() {
    const env = deps.env || process.env;
    const missing = REQUIRED_ENV.filter((k) => !env[k]);
    if (missing.length) {
      console.error("[anime-airing-check] missing required environment variables:", missing.join(","));
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: "not_configured" }) };
    }

    try {
      await deps.ensureFirebaseAdmin();
    } catch (err) {
      const stage = err instanceof FirebaseConfigError ? err.stage : "admin_initialization";
      console.error(`[anime-airing-check] Firebase Admin init failed: stage=${stage} code=${(err && err.code) || "no_code"}`);
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: "not_configured" }) };
    }

    const now = deps.now ? deps.now() : new Date();
    const summary = { checked: 0, refreshed: 0, notified: 0, skippedAlreadyNotified: 0, tokensCleaned: 0, errors: 0 };

    let due;
    try {
      due = await deps.getDueFollows(); // [{id, uid, anilistId, title, notifyOnAiring: true, ...}]
    } catch (err) {
      console.error("[anime-airing-check] failed to read followed_anime:", err && err.message);
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: "firestore_read_failed" }) };
    }
    summary.checked = due.length;
    if (due.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, ...summary }) };
    }

    // ---- Fetch fresh AniList schedule data for every due title, batched (never one call per
    // title — see the product direction against N+1 AniList calls, same as discover-ai.js). ----
    const ids = [...new Set(due.map((f) => f.anilistId))];
    const mediaById = new Map();
    const fetchedIds = new Set(); // ids from a chunk that actually completed this run — see below
    for (const idsChunk of chunk(ids, BATCH_CHUNK_SIZE)) {
      try {
        const variables = OPERATIONS.batch.validate({ ids: idsChunk });
        const { query, variables: gqlVars } = OPERATIONS.batch.buildRequest(variables);
        const raw = await callAniList({ fetchImpl: deps.fetchImpl, query, variables: gqlVars });
        const { results } = OPERATIONS.batch.sanitize(raw);
        results.forEach((m) => mediaById.set(m.id, m));
        idsChunk.forEach((id) => fetchedIds.add(id));
      } catch (err) {
        summary.errors++;
        if (err instanceof AniListUpstreamError) {
          const meta = safeAniListFailureMetadata(err);
          console.error(`[anime-airing-check] AniList batch failed: stage=${meta.stage} code=${meta.code}`);
        } else {
          console.error("[anime-airing-check] AniList batch failed (unexpected):", err && err.message);
        }
        // This chunk's titles simply don't get a schedule refresh or a possible notification
        // this run — the next scheduled invocation tries again. Never invent/guess a schedule.
      }
    }

    const nowSecs = nowEpochSeconds(now);

    for (const follow of due) {
      // The AniList chunk containing this title failed outright this run (network/timeout/
      // upstream error) — skip BOTH the snapshot refresh and any notification check for it
      // entirely, rather than writing a null snapshot over a possibly still-accurate previous
      // one. The next scheduled invocation tries again; nothing here is ever invented or guessed.
      if (!fetchedIds.has(follow.anilistId)) continue;

      const media = mediaById.get(follow.anilistId) || null;
      const nextEp = media && media.nextAiringEpisode && Number.isFinite(media.nextAiringEpisode.airingAt)
        ? media.nextAiringEpisode
        : null;

      // Requirement 8/9: store the minimum snapshot, and refresh it every run regardless of
      // whether anything is actually due to send — this IS the "refreshes due schedules" step.
      try {
        await deps.refreshSnapshot(follow.id, {
          nextEpisodeSnapshot: nextEp ? { episode: nextEp.episode, airingAt: nextEp.airingAt } : null,
        });
        summary.refreshed++;
      } catch (err) {
        summary.errors++;
        console.error(`[anime-airing-check] failed to refresh snapshot for ${follow.id}:`, err && err.message);
      }

      if (!nextEp || !Number.isFinite(nextEp.episode) || nextEp.airingAt > nowSecs) continue; // not due yet, or unknown

      const dedupeKey = `${follow.uid}_${follow.anilistId}_${nextEp.episode}`;
      let alreadyNotified;
      try {
        alreadyNotified = await deps.wasAlreadyNotified(dedupeKey);
      } catch (err) {
        summary.errors++;
        console.error(`[anime-airing-check] dedup check failed for ${dedupeKey}:`, err && err.message);
        continue; // fail closed on this title THIS run rather than risk a duplicate send
      }
      if (alreadyNotified) {
        summary.skippedAlreadyNotified++;
        continue;
      }

      let subscriptions;
      try {
        subscriptions = await deps.getSubscriptionsForUid(follow.uid);
      } catch (err) {
        summary.errors++;
        console.error(`[anime-airing-check] failed to read subscriptions for ${follow.uid}:`, err && err.message);
        continue;
      }

      const title = follow.title || (media && (media.title.english || media.title.romaji)) || "your anime";
      const notificationData = {
        title: "New episode available",
        body: `Episode ${nextEp.episode} of ${title} just aired.`,
        url: "discover.html",
        dedupeKey,
      };

      let sentCount = 0;
      for (const sub of subscriptions) {
        try {
          await deps.sendPush(sub.token, notificationData);
          sentCount++;
        } catch (err) {
          const code = (err && err.code) || "unknown";
          if (DEAD_TOKEN_CODES.has(code)) {
            try {
              await deps.deleteSubscription(sub.id);
              summary.tokensCleaned++;
            } catch (delErr) {
              console.error(`[anime-airing-check] failed to delete dead subscription ${sub.id}:`, delErr && delErr.message);
            }
          } else {
            summary.errors++;
            console.error(`[anime-airing-check] push send failed for subscription ${sub.id}: code=${code}`);
          }
        }
      }

      // Recorded even when sentCount is 0 (no subscribed device right now) — the episode itself
      // has been handled; a device subscribing LATER should not get a backlog of stale "just
      // aired" pings for an episode that aired days ago.
      try {
        await deps.recordNotified(dedupeKey, { uid: follow.uid, anilistId: follow.anilistId, episode: nextEp.episode, subscriberCount: sentCount });
        summary.notified++;
      } catch (err) {
        summary.errors++;
        console.error(`[anime-airing-check] failed to record dedup log for ${dedupeKey}:`, err && err.message);
      }
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, ...summary }) };
  };
}

// ---- Production wiring ----

function buildProductionDeps() {
  const { initializeApp, cert, getApps, getApp } = require("firebase-admin/app");
  const { getFirestore, FieldValue } = require("firebase-admin/firestore");
  const { getMessaging } = require("firebase-admin/messaging");
  const { initializeFirebaseAdmin } = require("./lib/firebase-admin");
  let app = null;

  function ensureApp() {
    if (app) return app;
    app = initializeFirebaseAdmin({
      getApps, getApp, initializeApp, cert,
      projectId: process.env.FIREBASE_PROJECT_ID,
      serviceAccountRaw: process.env.FIREBASE_SERVICE_ACCOUNT,
    });
    return app;
  }

  return {
    env: process.env,
    now: () => new Date(),
    ensureFirebaseAdmin: async () => { ensureApp(); },

    getDueFollows: async () => {
      const snap = await getFirestore(ensureApp()).collection("followed_anime").where("notifyOnAiring", "==", true).get();
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
    refreshSnapshot: async (id, fields) =>
      getFirestore(ensureApp()).collection("followed_anime").doc(id).update({
        ...fields,
        scheduleRefreshedAt: FieldValue.serverTimestamp(),
      }),
    wasAlreadyNotified: async (dedupeKey) => {
      const snap = await getFirestore(ensureApp()).collection("anime_notification_log").doc(dedupeKey).get();
      return snap.exists;
    },
    recordNotified: async (dedupeKey, fields) =>
      getFirestore(ensureApp()).collection("anime_notification_log").doc(dedupeKey).set({
        ...fields,
        sentAt: FieldValue.serverTimestamp(),
      }),
    getSubscriptionsForUid: async (uid) => {
      const snap = await getFirestore(ensureApp()).collection("push_subscriptions").where("uid", "==", uid).get();
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
    deleteSubscription: async (id) => getFirestore(ensureApp()).collection("push_subscriptions").doc(id).delete(),

    // Data-only payload (no top-level `notification` field) — see service-worker.js's
    // onBackgroundMessage comment for why: this keeps FCM from auto-displaying anything, so the
    // service worker's own handler is the single place that decides notification appearance and
    // click-target routing.
    sendPush: async (token, data) => getMessaging(ensureApp()).send({ token, data }),

    fetchImpl: undefined, // use global fetch
  };
}

exports.handler = createHandler(buildProductionDeps());
exports.createHandler = createHandler; // test-only export, same convention as every other Function
