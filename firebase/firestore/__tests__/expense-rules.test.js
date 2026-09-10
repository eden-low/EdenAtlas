// Emulator-backed tests for the canonical, Owner-only expenses schema. This suite refuses to run
// without a loopback Firestore Emulator so it can never reach a live project accidentally.

if (!process.env.FIRESTORE_EMULATOR_HOST
    || !/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST)) {
  console.error("[expense-rules.test.js] Run only through npm run test:firestore-rules.");
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
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  Timestamp,
} = require("firebase/firestore");

const PROJECT_ID = "demo-edenatlas-discover-rules";
const OWNER_EMAIL = "jjun8647@gmail.com";
const OWNER_UID = "expense-owner";
const OTHER_UID = "expense-other";
let testEnv;
let pass = 0;
let fail = 0;

function context(uid, email) {
  return uid == null
    ? testEnv.unauthenticatedContext()
    : testEnv.authenticatedContext(uid, { email, email_verified: true });
}
function ownerDb() { return context(OWNER_UID, OWNER_EMAIL).firestore(); }
function otherDb() { return context(OTHER_UID, "other@example.com").firestore(); }
function signedOutDb() { return context(null).firestore(); }

function validExpense(overrides = {}) {
  return {
    uid: OWNER_UID,
    amount: 12.30,
    currency: "MYR",
    category: "food",
    note: "Lunch",
    date: Timestamp.fromDate(new Date("2026-08-20T00:00:00Z")),
    createdAt: serverTimestamp(),
    collectionId: null,
    tags: ["meal"],
    locationName: null,
    latitude: null,
    longitude: null,
    ...overrides,
  };
}

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
  } catch (err) {
    fail++;
    console.log(`FAIL  - ${name}`);
    console.log(`        ${err && err.message ? err.message : err}`);
  }
}

async function run() {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "firestore.rules"), "utf8") },
  });
  try {
    await test("unauthenticated read is denied", async () => {
      await seed("expenses/owned", { ...validExpense(), createdAt: Timestamp.now() });
      await assertFails(getDoc(doc(signedOutDb(), "expenses/owned")));
    });

    await test("unauthenticated create is denied", async () => {
      await assertFails(setDoc(doc(signedOutDb(), "expenses/new"), validExpense()));
    });

    await test("Owner can create a canonical Expense with their own uid", async () => {
      await assertSucceeds(setDoc(doc(ownerDb(), "expenses/new"), validExpense()));
    });

    await test("cross-user create is denied", async () => {
      await assertFails(setDoc(doc(otherDb(), "expenses/new"), validExpense({ uid: OWNER_UID })));
    });

    await test("cross-user read, update, and delete are denied", async () => {
      await seed("expenses/owned", { ...validExpense(), createdAt: Timestamp.now() });
      const ref = doc(otherDb(), "expenses/owned");
      await assertFails(getDoc(ref));
      await assertFails(updateDoc(ref, { note: "stolen", updatedAt: serverTimestamp() }));
      await assertFails(deleteDoc(ref));
    });

    await test("Owner can update and delete their own Expense", async () => {
      await seed("expenses/owned", { ...validExpense(), createdAt: Timestamp.now() });
      const ref = doc(ownerDb(), "expenses/owned");
      await assertSucceeds(updateDoc(ref, { note: "Dinner", updatedAt: serverTimestamp() }));
      await assertSucceeds(deleteDoc(ref));
    });

    await test("uid mutation is denied", async () => {
      await seed("expenses/owned", { ...validExpense(), createdAt: Timestamp.now() });
      await assertFails(updateDoc(doc(ownerDb(), "expenses/owned"), { uid: OTHER_UID, updatedAt: serverTimestamp() }));
    });

    await test("createdAt is protected and updatedAt must be a fresh server timestamp", async () => {
      await seed("expenses/owned", { ...validExpense(), createdAt: Timestamp.now() });
      const ref = doc(ownerDb(), "expenses/owned");
      await assertFails(updateDoc(ref, { createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
      await assertFails(updateDoc(ref, { note: "missing updatedAt" }));
      await assertFails(updateDoc(ref, { note: "stale", updatedAt: Timestamp.fromMillis(1) }));
    });

    await test("malformed amounts are denied", async () => {
      await assertFails(setDoc(doc(ownerDb(), "expenses/zero"), validExpense({ amount: 0 })));
      await assertFails(setDoc(doc(ownerDb(), "expenses/string"), validExpense({ amount: "12.30" })));
      await assertFails(setDoc(doc(ownerDb(), "expenses/huge"), validExpense({ amount: 100000001 })));
    });

    await test("invalid category is denied", async () => {
      await assertFails(setDoc(doc(ownerDb(), "expenses/bad-category"), validExpense({ category: "travel" })));
    });

    await test("invalid currency is denied", async () => {
      await assertFails(setDoc(doc(ownerDb(), "expenses/bad-currency"), validExpense({ currency: "USD" })));
    });

    await test("missing required fields and malformed text/tags are denied", async () => {
      const missingDate = validExpense();
      delete missingDate.date;
      await assertFails(setDoc(doc(ownerDb(), "expenses/missing-date"), missingDate));
      await assertFails(setDoc(doc(ownerDb(), "expenses/long-note"), validExpense({ note: "x".repeat(241) })));
      await assertFails(setDoc(doc(ownerDb(), "expenses/bad-tags"), validExpense({ tags: [123] })));
    });

    await test("unexpected sensitive fields are denied on create and update", async () => {
      await assertFails(setDoc(doc(ownerDb(), "expenses/secret"), validExpense({ receiptStoragePath: "users/other/receipt.png" })));
      await seed("expenses/owned", { ...validExpense(), createdAt: Timestamp.now() });
      await assertFails(updateDoc(doc(ownerDb(), "expenses/owned"), { receiptStoragePath: "users/other/receipt.png", updatedAt: serverTimestamp() }));
    });

    await test("a legitimate legacy Expense can be read and upgraded without a migration", async () => {
      await seed("expenses/legacy", {
        uid: OWNER_UID,
        amount: 9.5,
        category: "other",
        note: "Legacy",
        createdAt: Timestamp.now(),
      });
      const ref = doc(ownerDb(), "expenses/legacy");
      await assertSucceeds(getDoc(ref));
      await assertSucceeds(updateDoc(ref, {
        currency: "MYR",
        date: Timestamp.fromDate(new Date("2026-08-19T00:00:00Z")),
        tags: [],
        collectionId: null,
        updatedAt: serverTimestamp(),
      }));
    });
  } finally {
    await testEnv.cleanup();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

run().catch((err) => {
  console.error("[expense-rules.test.js] unexpected failure:", err);
  process.exitCode = 1;
});
