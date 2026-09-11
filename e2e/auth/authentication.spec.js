const { test, expect } = require("../fixtures/emulator-test.js");
const { USERS } = require("../constants.js");
const { signInFromUi, expectAuthenticatedUid } = require("../helpers/browser-auth.js");

test("unauthenticated user reaches the login entry", async ({ page }) => {
  await page.goto("/login.html", { waitUntil: "commit" });
  await expect(page.locator("body")).not.toHaveClass(/auth-check-pending/);
  await expect(page.locator("#email-auth-form")).toBeVisible();
  await expect(page.locator("#auth-email")).toBeEditable();
});

test("protected pages redirect an unauthenticated browser to login", async ({ page }) => {
  await page.goto("/home.html", { waitUntil: "commit" });
  await expect(page).toHaveURL(/\/login\.html\?redirect=home\.html$/);
  await expect(page.locator("#email-auth-form")).toBeVisible();
});

test("the deterministic emulator Owner authenticates as Owner", async ({ page }) => {
  await signInFromUi(page, USERS.owner);
  await expect(page).toHaveURL(/\/home\.html$/);
  await expectAuthenticatedUid(page, USERS.owner.uid);
  expect(await page.evaluate(() => localStorage.getItem("lfj:userMode"))).toBe("OWNER");
});

test("a verified non-owner authenticates without Owner authority", async ({ page }) => {
  await signInFromUi(page, USERS.verifiedNonOwner);
  await expect(page).toHaveURL(/\/home\.html$/);
  await expectAuthenticatedUid(page, USERS.verifiedNonOwner.uid);
  expect(await page.evaluate(() => localStorage.getItem("lfj:userMode"))).toBe("VIEWER");
});

test("an unverified password user remains at the verification gate", async ({ page }) => {
  await signInFromUi(page, USERS.unverified);
  await expect(page).toHaveURL(/\/login\.html(?:\?redirect=home\.html)?$/);
  await expect(page.locator("#verification-panel")).toBeVisible();
  await expectAuthenticatedUid(page, USERS.unverified.uid);
  expect(await page.evaluate(() => localStorage.getItem("lfj:userMode"))).toBe("VIEWER");
});

test("browser-local authentication persists across a protected-page reload", async ({ page }) => {
  await signInFromUi(page, USERS.owner);
  await expect(page).toHaveURL(/\/home\.html$/);
  await page.reload({ waitUntil: "commit" });
  await expect(page).toHaveURL(/\/home\.html$/);
  await expectAuthenticatedUid(page, USERS.owner.uid);
});

test("logout clears authentication and returns to login", async ({ page }) => {
  await signInFromUi(page, USERS.owner);
  await expect(page).toHaveURL(/\/home\.html$/);
  await expect(page.locator("#eden-sidebar-logout")).toBeVisible();
  await page.locator("#eden-sidebar-logout").click();
  await expect(page).toHaveURL(/\/login\.html$/);
  await expect.poll(() => page.evaluate(async () => {
    const { auth } = await import("/js/firebase-init.js");
    return auth.currentUser;
  })).toBeNull();
});
