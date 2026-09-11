#!/usr/bin/env node
const { existsSync, readFileSync, rmSync } = require("fs");
const path = require("path");
const { DEMO_PROJECT_ID, RUNTIME_ROOT, TOPOLOGY } = require("../constants.js");
const { cleanupAll } = require("./emulator-fixtures.js");
const { assertDemoProjectId } = require("./safety.js");
const { assertRuntimePath } = require("./prepare-runtime.js");

async function main() {
  assertDemoProjectId(DEMO_PROJECT_ID);
  const sentinelPath = path.join(RUNTIME_ROOT, "safety.json");
  if (!existsSync(sentinelPath)) {
    console.log("Tier-1 E2E cleanup: no runtime sentinel; no emulator endpoint was contacted.");
    return;
  }
  const sentinel = JSON.parse(readFileSync(sentinelPath, "utf8"));
  if (sentinel.projectId !== DEMO_PROJECT_ID || JSON.stringify(sentinel.topology) !== JSON.stringify(TOPOLOGY)) {
    throw new Error("Tier-1 E2E cleanup refused an invalid runtime safety sentinel");
  }
  process.env.FIREBASE_PROJECT_ID = DEMO_PROJECT_ID;
  process.env.GCLOUD_PROJECT = DEMO_PROJECT_ID;
  process.env.GOOGLE_CLOUD_PROJECT = DEMO_PROJECT_ID;
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= `${TOPOLOGY.auth.host}:${TOPOLOGY.auth.port}`;
  process.env.FIRESTORE_EMULATOR_HOST ||= `${TOPOLOGY.firestore.host}:${TOPOLOGY.firestore.port}`;
  process.env.FIREBASE_STORAGE_EMULATOR_HOST ||= `${TOPOLOGY.storage.host}:${TOPOLOGY.storage.port}`;
  await cleanupAll({ allowUnavailable: true });
  assertRuntimePath(RUNTIME_ROOT);
  rmSync(RUNTIME_ROOT, { recursive: true, force: true });
  console.log("Tier-1 E2E cleanup complete (demo emulators/runtime only).");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
