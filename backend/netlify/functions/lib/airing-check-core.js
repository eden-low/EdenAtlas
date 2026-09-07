// EdenAtlas Discover — the actual airing-reminder scheduling/delivery logic (Gap 3 fix: extracted
// out of backend/netlify/functions/anime-airing-check.js so the CORE can be unit/integration tested with
// an injected clock and fully mocked Firestore/AniList/FCM deps, entirely independent of whether
// Netlify's Scheduled Functions cron ever actually fires — which it structurally cannot do on a
// Deploy Preview or branch deploy like `staging` (Netlify only runs a Function's `schedule` on a
// published/production-context deploy). See backend/netlify/functions/anime-airing-check.js's own header
// comment for the thin wrapper this module is called from, and the completion report for how
// Staging verification of THIS logic works without relying on cron.
//
// Responsibilities (Requirement list, Phase 4 — unchanged from the original single-file version):
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
//
// Gap 3's dry-run mode: `runAiringCheck(deps, { dryRun: true })` still runs every READ (AniList
// fetch, dedup check, subscription lookup) for real — so a Staging verification run exercises the
// genuine logic end to end — but every WRITE/SEND (refreshSnapshot/recordNotified/sendPush/
// deleteSubscription) is skipped and counted separately instead, so a manual verification run can
// never mutate a schedule snapshot, send a real push to a real device, or write a dedup log entry.
// This is enforced HERE, inside the core, rather than by the caller swapping in no-op deps — so a
// caller can never forget to wire dry-run safety correctly.

const { OPERATIONS } = require("./anilist-operations");
const { callAniList, AniListUpstreamError, safeAniListFailureMetadata } = require("./anilist-transport");

const BATCH_CHUNK_SIZE = 25; // matches lib/anilist-operations.js's own MAX_BATCH_IDS

// Tokens FCM will never accept again — safe to delete the subscription outright. Other failures
// are retryable: the subscription stays, and when no sibling token succeeds the due episode also
// stays pending for the next scheduled invocation.
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

function scheduleSnapshot(value) {
  if (!value || !Number.isFinite(value.episode) || !Number.isFinite(value.airingAt)) return null;
  return { episode: value.episode, airingAt: value.airingAt };
}

async function runAiringCheck(deps, options = {}) {
  const dryRun = !!options.dryRun;
  const now = deps.now ? deps.now() : new Date();
  const summary = {
    dryRun,
    checked: 0, refreshed: 0, notified: 0, skippedAlreadyNotified: 0, tokensCleaned: 0, errors: 0,
  };

  let due;
  try {
    due = await deps.getDueFollows(); // [{id, uid, anilistId, title, notifyOnAiring: true, ...}]
  } catch (err) {
    console.error("[airing-check-core] failed to read followed_anime:", err && err.message);
    return { ok: false, error: "firestore_read_failed", ...summary };
  }
  summary.checked = due.length;
  if (due.length === 0) {
    return { ok: true, ...summary };
  }

  // ---- Fetch fresh AniList schedule data for every due title, batched (never one call per
  // title — see the product direction against N+1 AniList calls, same as discover-ai.js). ----
  // Real reads happen even in dry-run — that's the whole point of a verification run.
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
        console.error(`[airing-check-core] AniList batch failed: stage=${meta.stage} code=${meta.code}`);
      } else {
        console.error("[airing-check-core] AniList batch failed (unexpected):", err && err.message);
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
    const latestSnapshot = scheduleSnapshot(media && media.nextAiringEpisode);
    const storedSnapshot = scheduleSnapshot(follow.nextEpisodeSnapshot);
    const storedDue = storedSnapshot && storedSnapshot.airingAt <= nowSecs;
    const latestDue = latestSnapshot && latestSnapshot.airingAt <= nowSecs;
    // AniList may expose episode N+1 before this poll observes that persisted episode N became
    // due. The persisted snapshot therefore wins until N has been handled successfully.
    const dueEpisode = storedDue ? storedSnapshot : latestDue ? latestSnapshot : null;

    const refreshLatestSnapshot = async () => {
      if (dryRun) return;
      try {
        await deps.refreshSnapshot(follow.id, { nextEpisodeSnapshot: latestSnapshot });
        summary.refreshed++;
      } catch (err) {
        summary.errors++;
        console.error(`[airing-check-core] failed to refresh snapshot for ${follow.id}:`, err && err.message);
      }
    };

    // Requirement 8/9: store the minimum snapshot, and refresh it every run regardless of
    // whether anything is actually due to send — this IS the "refreshes due schedules" step.
    // Dry-run: computed but never written — deps.refreshSnapshot is never called at all.
    if (!dryRun && !storedDue) {
      await refreshLatestSnapshot();
    } else if (dryRun) {
      summary.refreshed++; // "would have refreshed" — dry-run still counts it, never writes it
    }

    if (!dueEpisode) continue;

    const dedupeKey = `${follow.uid}_${follow.anilistId}_${dueEpisode.episode}`;
    let alreadyNotified;
    try {
      alreadyNotified = await deps.wasAlreadyNotified(dedupeKey);
    } catch (err) {
      summary.errors++;
      console.error(`[airing-check-core] dedup check failed for ${dedupeKey}:`, err && err.message);
      continue; // fail closed on this title THIS run rather than risk a duplicate send
    }
    if (alreadyNotified) {
      summary.skippedAlreadyNotified++;
      if (storedDue) await refreshLatestSnapshot();
      continue;
    }

    let subscriptions;
    try {
      subscriptions = await deps.getSubscriptionsForUid(follow.uid);
    } catch (err) {
      summary.errors++;
      console.error(`[airing-check-core] failed to read subscriptions for ${follow.uid}:`, err && err.message);
      continue;
    }

    const title = follow.title || (media && (media.title.english || media.title.romaji)) || "your anime";
    const notificationData = {
      title: "New episode available",
      body: `Episode ${dueEpisode.episode} of ${title} just aired.`,
      url: "discover.html",
      dedupeKey,
    };

    let sentCount = 0;
    let retryableFailureCount = 0;
    if (!dryRun) {
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
              console.error(`[airing-check-core] failed to delete dead subscription ${sub.id}:`, delErr && delErr.message);
            }
          } else {
            retryableFailureCount++;
            summary.errors++;
            console.error(`[airing-check-core] push send failed for subscription ${sub.id}: code=${code}`);
          }
        }
      }
    } else {
      sentCount = subscriptions.length; // "would have sent to" — never actually calls deps.sendPush
    }

    // Recorded with sentCount 0 only when there was no retryable failure (no subscribed device,
    // or only permanently-dead tokens); a device subscribing later should not get stale backlog.
    // A completely failed retryable delivery is still pending: do not write its dedup record or
    // advance a stored due snapshot. If at least one token succeeded, retain the existing
    // episode-level success semantics. Zero subscriptions and permanently-dead tokens remain
    // handled so they do not create a stale backlog or an infinite retry loop.
    if (!dryRun && sentCount === 0 && retryableFailureCount > 0) continue;

    if (!dryRun) {
      try {
        await deps.recordNotified(dedupeKey, { uid: follow.uid, anilistId: follow.anilistId, episode: dueEpisode.episode, subscriberCount: sentCount });
        summary.notified++;
        if (storedDue) await refreshLatestSnapshot();
      } catch (err) {
        summary.errors++;
        console.error(`[airing-check-core] failed to record dedup log for ${dedupeKey}:`, err && err.message);
      }
    } else {
      summary.notified++;
    }
  }

  return { ok: true, ...summary };
}

module.exports = { runAiringCheck, DEAD_TOKEN_CODES, BATCH_CHUNK_SIZE };
