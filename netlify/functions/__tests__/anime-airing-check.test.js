// Deterministic tests for the scheduled airing-reminder Function — fully mocked Firestore/
// AniList/FCM deps, no network access, no real Firebase project. Run with:
// node netlify/functions/__tests__/anime-airing-check.test.js (or `npm run test:functions`).
// Mirrors weather.test.js/anilist.test.js's own createHandler(deps) testing style.

const assert = require("node:assert");

const { createHandler } = require("../anime-airing-check.js");
const { FirebaseConfigError } = require("../lib/firebase-admin.js");
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

function baseEnv(overrides = {}) {
  return {
    FIREBASE_PROJECT_ID: "lfj-profolio",
    FIREBASE_SERVICE_ACCOUNT: '{"project_id":"lfj-profolio"}',
    ...overrides,
  };
}

// A minimal, fully in-memory fake of the three Firestore-shaped collections this Function
// touches, driven purely by JS Maps — never a real Firestore/emulator connection.
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

function makeDeps({ env, store, fetchImpl, ensureFirebaseAdmin, now } = {}) {
  const s = store || makeFakeStore();
  return {
    env: env || baseEnv(),
    now: now || (() => new Date("2026-08-01T12:00:00.000Z")),
    ensureFirebaseAdmin: ensureFirebaseAdmin || (async () => {}),
    fetchImpl,
    ...s.deps,
    __store: s,
  };
}

function makeAniListFetch(mediaById) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        Page: {
          media: Object.values(mediaById),
        },
      },
    }),
  });
}

(async () => {
  await test("missing required env fails closed with 500, never touches Firestore", async () => {
    const deps = makeDeps({ env: {} });
    const res = await createHandler(deps)();
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(JSON.parse(res.body).error, "not_configured");
  });

  await test("Firebase Admin init failure (FirebaseConfigError) maps to 500 not_configured, never crashes", async () => {
    const deps = makeDeps({
      ensureFirebaseAdmin: async () => { throw new FirebaseConfigError("bad key", "admin_initialization", "config/invalid-private-key"); },
    });
    const res = await createHandler(deps)();
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(JSON.parse(res.body).error, "not_configured");
  });

  await test("no notifyOnAiring follows: zero AniList calls, zero writes, ok:true", async () => {
    let fetchCalled = false;
    const deps = makeDeps({
      store: makeFakeStore({ follows: [] }),
      fetchImpl: async () => { fetchCalled = true; },
    });
    const res = await createHandler(deps)();
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.checked, 0);
    assert.strictEqual(fetchCalled, false);
  });

  await test("an episode that already aired, never notified before, sends push and records dedup log", async () => {
    const store = makeFakeStore({
      follows: [{ id: "u1_100", uid: "u1", anilistId: 100, title: "Test Anime", notifyOnAiring: true }],
      subscriptions: [{ id: "u1_hashA", uid: "u1", token: "tokenA", platform: "web" }],
    });
    const media = { 100: { id: 100, title: { romaji: "Test Anime", english: null, native: null }, isAdult: false, genres: [], nextAiringEpisode: { airingAt: 1754000000, timeUntilAiring: -100, episode: 5 } } };
    const deps = makeDeps({ store, fetchImpl: makeAniListFetch(media) });
    const res = await createHandler(deps)();
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(body.notified, 1);
    assert.strictEqual(store.calls.sendPush.length, 1);
    assert.strictEqual(store.calls.sendPush[0].token, "tokenA");
    assert.strictEqual(store.calls.sendPush[0].data.dedupeKey, "u1_100_5");
    // Data-only payload, matching service-worker.js's own onBackgroundMessage contract.
    assert.ok(!("notification" in store.calls.sendPush[0]));
    assert.strictEqual(store.calls.recordNotified.length, 1);
    assert.strictEqual(store.calls.recordNotified[0].key, "u1_100_5");
    assert.strictEqual(store.calls.recordNotified[0].fields.subscriberCount, 1);
    // Requirement 9: schedule refreshed every run, whether or not anything was due.
    assert.strictEqual(store.calls.refreshSnapshot.length, 1);
    assert.deepStrictEqual(store.calls.refreshSnapshot[0].fields.nextEpisodeSnapshot, { episode: 5, airingAt: 1754000000 });
  });

  await test("Requirement 10: the same episode is never notified twice — already-logged dedup key is skipped", async () => {
    const store = makeFakeStore({
      follows: [{ id: "u1_100", uid: "u1", anilistId: 100, title: "Test Anime", notifyOnAiring: true }],
      subscriptions: [{ id: "u1_hashA", uid: "u1", token: "tokenA", platform: "web" }],
      notificationLog: ["u1_100_5"],
    });
    const media = { 100: { id: 100, title: { romaji: "Test Anime" }, isAdult: false, genres: [], nextAiringEpisode: { airingAt: 1754000000, timeUntilAiring: -100, episode: 5 } } };
    const deps = makeDeps({ store, fetchImpl: makeAniListFetch(media) });
    const res = await createHandler(deps)();
    const body = JSON.parse(res.body);
    assert.strictEqual(body.skippedAlreadyNotified, 1);
    assert.strictEqual(store.calls.sendPush.length, 0);
    assert.strictEqual(store.calls.recordNotified.length, 0);
  });

  await test("a future episode (airingAt in the future) is not due — no push, no dedup log, snapshot still refreshed", async () => {
    const store = makeFakeStore({
      follows: [{ id: "u1_100", uid: "u1", anilistId: 100, title: "Test Anime", notifyOnAiring: true }],
    });
    const media = { 100: { id: 100, title: { romaji: "Test Anime" }, isAdult: false, genres: [], nextAiringEpisode: { airingAt: 9999999999, timeUntilAiring: 999999, episode: 6 } } };
    const deps = makeDeps({ store, fetchImpl: makeAniListFetch(media), now: () => new Date("2026-08-01T12:00:00.000Z") });
    const res = await createHandler(deps)();
    const body = JSON.parse(res.body);
    assert.strictEqual(body.notified, 0);
    assert.strictEqual(store.calls.sendPush.length, 0);
    assert.strictEqual(store.calls.refreshSnapshot.length, 1);
  });

  await test("Requirement 13: missing/absent nextAiringEpisode is stored as null (unknown), never treated as due", async () => {
    const store = makeFakeStore({
      follows: [{ id: "u1_100", uid: "u1", anilistId: 100, title: "Finished Show", notifyOnAiring: true }],
    });
    const media = { 100: { id: 100, title: { romaji: "Finished Show" }, isAdult: false, genres: [], nextAiringEpisode: null } };
    const deps = makeDeps({ store, fetchImpl: makeAniListFetch(media) });
    const res = await createHandler(deps)();
    const body = JSON.parse(res.body);
    assert.strictEqual(body.notified, 0);
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
    const res = await createHandler(deps)();
    const body = JSON.parse(res.body);
    assert.strictEqual(body.tokensCleaned, 1);
    assert.strictEqual(store.calls.deleteSubscription.length, 1);
    assert.strictEqual(store.calls.deleteSubscription[0], "u1_hashDead");
    assert.strictEqual(store.subMap.has("u1_hashDead"), false);
    // The episode itself is still recorded as handled, with subscriberCount reflecting the
    // failed send (0 successful deliveries) — a later-subscribing device won't get a backlog ping.
    assert.strictEqual(store.calls.recordNotified.length, 1);
    assert.strictEqual(store.calls.recordNotified[0].fields.subscriberCount, 0);
  });

  await test("a non-dead-token send() failure (transient) is logged, subscription NOT deleted, episode still recorded", async () => {
    const store = makeFakeStore({
      follows: [{ id: "u1_100", uid: "u1", anilistId: 100, title: "Test Anime", notifyOnAiring: true }],
      subscriptions: [{ id: "u1_hashFlaky", uid: "u1", token: "flakyToken", platform: "web", _failWith: "messaging/internal-error" }],
    });
    const media = { 100: { id: 100, title: { romaji: "Test Anime" }, isAdult: false, genres: [], nextAiringEpisode: { airingAt: 1754000000, timeUntilAiring: -1, episode: 5 } } };
    const deps = makeDeps({ store, fetchImpl: makeAniListFetch(media) });
    const res = await createHandler(deps)();
    const body = JSON.parse(res.body);
    assert.strictEqual(body.tokensCleaned, 0);
    assert.ok(body.errors >= 1);
    assert.strictEqual(store.subMap.has("u1_hashFlaky"), true);
  });

  await test("zero subscribed devices: the episode is still recorded as handled (subscriberCount 0), no crash", async () => {
    const store = makeFakeStore({
      follows: [{ id: "u1_100", uid: "u1", anilistId: 100, title: "Test Anime", notifyOnAiring: true }],
      subscriptions: [],
    });
    const media = { 100: { id: 100, title: { romaji: "Test Anime" }, isAdult: false, genres: [], nextAiringEpisode: { airingAt: 1754000000, timeUntilAiring: -1, episode: 5 } } };
    const deps = makeDeps({ store, fetchImpl: makeAniListFetch(media) });
    const res = await createHandler(deps)();
    const body = JSON.parse(res.body);
    assert.strictEqual(body.notified, 1);
    assert.strictEqual(store.calls.sendPush.length, 0);
    assert.strictEqual(store.calls.recordNotified[0].fields.subscriberCount, 0);
  });

  await test("multiple due follows are batched into a single AniList call (never one call per title) when <= 25", async () => {
    let fetchCallCount = 0;
    const store = makeFakeStore({
      follows: [
        { id: "u1_100", uid: "u1", anilistId: 100, title: "A", notifyOnAiring: true },
        { id: "u1_101", uid: "u1", anilistId: 101, title: "B", notifyOnAiring: true },
        { id: "u1_102", uid: "u1", anilistId: 102, title: "C", notifyOnAiring: false }, // toggle off — never fetched
      ],
    });
    const media = {
      100: { id: 100, title: { romaji: "A" }, isAdult: false, genres: [], nextAiringEpisode: null },
      101: { id: 101, title: { romaji: "B" }, isAdult: false, genres: [], nextAiringEpisode: null },
    };
    const deps = makeDeps({
      store,
      fetchImpl: async (...args) => { fetchCallCount++; return makeAniListFetch(media)(...args); },
    });
    const res = await createHandler(deps)();
    const body = JSON.parse(res.body);
    assert.strictEqual(body.checked, 2); // the notifyOnAiring:false one is never included
    assert.strictEqual(fetchCallCount, 1);
    assert.strictEqual(store.calls.refreshSnapshot.length, 2);
  });

  await test("AniList upstream failure for a chunk: no crash, that run's titles simply aren't refreshed, errors counted", async () => {
    const store = makeFakeStore({
      follows: [{ id: "u1_100", uid: "u1", anilistId: 100, title: "A", notifyOnAiring: true }],
    });
    const deps = makeDeps({
      store,
      fetchImpl: async () => { throw new AniListUpstreamError("timeout"); },
    });
    const res = await createHandler(deps)();
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200); // the whole run doesn't fail, it degrades per-chunk
    assert.ok(body.errors >= 1);
    assert.strictEqual(store.calls.refreshSnapshot.length, 0); // no data for this id, nothing to refresh
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
    const res = await createHandler(deps)();
    const body = JSON.parse(res.body);
    assert.ok(body.errors >= 1);
    assert.strictEqual(store.calls.sendPush.length, 0);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    failures.forEach(({ name, err }) => console.error(`\n[FAILED] ${name}\n${err.stack || err}`));
    process.exit(1);
  }
})();
