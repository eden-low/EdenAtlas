if (!process.env.FIRESTORE_EMULATOR_HOST
    || !/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST)) {
  console.error("[google-calendar-rules.test.js] Run only through npm run test:firestore-rules.");
  process.exit(1);
}

const fs = require("node:fs");
const path = require("node:path");
const { initializeTestEnvironment, assertFails } = require("@firebase/rules-unit-testing");
const { doc, setDoc, getDoc, updateDoc, deleteDoc } = require("firebase/firestore");

const PROJECT_ID = "demo-edenatlas-discover-rules";
let testEnv;
let passed = 0;
let failed = 0;

function dbFor(uid) {
  return uid
    ? testEnv.authenticatedContext(uid, { email: `${uid}@example.com` }).firestore()
    : testEnv.unauthenticatedContext().firestore();
}

async function seed(pathName, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => setDoc(doc(ctx.firestore(), pathName), data));
}

async function test(name, fn) {
  await testEnv.clearFirestore();
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  - ${name}`);
    console.log(`        ${err && err.message ? err.message : err}`);
  }
}

async function assertCollectionDenied(collectionName) {
  await seed(`${collectionName}/server-record`, { uid: "owner", secret: "server-only" });
  for (const db of [dbFor(null), dbFor("owner"), dbFor("other")]) {
    const existing = doc(db, collectionName, "server-record");
    const fresh = doc(db, collectionName, "client-write");
    await assertFails(getDoc(existing));
    await assertFails(setDoc(fresh, { uid: "owner" }));
    await assertFails(updateDoc(existing, { status: "tampered" }));
    await assertFails(deleteDoc(existing));
  }
}

async function run() {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: fs.readFileSync(path.resolve(__dirname, "..", "..", "firestore.rules"), "utf8") },
  });
  try {
    await test("all browser access to Google Calendar connections is denied", async () => {
      await assertCollectionDenied("google_calendar_connections");
    });
    await test("all browser access to Google Calendar OAuth state is denied", async () => {
      await assertCollectionDenied("google_calendar_oauth_states");
    });
    await test("all browser access to server-owned canonical Calendar events is denied", async () => {
      await assertCollectionDenied("calendar_events");
    });
  } finally {
    await testEnv.cleanup();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

run().catch((err) => {
  console.error("[google-calendar-rules.test.js] unexpected failure:", err);
  process.exitCode = 1;
});
