#!/usr/bin/env node
const path = require("path");
const { spawnSync } = require("child_process");
const { ROOT, RUNTIME_ROOT, DEMO_PROJECT_ID } = require("./constants.js");
const { assertLauncherEnvironment } = require("./helpers/safety.js");
const { prepareRuntime, removeRuntime } = require("./helpers/prepare-runtime.js");

function main() {
  assertLauncherEnvironment(process.env);
  const headed = process.argv.includes("--headed");
  prepareRuntime();

  const firebaseRoot = path.dirname(require.resolve("firebase-tools/package.json"));
  const firebaseCli = path.join(firebaseRoot, "lib", "bin", "firebase.js");
  const command = `node e2e/helpers/execute-e2e.js${headed ? " --headed" : ""}`;
  const env = {
    ...process.env,
    CONTEXT: "dev",
    BRANCH: "local-e2e",
    FIREBASE_PROJECT_ID: DEMO_PROJECT_ID,
    GCLOUD_PROJECT: DEMO_PROJECT_ID,
    GOOGLE_CLOUD_PROJECT: DEMO_PROJECT_ID,
    FIREBASE_CONFIG: JSON.stringify({ projectId: DEMO_PROJECT_ID }),
  };

  let status = 1;
  try {
    const result = spawnSync(process.execPath, [
      firebaseCli,
      "emulators:exec",
      "--project", DEMO_PROJECT_ID,
      "--config", path.join(RUNTIME_ROOT, "firebase.json"),
      "--only", "auth,firestore,storage",
      command,
    ], { cwd: ROOT, env, stdio: "inherit" });
    status = result.status ?? 1;
  } finally {
    removeRuntime();
  }
  if (status !== 0) process.exitCode = status;
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
