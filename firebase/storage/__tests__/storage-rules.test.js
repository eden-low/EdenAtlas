// Real Storage Rules tests. Both Firestore and Storage emulators are required because the
// Storage policy reads whitelist, friendship, and Career policy documents from Firestore.
if (!process.env.FIRESTORE_EMULATOR_HOST
    || !/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST)
    || !process.env.FIREBASE_STORAGE_EMULATOR_HOST
    || !/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(process.env.FIREBASE_STORAGE_EMULATOR_HOST)) {
  console.error("[storage-rules.test.js] Run only through npm run test:storage-rules.");
  process.exit(1);
}

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert");
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require("@firebase/rules-unit-testing");
const { doc, setDoc, deleteDoc, updateDoc, writeBatch, serverTimestamp } = require("firebase/firestore");
const { ref, uploadBytes, getBytes, deleteObject, updateMetadata } = require("firebase/storage");
const { analyzeCareerStorageLookups, RulesAnalysisError } = require("../rules-static-analysis.js");

const PROJECT_ID = "demo-edenatlas-storage-rules";
const BUCKET = `gs://${PROJECT_ID}.appspot.com`;
const OWNER_UID = "storage-owner";
const OWNER_EMAIL = "jjun8647@gmail.com";
const FRIEND_UID = "storage-friend";
const FRIEND_EMAIL = "friend@example.com";
const CONNECTION_UID = "storage-connection";
const CONNECTION_EMAIL = "connection@example.com";
const OTHER_UID = "storage-other";
const CAPSULE_ID = "AbCdEfGhIjKlMnOpQrSt";
let testEnv;
let pass = 0;
let fail = 0;

function context(uid, email, emailVerified = true) {
  return uid == null
    ? testEnv.unauthenticatedContext()
    : testEnv.authenticatedContext(uid, { email, email_verified: emailVerified });
}
function ownerStorage() { return context(OWNER_UID, OWNER_EMAIL).storage(BUCKET); }
function friendStorage(verified = true) { return context(FRIEND_UID, FRIEND_EMAIL, verified).storage(BUCKET); }
function connectionStorage(verified = true) { return context(CONNECTION_UID, CONNECTION_EMAIL, verified).storage(BUCKET); }
function otherStorage() { return context(OTHER_UID, "other@example.com").storage(BUCKET); }
function anonymousStorage() { return context(null).storage(BUCKET); }
function bytes(contentType = "image/png") {
  return { data: new Uint8Array([1, 2, 3]), metadata: { contentType } };
}
async function put(storage, objectPath, contentType = "image/png") {
  const payload = bytes(contentType);
  return uploadBytes(ref(storage, objectPath), payload.data, payload.metadata);
}
async function read(storage, objectPath) {
  return getBytes(ref(storage, objectPath), 1024);
}
async function seedFirestore(documentPath, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), documentPath), data);
  });
}
async function seedObject(objectPath, contentType = "image/png") {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await put(ctx.storage(BUCKET), objectPath, contentType);
  });
}
function analyzerFixture(functions, allowExpression) {
  return `rules_version = '2';
    service firebase.storage { match /b/{bucket}/o {
      ${functions}
      match /career/{uid}/{collectionName}/{itemId}/{attachmentId} {
        allow read: if ${allowExpression};
      }
    } }`;
}
async function test(name, fn) {
  await testEnv.clearFirestore();
  await testEnv.clearStorage();
  try {
    await fn();
    pass++;
    console.log(`  ok  - ${name}`);
  } catch (error) {
    fail++;
    console.log(`FAIL  - ${name}`);
    console.log(`        ${error?.message || error}`);
  }
}

async function run() {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "firestore.rules"), "utf8") },
    storage: { rules: fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "storage.rules"), "utf8") },
  });

  try {
    await test("Career read authorization has a static two-document lookup ceiling", async () => {
      const rules = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "storage.rules"), "utf8");
      const report = analyzeCareerStorageLookups(rules);
      const lookups = new Set(report.lookupTemplates);
      if (lookups.size !== 2) {
        throw new Error(`Career read closure uses ${lookups.size} distinct Firestore paths: ${[...lookups].join(", ")}`);
      }
      const expected = [
        "/databases/(default)/documents/$(collectionName)/$(itemId)",
        "/databases/(default)/documents/friendships/$(uid)/friends/$(request.auth.uid)",
      ];
      for (const documentPath of expected) {
        if (!lookups.has(documentPath)) throw new Error(`Missing expected lookup: ${documentPath}`);
      }
      if ([...lookups].some((documentPath) => documentPath.includes("public_profiles"))) {
        throw new Error("Career Storage authorization must not perform a third profile lookup");
      }
      assert.ok(report.careerReadExpressions.length === 2, "both canonical and legacy Career reads must be roots");
      assert.ok(report.reachableFunctions.includes("canReadCareerItem"));
      assert.ok(report.reachableFunctions.includes("isAcceptedFriend"));
    });

    await test("lookup guard rejects third direct and multiline lookups", async () => {
      const direct = analyzerFixture("", `
        firestore.get(/databases/(default)/documents/a/$(uid)).data.ok == true
        && firestore.exists(
          /databases/(default)/documents/b/$(uid)
        )
        && firestore.getAfter(/databases/(default)/documents/c/$(uid)).data.ok == true`);
      assert.throws(() => analyzeCareerStorageLookups(direct), RulesAnalysisError);
    });

    await test("lookup guard recursively rejects a third nested helper", async () => {
      const nested = analyzerFixture(`
        function first(uid) { return firestore.get(/databases/(default)/documents/a/$(uid)).data.ok; }
        function second(uid) { return first(uid) && firestore.exists(/databases/(default)/documents/b/$(uid)); }
        function third(uid) { return firestore.getAfter(/databases/(default)/documents/c/$(uid)).data.ok; }
      `, "second(uid) && third(uid)");
      assert.throws(() => analyzeCareerStorageLookups(nested), RulesAnalysisError);
    });

    await test("lookup guard follows an additional helper introduced in an allow expression", async () => {
      const added = analyzerFixture(`
        function normal(uid) { return firestore.get(/databases/(default)/documents/a/$(uid)).data.ok; }
        function added(uid) { return firestore.exists(/databases/(default)/documents/b/$(uid)); }
      `, "normal(uid) && added(uid)");
      const report = analyzeCareerStorageLookups(added);
      assert.deepStrictEqual(report.lookupTemplates, [
        "/databases/(default)/documents/a/$(uid)",
        "/databases/(default)/documents/b/$(uid)",
      ]);
      assert.ok(report.reachableFunctions.includes("added"));
    });

    await test("lookup guard detects aliases and fails closed on unresolved calls", async () => {
      const aliases = analyzerFixture(`
        function helper(uid) {
          let lookup = firestore.getAfter;
          return lookup(/databases/(default)/documents/a/$(uid)).data.ok;
        }
      `, "helper(uid)");
      assert.deepStrictEqual(analyzeCareerStorageLookups(aliases).lookupTemplates, [
        "/databases/(default)/documents/a/$(uid)",
      ]);
      assert.throws(() => analyzeCareerStorageLookups(analyzerFixture("", "unknownAuthorization(uid)")), RulesAnalysisError);
      assert.throws(() => analyzeCareerStorageLookups(analyzerFixture("", "request.auth.uid @ uid")), RulesAnalysisError);
    });

    await test("lookup guard fails closed on nested Career matches and ambiguous catch-all reads", async () => {
      const nestedCareer = `${analyzerFixture("", "true").replace(/\s*}\s*}\s*$/, "")}
        match /career/{uid} {
          match /{collectionName}/{itemId}/{attachmentId} {
            allow read: if firestore.get(/databases/(default)/documents/third/$(uid)).data.ok;
          }
        }
      } }`;
      assert.throws(() => analyzeCareerStorageLookups(nestedCareer), RulesAnalysisError);

      const catchAll = `${analyzerFixture("", "true").replace(/\s*}\s*}\s*$/, "")}
        match /{allPaths=**} {
          allow read: if firestore.get(/databases/(default)/documents/third/global).data.ok;
        }
      } }`;
      assert.throws(() => analyzeCareerStorageLookups(catchAll), RulesAnalysisError);
      assert.throws(() => analyzeCareerStorageLookups(analyzerFixture(
        "function dynamic(path) { return firestore.get(path).data.ok; }", "dynamic(uid)",
      )), RulesAnalysisError);
    });

    await test("anonymous private read and write are denied", async () => {
      await seedObject(`gallery/${OWNER_UID}/private/photo.png`);
      await assertFails(read(anonymousStorage(), `gallery/${OWNER_UID}/private/photo.png`));
      await assertFails(put(anonymousStorage(), `gallery/${OWNER_UID}/private/new.png`));
    });

    await test("verified Owner intended writes are allowed", async () => {
      await assertSucceeds(put(ownerStorage(), `gallery/${OWNER_UID}/private/photo.png`));
      await assertSucceeds(put(ownerStorage(), `journal/${OWNER_UID}/private/note.txt`, "text/plain"));
      await seedFirestore(`career_certificates/cert`, { uid: OWNER_UID, visibility: "private" });
      await assertSucceeds(put(ownerStorage(), `career/${OWNER_UID}/career_certificates/cert/resume`, "application/pdf"));
    });

    await test("verified whitelist Friend may write only their own UID path", async () => {
      await seedFirestore(`friends/${FRIEND_EMAIL}`, { approved: true });
      await assertSucceeds(put(friendStorage(true), `gallery/${FRIEND_UID}/private/photo.png`));
      await assertSucceeds(put(context(FRIEND_UID, "Friend@Example.com", true).storage(BUCKET), `gallery/${FRIEND_UID}/private/mixed-case.png`));
      await assertSucceeds(put(friendStorage(true), `journal/${FRIEND_UID}/connections/note.txt`, "text/plain"));
      await assertFails(put(friendStorage(true), `gallery/${OWNER_UID}/private/photo.png`));
    });

    await test("unverified same-email whitelist Friend is denied", async () => {
      await seedFirestore(`friends/${FRIEND_EMAIL}`, { approved: true });
      await assertFails(put(friendStorage(false), `gallery/${FRIEND_UID}/private/photo.png`));
      await assertFails(put(friendStorage(false), `journal/${FRIEND_UID}/public/note.txt`, "text/plain"));
    });

    await test("accepted connection read requires verified email", async () => {
      const objectPath = `gallery/${OWNER_UID}/connections/photo.png`;
      await seedFirestore(`friendships/${OWNER_UID}/friends/${CONNECTION_UID}`, { friendUid: CONNECTION_UID });
      await seedObject(objectPath);
      await assertSucceeds(read(connectionStorage(true), objectPath));
      await assertFails(read(connectionStorage(false), objectPath));
      await assertFails(read(otherStorage(), objectPath));
    });

    await test("intentional public gallery and journal reads remain anonymous", async () => {
      for (const objectPath of [
        `gallery/${OWNER_UID}/public/photo.png`,
        `journal/${OWNER_UID}/public/note.txt`,
      ]) {
        await seedObject(objectPath);
        await assertSucceeds(read(anonymousStorage(), objectPath));
      }
    });

    await test("malformed and mismatched paths fail closed", async () => {
      await assertFails(put(ownerStorage(), `gallery/${OWNER_UID}/unknown/photo.png`));
      await assertFails(put(ownerStorage(), `capsules/${OWNER_UID}/short`, "application/pdf"));
      await assertFails(put(ownerStorage(), `capsules/${OTHER_UID}/${CAPSULE_ID}`, "application/pdf"));
    });

    await test("capsule policy accepts compatible files and rejects invalid type/size", async () => {
      const objectPath = `capsules/${OWNER_UID}/${CAPSULE_ID}`;
      await assertSucceeds(put(ownerStorage(), objectPath, "application/pdf"));
      await assertFails(put(ownerStorage(), `capsules/${OWNER_UID}/BcCdEfGhIjKlMnOpQrSt`, "text/html"));
      await assertFails(uploadBytes(
        ref(ownerStorage(), `capsules/${OWNER_UID}/CcCdEfGhIjKlMnOpQrSt`),
        new Uint8Array(12 * 1024 * 1024 + 1),
        { contentType: "image/png" }
      ));
      await assertFails(uploadBytes(
        ref(ownerStorage(), `capsules/${OWNER_UID}/DcCdEfGhIjKlMnOpQrSt`),
        new Uint8Array(0),
        { contentType: "image/png" }
      ));
      await assertFails(updateMetadata(ref(ownerStorage(), objectPath), {
        contentType: "text/html",
        customMetadata: { authorization: "public" },
      }));
      await assertFails(put(friendStorage(true), `capsules/${OWNER_UID}/EcCdEfGhIjKlMnOpQrSt`, "application/pdf"));
    });

    await test("capsule reads stay private and canonical objects remain owner-deletable", async () => {
      const objectPath = `capsules/${OWNER_UID}/${CAPSULE_ID}`;
      await seedObject(objectPath, "application/pdf");
      await assertSucceeds(read(ownerStorage(), objectPath));
      await assertFails(read(anonymousStorage(), objectPath));
      await assertFails(read(connectionStorage(true), objectPath));
      await assertFails(read(otherStorage(), objectPath));
      await assertFails(deleteObject(ref(otherStorage(), objectPath)));
      await assertSucceeds(deleteObject(ref(ownerStorage(), objectPath)));
    });

    await test("Capsule MIME and size limits are intentionally capsule-only", async () => {
      // Phase 5 specifies a narrow 12 MiB policy for Time Capsule. Gallery, Journal, and Career
      // retain their pre-existing authorization-only upload policy; this test makes that boundary
      // explicit instead of silently broadening unrelated product behavior.
      await assertSucceeds(put(ownerStorage(), `gallery/${OWNER_UID}/private/archive.bin`, "application/octet-stream"));
      await assertSucceeds(put(ownerStorage(), `journal/${OWNER_UID}/private/archive.bin`, "application/octet-stream"));
      await seedFirestore("career_projects/item", { uid: OWNER_UID, visibility: "private" });
      await assertSucceeds(put(ownerStorage(), `career/${OWNER_UID}/career_projects/item/archive`, "application/octet-stream"));
    });

    await test("all four canonical Career attachment types are item-bound and cross-user writes fail", async () => {
      for (const collectionName of [
        "career_projects", "career_experiences", "career_certificates", "career_awards",
      ]) {
        await seedFirestore(`${collectionName}/item-${collectionName}`, { uid: OWNER_UID, visibility: "private" });
        const objectPath = `career/${OWNER_UID}/${collectionName}/item-${collectionName}/asset`;
        await assertSucceeds(put(ownerStorage(), objectPath, "application/pdf"));
        await assertFails(put(otherStorage(), objectPath, "application/pdf"));
        await assertFails(read(anonymousStorage(), objectPath));
      }
    });

    await test("Career object paths cannot claim a missing, mismatched, or invalid item identity", async () => {
      await seedFirestore("career_projects/foreign", { uid: OTHER_UID, visibility: "public" });
      await assertFails(put(ownerStorage(), `career/${OWNER_UID}/career_projects/missing/asset`, "application/pdf"));
      await assertFails(put(ownerStorage(), `career/${OWNER_UID}/career_projects/foreign/asset`, "application/pdf"));
      await assertFails(put(ownerStorage(), `career/${OWNER_UID}/unknown_collection/item/asset`, "application/pdf"));
      await assertFails(put(ownerStorage(), `career/${OWNER_UID}/career_projects/foreign/bad.name`, "application/pdf"));
    });

    for (const globalVisibility of ["private", "connections", "public"]) {
      for (const itemVisibility of ["private", "connections", "public"]) {
        await test(`Career Storage matrix: global ${globalVisibility}, item ${itemVisibility}`, async () => {
          await seedFirestore(`friendships/${OWNER_UID}/friends/${CONNECTION_UID}`, { friendUid: CONNECTION_UID });
          await seedFirestore(`career_projects/item`, {
            uid: OWNER_UID,
            visibility: itemVisibility,
            careerVisibility: globalVisibility,
            careerPolicyVersion: 1,
          });
          const objectPath = `career/${OWNER_UID}/career_projects/item/asset`;
          await seedObject(objectPath, "application/pdf");
          await assertSucceeds(read(ownerStorage(), objectPath));
          const connectionAllowed = globalVisibility !== "private" && itemVisibility !== "private";
          await (connectionAllowed ? assertSucceeds : assertFails)(read(connectionStorage(true), objectPath));
          const publicAllowed = globalVisibility === "public" && itemVisibility === "public";
          await (publicAllowed ? assertSucceeds : assertFails)(read(connectionStorage(false), objectPath));
          await (publicAllowed ? assertSucceeds : assertFails)(read(anonymousStorage(), objectPath));
          await (publicAllowed ? assertSucceeds : assertFails)(read(otherStorage(), objectPath));
        });
      }
    }

    await test("Career Storage missing or invalid global policy fails closed", async () => {
      for (const value of [undefined, "everyone"]) {
        const item = { uid: OWNER_UID, visibility: "public", careerPolicyVersion: 1 };
        if (value !== undefined) item.careerVisibility = value;
        await seedFirestore(`career_projects/item`, item);
        const objectPath = `career/${OWNER_UID}/career_projects/item/resume`;
        await seedObject(objectPath, "application/pdf");
        await assertFails(read(anonymousStorage(), objectPath));
        await assertFails(read(connectionStorage(true), objectPath));
        await testEnv.clearFirestore();
        await testEnv.clearStorage();
      }
    });

    for (const [from, to] of [
      ["public", "private"], ["public", "connections"], ["connections", "private"],
      ["private", "public"], ["private", "connections"],
    ]) {
      await test(`Career canonical object follows Firestore item visibility ${from} -> ${to}`, async () => {
        await seedFirestore(`friendships/${OWNER_UID}/friends/${CONNECTION_UID}`, { friendUid: CONNECTION_UID });
        await seedFirestore(`career_projects/item`, {
          uid: OWNER_UID, visibility: from, careerVisibility: "public", careerPolicyVersion: 1,
        });
        const objectPath = `career/${OWNER_UID}/career_projects/item/asset`;
        await seedObject(objectPath, "application/pdf");

        await assertSucceeds(read(ownerStorage(), objectPath));
        await seedFirestore(`career_projects/item`, {
          uid: OWNER_UID, visibility: to, careerVisibility: "public", careerPolicyVersion: 1,
        });
        const anonymousAllowed = to === "public";
        const connectionAllowed = to === "public" || to === "connections";
        await (anonymousAllowed ? assertSucceeds : assertFails)(read(anonymousStorage(), objectPath));
        await (connectionAllowed ? assertSucceeds : assertFails)(read(connectionStorage(true), objectPath));
        await (anonymousAllowed ? assertSucceeds : assertFails)(read(connectionStorage(false), objectPath));
        await (anonymousAllowed ? assertSucceeds : assertFails)(read(otherStorage(), objectPath));
      });
    }

    await test("Career global policy snapshots govern the same canonical object across transitions", async () => {
      await seedFirestore(`friendships/${OWNER_UID}/friends/${CONNECTION_UID}`, { friendUid: CONNECTION_UID });
      const objectPath = `career/${OWNER_UID}/career_projects/item/asset`;
      await seedObject(objectPath, "application/pdf");
      for (const [version, globalVisibility, anonymousAllowed, connectionAllowed] of [
        [1, "public", true, true],
        [2, "connections", false, true],
        [3, "private", false, false],
        [4, "public", true, true],
        [5, "connections", false, true],
      ]) {
        await seedFirestore(`career_projects/item`, {
          uid: OWNER_UID,
          visibility: "public",
          careerVisibility: globalVisibility,
          careerPolicyVersion: version,
        });
        await (anonymousAllowed ? assertSucceeds : assertFails)(read(anonymousStorage(), objectPath));
        await (connectionAllowed ? assertSucceeds : assertFails)(read(connectionStorage(true), objectPath));
      }
    });

    await test("Career connection authorization is live and revocation fails closed", async () => {
      await seedFirestore(`career_projects/item`, {
        uid: OWNER_UID,
        visibility: "connections",
        careerVisibility: "connections",
        careerPolicyVersion: 7,
      });
      await seedFirestore(`friendships/${OWNER_UID}/friends/${CONNECTION_UID}`, { friendUid: CONNECTION_UID });
      const objectPath = `career/${OWNER_UID}/career_projects/item/asset`;
      await seedObject(objectPath, "application/pdf");
      await assertSucceeds(read(connectionStorage(true), objectPath));
      await assertFails(read(connectionStorage(false), objectPath));
      await assertFails(read(otherStorage(), objectPath));
      await assertSucceeds(deleteDoc(doc(
        context(CONNECTION_UID, CONNECTION_EMAIL, true).firestore(),
        "friendships", OWNER_UID, "friends", CONNECTION_UID
      )));
      await assertFails(read(connectionStorage(true), objectPath));
    });

    await test("asymmetric prune plus old accepted request cannot restore Career Storage access", async () => {
      const objectPath = `career/${OWNER_UID}/career_projects/item/asset`;
      await seedFirestore("career_projects/item", {
        uid: OWNER_UID, visibility: "connections",
        careerVisibility: "connections", careerPolicyVersion: 8,
      });
      await seedObject(objectPath, "application/pdf");
      for (const actorIsOwner of [true, false]) {
        await seedFirestore(`friend_requests/${CONNECTION_UID}/incoming/${OWNER_UID}`, {
          fromUid: OWNER_UID, toUid: CONNECTION_UID, status: "accepted",
          fromDisplayName: "Owner", fromUsername: null, fromPhotoURL: null,
          createdAt: new Date(), updatedAt: new Date(),
        });
        await seedFirestore(`friendships/${OWNER_UID}/friends/${CONNECTION_UID}`, {
          uid: OWNER_UID, friendUid: CONNECTION_UID,
        });
        await seedFirestore(`friendships/${CONNECTION_UID}/friends/${OWNER_UID}`, {
          uid: CONNECTION_UID, friendUid: OWNER_UID,
        });
        await assertSucceeds(read(connectionStorage(true), objectPath));

        const missingPath = actorIsOwner
          ? `friendships/${CONNECTION_UID}/friends/${OWNER_UID}`
          : `friendships/${OWNER_UID}/friends/${CONNECTION_UID}`;
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          await deleteDoc(doc(ctx.firestore(), missingPath));
        });
        const actorDb = actorIsOwner
          ? context(OWNER_UID, OWNER_EMAIL).firestore()
          : context(CONNECTION_UID, CONNECTION_EMAIL).firestore();
        const batch = writeBatch(actorDb);
        batch.update(doc(actorDb, "friend_requests", CONNECTION_UID, "incoming", OWNER_UID), {
          status: "cancelled", updatedAt: serverTimestamp(),
        });
        batch.delete(doc(actorDb, "friendships", OWNER_UID, "friends", CONNECTION_UID));
        batch.delete(doc(actorDb, "friendships", CONNECTION_UID, "friends", OWNER_UID));
        await assertSucceeds(batch.commit());
        await assertFails(setDoc(doc(context(OWNER_UID, OWNER_EMAIL).firestore(),
          "friendships", OWNER_UID, "friends", CONNECTION_UID), {
          uid: OWNER_UID, friendUid: CONNECTION_UID, createdAt: serverTimestamp(),
        }));
        await assertFails(read(connectionStorage(true), objectPath));
      }
    });

    await test("Career canonical read cannot cross the item owner's UID path", async () => {
      await seedFirestore(`career_projects/item`, {
        uid: OTHER_UID,
        visibility: "public",
        careerVisibility: "public",
        careerPolicyVersion: 1,
      });
      const forgedPath = `career/${OWNER_UID}/career_projects/item/asset`;
      await seedObject(forgedPath, "application/pdf");
      await assertFails(read(anonymousStorage(), forgedPath));
      await assertFails(read(connectionStorage(true), forgedPath));
      await assertFails(read(ownerStorage(), forgedPath));
    });

    await test("legacy Career visibility paths never bypass current Firestore state", async () => {
      await seedFirestore(`public_profiles/${OWNER_UID}`, {
        uid: OWNER_UID, role: "owner", careerVisibility: "public",
      });
      await seedFirestore(`career_projects/item`, { uid: OWNER_UID, visibility: "public" });
      const oldPath = `career/${OWNER_UID}/public/projects/images/old.png`;
      await seedObject(oldPath);
      await assertSucceeds(read(ownerStorage(), oldPath));
      await assertFails(read(anonymousStorage(), oldPath));
      await assertFails(read(connectionStorage(true), oldPath));
    });
  } finally {
    await testEnv.cleanup();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

run().catch((error) => {
  console.error("[storage-rules.test.js] unexpected failure:", error);
  process.exitCode = 1;
});
