const { test, expect } = require("../fixtures/emulator-test.js");
const { USERS } = require("../constants.js");
const { signInFromUi, assertLocalFirebaseRuntime } = require("../helpers/browser-auth.js");
const { firestoreOperation, storageOperation } = require("../helpers/browser-client.js");
const {
  CAREER_IDS,
  CAREER_ATTACHMENT_PATH,
  LEGACY_CAREER_PATH,
  seedCareerDomain,
  seedFriendship,
} = require("../helpers/domain-fixtures.js");
const { getAdminServices } = require("../helpers/emulator-fixtures.js");

async function signOutInBrowser(page) {
  await page.evaluate(async () => {
    const { auth } = await import("/js/firebase-init.js");
    const { signOut } = await import("https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js");
    await signOut(auth);
  });
}

test("Owner succeeds while cross-user and mismatched Career access fails", async ({ page }) => {
  await seedCareerDomain({ visibility: "private", version: 7 });
  await signInFromUi(page, USERS.owner);
  await assertLocalFirebaseRuntime(page, USERS.owner.uid);

  const ownerDocument = await firestoreOperation(page, "get", `career_projects/${CAREER_IDS.career_projects}`);
  expect(ownerDocument.ok).toBe(true);
  expect(ownerDocument.exists).toBe(true);
  const ownerObject = await storageOperation(page, "get", CAREER_ATTACHMENT_PATH);
  expect(ownerObject.ok).toBe(true);
  expect(ownerObject.text).toBe("career attachment");
  const ownerUpload = await storageOperation(
    page,
    "upload",
    `career/${USERS.owner.uid}/career_projects/${CAREER_IDS.career_projects}/owner-upload`
  );
  expect(ownerUpload.ok).toBe(true);

  const mismatchedPath = await storageOperation(
    page,
    "get",
    `career/${USERS.unrelated.uid}/career_projects/${CAREER_IDS.career_projects}/attachment-1`
  );
  expect(mismatchedPath.ok).toBe(false);
  expect(mismatchedPath.code).toContain("unauthorized");

  await signOutInBrowser(page);
  await signInFromUi(page, USERS.verifiedNonOwner);
  const crossUserDocument = await firestoreOperation(page, "get", `career_projects/${CAREER_IDS.career_projects}`);
  expect(crossUserDocument.ok).toBe(false);
  expect(crossUserDocument.code).toContain("permission-denied");
  const crossUserObject = await storageOperation(page, "get", CAREER_ATTACHMENT_PATH);
  expect(crossUserObject.ok).toBe(false);
  expect(crossUserObject.code).toContain("unauthorized");
  const historical = await storageOperation(page, "get", LEGACY_CAREER_PATH);
  expect(historical.ok).toBe(false);
  expect(historical.code).toContain("unauthorized");
});

test("verified live friendship grants connection access and dashboard revoke removes it", async ({ page }) => {
  await seedCareerDomain({ visibility: "connections", version: 7 });
  await seedFriendship({ profileOptions: { careerVisibility: "connections", careerPolicyVersion: 7 } });
  await signInFromUi(page, USERS.verifiedNonOwner);
  const beforeDocument = await firestoreOperation(page, "get", `career_projects/${CAREER_IDS.career_projects}`);
  const beforeObject = await storageOperation(page, "get", CAREER_ATTACHMENT_PATH);
  expect(beforeDocument.ok).toBe(true);
  expect(beforeObject.ok).toBe(true);

  await signOutInBrowser(page);
  await signInFromUi(page, USERS.owner, "dashboard.html");
  await expect(page.getByRole("button", { name: /remove friend/i })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /remove friend/i }).click();
  const { db } = getAdminServices();
  await expect.poll(async () => {
    const snapshot = await db.collection("friendships").doc(USERS.owner.uid)
      .collection("friends").doc(USERS.verifiedNonOwner.uid).get();
    return snapshot.exists;
  }).toBe(false);

  await signOutInBrowser(page);
  await signInFromUi(page, USERS.verifiedNonOwner);
  const afterDocument = await firestoreOperation(page, "get", `career_projects/${CAREER_IDS.career_projects}`);
  const afterObject = await storageOperation(page, "get", CAREER_ATTACHMENT_PATH);
  expect(afterDocument.ok).toBe(false);
  expect(afterDocument.code).toContain("permission-denied");
  expect(afterObject.ok).toBe(false);
  expect(afterObject.code).toContain("unauthorized");
});

test("unverified accepted identity cannot use the connection branch", async ({ page }) => {
  await seedCareerDomain({ visibility: "connections", version: 7 });
  await seedFriendship({
    toKey: "unverified",
    profileOptions: { careerVisibility: "connections", careerPolicyVersion: 7 },
  });
  await signInFromUi(page, USERS.unverified);
  await expect(page.locator("#verification-panel")).toBeVisible();
  const documentRead = await firestoreOperation(page, "get", `career_projects/${CAREER_IDS.career_projects}`);
  const objectRead = await storageOperation(page, "get", CAREER_ATTACHMENT_PATH);
  expect(documentRead.ok).toBe(false);
  expect(documentRead.code).toContain("permission-denied");
  expect(objectRead.ok).toBe(false);
  expect(objectRead.code).toContain("unauthorized");
});

test("anonymous public access uses the current item while historical Career path remains owner-only", async ({ page }) => {
  await seedCareerDomain({ visibility: "public", version: 7 });
  await page.goto("/login.html", { waitUntil: "commit" });
  await assertLocalFirebaseRuntime(page, null);
  const current = await storageOperation(page, "get", CAREER_ATTACHMENT_PATH);
  expect(current.ok).toBe(true);
  expect(current.text).toBe("career attachment");
  const historical = await storageOperation(page, "get", LEGACY_CAREER_PATH);
  expect(historical.ok).toBe(false);
  expect(historical.code).toContain("unauthorized");
});
