const { test, expect } = require("../fixtures/emulator-test.js");
const { USERS } = require("../constants.js");
const { signInFromUi, assertLocalFirebaseRuntime } = require("../helpers/browser-auth.js");
const { firestoreOperation } = require("../helpers/browser-client.js");
const { seedCareerDomain } = require("../helpers/domain-fixtures.js");
const { getAdminServices } = require("../helpers/emulator-fixtures.js");

async function expectPrivateCareerDenied(page) {
  await expect(page.locator("#career-access-notice")).toBeVisible();
  await expect(page.locator("#career-main")).toBeHidden();
  await expect(page.locator("#add-award-btn")).toBeHidden();
}

test("authenticated emulator Owner reaches Career and performs an actual UI write", async ({ page }) => {
  await seedCareerDomain();
  await signInFromUi(page, USERS.owner, "resume.html");
  await expect(page).toHaveURL(/\/resume\.html$/);
  await assertLocalFirebaseRuntime(page, USERS.owner.uid);
  await expect(page.locator("#career-main")).toBeVisible();
  await expect(page.locator("#career-visibility-select")).toHaveValue("private");
  await expect(page.locator("#add-award-btn")).toBeVisible();

  await page.locator("#add-award-btn").click();
  await page.locator("#award-title-en").fill("E2E Browser Award");
  await page.locator("#award-issuer").fill("Local Emulator");
  await page.locator("#award-date").fill("2026-09");
  await page.locator("#award-description-en").fill("Created through the real Career form");
  await page.locator('#award-form input[name="award-visibility"][value="private"]').check();
  await page.locator("#award-form button[type=submit]").click();
  await expect(page.getByText("E2E Browser Award", { exact: true })).toBeVisible();

  const { db } = getAdminServices();
  await expect.poll(async () => {
    const snapshot = await db.collection("career_awards")
      .where("uid", "==", USERS.owner.uid)
      .where("title_en", "==", "E2E Browser Award")
      .get();
    return snapshot.size;
  }).toBe(1);
});

for (const [label, user] of [
  ["verified non-owner", USERS.verifiedNonOwner],
  ["unrelated user", USERS.unrelated],
]) {
  test(`${label} cannot reach Owner-only Career operations`, async ({ page }) => {
    await seedCareerDomain();
    await signInFromUi(page, user);
    await page.goto(`/resume.html?uid=${USERS.owner.uid}`, { waitUntil: "commit" });
    await assertLocalFirebaseRuntime(page, user.uid);
    await expectPrivateCareerDenied(page);
    const write = await firestoreOperation(
      page,
      "set",
      `career_awards/forged-${user.uid}`,
      { uid: USERS.owner.uid, visibility: "public", careerVisibility: "public", careerPolicyVersion: 7 }
    );
    expect(write.ok).toBe(false);
    expect(write.code).toContain("permission-denied");
  });
}

test("unverified authenticated user cannot bypass private Career access", async ({ page }) => {
  await seedCareerDomain();
  await signInFromUi(page, USERS.unverified);
  await expect(page.locator("#verification-panel")).toBeVisible();
  await page.goto(`/resume.html?uid=${USERS.owner.uid}`, { waitUntil: "commit" });
  await assertLocalFirebaseRuntime(page, USERS.unverified.uid);
  await expectPrivateCareerDenied(page);
});

test("unauthenticated visitor cannot access a private Owner Career", async ({ page }) => {
  await seedCareerDomain();
  await page.goto(`/resume.html?uid=${USERS.owner.uid}`, { waitUntil: "commit" });
  await assertLocalFirebaseRuntime(page, null);
  await expectPrivateCareerDenied(page);
});
