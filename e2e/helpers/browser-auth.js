const { expect } = require("@playwright/test");

async function signInFromUi(page, user, redirect = "home.html") {
  await page.goto(`/login.html?redirect=${encodeURIComponent(redirect)}`, { waitUntil: "commit" });
  await expect(page.locator("body")).not.toHaveClass(/auth-check-pending/);
  await expect(page.locator("#email-auth-form")).toBeVisible();
  await page.locator("#auth-email").fill(user.email);
  await page.locator("#auth-password").fill(user.password);
  await page.locator("#email-submit-btn").click();
  if (user.emailVerified) {
    await expect(page).toHaveURL(new RegExp(`/${redirect.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  } else {
    await expect(page.locator("#verification-panel")).toBeVisible();
  }
  await expectAuthenticatedUid(page, user.uid);
}

async function expectAuthenticatedUid(page, uid) {
  await expect.poll(() => page.evaluate(async () => {
    const { auth } = await import("/js/firebase-init.js");
    return auth.currentUser && auth.currentUser.uid;
  })).toBe(uid);
}

async function assertLocalFirebaseRuntime(page, expectedUid = null) {
  if (expectedUid !== null) await expectAuthenticatedUid(page, expectedUid);
  const runtime = await page.evaluate(async () => {
    const { auth, firebaseConfig, LOCAL_E2E_RUNTIME } = await import("/js/firebase-init.js");
    return {
      uid: auth.currentUser?.uid || null,
      projectId: firebaseConfig.projectId,
      runtime: LOCAL_E2E_RUNTIME,
      bypassFlags: ["AUTH_BYPASS", "SKIP_AUTH", "E2E_AUTH_BYPASS"]
        .filter((key) => Object.prototype.hasOwnProperty.call(window, key)),
    };
  });
  expect(runtime.projectId).toBe("demo-edenatlas-e2e");
  expect(runtime.runtime).toEqual({
    projectId: "demo-edenatlas-e2e",
    topology: {
      auth: { host: "127.0.0.1", port: 9099 },
      firestore: { host: "127.0.0.1", port: 8080 },
      storage: { host: "127.0.0.1", port: 9199 },
    },
  });
  expect(runtime.bypassFlags).toEqual([]);
  if (expectedUid !== null) expect(runtime.uid).toBe(expectedUid);
}

module.exports = { signInFromUi, expectAuthenticatedUid, assertLocalFirebaseRuntime };
