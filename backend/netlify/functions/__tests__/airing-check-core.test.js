// Deterministic tests for the airing-reminder CORE logic (backend/netlify/functions/lib/
// airing-check-core.js) — fully mocked Firestore/AniList/FCM deps, no network access, no real
// Firebase project, no dependency on Netlify's Scheduled Functions cron ever firing (see that
// module's own header comment for why this split exists — Gap 3 of the Staging/Production
// isolation follow-up). Run with: node backend/netlify/functions/__tests__/airing-check-core.test.js
// (or `npm run test:functions`).
//
// This file used to live inside backend/netlify/functions/__tests__/anime-airing-check.test.js, calling
// through createHandler(deps)() — that file now tests only the thin wrapper's own concerns
// (env, invocation-source gating, Owner auth, dryRun parsing); every scenario below calls
// runAiringCheck(deps, options) directly.

const assert = require("node:assert");

const { runAiringCheck } = require("../lib/airing-check-core.js");
const { AniListUpstreamError } = require("../lib/anilist-transport.js");

let pass = 0;
let fail = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, err });
    console.log(`FAIL  - ${name}`);
    console.log(`        ${err.message}`);
  }
}

// A minimal, fully in-memory fake of the three Firestore-shaped collections this module touches,
// driven purely by JS Maps — never a real Firestore/emulator connection.
function makeFakeStore({ follows = [], subscriptions = [], notificationLog = [] } = {}) {
  const followMap = new Map(follows.map((f) => [f.id, { ...f }]));
  const subMap = new Map(subscriptions.map((s) => [s.id, { ...s }]));
  const logSet = new Set(notificationLog);
  const calls = { refreshSnapshot: [], deleteSubscription: [], sendPush: [], recordNotified: [] };

  return {
    calls,
    followMap,
    subMap,
    logSet,
    deps: {
      getDueFollows: async () => [...followMap.values()].filter((f) => f.notifyOnAiring === true),
      refreshSnapshot: async (id, fields) => {
        calls.refreshSnapshot.push({ id, fields });
        const doc = followMap.get(id);
        if (doc) Object.assign(doc, fields);
      },
      wasAlreadyNotified: async (key) => logSet.has(key),
      recordNotified: async (key, fields) => {
        calls.recordNotified.push({ key, fields });
        logSet.add(key);
      },
      getSubscriptionsForUid: async (uid) => [...subMap.values()].filter((s) => s.uid === uid),
      deleteSubscription: async (id) => {
        calls.deleteSubscription.push(id);
        subMap.delete(id);
      },
      sendPush: async (token, data) => {
        calls.sendPush.push({ token, data });
        const sub = [...subMap.values()].find((s) => s.token === token);
        if (sub && sub._failWith) {
          const err = new Error(sub._failWith);
          err.code = sub._failWith;
          throw err;
        }
      },
    },
  };
}

function makeDeps({ store, fetchImpl, now } = {}) {
  const s = store || makeFakeStore();
  return {
    now: now || (() => new Date("2026-08-01T12:00:00.000Z")),
    fetchImpl,
    ...s.deps,
    __store: s,
  };
}

function makeAniListFetch(mediaById) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { Page: { media: Object.values(mediaById) } } }),
  });
}

(async () => {
  await test("no notifyOnAiring follows: zero AniList calls, zero writes, ok:true", async () => {
    let fetchCalled = false;
    const deps = makeDeps({ store: makeFakeStore({ follows: [] }), fetchImpl: async () => { fetchCalled = true; } });
    const result = await runAiringCheck(deps);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.checked, 0);
    assert.strictEqual(fetchCalled, false);
  });

  await test("an episode that already aired, never notified before, sends push and records dedup log", async () => {
    const store = makeFakeStore({
      follows: [{ id: "u1_100", uid: "u1", anilistId: 100, title: "Test Anime", notifyOnAiring: true }],
      subscriptions: [{ id: "u1_hashA", uid: "u1", token: "tokenA", platform: "web" }],
    });
    const media = { 100: { id: 100, title: { romaji: "Test Anime", english: null, native: null }, isAdult: false, genres: [], nextAiringEpisode: { airingAt: 1754000000, timeUntilAiring: -100, episode: 5 } } };
    const deps = makeDeps({ store, fetchImpl: makeAniListFetch(media) });
    const result = await runAiringCheck(deps);
    assert.strictEqual(result.notified, 1);
    assert.strictEqual(store.calls.sendPush.length, 1);
    assert.strictEqual(store.calls.sendPush[0].token, "tokenA");
    assert.strictEqual(store.calls.sendPush[0].data.dedupeKey, "u1_100_5");
    assert.ok(!("notification" in store.calls.sendPush[0]));
    assert.strictEqual(store.calls.recordNotified.length, 1);
    assert.strictEqual(store.calls.recordNotified[0].key, "u1_100_5");
    assert.strictEqual(store.calls.recordNotified[0].fields.subscriberCount, 1);
    assert.strictEqual(store.calls.refreshSnapshot.length, 1);
    assert.deepStrictEqual(store.calls.refreshSnapshot[0].fields.nextEpisodeSnapshot, { episode: 5, airingAt: 1754000000 });
  });

  await test("advanced AniList state: a due stored episode is notified before the snapshot advances", async () => {
    const store = makeFakeStore({
      follows: [{
        id: "u1_100", uid: "u1", anilistId: 100, title: "Test Anime", notifyOnAiring: true,
        nextEpisodeSnapshot: { episode: 5, airingAt: 1754000000 },
      }],
      subscriptions: [{ id: "u1_hashA", uid: "u1", token: "tokenA", platform: "web" }],
    });
    const media = { 100: {
      id: 100, title: { romaji: "Test Anime" }, isAdult: false, genres: [],
      nextAiringEpisode: { airingAt: 9999999999, timeUntilAiring: 999999, episode: 6 },
    } };
    const deps = makeDeps({ store, fetchImpl: makeAniListFetch(media) });

    const result = await runAiringCheck(deps);

    assert.strictEqual(result.notified, 1);
    assert.strictEqual(store.calls.sendPush.length, 1);
    assert.strictEqual(store.calls.sendPush[0].data.dedupeKey, "u1_100_5");
    assert.strictEqual(store.calls.recordNotified[0].key, "u1_100_5");
    assert.deepStrictEqual(
      store.followMap.get("u1_100").nextEpisodeSnapshot,
      { episode: 6, airingAt: 9999999999 }
    );
    assert.strictEqual(store.calls.refreshSnapshot.length, 1);
  });

  await test("advanced AniList state: the handled stored episode is not sent again on the next run", async () => {
    const store = makeFakeStore({
      follows: [{
        id: "u1_100", uid: "u1", anilistId: 100, title: "Test Anime", notifyOnAiring: true,
        nextEpisodeSnapshot: { episode: 5, airingAt: 1754000000 },
      }],
      subscriptions: [{ id: "u1_hashA", uid: "u1", token: "tokenA", platform: "web" }],
    });
    const media = { 100: {
      id: 100, title: { romaji: "Test Anime" }, isAdult: false, genres: [],
      nextAiringEpisode: { airingAt: 9999999999, timeUntilAiring: 999999, episode: 6 },
    } };
    const deps = makeDeps({ store, fetchImpl: makeAniListFetch(media) });

    const first = await runAiringCheck(deps);
    const second = await runAiringCheck(deps);

    assert.strictEqual(first.notified, 1);
    assert.strictEqual(second.notified, 0);
    assert.strictEqual(store.calls.sendPush.length, 1);
    assert.strictEqual(store.calls.recordNotified.length, 1);
    assert.strictEqual(store.logSet.has("u1_100_5"), true);
    assert.deepStrictEqual(
      store.followMap.get("u1_100").nextEpisodeSnapshot,
      { episode: 6, airingAt: 9999999999 }
    );
  });

  await test("Requirement 10: the same episode is never notified twice — already-logged dedup key is skipped", async () => {
    const store = makeFakeStore({
      follows: [{ id: "u1_100", uid: "u1", anilistId: 100, title: "Test Anime", notifyOnAiring: true }],
      subscriptions: [{ id: "u1_hashA", uid: "u1", token: "tokenA", platform: "web" }],
      notificationLog: ["u1_100_5"],
    });
    const media = { 100: { id: 100, title: { romaji: "Test Anime" }, isAdult: false, genres: [], nextAiringEpisode: { airingAt: 1754000000, timeUntilAiring: -100, episode: 5 } } };
    const deps = makeDeps({ store, fetchImpl: makeAniListFetch(media) });
    const result = await runAiringCheck(deps);
    assert.strictEqual(result.skippedAlreadyNotified, 1);
    assert.strictEqual(store.calls.sendPush.length, 0);
    assert.strictEqual(store.calls.recordNotified.length, 0);
  });

  await test("a future episode (airingAt in the future) is not due — no push, no dedup log, snapshot still refreshed", async () => {
    const store = makeFakeStore({ follows: [{ id: "u1_100", uid: "u1", anilistId: 100, title: "Test Anime", notifyOnAiring: true }] });
    const media = { 100: { id: 100, title: { romaji: "Test Anime" }, isAdult: false, genres: [], nextAiringEpisode: { airingAt: 9999999999, timeUntilAiring: 999999, episode: 6 } } };
    const deps = makeDeps({ store, fetchImpl: makeAniListFetch(media), now: () => new Date("2026-08-01T12:00:00.000Z") });
    const result = await runAiringCheck(deps);
    assert.strictEqual(result.notified, 0);
    assert.strictEqual(store.calls.sendPush.length, 0);
    assert.strictEqual(store.calls.refreshSnapshot.length, 1);
  });

  await test("Requirement 13: missing/absent nextAiringEpisode is stored as null (unknown), never treated as due", async () => {
    const store = makeFakeStore({ follows: [{ id: "u1_100", uid: "u1", anilistId: 100, title: "Finished Show", notifyOnAiring: true }] });
    const media = { 100: { id: 100, title: { romaji: "Finished Show" }, isAdult: false, genres: [], nextAiringEpisode: null } };
    const deps = makeDeps({ store, fetchImpl: makeAniListFetch(media) });
    const result = await runAiringCheck(deps);
    assert.strictEqual(result.notified, 0);
    assert.strictEqual(store.calls.refreshSnapshot.length, 1);
    assert.strictEqual(store.calls.refreshSnapshot[0].fields.nextEpisodeSnapshot, null);
  });

  await test("Requirement 11: a dead-token send() failure deletes that subscription, still records the episode as notified", async () => {
    const store = makeFakeStore({
      follows: [{ id: "u1_100", uid: "u1", anilistId: 100, title: "Test Anime", notifyOnAiring: true }],
      subscriptions: [{ id: "u1_hashDead", uid: "u1", token: "deadToken", platform: "web", _failWith: "messaging/registration-token-not-registered" }],
    });
    const media = { 100: { id: 100, title: { romaji: "Test Anime" }, isAdult: false, genres: [], nextAiringEpisode: { airingAt: 1754000000, timeUntilAiring: -1, episode: 5 } } };
    const deps = makeDeps({ store, fetchImpl: makeAniListFetch(media) });
    const result = await runAiringCheck(deps);
    const nextRun = await runAiringCheck(deps);
    assert.strictEqual(result.notified, 1);
    assert.strictEqual(nextRun.notified, 0);
    assert.strictEqual(result.tokensCleaned, 1);
    assert.strictEqual(store.calls.deleteSubscription.length, 1);
    assert.strictEqual(store.calls.sendPush.length, 1);
    assert.strictEqual(store.calls.deleteSubscription[0], "u1_hashDead");
    assert.strictEqual(store.subMap.has("u1_hashDead"), false);
    assert.strictEqual(store.calls.recordNotified.length, 1);
    assert.strictEqual(store.calls.recordNotified[0].fields.subscriberCount, 0);
  });

  await test("stored due + AniList advanced: a transient send failure remains pending and does not advance the snapshot", async () => {
    const store = makeFakeStore({
      follows: [{
        id: "u1_100", uid: "u1", anilistId: 100, title: "Test Anime", notifyOnAiring: true,
        nextEpisodeSnapshot: { episode: 5, airingAt: 1754000000 },
      }],
      subscriptions: [{ id: "u1_hashFlaky", uid: "u1", token: "flakyToken", platform: "web", _failWith: "messaging/internal-error" }],
    });
    const media = { 100: {
      id: 100, title: { romaji: "Test Anime" }, isAdult: false, genres: [],
      nextAiringEpisode: { airingAt: 9999999999, timeUntilAiring: 999999, episode: 6 },
    } };
    const deps = makeDeps({ store, fetchImpl: makeAniListFetch(media) });
    const result = await runAiringCheck(deps);

    assert.strictEqual(result.notified, 0);
    assert.strictEqual(result.tokensCleaned, 0);
    assert.ok(result.errors >= 1);
    assert.strictEqual(store.subMap.has("u1_hashFlaky"), true);
    assert.strictEqual(store.calls.recordNotified.length, 0);
    assert.strictEqual(store.calls.refreshSnapshot.length, 0);
    assert.strictEqual(store.logSet.has("u1_100_5"), false);
    assert.deepStrictEqual(
      store.followMap.get("u1_100").nextEpisodeSnapshot,
      { episode: 5, airingAt: 1754000000 }
    );
  });

  await test("a transiently-failed stored episode retries, succeeds later, then advances and is not resent", async () => {
    const store = makeFakeStore({
      follows: [{
        id: "u1_100", uid: "u1", anilistId: 100, title: "Test Anime", notifyOnAiring: true,
        nextEpisodeSnapshot: { episode: 5, airingAt: 1754000000 },
      }],
      subscriptions: [{ id: "u1_hashFlaky", uid: "u1", token: "flakyToken", platform: "web", _failWith: "messaging/internal-error" }],
    });
    const media = { 100: {
      id: 100, title: { romaji: "Test Anime" }, isAdult: false, genres: [],
      nextAiringEpisode: { airingAt: 9999999999, timeUntilAiring: 999999, episode: 6 },
    } };
    const deps = makeDeps({ store, fetchImpl: makeAniListFetch(media) });

    const failed = await runAiringCheck(deps);
    delete store.subMap.get("u1_hashFlaky")._failWith;
    const succeeded = await runAiringCheck(deps);
    const deduplicated = await runAiringCheck(deps);

    assert.strictEqual(failed.notified, 0);
    assert.strictEqual(succeeded.notified, 1);
    assert.strictEqual(deduplicated.notified, 0);
    assert.strictEqual(store.calls.sendPush.length, 2);
    assert.strictEqual(store.calls.recordNotified.length, 1);
    assert.strictEqual(store.calls.recordNotified[0].key, "u1_100_5");
    assert.deepStrictEqual(
      store.followMap.get("u1_100").nextEpisodeSnapshot,
      { episode: 6, airingAt: 9999999999 }
    );
  });

  await test("multiple subscriptions retain episode-level success when at least one token delivers", async () => {
    const store = makeFakeStore({
      follows: [{
        id: "u1_100", uid: "u1", anilistId: 100, title: "Test Anime", notifyOnAiring: true,
        nextEpisodeSnapshot: { episode: 5, airingAt: 1754000000 },
      }],
      subscriptions: [
        { id: "u1_hashGood", uid: "u1", token: "goodToken", platform: "web" },
        { id: "u1_hashFlaky", uid: "u1", token: "flakyToken", platform: "web", _failWith: "messaging/internal-error" },
      ],
    });
    const media = { 100: {
      id: 100, title: { romaji: "Test Anime" }, isAdult: false, genres: [],
      nextAiringEpisode: { airingAt: 9999999999, timeUntilAiring: 999999, episode: 6 },
    } };
    const deps = makeDeps({ store, fetchImpl: makeAniListFetch(media) });
    const result = await runAiringCheck(deps);

    assert.strictEqual(result.notified, 1);
    assert.strictEqual(store.calls.sendPush.length, 2);
    assert.strictEqual(store.calls.recordNotified.length, 1);
    assert.strictEqual(store.calls.recordNotified[0].fields.subscriberCount, 1);
    assert.deepStrictEqual(
      store.followMap.get("u1_100").nextEpisodeSnapshot,
      { episode: 6, airingAt: 9999999999 }
    );
  });

  await test("send success + dedup write failure keeps the stored due episode, so a later run may duplicate but cannot lose it", async () => {
    const store = makeFakeStore({
      follows: [{
        id: "u1_100", uid: "u1", anilistId: 100, title: "Test Anime", notifyOnAiring: true,
        nextEpisodeSnapshot: { episode: 5, airingAt: 1754000000 },
      }],
      subscriptions: [{ id: "u1_hashA", uid: "u1", token: "tokenA", platform: "web" }],
    });
    const media = { 100: {
      id: 100, title: { romaji: "Test Anime" }, isAdult: false, genres: [],
      nextAiringEpisode: { airingAt: 9999999999, timeUntilAiring: 999999, episode: 6 },
    } };
    const deps = makeDeps({ store, fetchImpl: makeAniListFetch(media) });
    deps.recordNotified = async (key, fields) => {
      store.calls.recordNotified.push({ key, fields });
      throw new Error("firestore unavailable");
    };

    const first = await runAiringCheck(deps);
    const second = await runAiringCheck(deps);

    assert.strictEqual(first.notified, 0);
    assert.strictEqual(second.notified, 0);
    assert.strictEqual(store.calls.sendPush.length, 2);
    assert.strictEqual(store.calls.recordNotified.length, 2);
    assert.strictEqual(store.calls.refreshSnapshot.length, 0);
    assert.strictEqual(store.logSet.has("u1_100_5"), false);
    assert.deepStrictEqual(
      store.followMap.get("u1_100").nextEpisodeSnapshot,
      { episode: 5, airingAt: 1754000000 }
    );
  });

  await test("zero subscribed devices: the episode is still recorded as handled (subscriberCount 0), no crash", async () => {
    const store = makeFakeStore({ follows: [{ id: "u1_100", uid: "u1", anilistId: 100, title: "Test Anime", notifyOnAiring: true }], subscriptions: [] });
    const media = { 100: { id: 100, title: { romaji: "Test Anime" }, isAdult: false, genres: [], nextAiringEpisode: { airingAt: 1754000000, timeUntilAiring: -1, episode: 5 } } };
    const deps = makeDeps({ store, fetchImpl: makeAniListFetch(media) });
    const result = await runAiringCheck(deps);
    assert.strictEqual(result.notified, 1);
    assert.strictEqual(store.calls.sendPush.length, 0);
    assert.strictEqual(store.calls.recordNotified[0].fields.subscriberCount, 0);
  });

  await test("multiple due follows are batched into a single AniList call (never one call per title) when <= 25", async () => {
    let fetchCallCount = 0;
    const store = makeFakeStore({
      follows: [
        { id: "u1_100", uid: "u1", anilistId: 100, title: "A", notifyOnAiring: true },
        { id: "u1_101", uid: "u1", anilistId: 101, title: "B", notifyOnAiring: true },
        { id: "u1_102", uid: "u1", anilistId: 102, title: "C", notifyOnAiring: false },
      ],
    });
    const media = {
      100: { id: 100, title: { romaji: "A" }, isAdult: false, genres: [], nextAiringEpisode: null },
      101: { id: 101, title: { romaji: "B" }, isAdult: false, genres: [], nextAiringEpisode: null },
    };
    const deps = makeDeps({ store, fetchImpl: async (...args) => { fetchCallCount++; return makeAniListFetch(media)(...args); } });
    const result = await runAiringCheck(deps);
    assert.strictEqual(result.checked, 2);
    assert.strictEqual(fetchCallCount, 1);
    assert.strictEqual(store.calls.refreshSnapshot.length, 2);
  });

  await test("AniList upstream failure for a chunk: no crash, that run's titles simply aren't refreshed, errors counted", async () => {
    const store = makeFakeStore({ follows: [{ id: "u1_100", uid: "u1", anilistId: 100, title: "A", notifyOnAiring: true }] });
    const deps = makeDeps({ store, fetchImpl: async () => { throw new AniListUpstreamError("timeout"); } });
    const result = await runAiringCheck(deps);
    assert.strictEqual(result.ok, true); // the whole run doesn't fail, it degrades per-chunk
    assert.ok(result.errors >= 1);
    assert.strictEqual(store.calls.refreshSnapshot.length, 0);
    assert.strictEqual(store.calls.sendPush.length, 0);
  });

  await test("a dedup-check (wasAlreadyNotified) failure fails closed on that title THIS run — no send, no double-notify risk", async () => {
    const store = makeFakeStore({
      follows: [{ id: "u1_100", uid: "u1", anilistId: 100, title: "A", notifyOnAiring: true }],
      subscriptions: [{ id: "u1_hashA", uid: "u1", token: "tokenA", platform: "web" }],
    });
    const media = { 100: { id: 100, title: { romaji: "A" }, isAdult: false, genres: [], nextAiringEpisode: { airingAt: 1754000000, timeUntilAiring: -1, episode: 5 } } };
    const deps = makeDeps({ store, fetchImpl: makeAniListFetch(media) });
    deps.wasAlreadyNotified = async () => { throw new Error("firestore unavailable"); };
    const result = await runAiringCheck(deps);
    assert.ok(result.errors >= 1);
    assert.strictEqual(store.calls.sendPush.length, 0);
  });

  // ---- Gap 3: dry-run mode ----

  await test("dryRun:true never calls refreshSnapshot/sendPush/recordNotified/deleteSubscription, but still reads AniList and computes the same due episode", async () => {
    const store = makeFakeStore({
      follows: [{
        id: "u1_100", uid: "u1", anilistId: 100, title: "Test Anime", notifyOnAiring: true,
        nextEpisodeSnapshot: { episode: 5, airingAt: 1754000000 },
      }],
      subscriptions: [{ id: "u1_hashA", uid: "u1", token: "tokenA", platform: "web" }],
    });
    let fetchCallCount = 0;
    const media = { 100: {
      id: 100, title: { romaji: "Test Anime" }, isAdult: false, genres: [],
      nextAiringEpisode: { airingAt: 9999999999, timeUntilAiring: 999999, episode: 6 },
    } };
    const deps = makeDeps({ store, fetchImpl: async (...args) => { fetchCallCount++; return makeAniListFetch(media)(...args); } });
    const result = await runAiringCheck(deps, { dryRun: true });
    assert.strictEqual(result.dryRun, true);
    assert.strictEqual(fetchCallCount, 1); // reads still happen for real
    assert.strictEqual(result.refreshed, 1); // "would have refreshed" is still counted
    assert.strictEqual(result.notified, 1); // "would have notified" is still counted
    assert.strictEqual(store.calls.refreshSnapshot.length, 0); // never actually written
    assert.strictEqual(store.calls.sendPush.length, 0); // never actually sent
    assert.strictEqual(store.calls.recordNotified.length, 0); // dedup log never actually written
    assert.strictEqual(store.calls.deleteSubscription.length, 0);
    // The real Firestore state is completely untouched.
    assert.deepStrictEqual(
      store.followMap.get("u1_100").nextEpisodeSnapshot,
      { episode: 5, airingAt: 1754000000 }
    );
    assert.strictEqual(store.logSet.has("u1_100_5"), false);
  });

  await test("dryRun:true against an already-logged episode still reports skippedAlreadyNotified — dedup logic itself is exercised for real", async () => {
    const store = makeFakeStore({
      follows: [{ id: "u1_100", uid: "u1", anilistId: 100, title: "Test Anime", notifyOnAiring: true }],
      notificationLog: ["u1_100_5"],
    });
    const media = { 100: { id: 100, title: { romaji: "Test Anime" }, isAdult: false, genres: [], nextAiringEpisode: { airingAt: 1754000000, timeUntilAiring: -1, episode: 5 } } };
    const deps = makeDeps({ store, fetchImpl: makeAniListFetch(media) });
    const result = await runAiringCheck(deps, { dryRun: true });
    assert.strictEqual(result.skippedAlreadyNotified, 1);
    assert.strictEqual(result.notified, 0);
  });

  await test("dryRun defaults to false when options is omitted entirely", async () => {
    const store = makeFakeStore({ follows: [{ id: "u1_100", uid: "u1", anilistId: 100, title: "A", notifyOnAiring: true }] });
    const media = { 100: { id: 100, title: { romaji: "A" }, isAdult: false, genres: [], nextAiringEpisode: { airingAt: 1754000000, timeUntilAiring: -1, episode: 5 } } };
    const deps = makeDeps({ store, fetchImpl: makeAniListFetch(media) });
    const result = await runAiringCheck(deps);
    assert.strictEqual(result.dryRun, false);
    assert.strictEqual(store.calls.recordNotified.length, 1); // a real run, real write
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    failures.forEach(({ name, err }) => console.error(`\n[FAILED] ${name}\n${err.stack || err}`));
    process.exit(1);
  }
})();
