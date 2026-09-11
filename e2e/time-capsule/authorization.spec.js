const { test, expect } = require("../fixtures/emulator-test.js");
const { USERS } = require("../constants.js");
const { signInFromUi, assertLocalFirebaseRuntime } = require("../helpers/browser-auth.js");
const { firestoreOperation, storageOperation } = require("../helpers/browser-client.js");
const {
  CAPSULE_ID,
  CAPSULE_ATTACHMENT_PATH,
  LEGACY_CAPSULE_PATH,
  seedTimeCapsule,
} = require("../helpers/domain-fixtures.js");
const { getAdminServices, storageObjectExists } = require("../helpers/emulator-fixtures.js");

test("Owner reads a protected capsule and creates a capsule with attachment through the real UI", async ({ page }) => {
  await seedTimeCapsule();
  await signInFromUi(page, USERS.owner, "time-capsule.html");
  await expect(page).toHaveURL(/\/time-capsule\.html$/);
  await assertLocalFirebaseRuntime(page, USERS.owner.uid);
  await expect(page.getByText("E2E Protected Capsule", { exact: true })).toBeVisible();
  await expect(page.locator('#capsules-opened a[href^="blob:"]')).toBeVisible();

  const protectedRead = await storageOperation(page, "get", CAPSULE_ATTACHMENT_PATH);
  expect(protectedRead).toEqual({ ok: true, text: "capsule attachment", uid: USERS.owner.uid });

  await page.locator("#new-capsule-btn").click();
  await page.locator("#capsule-title").fill("E2E Browser Capsule");
  await page.locator("#capsule-message").fill("Created through the authenticated local UI");
  await page.locator("#capsule-open-date").fill("2099-01-01");
  await page.locator("#capsule-attachment").setInputFiles({
    name: "e2e-note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("browser capsule attachment"),
  });
  await page.locator('#capsule-form button[type="submit"]').click();
  await expect(page.getByText("E2E Browser Capsule", { exact: true })).toBeVisible();

  const { db } = getAdminServices();
  const created = await db.collection("time_capsules")
    .where("uid", "==", USERS.owner.uid)
    .where("title", "==", "E2E Browser Capsule")
    .get();
  expect(created.size).toBe(1);
  const createdData = created.docs[0].data();
  expect(createdData.attachmentPath).toBe(`capsules/${USERS.owner.uid}/${created.docs[0].id}`);
  expect(await storageObjectExists(createdData.attachmentPath)).toBe(true);
});

for (const [label, user] of [
  ["verified non-owner", USERS.verifiedNonOwner],
  ["unrelated user", USERS.unrelated],
]) {
  test(`${label} cannot read, mutate, or load protected Time Capsule attachments`, async ({ page }) => {
    await seedTimeCapsule();
    await signInFromUi(page, user);
    await page.goto("/time-capsule.html", { waitUntil: "commit" });
    await expect(page).toHaveURL(/\/home\.html(?:\?notice=private_space)?$/);
    await assertLocalFirebaseRuntime(page, user.uid);

    const read = await firestoreOperation(page, "get", `time_capsules/${CAPSULE_ID}`);
    expect(read.ok).toBe(false);
    expect(read.code).toContain("permission-denied");
    const update = await firestoreOperation(page, "update", `time_capsules/${CAPSULE_ID}`, { title: "forged" });
    expect(update.ok).toBe(false);
    expect(update.code).toContain("permission-denied");

    for (const objectPath of [CAPSULE_ATTACHMENT_PATH, LEGACY_CAPSULE_PATH]) {
      const objectRead = await storageOperation(page, "get", objectPath);
      expect(objectRead.ok).toBe(false);
      expect(objectRead.code).toContain("unauthorized");
    }
  });
}

test("anonymous client cannot read canonical or historical Time Capsule resources", async ({ page }) => {
  await seedTimeCapsule();
  await page.goto("/login.html", { waitUntil: "commit" });
  await assertLocalFirebaseRuntime(page, null);
  const documentRead = await firestoreOperation(page, "get", `time_capsules/${CAPSULE_ID}`);
  expect(documentRead.ok).toBe(false);
  expect(documentRead.code).toContain("permission-denied");
  for (const objectPath of [CAPSULE_ATTACHMENT_PATH, LEGACY_CAPSULE_PATH]) {
    const objectRead = await storageOperation(page, "get", objectPath);
    expect(objectRead.ok).toBe(false);
    expect(objectRead.code).toContain("unauthorized");
  }
});
