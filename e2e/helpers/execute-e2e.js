#!/usr/bin/env node
const path = require("path");
const { spawn } = require("child_process");
const { ROOT, SITE_ROOT, BASE_URL, DEMO_PROJECT_ID } = require("../constants.js");
const { assertEmulatorEnvironment, assertLoopbackBaseUrl } = require("./safety.js");
const { cleanupAll, resetFixtures } = require("./emulator-fixtures.js");
const { startStaticServer } = require("./static-server.js");
const { createPolicyTransitionHandler } = require("./policy-transition-backend.js");

async function main() {
  // firebase-admin may probe the GCE metadata service while resolving its emulator-only client.
  // Pin that probe to a closed loopback port before any Admin service is initialized.
  process.env.GCE_METADATA_HOST = "127.0.0.1:1";
  assertEmulatorEnvironment(process.env);
  const baseURL = assertLoopbackBaseUrl(BASE_URL);
  process.env.EDEN_E2E_BASE_URL = baseURL;
  process.env.EDEN_E2E_SITE_DIR = SITE_ROOT;
  process.env.EDEN_E2E_PROJECT_ID = DEMO_PROJECT_ID;
  process.env.EDEN_E2E_HEADED = process.argv.includes("--headed") ? "1" : "0";

  await resetFixtures();
  const staticServer = await startStaticServer({
    functionHandlers: {
      "/.netlify/functions/career-policy-transition": createPolicyTransitionHandler(),
    },
  });
  let status = 1;
  try {
    const playwrightRoot = path.dirname(require.resolve("@playwright/test/package.json"));
    const cli = path.join(playwrightRoot, "cli.js");
    const child = spawn(process.execPath, [cli, "test", "--config", "playwright.config.js"], {
      cwd: ROOT,
      env: process.env,
      stdio: "inherit",
    });
    status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await cleanupAll();
    await staticServer.close();
  }
  if (status !== 0) process.exitCode = status;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
