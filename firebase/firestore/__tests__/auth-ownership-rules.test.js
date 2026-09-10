// Emulator-backed authentication/ownership hardening tests. This file refuses any non-loopback
// Firestore endpoint, so it can never contact the production project.

if (!process.env.FIRESTORE_EMULATOR_HOST
    || !/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST)) {
  console.error("[auth-ownership-rules.test.js] Run only through npm run test:firestore-rules.");
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
const {
  collection,
  query,
  where,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  deleteField,
  serverTimestamp,
  Timestamp,
  writeBatch,
} = require("firebase/firestore");

const PROJECT_ID = "demo-edenatlas-discover-rules";
const OWNER_UID = "auth-owner";
const OWNER_EMAIL = "jjun8647@gmail.com";
const OTHER_UID = "auth-other";
const OTHER_EMAIL = "other@example.com";
const FRIEND_UID = "auth-friend";
const FRIEND_EMAIL = "friend@example.com";
const CONNECTION_UID = "auth-connection";
const CONNECTION_EMAIL = "connection@example.com";
let testEnv;
let pass = 0;
let fail = 0;

function context(uid, email, emailVerified = true) {
  return uid == null
    ? testEnv.unauthenticatedContext()
    : testEnv.authenticatedContext(uid, { email, email_verified: emailVerified });
}
function ownerDb() { return context(OWNER_UID, OWNER_EMAIL).firestore(); }
function otherDb() { return context(OTHER_UID, OTHER_EMAIL).firestore(); }
function friendDb(verified = true) { return context(FRIEND_UID, FRIEND_EMAIL, verified).firestore(); }
function connectionDb(verified = true) { return context(CONNECTION_UID, CONNECTION_EMAIL, verified).firestore(); }
function signedOutDb() { return context(null).firestore(); }

async function seed(pathName, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), pathName), data);
  });
}

async function test(name, fn) {
  await testEnv.clearFirestore();
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

function privateUser(uid = OWNER_UID, email = OWNER_EMAIL, role = "owner") {
  return {
    uid,
    email,
    role,
    displayName: "Test User",
    photoURL: "",
    createdAt: serverTimestamp(),
  };
}

function ownedEntity(uid = OWNER_UID) {
  return { uid, title: "Original", visibility: "private" };
}

function requestPayload(fromUid, toUid) {
  return {
    fromUid,
    toUid,
    status: "pending",
    fromDisplayName: "Sender",
    fromUsername: "sender",
    fromPhotoURL: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function crossNotification(uid, fromUid, type) {
  return {
    uid,
    fromUid,
    type,
    title: "Connection update",
    message: "Connection state changed.",
    read: false,
    createdAt: serverTimestamp(),
  };
}

function legacyCapsule(overrides = {}) {
  return {
    uid: OWNER_UID,
    title: "Legacy note",
    message: "Legacy message",
    openAt: Timestamp.fromDate(new Date(Date.now() - 60_000)),
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    status: "sealed",
    visibility: "private",
    attachmentUrl: null,
    attachmentType: null,
    ...overrides,
  };
}

async function run() {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "firestore.rules"), "utf8") },
  });

  try {
    await test("unauthenticated callers cannot read a private user document", async () => {
      await seed(`users/${OWNER_UID}`, { ...privateUser(), createdAt: Timestamp.now() });
      await assertFails(getDoc(doc(signedOutDb(), "users", OWNER_UID)));
    });

    await test("a user can create and read their own private user document", async () => {
      const ref = doc(ownerDb(), "users", OWNER_UID);
      await assertSucceeds(setDoc(ref, privateUser()));
      await assertSucceeds(getDoc(ref));
    });

    await test("a user cannot read another user document or list the private users collection", async () => {
      await seed(`users/${OWNER_UID}`, { ...privateUser(), createdAt: Timestamp.now() });
      await assertFails(getDoc(doc(otherDb(), "users", OWNER_UID)));
      await assertFails(getDocs(collection(otherDb(), "users")));
    });

    await test("a user cannot write another user document or self-assign owner role/email", async () => {
      await assertFails(setDoc(doc(otherDb(), "users", OWNER_UID), privateUser(OWNER_UID, OTHER_EMAIL, "viewer")));
      await assertFails(setDoc(doc(otherDb(), "users", OTHER_UID), privateUser(OTHER_UID, OTHER_EMAIL, "owner")));
      await assertFails(setDoc(doc(otherDb(), "users", OTHER_UID), privateUser(OTHER_UID, OWNER_EMAIL, "viewer")));
    });

    await test("private user identity fields stay token-derived and unknown fields cannot be injected", async () => {
      await seed(`users/${OTHER_UID}`, {
        ...privateUser(OTHER_UID, OTHER_EMAIL, "viewer"),
        createdAt: Timestamp.now(),
      });
      const ref = doc(otherDb(), "users", OTHER_UID);
      await assertSucceeds(updateDoc(ref, { displayName: "Updated" }));
      await assertFails(updateDoc(ref, { role: "owner" }));
      await assertFails(updateDoc(ref, { email: OWNER_EMAIL }));
      await assertFails(updateDoc(ref, { refreshToken: "must-not-be-stored" }));
    });

    await test("public profiles are world-readable and accept only the confirmed presentation schema", async () => {
      await assertSucceeds(setDoc(doc(otherDb(), "public_profiles", OTHER_UID), {
        uid: OTHER_UID,
        displayName: "Other",
        username: "other_user",
        photoURL: "",
        bio: "Public bio",
        location: "Kuala Lumpur",
        careerVisibility: "public",
        role: "viewer",
        createdAt: serverTimestamp(),
      }));
      await assertSucceeds(getDoc(doc(signedOutDb(), "public_profiles", OTHER_UID)));
    });

    await test("private/auth/admin fields cannot be injected into a public profile", async () => {
      for (const field of ["email", "admin", "isAdmin", "authMetadata", "refreshToken"]) {
        await assertFails(setDoc(doc(otherDb(), "public_profiles", OTHER_UID), {
          uid: OTHER_UID,
          displayName: "Other",
          role: "viewer",
          [field]: "not-public",
        }));
      }
    });

    await test("a public profile cannot claim another uid or elevate its directory role", async () => {
      await assertFails(setDoc(doc(otherDb(), "public_profiles", OTHER_UID), {
        uid: OWNER_UID, displayName: "Other", role: "viewer",
      }));
      await assertFails(setDoc(doc(otherDb(), "public_profiles", OTHER_UID), {
        uid: OTHER_UID, displayName: "Other", role: "owner",
      }));
    });

    await test("a public profile update cannot add or change private fields", async () => {
      await seed(`public_profiles/${OTHER_UID}`, {
        uid: OTHER_UID, displayName: "Other", role: "viewer",
      });
      const ref = doc(otherDb(), "public_profiles", OTHER_UID);
      await assertSucceeds(updateDoc(ref, { displayName: "Updated" }));
      await assertFails(updateDoc(ref, { email: OTHER_EMAIL }));
      await assertFails(updateDoc(ref, { role: "owner" }));
    });

    const entityCollections = [
      "journals", "life_events", "habits", "collections", "goals",
      "daily_reflections", "photos",
    ];
    for (const name of entityCollections) {
      await test(`${name}: owner create and same-uid update succeed`, async () => {
        const ref = doc(ownerDb(), name, "owned");
        await assertSucceeds(setDoc(ref, ownedEntity()));
        await assertSucceeds(updateDoc(ref, { title: "Updated" }));
      });

      await test(`${name}: owner cannot change uid and another user cannot update`, async () => {
        await seed(`${name}/owned`, ownedEntity());
        await assertFails(updateDoc(doc(ownerDb(), name, "owned"), { uid: OTHER_UID }));
        await assertFails(updateDoc(doc(otherDb(), name, "owned"), { title: "Taken" }));
      });
    }

    await test("verified whitelist friend may create all six friend-space entities", async () => {
      await seed(`friends/${FRIEND_EMAIL}`, { addedBy: OWNER_EMAIL, addedAt: Timestamp.now() });
      for (const name of ["goals", "journals", "life_events", "habits", "collections", "photos"]) {
        await assertSucceeds(setDoc(doc(friendDb(true), name, `friend-${name}`), ownedEntity(FRIEND_UID)));
      }
    });

    await test("unverified same-email whitelist friend is denied on all six friend-space creates", async () => {
      await seed(`friends/${FRIEND_EMAIL}`, { addedBy: OWNER_EMAIL, addedAt: Timestamp.now() });
      for (const name of ["goals", "journals", "life_events", "habits", "collections", "photos"]) {
        await assertFails(setDoc(doc(friendDb(false), name, `friend-${name}`), ownedEntity(FRIEND_UID)));
      }
    });

    await test("unverified whitelist identity cannot persist a privileged friend role", async () => {
      await seed(`friends/${FRIEND_EMAIL}`, { addedBy: OWNER_EMAIL, addedAt: Timestamp.now() });
      await assertFails(setDoc(doc(friendDb(false), "users", FRIEND_UID),
        privateUser(FRIEND_UID, FRIEND_EMAIL, "friend")));
      await assertFails(setDoc(doc(friendDb(false), "public_profiles", FRIEND_UID), {
        uid: FRIEND_UID, displayName: "Friend", role: "friend",
      }));
    });

    await test("friends self-read requires a verified email claim", async () => {
      await seed(`friends/${FRIEND_EMAIL}`, { addedBy: OWNER_EMAIL, addedAt: Timestamp.now() });
      await assertSucceeds(getDoc(doc(friendDb(true), "friends", FRIEND_EMAIL)));
      await assertSucceeds(getDoc(doc(context(FRIEND_UID, "Friend@Example.com", true).firestore(), "friends", FRIEND_EMAIL)));
      await assertFails(getDoc(doc(friendDb(false), "friends", FRIEND_EMAIL)));
    });

    await test("accepted UID connection shared read requires verified email", async () => {
      await seed(`friendships/${OWNER_UID}/friends/${CONNECTION_UID}`, { friendUid: CONNECTION_UID });
      await seed("journals/shared", { uid: OWNER_UID, title: "Shared", visibility: "connections" });
      await assertSucceeds(getDoc(doc(connectionDb(true), "journals", "shared")));
      await assertFails(getDoc(doc(connectionDb(false), "journals", "shared")));
    });

    await test("unverified Owner email cannot use email-derived Owner powers", async () => {
      const unverifiedOwner = context(OWNER_UID, OWNER_EMAIL, false).firestore();
      await assertFails(setDoc(doc(unverifiedOwner, "goals", "unverified-owner"), ownedEntity()));
      await assertFails(setDoc(doc(unverifiedOwner, "users", OWNER_UID), privateUser()));
      await assertFails(getDocs(collection(unverifiedOwner, "login_logs")));
      await assertSucceeds(getDoc(doc(ownerDb(), "friends", FRIEND_EMAIL)));
    });

    await test("time capsule schema, immutable identity, and due-time opening are enforced", async () => {
      const capsuleRef = doc(ownerDb(), "time_capsules", "capsule");
      const openAt = Timestamp.fromDate(new Date(Date.now() - 60_000));
      await assertSucceeds(setDoc(capsuleRef, {
        uid: OWNER_UID,
        title: "Future note",
        message: "Remember this",
        openAt,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        status: "sealed",
        visibility: "private",
        attachmentPath: `capsules/${OWNER_UID}/capsule`,
        attachmentType: "image",
      }));
      await assertSucceeds(updateDoc(capsuleRef, { status: "opened", updatedAt: serverTimestamp() }));
      await assertFails(updateDoc(capsuleRef, { uid: OTHER_UID, updatedAt: serverTimestamp() }));
      await assertFails(updateDoc(capsuleRef, { visibility: "public", updatedAt: serverTimestamp() }));
      await assertFails(updateDoc(capsuleRef, { attachmentPath: `capsules/${OWNER_UID}/other-capsule`, updatedAt: serverTimestamp() }));
    });

    await test("time capsule rejects unsafe schema, attachment paths, and premature opening", async () => {
      const base = {
        uid: OWNER_UID,
        title: "Future note",
        message: "Remember this",
        openAt: Timestamp.fromDate(new Date(Date.now() + 86_400_000)),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        status: "sealed",
        visibility: "private",
        attachmentPath: null,
        attachmentType: null,
      };
      await assertFails(setDoc(doc(ownerDb(), "time_capsules", "extra"), { ...base, attachmentUrl: "javascript:alert(1)" }));
      await assertFails(setDoc(doc(ownerDb(), "time_capsules", "bad-path"), { ...base, attachmentPath: `capsules/${OTHER_UID}/file`, attachmentType: "file" }));
      await seed("time_capsules/not-due", {
        ...base, createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
      });
      await assertFails(updateDoc(doc(ownerDb(), "time_capsules", "not-due"), { status: "opened", updatedAt: serverTimestamp() }));
    });

    await test("legacy capsule without an attachment migrates once to the exact canonical schema", async () => {
      await seed("time_capsules/legacy-empty", legacyCapsule());
      const ref = doc(ownerDb(), "time_capsules", "legacy-empty");
      await assertSucceeds(updateDoc(ref, {
        attachmentUrl: deleteField(),
        attachmentPath: null,
        attachmentType: null,
        updatedAt: serverTimestamp(),
      }));
      const migrated = await getDoc(ref);
      assert.strictEqual(migrated.data().attachmentPath, null);
      assert.strictEqual(Object.hasOwn(migrated.data(), "attachmentUrl"), false);
      await assertFails(updateDoc(ref, { attachmentUrl: "https://attacker.example/file", updatedAt: serverTimestamp() }));
    });

    await test("legacy capsule with a valid own Storage locator can migrate to only its document-bound path", async () => {
      await seed("time_capsules/legacy-file", legacyCapsule({
        attachmentUrl: "https://firebasestorage.googleapis.com/v0/b/lfj-profolio.firebasestorage.app/o/capsules%2Fauth-owner%2Fold-file.pdf?alt=media&token=legacy",
        attachmentType: "file",
      }));
      const ref = doc(ownerDb(), "time_capsules", "legacy-file");
      await assertFails(updateDoc(ref, {
        attachmentUrl: deleteField(),
        attachmentPath: `capsules/${OWNER_UID}/attacker-chosen`,
        attachmentType: "file",
        updatedAt: serverTimestamp(),
      }));
      await assertSucceeds(updateDoc(ref, {
        attachmentUrl: deleteField(),
        attachmentPath: `capsules/${OWNER_UID}/legacy-file`,
        attachmentType: "file",
        updatedAt: serverTimestamp(),
      }));
    });

    await test("malformed or external legacy URLs cannot persist or become a canonical path escalation", async () => {
      for (const [id, attachmentUrl] of [
        ["legacy-malformed", "javascript:alert(1)"],
        ["legacy-external", "https://attacker.example/private.pdf"],
      ]) {
        await seed(`time_capsules/${id}`, legacyCapsule({ attachmentUrl, attachmentType: "file" }));
        const ref = doc(ownerDb(), "time_capsules", id);
        await assertFails(updateDoc(ref, {
          attachmentUrl,
          attachmentPath: `capsules/${OWNER_UID}/${id}`,
          attachmentType: "file",
          updatedAt: serverTimestamp(),
        }));
        await assertSucceeds(updateDoc(ref, {
          attachmentUrl: deleteField(),
          attachmentPath: null,
          attachmentType: null,
          updatedAt: serverTimestamp(),
        }));
      }
    });

    await test("legacy capsules retain bounded open, edit, and delete lifecycles", async () => {
      await seed("time_capsules/legacy-open", legacyCapsule());
      await assertSucceeds(updateDoc(doc(ownerDb(), "time_capsules", "legacy-open"), {
        status: "opened",
        attachmentUrl: deleteField(),
        attachmentPath: null,
        attachmentType: null,
        updatedAt: serverTimestamp(),
      }));
      await seed("time_capsules/legacy-edit", legacyCapsule());
      await assertSucceeds(updateDoc(doc(ownerDb(), "time_capsules", "legacy-edit"), {
        title: "Edited safely",
        attachmentUrl: deleteField(),
        attachmentPath: null,
        attachmentType: null,
        updatedAt: serverTimestamp(),
      }));
      await seed("time_capsules/legacy-delete", legacyCapsule({ attachmentUrl: "not-a-url", attachmentType: "file" }));
      await assertSucceeds(deleteDoc(doc(ownerDb(), "time_capsules", "legacy-delete")));
      await assertFails(deleteDoc(doc(otherDb(), "time_capsules", "legacy-edit")));
    });

    await test("login_logs accept only exact token-bound server-timestamped records", async () => {
      const valid = {
        uid: OTHER_UID,
        email: OTHER_EMAIL,
        loginTime: serverTimestamp(),
        device: "Test Browser",
        page: "login",
      };
      await assertSucceeds(setDoc(doc(otherDb(), "login_logs", "valid"), valid));
      await assertFails(setDoc(doc(otherDb(), "login_logs", "spoof-email"), { ...valid, email: OWNER_EMAIL }));
      await assertFails(setDoc(doc(otherDb(), "login_logs", "spoof-uid"), { ...valid, uid: OWNER_UID }));
      await assertFails(setDoc(doc(otherDb(), "login_logs", "bad-time"), { ...valid, loginTime: Timestamp.now() }));
      await assertFails(setDoc(doc(otherDb(), "login_logs", "extra"), { ...valid, token: "no" }));
      await assertFails(setDoc(doc(otherDb(), "login_logs", "missing"), { uid: OTHER_UID, email: OTHER_EMAIL }));
      await assertFails(setDoc(doc(otherDb(), "login_logs", "wrong-email-type"), { ...valid, email: 42 }));
      await assertFails(setDoc(doc(otherDb(), "login_logs", "wrong-device-type"), { ...valid, device: ["browser"] }));
      await assertFails(setDoc(doc(otherDb(), "login_logs", "wrong-page"), { ...valid, page: "settings" }));
      const longEmail = `${"a".repeat(245)}@example.com`;
      const longEmailDb = context("long-email-user", longEmail, true).firestore();
      await assertFails(setDoc(doc(longEmailDb, "login_logs", "long-email"), {
        ...valid, uid: "long-email-user", email: longEmail,
      }));
      await assertFails(setDoc(doc(otherDb(), "login_logs", "long-device"), { ...valid, device: "x".repeat(513) }));
      await assertFails(updateDoc(doc(otherDb(), "login_logs", "valid"), { device: "Changed" }));
      await assertFails(deleteDoc(doc(otherDb(), "login_logs", "valid")));
    });

    const careerCollections = [
      "career_experiences", "career_projects", "career_certificates", "career_awards",
    ];
    for (const globalVisibility of ["private", "connections", "public"]) {
      for (const itemVisibility of ["private", "connections", "public"]) {
        await test(`Career matrix: global ${globalVisibility}, item ${itemVisibility}`, async () => {
          await seed(`public_profiles/${OWNER_UID}`, {
            uid: OWNER_UID, role: "owner", careerVisibility: globalVisibility,
          });
          await seed(`friendships/${OWNER_UID}/friends/${CONNECTION_UID}`, { friendUid: CONNECTION_UID });
          for (const name of careerCollections) {
            await seed(`${name}/item`, { uid: OWNER_UID, title: name, visibility: itemVisibility });
            const refFor = (db) => doc(db, name, "item");
            await assertSucceeds(getDoc(refFor(ownerDb())));
            const connectionAllowed = globalVisibility !== "private" && itemVisibility !== "private";
            await (connectionAllowed ? assertSucceeds : assertFails)(getDoc(refFor(connectionDb(true))));
            const publicAllowed = globalVisibility === "public" && itemVisibility === "public";
            // An unverified accepted connection receives no connection privilege, but remains an
            // ordinary public viewer when both global and item policy are public.
            await (publicAllowed ? assertSucceeds : assertFails)(getDoc(refFor(connectionDb(false))));
            await (publicAllowed ? assertSucceeds : assertFails)(getDoc(refFor(signedOutDb())));
            await (publicAllowed ? assertSucceeds : assertFails)(getDoc(refFor(otherDb())));
          }
        });
      }
    }

    await test("Career missing or invalid global policy fails closed for non-owners", async () => {
      for (const value of [undefined, "everyone"]) {
        const profile = { uid: OWNER_UID, role: "owner" };
        if (value !== undefined) profile.careerVisibility = value;
        await seed(`public_profiles/${OWNER_UID}`, profile);
        await seed("career_projects/item", { uid: OWNER_UID, title: "Public", visibility: "public" });
        await assertFails(getDoc(doc(signedOutDb(), "career_projects", "item")));
        await assertFails(getDoc(doc(connectionDb(true), "career_projects", "item")));
        await testEnv.clearFirestore();
      }
    });

    await test("Career public and connection query shapes are Rules-compatible and UID-bound", async () => {
      await seed(`public_profiles/${OWNER_UID}`, {
        uid: OWNER_UID, role: "owner", careerVisibility: "public",
      });
      await seed("career_projects/public", { uid: OWNER_UID, title: "Public", visibility: "public" });
      await seed("career_projects/private", { uid: OWNER_UID, title: "Private", visibility: "private" });
      const ownerLookup = query(
        collection(signedOutDb(), "public_profiles"),
        where("role", "==", "owner"),
        where("careerVisibility", "==", "public")
      );
      await assertSucceeds(getDocs(ownerLookup));
      const publicQuery = query(
        collection(signedOutDb(), "career_projects"),
        where("uid", "==", OWNER_UID),
        where("visibility", "==", "public")
      );
      await assertSucceeds(getDocs(publicQuery));
      await assertFails(getDocs(query(
        collection(signedOutDb(), "career_projects"), where("visibility", "==", "public")
      )));
      await seed(`public_profiles/${OTHER_UID}`, {
        uid: OTHER_UID, role: "viewer", careerVisibility: "private",
      });
      await seed("career_projects/other-private", { uid: OTHER_UID, title: "Other", visibility: "private" });
      await assertFails(getDocs(query(
        collection(ownerDb(), "career_projects"), where("uid", "==", OTHER_UID)
      )));

      await seed(`friendships/${OWNER_UID}/friends/${CONNECTION_UID}`, { friendUid: CONNECTION_UID });
      await seed(`public_profiles/${OWNER_UID}`, {
        uid: OWNER_UID, role: "owner", careerVisibility: "connections",
      });
      await seed("career_projects/connections", { uid: OWNER_UID, title: "Shared", visibility: "connections" });
      for (const visibility of ["public", "connections"]) {
        await assertSucceeds(getDocs(query(
          collection(connectionDb(true), "career_projects"),
          where("uid", "==", OWNER_UID),
          where("visibility", "==", visibility)
        )));
      }
    });

    await test("Career writes stay verified-Owner-only and UID immutable", async () => {
      await seed(`public_profiles/${OWNER_UID}`, {
        uid: OWNER_UID, role: "owner", careerVisibility: "private", careerPolicyVersion: 1,
      });
      for (const name of careerCollections) {
        const ref = doc(ownerDb(), name, "owned-write");
        await assertSucceeds(setDoc(ref, {
          uid: OWNER_UID, title: name, visibility: "private",
          careerVisibility: "private", careerPolicyVersion: 1,
        }));
        await assertFails(updateDoc(ref, { uid: OTHER_UID }));
        await assertFails(setDoc(doc(ownerDb(), name, "foreign-write"), {
          uid: OTHER_UID, title: name, visibility: "public",
        }));
        await assertFails(setDoc(doc(otherDb(), name, "other-write"), {
          uid: OTHER_UID, title: name, visibility: "public",
        }));
      }
    });

    await test("Career policy snapshots match the effective profile and incomplete writes fail closed", async () => {
      const db = ownerDb();
      const profileRef = doc(db, "public_profiles", OWNER_UID);
      await seed(`public_profiles/${OWNER_UID}`, {
        uid: OWNER_UID,
        role: "owner",
        careerVisibility: "private",
        careerPolicyVersion: 1,
      });

      for (const name of careerCollections) {
        await assertSucceeds(setDoc(doc(db, name, `snapshot-${name}`), {
          uid: OWNER_UID,
          visibility: "public",
          careerVisibility: "private",
          careerPolicyVersion: 1,
        }));
        await assertFails(setDoc(doc(db, name, `mismatch-${name}`), {
          uid: OWNER_UID,
          visibility: "public",
          careerVisibility: "public",
          careerPolicyVersion: 1,
        }));
        await assertFails(setDoc(doc(db, name, `partial-${name}`), {
          uid: OWNER_UID,
          visibility: "private",
          careerVisibility: "private",
        }));
      }

      await assertFails(updateDoc(profileRef, { careerVisibility: "public" }));
      await assertFails(updateDoc(profileRef, { careerPolicyVersion: 2 }));
      await assertFails(updateDoc(profileRef, {
        careerVisibility: "public", careerPolicyVersion: 2,
      }));
      await assertFails(updateDoc(profileRef, { careerPolicyTransition: {
        id: "12345678-1234-1234-1234-123456789abc",
        ownerUid: OWNER_UID,
        secretHash: "a".repeat(64),
        sourceVisibility: "private", targetVisibility: "public",
        sourceVersion: 1, targetVersion: 2,
        createdAt: serverTimestamp(), expiresAt: serverTimestamp(),
      } }));

      // Simulate the Admin endpoint's acquired lock. Client rules cannot alter or remove it, and
      // every create/update/delete remains blocked until the server atomically finalizes.
      await seed(`public_profiles/${OWNER_UID}`, {
        uid: OWNER_UID, role: "owner", careerVisibility: "private", careerPolicyVersion: 1,
        careerPolicyTransition: {
          id: "12345678-1234-1234-1234-123456789abc",
          ownerUid: OWNER_UID,
          secretHash: "a".repeat(64),
          sourceVisibility: "private", targetVisibility: "public",
          sourceVersion: 1, targetVersion: 2,
          createdAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + 2 * 60 * 1000),
        },
      });
      await assertFails(updateDoc(doc(db, "career_projects", "snapshot-career_projects"), {
        title: "Blocked while policy snapshot set is locked",
      }));
      await assertFails(setDoc(doc(db, "career_projects", "concurrent-create"), {
        uid: OWNER_UID,
        visibility: "private",
      }));
      await assertFails(deleteDoc(doc(db, "career_projects", "snapshot-career_projects")));
      await assertFails(updateDoc(profileRef, { careerPolicyTransition: deleteField() }));
      const incompleteBatch = writeBatch(db);
      incompleteBatch.update(profileRef, {
        careerVisibility: "public",
        careerPolicyVersion: 2,
        careerPolicyTransition: deleteField(),
      });
      for (const name of careerCollections) {
        incompleteBatch.update(doc(db, name, `snapshot-${name}`), {
          careerVisibility: "public",
          careerPolicyVersion: 2,
        });
      }
      await assertFails(incompleteBatch.commit());

      // The Admin endpoint bypasses client Rules only after validating the complete set. Seed its
      // atomic result and prove ordinary writes now require that exact new snapshot.
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const adminBatch = writeBatch(ctx.firestore());
        adminBatch.set(doc(ctx.firestore(), "public_profiles", OWNER_UID), {
          uid: OWNER_UID, role: "owner", careerVisibility: "public", careerPolicyVersion: 2,
        });
        for (const name of careerCollections) adminBatch.update(doc(ctx.firestore(), name, `snapshot-${name}`), {
          careerVisibility: "public", careerPolicyVersion: 2,
        });
        await adminBatch.commit();
      });
      await assertSucceeds(updateDoc(doc(db, "career_projects", "snapshot-career_projects"), {
        title: "Allowed after complete server finalization",
      }));
      await assertFails(updateDoc(doc(db, "career_projects", "snapshot-career_projects"), {
        careerVisibility: "connections",
        careerPolicyVersion: 3,
      }));
    });

    await test("Career policy lock cannot be cleared or replaced by any browser client", async () => {
      const ref = doc(ownerDb(), "public_profiles", OWNER_UID);
      await seed(`public_profiles/${OWNER_UID}`, {
        uid: OWNER_UID,
        role: "owner",
        careerVisibility: "private",
        careerPolicyVersion: 1,
        careerPolicyTransition: {
          id: "stale-lock-12345678901234567890",
          ownerUid: OWNER_UID,
          secretHash: "b".repeat(64),
          sourceVisibility: "private", targetVisibility: "connections",
          sourceVersion: 1, targetVersion: 2,
          createdAt: Timestamp.fromMillis(Date.now() - 7 * 60 * 1000),
          expiresAt: Timestamp.fromMillis(Date.now() - 5 * 60 * 1000),
        },
        careerPolicyLastConsumed: {
          id: "consumed-12345678901234567890", ownerUid: OWNER_UID,
          secretHash: "d".repeat(64),
          sourceVisibility: "connections", targetVisibility: "private",
          sourceVersion: 0, targetVersion: 1,
          createdAt: Timestamp.fromMillis(Date.now() - 10 * 60 * 1000),
          expiresAt: Timestamp.fromMillis(Date.now() - 8 * 60 * 1000),
          consumedAt: Timestamp.fromMillis(Date.now() - 9 * 60 * 1000),
        },
      });
      await assertFails(updateDoc(ref, {
        careerPolicyTransition: {
          id: "replacement-12345678901234567890",
          ownerUid: OWNER_UID,
          secretHash: "c".repeat(64),
          sourceVisibility: "private", targetVisibility: "public",
          sourceVersion: 1, targetVersion: 2,
          createdAt: serverTimestamp(), expiresAt: serverTimestamp(),
        },
      }));
      await assertFails(updateDoc(ref, { careerPolicyTransition: deleteField() }));
      await assertFails(updateDoc(ref, { careerPolicyLastConsumed: deleteField() }));
      await assertFails(updateDoc(ref, {
        "careerPolicyLastConsumed.id": "forged-consumed-123456789012345",
      }));
      await assertFails(updateDoc(ref, {
        careerVisibility: "connections", careerPolicyVersion: 2,
        careerPolicyTransition: deleteField(),
      }));
      await assertSucceeds(updateDoc(ref, { displayName: "Presentation update remains allowed" }));
    });

    await test("Career owner policy initialization is server-only and starts from canonical version one", async () => {
      const ref = doc(ownerDb(), "public_profiles", OWNER_UID);
      await assertFails(setDoc(ref, {
        uid: OWNER_UID, role: "owner", careerVisibility: "public", careerPolicyVersion: 1,
      }));
      await assertFails(setDoc(ref, {
        uid: OWNER_UID, role: "owner", careerVisibility: "private", careerPolicyVersion: 99,
      }));
      await assertFails(setDoc(ref, {
        uid: OWNER_UID, role: "owner", careerVisibility: "private", careerPolicyVersion: 1,
      }));
      await assertSucceeds(setDoc(ref, { uid: OWNER_UID, role: "owner", displayName: "Owner" }));
      await assertFails(updateDoc(ref, {
        careerVisibility: "private", careerPolicyVersion: 1,
      }));
    });

    await test("friend removal atomically revokes accepted proof and both authorization mirrors", async () => {
      const db = ownerDb();
      const requestRef = doc(db, "friend_requests", CONNECTION_UID, "incoming", OWNER_UID);
      await seed(`friend_requests/${CONNECTION_UID}/incoming/${OWNER_UID}`, {
        fromUid: OWNER_UID,
        toUid: CONNECTION_UID,
        status: "accepted",
        fromDisplayName: "Owner",
        fromUsername: null,
        fromPhotoURL: null,
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      });
      await seed(`friendships/${OWNER_UID}/friends/${CONNECTION_UID}`, {
        uid: OWNER_UID, friendUid: CONNECTION_UID,
      });
      await seed(`friendships/${CONNECTION_UID}/friends/${OWNER_UID}`, {
        uid: CONNECTION_UID, friendUid: OWNER_UID,
      });

      const batch = writeBatch(db);
      batch.update(requestRef, { status: "cancelled", updatedAt: serverTimestamp() });
      batch.delete(doc(db, "friendships", OWNER_UID, "friends", CONNECTION_UID));
      batch.delete(doc(db, "friendships", CONNECTION_UID, "friends", OWNER_UID));
      await assertSucceeds(batch.commit());

      await assertFails(setDoc(doc(db, "friendships", OWNER_UID, "friends", CONNECTION_UID), {
        uid: OWNER_UID,
        friendUid: CONNECTION_UID,
        createdAt: serverTimestamp(),
      }));
    });

    await test("asymmetric prune in either direction cancels old proof; only fresh acceptance heals", async () => {
      for (const actorIsOwner of [true, false]) {
        await testEnv.clearFirestore();
        const requestPath = `friend_requests/${CONNECTION_UID}/incoming/${OWNER_UID}`;
        await seed(requestPath, {
          fromUid: OWNER_UID, toUid: CONNECTION_UID, status: "accepted",
          fromDisplayName: "Owner", fromUsername: null, fromPhotoURL: null,
          createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
        });
        const survivingUid = actorIsOwner ? OWNER_UID : CONNECTION_UID;
        const missingUid = actorIsOwner ? CONNECTION_UID : OWNER_UID;
        await seed(`friendships/${survivingUid}/friends/${missingUid}`, {
          uid: survivingUid, friendUid: missingUid,
        });

        const actorDb = actorIsOwner ? ownerDb() : connectionDb();
        const revoke = writeBatch(actorDb);
        revoke.update(doc(actorDb, requestPath), { status: "cancelled", updatedAt: serverTimestamp() });
        revoke.delete(doc(actorDb, "friendships", OWNER_UID, "friends", CONNECTION_UID));
        revoke.delete(doc(actorDb, "friendships", CONNECTION_UID, "friends", OWNER_UID));
        await assertSucceeds(revoke.commit());

        await assertFails(setDoc(doc(ownerDb(), "friendships", OWNER_UID, "friends", CONNECTION_UID), {
          uid: OWNER_UID, friendUid: CONNECTION_UID, createdAt: serverTimestamp(),
        }));
        await assertFails(setDoc(doc(connectionDb(), "friendships", CONNECTION_UID, "friends", OWNER_UID), {
          uid: CONNECTION_UID, friendUid: OWNER_UID, createdAt: serverTimestamp(),
        }));

        // A new sender reset plus a new recipient acceptance is the only legitimate reconstruction.
        await assertSucceeds(updateDoc(doc(ownerDb(), requestPath), { status: "pending", updatedAt: serverTimestamp() }));
        await assertSucceeds(updateDoc(doc(connectionDb(), requestPath), { status: "accepted", updatedAt: serverTimestamp() }));
        await assertSucceeds(setDoc(doc(ownerDb(), "friendships", OWNER_UID, "friends", CONNECTION_UID), {
          uid: OWNER_UID, friendUid: CONNECTION_UID, createdAt: serverTimestamp(),
        }));
        await assertSucceeds(setDoc(doc(connectionDb(), "friendships", CONNECTION_UID, "friends", OWNER_UID), {
          uid: CONNECTION_UID, friendUid: OWNER_UID, createdAt: serverTimestamp(),
        }));
      }
    });

    await test("photos: uid is authoritative when legacy uploadedBy conflicts", async () => {
      await seed("photos/conflict", {
        uid: OTHER_UID,
        uploadedBy: OWNER_UID,
        title: "Conflicting legacy owner",
        visibility: "private",
      });
      await assertFails(getDoc(doc(ownerDb(), "photos", "conflict")));
      await assertFails(updateDoc(doc(ownerDb(), "photos", "conflict"), { title: "Taken" }));
      await assertSucceeds(getDoc(doc(otherDb(), "photos", "conflict")));
    });

    await test("photos: a genuine uploadedBy-only legacy owner may edit but cannot add uid", async () => {
      await seed("photos/legacy", {
        uploadedBy: OWNER_UID,
        title: "Legacy",
        visibility: "private",
      });
      await assertSucceeds(updateDoc(doc(ownerDb(), "photos", "legacy"), { title: "Edited" }));
      await assertFails(updateDoc(doc(ownerDb(), "photos", "legacy"), { uid: OWNER_UID }));
    });

    await test("cross-user friend_request notification requires a real pending request", async () => {
      await assertFails(setDoc(doc(ownerDb(), "notifications", "spoofed"),
        crossNotification(OTHER_UID, OWNER_UID, "friend_request")));

      await assertSucceeds(setDoc(
        doc(ownerDb(), "friend_requests", OTHER_UID, "incoming", OWNER_UID),
        requestPayload(OWNER_UID, OTHER_UID)
      ));
      await assertSucceeds(setDoc(doc(ownerDb(), "notifications", "valid"),
        crossNotification(OTHER_UID, OWNER_UID, "friend_request")));
    });

    await test("friend_accepted notification requires the recipient to have accepted the request", async () => {
      await assertSucceeds(setDoc(
        doc(otherDb(), "friend_requests", OWNER_UID, "incoming", OTHER_UID),
        requestPayload(OTHER_UID, OWNER_UID)
      ));
      await assertFails(setDoc(doc(ownerDb(), "notifications", "too-early"),
        crossNotification(OTHER_UID, OWNER_UID, "friend_accepted")));
      await assertSucceeds(updateDoc(
        doc(ownerDb(), "friend_requests", OWNER_UID, "incoming", OTHER_UID),
        { status: "accepted", updatedAt: serverTimestamp() }
      ));
      await assertSucceeds(setDoc(doc(ownerDb(), "notifications", "accepted"),
        crossNotification(OTHER_UID, OWNER_UID, "friend_accepted")));
    });

    await test("notification owner may mark read but cannot change uid or other content", async () => {
      await seed("notifications/own", {
        uid: OWNER_UID,
        type: "login",
        title: "Login",
        message: "Signed in",
        read: false,
        createdAt: Timestamp.now(),
      });
      const ref = doc(ownerDb(), "notifications", "own");
      await assertSucceeds(updateDoc(ref, { read: true }));
      await assertFails(updateDoc(ref, { uid: OTHER_UID }));
      await assertFails(updateDoc(ref, { title: "Changed" }));
    });

    await test("usernames enforce document shape, ownership, and normalized id", async () => {
      await assertSucceeds(setDoc(doc(otherDb(), "usernames", "other.user"), {
        uid: OTHER_UID, createdAt: serverTimestamp(),
      }));
      await assertFails(setDoc(doc(otherDb(), "usernames", "Bad Name"), {
        uid: OTHER_UID, createdAt: serverTimestamp(),
      }));
      await assertFails(setDoc(doc(otherDb(), "usernames", "other_secret"), {
        uid: OTHER_UID, createdAt: serverTimestamp(), email: OTHER_EMAIL,
      }));
    });
  } finally {
    await testEnv.cleanup();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

run().catch((error) => {
  console.error("[auth-ownership-rules.test.js] unexpected failure:", error);
  process.exitCode = 1;
});
