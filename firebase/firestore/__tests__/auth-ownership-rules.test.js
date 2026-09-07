// Emulator-backed authentication/ownership hardening tests. This file refuses any non-loopback
// Firestore endpoint, so it can never contact the production project.

if (!process.env.FIRESTORE_EMULATOR_HOST
    || !/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST)) {
  console.error("[auth-ownership-rules.test.js] Run only through npm run test:firestore-rules.");
  process.exit(1);
}

const fs = require("node:fs");
const path = require("node:path");
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require("@firebase/rules-unit-testing");
const {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  serverTimestamp,
  Timestamp,
} = require("firebase/firestore");

const PROJECT_ID = "demo-edenatlas-discover-rules";
const OWNER_UID = "auth-owner";
const OWNER_EMAIL = "jjun8647@gmail.com";
const OTHER_UID = "auth-other";
const OTHER_EMAIL = "other@example.com";
let testEnv;
let pass = 0;
let fail = 0;

function context(uid, email) {
  return uid == null
    ? testEnv.unauthenticatedContext()
    : testEnv.authenticatedContext(uid, { email });
}
function ownerDb() { return context(OWNER_UID, OWNER_EMAIL).firestore(); }
function otherDb() { return context(OTHER_UID, OTHER_EMAIL).firestore(); }
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
      "time_capsules", "daily_reflections", "photos",
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
