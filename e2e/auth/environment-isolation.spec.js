const { test, expect } = require("../fixtures/emulator-test.js");
const { DEMO_PROJECT_ID, TOPOLOGY, USERS } = require("../constants.js");
const {
  assertDemoProjectId,
  assertLauncherEnvironment,
  assertLoopbackBaseUrl,
  isForbiddenFirebaseEndpoint,
} = require("../helpers/safety.js");

test("browser Firebase runtime is pinned to demo Auth, Firestore, and Storage emulators", async ({ page }) => {
  await page.goto("/login.html", { waitUntil: "commit" });
  const runtime = await page.evaluate(async () => {
    const module = await import("/js/firebase-init.js");
    return {
      projectId: module.ACTIVE_PROJECT_ID,
      ownerEmail: module.OWNER_EMAIL,
      runtime: module.LOCAL_E2E_RUNTIME,
    };
  });
  expect(runtime.projectId).toBe(DEMO_PROJECT_ID);
  expect(runtime.ownerEmail).toBe(USERS.owner.email);
  expect(runtime.runtime).toEqual({ projectId: DEMO_PROJECT_ID, topology: TOPOLOGY });
});

test("safety helpers reject both live projects, deployed contexts, credentials, and non-loopback URLs", async () => {
  for (const projectId of ["lfj-profolio", "edenatlas-staging", "some-real-project"]) {
    expect(() => assertDemoProjectId(projectId)).toThrow(/safety refusal/);
  }
  expect(() => assertLauncherEnvironment({ CONTEXT: "production" })).toThrow(/safety refusal/);
  expect(() => assertLauncherEnvironment({ CONTEXT: "branch-deploy", BRANCH: "staging" })).toThrow(/safety refusal/);
  expect(() => assertLauncherEnvironment({ GOOGLE_APPLICATION_CREDENTIALS: "credential.json" })).toThrow(/safety refusal/);
  expect(() => assertLauncherEnvironment({ GCE_METADATA_HOST: "metadata.google.internal" })).toThrow(/safety refusal/);
  expect(() => assertLoopbackBaseUrl("https://edenatlas.netlify.app")).toThrow(/safety refusal/);
  expect(() => assertLoopbackBaseUrl("https://staging--edenatlas.netlify.app")).toThrow(/safety refusal/);
  expect(isForbiddenFirebaseEndpoint("https://identitytoolkit.googleapis.com/v1/accounts")).toBe(true);
  expect(isForbiddenFirebaseEndpoint("https://lfj-profolio.firebaseio.com/data.json")).toBe(true);
  expect(isForbiddenFirebaseEndpoint("http://127.0.0.1:8080/v1/projects/demo-edenatlas-e2e")).toBe(false);
});
