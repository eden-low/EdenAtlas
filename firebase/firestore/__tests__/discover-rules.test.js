// Real, emulator-backed Firestore Rules tests for the `followed_anime` collection
// (firestore.rules, "Discover" — the Owner-only AniList follow list, see CLAUDE.md's
// "EdenAtlas Discover" history entry). This is NOT the hand-translated JS simulation that
// frontend/js/__tests__/discover-security.test.js already contains (that suite re-implements the rule
// logic in plain JS and checks it against the rules text string — useful as a fast, offline
// sanity check, but it is a reimplementation, not a test of the real Rules engine, and this file
// is written specifically because that distinction matters: a bug in the hand-translation could
// pass while the real deployed rule fails, or vice versa). Every assertion here runs the actual
// `@firebase/rules-unit-testing` SDK against a real Firestore Emulator process, loading the
// literal, unmodified firestore.rules file from the repo root and exercising it with real
// Firestore client SDK calls (setDoc/getDoc/getDocs/updateDoc/deleteDoc/writeBatch) under real
// request.auth/request.resource/resource.data semantics as Firestore itself evaluates them.
//
// Run with: `npm run test:firestore-rules` (wraps this file in
// `firebase emulators:exec --only firestore "node firebase/firestore/__tests__/discover-rules.test.js"`,
// see package.json). Do NOT run this file with plain `node firebase/firestore/__tests__/discover-rules.test.js`
// directly — it requires FIRESTORE_EMULATOR_HOST to be set (emulators:exec sets it for the child
// process automatically) and refuses to run without it, on purpose: this must never be able to
// silently fall through to a real Firestore project.
//
// Safety invariants, load-bearing, do not relax:
//   - `PROJECT_ID` below begins with "demo-" — Firebase's own documented convention (see
//     firebase.google.com/docs/emulator-suite) for a project ID that needs no real GCP project
//     and that both the Admin and client SDKs refuse to treat as reachable outside the emulator.
//   - No Firebase Admin SDK, service-account credential, or production project ID is loaded
//     anywhere in this file. Seeding/verification that needs to bypass the rules (e.g. planting
//     a foreign-uid document, or confirming a failed batch left nothing behind) uses
//     `testEnv.withSecurityRulesDisabled()` — the rules-unit-testing library's own emulator-only
//     bypass mechanism, not a real Admin credential.
//   - `.firebaserc`'s real `lfj-profolio` project id is never referenced here; the project id is
//     passed explicitly via `--project demo-edenatlas-discover-rules` on the CLI / hardcoded in
//     this file, never read from `.firebaserc`.

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error(
    "[discover-rules.test.js] FIRESTORE_EMULATOR_HOST is not set - refusing to run.\n" +
    "This suite must only ever run against a real Firestore Emulator, never a live project.\n" +
    "Use `npm run test:firestore-rules`, which wraps this file in `firebase emulators:exec`."
  );
  process.exit(1);
}
if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST)) {
  console.error(
    `[discover-rules.test.js] FIRESTORE_EMULATOR_HOST ("${process.env.FIRESTORE_EMULATOR_HOST}") ` +
    "does not look like a local emulator address - refusing to run as a precaution."
  );
  process.exit(1);
}

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require("@firebase/rules-unit-testing");
const {
  doc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  serverTimestamp,
  Timestamp,
  writeBatch,
} = require("firebase/firestore");

const PROJECT_ID = "demo-edenatlas-discover-rules";
const OWNER_EMAIL = "jjun8647@gmail.com"; // must match firestore.rules' hardcoded isOwner() email

const OWNER_UID = "owner-uid-1";
const OTHER_OWNER_UID = "owner-uid-2"; // a second uid that ALSO claims the owner email (impersonation-shaped test)
const FRIEND_UID = "friend-uid-1";
const FRIEND_EMAIL = "friend@example.com";
const VIEWER_UID = "viewer-uid-1";
const VIEWER_EMAIL = "viewer@example.com";
const FOREIGN_UID = "some-other-uid"; // used only to seed a doc that belongs to "nobody in particular"

const STATUSES = ["planning", "watching", "completed", "paused", "dropped"];
const ALLOWED_KEYS = [
  "uid", "anilistId", "mediaType", "title", "coverImage", "format", "status", "isAdult", "notifyOnAiring", "followedAt", "updatedAt",
];

let pass = 0;
let fail = 0;
const failures = [];
let testEnv;

async function test(name, fn) {
  // Clean emulator state before every test so tests are fully order-independent and never leak
  // documents from one scenario into the next.
  await testEnv.clearFirestore();
  try {
    await fn();
    pass++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, err });
    console.log(`FAIL  - ${name}`);
    console.log(`        ${err && err.message ? err.message : err}`);
  }
}

function ctxFor(uid, claims) {
  return uid == null ? testEnv.unauthenticatedContext() : testEnv.authenticatedContext(uid, claims);
}
function ownerCtx(uid = OWNER_UID) {
  return ctxFor(uid, { email: OWNER_EMAIL });
}
function friendCtx() {
  return ctxFor(FRIEND_UID, { email: FRIEND_EMAIL });
}
function viewerCtx() {
  return ctxFor(VIEWER_UID, { email: VIEWER_EMAIL });
}

function followId(uid, anilistId) {
  return `${uid}_${anilistId}`;
}

function validPayload(overrides = {}) {
  return {
    uid: OWNER_UID,
    anilistId: 12345,
    mediaType: "ANIME",
    title: "Test Anime",
    coverImage: "https://example.com/cover.jpg",
    format: "TV",
    status: "planning",
    isAdult: false,
    notifyOnAiring: false,
    followedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  };
}

// Seed a document bypassing rules entirely (per instructions: seeding only via
// withSecurityRulesDisabled(), never via a real Admin credential).
//
// ctx.firestore() returns the COMPAT/namespaced Firestore instance (confirmed by reading the
// library's own type declarations: `firestore(settings?): firebase.firestore.Firestore`), not
// the modular instance every other call in this file uses - its own doc example even shows
// `doc(alice.firestore(), path)`, the modular function, rather than `alice.firestore().doc(path)`.
// Calling `.doc(path).get()` directly on it (the compat/namespaced method chain) still "works"
// but returns a compat-style DocumentSnapshot whose `.exists` is a boolean PROPERTY, not a
// function - mixing the two APIs is what caused a real bug here (see adminGet below). Always go
// through the modular doc()/setDoc()/getDoc() functions against the db handle instead.
async function seed(id, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `followed_anime/${id}`), data);
  });
}
// Same admin-bypass shape as seed() above, for push_subscriptions — kept a separate helper
// rather than parameterizing seed() itself, so every existing followed_anime call site stays
// untouched.
async function seedSub(id, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `push_subscriptions/${id}`), data);
  });
}
async function seedValidOwnerDoc(overrides = {}) {
  const anilistId = overrides.anilistId ?? 12345;
  const id = followId(OWNER_UID, anilistId);
  const data = validPayload({ anilistId, followedAt: Timestamp.now(), updatedAt: Timestamp.now(), ...overrides });
  await seed(id, data);
  return { id, data };
}
async function adminGet(id) {
  // @firebase/rules-unit-testing's withSecurityRulesDisabled() awaits its callback but does NOT
  // propagate the callback's return value (confirmed by reading the installed package source,
  // dist/index.cjs.js: `await callback(context);` with no `return` at all) - the result must be
  // captured via an outer variable instead of relying on withSecurityRulesDisabled's own
  // resolution value. Uses the modular getDoc()/doc() functions, not ctx.firestore().doc().get()
  // (the compat method chain) - see seed()'s comment above for why that distinction matters.
  let result;
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    result = await getDoc(doc(ctx.firestore(), `followed_anime/${id}`));
  });
  return result;
}
async function adminExists(id) {
  const snap = await adminGet(id);
  return snap.exists();
}

async function run() {
  const rulesPath = path.join(__dirname, "..", "..", "..", "firestore.rules");
  const rules = fs.readFileSync(rulesPath, "utf8");
  assert.ok(rules.includes("match /followed_anime/{id}"), "firestore.rules is missing the followed_anime match block - wrong file?");

  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules },
  });

  try {
    // =========================================================================================
    // SUCCESS CASES
    // =========================================================================================

    await test("Owner can create followed_anime/{uid}_{anilistId} with the exact approved field allowlist", async () => {
      const uid = OWNER_UID;
      const anilistId = 100;
      const id = followId(uid, anilistId);
      const db = ownerCtx(uid).firestore();
      const payload = validPayload({ anilistId });
      assert.deepStrictEqual(Object.keys(payload).sort(), [...ALLOWED_KEYS].sort());
      await assertSucceeds(setDoc(doc(db, "followed_anime", id), payload));
    });

    await test("status accepts each of the 5 supported values (planning/watching/completed/paused/dropped)", async () => {
      const db = ownerCtx().firestore();
      for (let i = 0; i < STATUSES.length; i++) {
        const status = STATUSES[i];
        const anilistId = 200 + i;
        const id = followId(OWNER_UID, anilistId);
        await assertSucceeds(setDoc(doc(db, "followed_anime", id), validPayload({ anilistId, status })));
      }
    });

    await test("followedAt/updatedAt written with serverTimestamp() succeed and resolve to real server Timestamps", async () => {
      const db = ownerCtx().firestore();
      const anilistId = 300;
      const id = followId(OWNER_UID, anilistId);
      await assertSucceeds(setDoc(doc(db, "followed_anime", id), validPayload({ anilistId })));
      const snap = await getDoc(doc(db, "followed_anime", id));
      assert.ok(snap.data().followedAt instanceof Timestamp, "followedAt did not resolve to a Timestamp");
      assert.ok(snap.data().updatedAt instanceof Timestamp, "updatedAt did not resolve to a Timestamp");
    });

    await test("Owner can get their own document", async () => {
      const { id } = await seedValidOwnerDoc({ anilistId: 400 });
      const db = ownerCtx().firestore();
      const snap = await assertSucceeds(getDoc(doc(db, "followed_anime", id)));
      assert.strictEqual(snap.data().anilistId, 400);
    });

    await test("Owner can run the exact uid-scoped My List query used by discover.js", async () => {
      await seedValidOwnerDoc({ anilistId: 500 });
      await seedValidOwnerDoc({ anilistId: 501 });
      const db = ownerCtx().firestore();
      const snap = await assertSucceeds(
        getDocs(query(collection(db, "followed_anime"), where("uid", "==", OWNER_UID)))
      );
      assert.strictEqual(snap.size, 2);
    });

    await test("Owner can update status while preserving immutable fields and followedAt", async () => {
      const { id, data } = await seedValidOwnerDoc({ anilistId: 600, status: "planning" });
      const db = ownerCtx().firestore();
      await assertSucceeds(updateDoc(doc(db, "followed_anime", id), { status: "watching", updatedAt: serverTimestamp() }));
      const snap = await getDoc(doc(db, "followed_anime", id));
      assert.strictEqual(snap.data().status, "watching");
      assert.strictEqual(snap.data().uid, data.uid);
      assert.strictEqual(snap.data().anilistId, data.anilistId);
      assert.strictEqual(snap.data().mediaType, data.mediaType);
      assert.ok(snap.data().followedAt.isEqual(data.followedAt), "followedAt must be preserved exactly across an update");
    });

    await test("A valid update refreshes updatedAt using serverTimestamp() (never a stale/unchanged value)", async () => {
      const { id, data } = await seedValidOwnerDoc({ anilistId: 700 });
      const db = ownerCtx().firestore();
      await assertSucceeds(updateDoc(doc(db, "followed_anime", id), { status: "completed", updatedAt: serverTimestamp() }));
      const snap = await getDoc(doc(db, "followed_anime", id));
      assert.ok(snap.data().updatedAt instanceof Timestamp);
      assert.ok(snap.data().updatedAt.toMillis() >= data.updatedAt.toMillis(), "updatedAt should not move backward");
    });

    await test("Owner can delete their own document", async () => {
      const { id } = await seedValidOwnerDoc({ anilistId: 800 });
      const db = ownerCtx().firestore();
      await assertSucceeds(deleteDoc(doc(db, "followed_anime", id)));
      assert.strictEqual(await adminExists(id), false);
    });

    // =========================================================================================
    // DENIAL CASES
    // =========================================================================================

    await test("Unauthenticated: read/create/update/delete all denied", async () => {
      const { id } = await seedValidOwnerDoc({ anilistId: 900 });
      const db = ctxFor(null).firestore();
      await assertFails(getDoc(doc(db, "followed_anime", id)));
      await assertFails(setDoc(doc(db, "followed_anime", followId(OWNER_UID, 901)), validPayload({ anilistId: 901 })));
      await assertFails(updateDoc(doc(db, "followed_anime", id), { status: "watching", updatedAt: serverTimestamp() }));
      await assertFails(deleteDoc(doc(db, "followed_anime", id)));
    });

    await test("Friend: read/create/update/delete all denied (Discover is strictly Owner-only, never canParticipate())", async () => {
      const { id } = await seedValidOwnerDoc({ anilistId: 1000 });
      const db = friendCtx().firestore();
      await assertFails(getDoc(doc(db, "followed_anime", id)));
      await assertFails(setDoc(
        doc(db, "followed_anime", followId(FRIEND_UID, 1001)),
        validPayload({ uid: FRIEND_UID, anilistId: 1001 })
      ));
      await assertFails(updateDoc(doc(db, "followed_anime", id), { status: "watching", updatedAt: serverTimestamp() }));
      await assertFails(deleteDoc(doc(db, "followed_anime", id)));
    });

    await test("Viewer: read/create/update/delete all denied", async () => {
      const { id } = await seedValidOwnerDoc({ anilistId: 1100 });
      const db = viewerCtx().firestore();
      await assertFails(getDoc(doc(db, "followed_anime", id)));
      await assertFails(setDoc(
        doc(db, "followed_anime", followId(VIEWER_UID, 1101)),
        validPayload({ uid: VIEWER_UID, anilistId: 1101 })
      ));
      await assertFails(updateDoc(doc(db, "followed_anime", id), { status: "watching", updatedAt: serverTimestamp() }));
      await assertFails(deleteDoc(doc(db, "followed_anime", id)));
    });

    await test("Owner-email/document-uid mismatch: a second uid claiming the owner's email cannot touch the first owner uid's doc", async () => {
      // firestore.rules' isOwner() checks ONLY request.auth.token.email - there is no
      // users/{uid}.role cross-check at the rules layer for this collection (unlike
      // backend/netlify/functions/assistant.js's server-side two-signal AND check). This is the rules
      // layer's actual analogue of a "role mismatch": having the right email is not enough,
      // the uid must also match the document's own stored uid.
      const { id } = await seedValidOwnerDoc({ anilistId: 1200 });
      const db = ownerCtx(OTHER_OWNER_UID).firestore(); // same email, different uid
      await assertFails(getDoc(doc(db, "followed_anime", id)));
      await assertFails(updateDoc(doc(db, "followed_anime", id), { status: "watching", updatedAt: serverTimestamp() }));
      await assertFails(deleteDoc(doc(db, "followed_anime", id)));
    });

    await test("Owner-uid/token-email mismatch: matching uid alone with a non-owner email is not isOwner()", async () => {
      const { id } = await seedValidOwnerDoc({ anilistId: 1300 });
      const db = ctxFor(OWNER_UID, { email: "not-the-owner@example.com" }).firestore();
      await assertFails(getDoc(doc(db, "followed_anime", id)));
      await assertFails(updateDoc(doc(db, "followed_anime", id), { status: "watching", updatedAt: serverTimestamp() }));
      await assertFails(deleteDoc(doc(db, "followed_anime", id)));
    });

    await test("Wrong deterministic document ID (not `${uid}_${anilistId}`) is rejected on create", async () => {
      const db = ownerCtx().firestore();
      await assertFails(setDoc(doc(db, "followed_anime", "not-the-right-id"), validPayload({ anilistId: 1400 })));
      // also reject a swapped/mismatched id (right shape, wrong anilistId segment)
      await assertFails(setDoc(doc(db, "followed_anime", followId(OWNER_UID, 999999)), validPayload({ anilistId: 1400 })));
    });

    await test("uid belonging to another user is rejected even when the doc ID itself matches the caller's uid", async () => {
      const db = ownerCtx().firestore();
      const id = followId(OWNER_UID, 1500); // id matches auth.uid's prefix
      await assertFails(setDoc(doc(db, "followed_anime", id), validPayload({ uid: FRIEND_UID, anilistId: 1500 })));
    });

    await test("Wrong or missing anilistId is rejected", async () => {
      const db = ownerCtx().firestore();
      await assertFails(setDoc(doc(db, "followed_anime", followId(OWNER_UID, "1600")), validPayload({ anilistId: "1600" }))); // string, not int
      await assertFails(setDoc(doc(db, "followed_anime", followId(OWNER_UID, 0)), validPayload({ anilistId: 0 }))); // not > 0
      await assertFails(setDoc(doc(db, "followed_anime", followId(OWNER_UID, -5)), validPayload({ anilistId: -5 }))); // negative
      const missing = validPayload({ anilistId: 1601 });
      delete missing.anilistId;
      await assertFails(setDoc(doc(db, "followed_anime", followId(OWNER_UID, 1601)), missing));
    });

    await test("Wrong mediaType is rejected", async () => {
      const db = ownerCtx().firestore();
      await assertFails(setDoc(doc(db, "followed_anime", followId(OWNER_UID, 1700)), validPayload({ anilistId: 1700, mediaType: "MANGA" })));
    });

    await test("isAdult true or missing is rejected", async () => {
      const db = ownerCtx().firestore();
      await assertFails(setDoc(doc(db, "followed_anime", followId(OWNER_UID, 1800)), validPayload({ anilistId: 1800, isAdult: true })));
      const missing = validPayload({ anilistId: 1801 });
      delete missing.isAdult;
      await assertFails(setDoc(doc(db, "followed_anime", followId(OWNER_UID, 1801)), missing));
    });

    await test("Invalid or missing status is rejected", async () => {
      const db = ownerCtx().firestore();
      await assertFails(setDoc(doc(db, "followed_anime", followId(OWNER_UID, 1900)), validPayload({ anilistId: 1900, status: "on-hold" })));
      const missing = validPayload({ anilistId: 1901 });
      delete missing.status;
      await assertFails(setDoc(doc(db, "followed_anime", followId(OWNER_UID, 1901)), missing));
    });

    await test("Extra fields on create are rejected (hasOnly allowlist)", async () => {
      const db = ownerCtx().firestore();
      await assertFails(setDoc(
        doc(db, "followed_anime", followId(OWNER_UID, 2000)),
        validPayload({ anilistId: 2000, personalScore: 10 })
      ));
    });

    await test("Extra fields introduced on update are rejected", async () => {
      const { id } = await seedValidOwnerDoc({ anilistId: 2100 });
      const db = ownerCtx().firestore();
      await assertFails(updateDoc(doc(db, "followed_anime", id), {
        status: "watching", updatedAt: serverTimestamp(), personalNote: "sneaked in",
      }));
    });

    await test("Client-literal timestamps instead of request.time server timestamps are rejected on create", async () => {
      const db = ownerCtx().firestore();
      const literalNow = Timestamp.now();
      await assertFails(setDoc(doc(db, "followed_anime", followId(OWNER_UID, 2200)), validPayload({
        anilistId: 2200, followedAt: literalNow, updatedAt: literalNow,
      })));
    });

    await test("followedAt changed during update is rejected", async () => {
      const { id } = await seedValidOwnerDoc({ anilistId: 2300 });
      const db = ownerCtx().firestore();
      await assertFails(updateDoc(doc(db, "followed_anime", id), {
        status: "watching", followedAt: serverTimestamp(), updatedAt: serverTimestamp(),
      }));
    });

    await test("updatedAt left unchanged, or supplied as a client literal, is rejected on update", async () => {
      const { id } = await seedValidOwnerDoc({ anilistId: 2400 });
      const db = ownerCtx().firestore();
      // (a) updatedAt simply not included in the update at all - request.resource.data.updatedAt
      // carries over the OLD value, which will never equal the new request.time.
      await assertFails(updateDoc(doc(db, "followed_anime", id), { status: "watching" }));
      // (b) updatedAt supplied as a client-chosen literal Timestamp, not serverTimestamp().
      await assertFails(updateDoc(doc(db, "followed_anime", id), { status: "watching", updatedAt: Timestamp.now() }));
    });

    await test("uid, anilistId, or mediaType changed during update are each rejected", async () => {
      const { id } = await seedValidOwnerDoc({ anilistId: 2500 });
      const db = ownerCtx().firestore();
      await assertFails(updateDoc(doc(db, "followed_anime", id), { uid: FRIEND_UID, updatedAt: serverTimestamp() }));
      await assertFails(updateDoc(doc(db, "followed_anime", id), { anilistId: 999999, updatedAt: serverTimestamp() }));
      await assertFails(updateDoc(doc(db, "followed_anime", id), { mediaType: "MANGA", updatedAt: serverTimestamp() }));
    });

    await test("Owner reading/deleting a document whose resource uid belongs to another user is rejected", async () => {
      // Seed a doc (bypassing rules) whose stored uid does NOT match OWNER_UID at all - under
      // enforced rules this could never have been created honestly (create requires
      // request.resource.data.uid == request.auth.uid), but this proves isOwner() alone is not a
      // blanket bypass: the per-document uid == request.auth.uid check still applies even to the
      // real Owner.
      const anilistId = 2600;
      const id = followId(FOREIGN_UID, anilistId);
      await seed(id, validPayload({ uid: FOREIGN_UID, anilistId, followedAt: Timestamp.now(), updatedAt: Timestamp.now() }));
      const db = ownerCtx().firestore();
      await assertFails(getDoc(doc(db, "followed_anime", id)));
      await assertFails(deleteDoc(doc(db, "followed_anime", id)));
    });

    await test("An unscoped collection query with no uid constraint is rejected outright", async () => {
      await seedValidOwnerDoc({ anilistId: 2700 });
      const db = ownerCtx().firestore();
      await assertFails(getDocs(collection(db, "followed_anime")));
    });

    await test("A query scoped to a different uid than the caller is also rejected (bonus: rules-provability, not just an empty result)", async () => {
      await seedValidOwnerDoc({ anilistId: 2701 });
      const db = ownerCtx().firestore();
      await assertFails(getDocs(query(collection(db, "followed_anime"), where("uid", "==", FRIEND_UID))));
    });

    await test("Batch write fails atomically if any operation in the batch is invalid", async () => {
      const db = ownerCtx().firestore();
      const goodId = followId(OWNER_UID, 2800);
      const badId = followId(OWNER_UID, 2801);
      const batch = writeBatch(db);
      batch.set(doc(db, "followed_anime", goodId), validPayload({ anilistId: 2800 }));
      batch.set(doc(db, "followed_anime", badId), validPayload({ anilistId: 2801, isAdult: true })); // invalid
      await assertFails(batch.commit());
      assert.strictEqual(await adminExists(goodId), false, "the VALID half of a failed batch must not have been written");
      assert.strictEqual(await adminExists(badId), false);
    });

    // ---- Public Resume owner identity (public_profiles) ----

    await test("a normal user cannot create or update public_profiles role to owner", async () => {
      const db = friendCtx().firestore();
      const ref = doc(db, "public_profiles", FRIEND_UID);
      await assertFails(setDoc(ref, {
        uid: FRIEND_UID, displayName: "Friend", role: "owner", careerVisibility: "public",
      }));

      await assertSucceeds(setDoc(ref, {
        uid: FRIEND_UID, displayName: "Friend", role: "friend", careerVisibility: "public",
      }));
      await assertFails(updateDoc(ref, { role: "owner" }));
    });

    await test("normal allowed public-profile edits still work", async () => {
      const db = viewerCtx().firestore();
      const ref = doc(db, "public_profiles", VIEWER_UID);
      await assertSucceeds(setDoc(ref, {
        uid: VIEWER_UID, displayName: "Viewer", role: "viewer", careerVisibility: "public",
      }));
      await assertSucceeds(updateDoc(ref, {
        displayName: "Updated Viewer", username: "updated-viewer", careerVisibility: "connections",
      }));
      const snap = await getDoc(ref);
      assert.strictEqual(snap.data().displayName, "Updated Viewer");
      assert.strictEqual(snap.data().role, "viewer");
    });

    await test("the actual Owner can create and update the canonical owner public profile", async () => {
      const db = ownerCtx().firestore();
      const ref = doc(db, "public_profiles", OWNER_UID);
      await assertSucceeds(setDoc(ref, {
        uid: OWNER_UID, displayName: "Owner", role: "owner", careerVisibility: "public",
      }));
      await assertSucceeds(updateDoc(ref, { displayName: "Updated Owner" }));
      const snap = await getDoc(ref);
      assert.strictEqual(snap.data().role, "owner");
      assert.strictEqual(snap.data().displayName, "Updated Owner");
    });

    await test("signed-out Resume owner resolution query returns only the real Owner profile", async () => {
      await assertSucceeds(setDoc(doc(ownerCtx().firestore(), "public_profiles", OWNER_UID), {
        uid: OWNER_UID, displayName: "Owner", role: "owner", careerVisibility: "public",
      }));
      await assertSucceeds(setDoc(doc(friendCtx().firestore(), "public_profiles", FRIEND_UID), {
        uid: FRIEND_UID, displayName: "Friend", role: "friend", careerVisibility: "public",
      }));

      const publicDb = ctxFor(null).firestore();
      const snap = await assertSucceeds(getDocs(query(
        collection(publicDb, "public_profiles"),
        where("role", "==", "owner")
      )));
      assert.strictEqual(snap.size, 1);
      assert.strictEqual(snap.docs[0].id, OWNER_UID);
    });

    // ---- Phase 4: notifyOnAiring (followed_anime) ----

    await test("create WITHOUT notifyOnAiring is rejected (required field, no implicit default)", async () => {
      const db = ownerCtx().firestore();
      const id = followId(OWNER_UID, 3000);
      const payload = validPayload({ anilistId: 3000 });
      delete payload.notifyOnAiring;
      await assertFails(setDoc(doc(db, "followed_anime", id), payload));
    });

    await test("create with notifyOnAiring as a non-boolean is rejected", async () => {
      const db = ownerCtx().firestore();
      const id = followId(OWNER_UID, 3001);
      await assertFails(setDoc(doc(db, "followed_anime", id), validPayload({ anilistId: 3001, notifyOnAiring: "true" })));
      await assertFails(setDoc(doc(db, "followed_anime", id), validPayload({ anilistId: 3001, notifyOnAiring: 1 })));
    });

    await test("create with notifyOnAiring: false succeeds (a new follow never starts subscribed)", async () => {
      const db = ownerCtx().firestore();
      const id = followId(OWNER_UID, 3002);
      await assertSucceeds(setDoc(doc(db, "followed_anime", id), validPayload({ anilistId: 3002, notifyOnAiring: false })));
    });

    await test("update can toggle notifyOnAiring true/false without touching any other field", async () => {
      const { id } = await seedValidOwnerDoc({ anilistId: 3003, notifyOnAiring: false });
      const db = ownerCtx().firestore();
      await assertSucceeds(updateDoc(doc(db, "followed_anime", id), { notifyOnAiring: true, updatedAt: serverTimestamp() }));
      const snap = await adminGet(id);
      assert.strictEqual(snap.data().notifyOnAiring, true);
      await assertSucceeds(updateDoc(doc(db, "followed_anime", id), { notifyOnAiring: false, updatedAt: serverTimestamp() }));
    });

    await test("a status-only update leaves a previously-true notifyOnAiring unchanged (partial update semantics)", async () => {
      const { id } = await seedValidOwnerDoc({ anilistId: 3004, notifyOnAiring: true });
      const db = ownerCtx().firestore();
      await assertSucceeds(updateDoc(doc(db, "followed_anime", id), { status: "watching", updatedAt: serverTimestamp() }));
      const snap = await adminGet(id);
      assert.strictEqual(snap.data().notifyOnAiring, true);
    });

    await test("update with notifyOnAiring as a non-boolean is rejected", async () => {
      const { id } = await seedValidOwnerDoc({ anilistId: 3005 });
      const db = ownerCtx().firestore();
      await assertFails(updateDoc(doc(db, "followed_anime", id), { notifyOnAiring: "yes", updatedAt: serverTimestamp() }));
    });

    // ---- Phase 4: push_subscriptions ----

    function subValidPayload(overrides = {}) {
      return {
        uid: OWNER_UID,
        tokenHash: "hash-abc-123",
        token: "fcm-token-xyz",
        platform: "web",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        ...overrides,
      };
    }
    function subId(uid, tokenHash) {
      return `${uid}_${tokenHash}`;
    }

    await test("Owner can create a push_subscriptions doc with the correct deterministic id", async () => {
      const db = ownerCtx().firestore();
      const id = subId(OWNER_UID, "hash-abc-123");
      await assertSucceeds(setDoc(doc(db, "push_subscriptions", id), subValidPayload()));
    });

    await test("push_subscriptions create with a mismatched id (not uid_tokenHash) is rejected", async () => {
      const db = ownerCtx().firestore();
      await assertFails(setDoc(doc(db, "push_subscriptions", "not-the-right-id"), subValidPayload()));
    });

    await test("push_subscriptions create with an extra field is rejected", async () => {
      const db = ownerCtx().firestore();
      const id = subId(OWNER_UID, "hash-extra");
      await assertFails(setDoc(doc(db, "push_subscriptions", id), subValidPayload({ tokenHash: "hash-extra", nickname: "my phone" })));
    });

    await test("push_subscriptions create with platform other than 'web' is rejected", async () => {
      const db = ownerCtx().firestore();
      const id = subId(OWNER_UID, "hash-plat");
      await assertFails(setDoc(doc(db, "push_subscriptions", id), subValidPayload({ tokenHash: "hash-plat", platform: "ios" })));
    });

    await test("Friend and Viewer can never create a push_subscriptions doc (strictly Owner-only, not canParticipate())", async () => {
      const friendDb = friendCtx().firestore();
      const viewerDb = viewerCtx().firestore();
      await assertFails(setDoc(doc(friendDb, "push_subscriptions", subId(FRIEND_UID, "h1")), subValidPayload({ uid: FRIEND_UID, tokenHash: "h1" })));
      await assertFails(setDoc(doc(viewerDb, "push_subscriptions", subId(VIEWER_UID, "h2")), subValidPayload({ uid: VIEWER_UID, tokenHash: "h2" })));
    });

    await test("a signed-out caller can never create a push_subscriptions doc", async () => {
      const db = ctxFor(null).firestore();
      await assertFails(setDoc(doc(db, "push_subscriptions", subId(OWNER_UID, "h3")), subValidPayload({ tokenHash: "h3" })));
    });

    await test("push_subscriptions update can refresh updatedAt only — uid/tokenHash/token/platform/createdAt are immutable", async () => {
      const id = subId(OWNER_UID, "hash-refresh");
      await seedSub(id, subValidPayload({ tokenHash: "hash-refresh", createdAt: Timestamp.now(), updatedAt: Timestamp.now() }));
      const db = ownerCtx().firestore();
      await assertSucceeds(updateDoc(doc(db, "push_subscriptions", id), { updatedAt: serverTimestamp() }));
      await assertFails(updateDoc(doc(db, "push_subscriptions", id), { token: "a-different-token", updatedAt: serverTimestamp() }));
      await assertFails(updateDoc(doc(db, "push_subscriptions", id), { tokenHash: "different-hash", updatedAt: serverTimestamp() }));
      await assertFails(updateDoc(doc(db, "push_subscriptions", id), { platform: "ios", updatedAt: serverTimestamp() }));
      await assertFails(updateDoc(doc(db, "push_subscriptions", id), { createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
    });

    await test("push_subscriptions: reading/deleting a doc whose resource uid belongs to another user is rejected even for the real Owner", async () => {
      const id = subId(FOREIGN_UID, "hash-foreign");
      await seedSub(id, subValidPayload({ uid: FOREIGN_UID, tokenHash: "hash-foreign", createdAt: Timestamp.now(), updatedAt: Timestamp.now() }));
      const db = ownerCtx().firestore();
      await assertFails(getDoc(doc(db, "push_subscriptions", id)));
      await assertFails(deleteDoc(doc(db, "push_subscriptions", id)));
    });

    await test("Owner can read and delete their own push_subscriptions doc", async () => {
      const id = subId(OWNER_UID, "hash-own");
      await seedSub(id, subValidPayload({ tokenHash: "hash-own", createdAt: Timestamp.now(), updatedAt: Timestamp.now() }));
      const db = ownerCtx().firestore();
      await assertSucceeds(getDoc(doc(db, "push_subscriptions", id)));
      await assertSucceeds(deleteDoc(doc(db, "push_subscriptions", id)));
    });

    // REGRESSION (root cause of the reported "开启提醒 fails with permission-denied" bug):
    // js/push-notifications.js's subscribeThisDevice() calls getDoc(ref) on the device's
    // deterministic push_subscriptions doc BEFORE deciding whether to setDoc (new device) or
    // updateDoc (already-registered device) — this is the very first Firestore call a first-time
    // subscribe makes. For a brand-new device, that doc does not exist yet, so `resource` is null
    // when the `read`/`get` rule evaluates `resource.data.uid` — dereferencing a property of a
    // null resource is a rules evaluation error, which Firestore reports to the client identically
    // to a real permission denial (PERMISSION_DENIED), never NOT_FOUND. This never showed up in
    // "Owner can read ... own push_subscriptions doc" above because that test seeds the doc first.
    await test("Owner reading their OWN not-yet-existing push_subscriptions doc must not fail closed (first-time subscribe)", async () => {
      const id = subId(OWNER_UID, "hash-brand-new-device");
      const db = ownerCtx().firestore();
      const snap = await getDoc(doc(db, "push_subscriptions", id));
      assert.strictEqual(snap.exists(), false, "expected a clean non-existent read, not a thrown/denied error");
    });

    // ---- Phase 4: anime_notification_log (server-Admin-write-only dedup log) ----

    await test("anime_notification_log: no client (Owner included) can ever create/update/delete — default-deny, no rule grants it", async () => {
      const db = ownerCtx().firestore();
      const id = "owner-uid-1_100_5";
      await assertFails(setDoc(doc(db, "anime_notification_log", id), { uid: OWNER_UID, anilistId: 100, episode: 5, sentAt: serverTimestamp() }));
      // Seed one via the rules-disabled admin bypass (simulating the real server-side writer),
      // then confirm no client write path can touch it afterward either.
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), `anime_notification_log/${id}`), { uid: OWNER_UID, anilistId: 100, episode: 5, sentAt: Timestamp.now() });
      });
      await assertFails(updateDoc(doc(db, "anime_notification_log", id), { episode: 6 }));
      await assertFails(deleteDoc(doc(db, "anime_notification_log", id)));
    });

    await test("Owner can read their own anime_notification_log doc; Friend/Viewer/signed-out and a foreign-uid doc are all rejected", async () => {
      const id = "owner-uid-1_100_5";
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), `anime_notification_log/${id}`), { uid: OWNER_UID, anilistId: 100, episode: 5, sentAt: Timestamp.now() });
      });
      await assertSucceeds(getDoc(doc(ownerCtx().firestore(), "anime_notification_log", id)));
      await assertFails(getDoc(doc(friendCtx().firestore(), "anime_notification_log", id)));
      await assertFails(getDoc(doc(viewerCtx().firestore(), "anime_notification_log", id)));
      await assertFails(getDoc(doc(ctxFor(null).firestore(), "anime_notification_log", id)));

      const foreignId = "some-other-uid_200_1";
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), `anime_notification_log/${foreignId}`), { uid: FOREIGN_UID, anilistId: 200, episode: 1, sentAt: Timestamp.now() });
      });
      await assertFails(getDoc(doc(ownerCtx().firestore(), "anime_notification_log", foreignId)));
    });
  } finally {
    await testEnv.cleanup();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error("[discover-rules.test.js] unexpected failure:", err);
  process.exitCode = 1;
});
