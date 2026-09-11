const { defineConfig } = require("@playwright/test");
const path = require("path");
const { ROOT, DEMO_PROJECT_ID } = require("./e2e/constants.js");
const { assertDemoProjectId, assertEmulatorEnvironment, assertLoopbackBaseUrl } = require("./e2e/helpers/safety.js");

assertDemoProjectId(process.env.EDEN_E2E_PROJECT_ID);
assertEmulatorEnvironment(process.env);
const baseURL = assertLoopbackBaseUrl(process.env.EDEN_E2E_BASE_URL);

module.exports = defineConfig({
  testDir: path.join(ROOT, "e2e"),
  testMatch: "**/*.spec.js",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 15_000 },
  outputDir: path.join(ROOT, ".e2e-runtime", "test-results"),
  reporter: "line",
  use: {
    baseURL,
    browserName: "chromium",
    headless: process.env.EDEN_E2E_HEADED !== "1",
    serviceWorkers: "block",
    // Policy-transition requests carry a one-time raw capability by design. Do not persist
    // network traces that could retain that ephemeral secret after a failed test.
    trace: "off",
  },
});
