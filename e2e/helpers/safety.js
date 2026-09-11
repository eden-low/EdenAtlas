const { DEMO_PROJECT_ID, BASE_URL, TOPOLOGY } = require("../constants.js");

const FORBIDDEN_PROJECTS = new Set(["lfj-profolio", "edenatlas-staging"]);
const PROJECT_ENV_KEYS = ["FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"];

function assertDemoProjectId(projectId) {
  if (FORBIDDEN_PROJECTS.has(projectId) || projectId !== DEMO_PROJECT_ID || !projectId.startsWith("demo-")) {
    throw new Error(`E2E safety refusal: Firebase project must be exactly ${DEMO_PROJECT_ID}`);
  }
  return projectId;
}

function projectIdFromFirebaseConfig(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("E2E safety refusal: FIREBASE_CONFIG must be absent or valid demo-only JSON");
  }
  return parsed && parsed.projectId ? parsed.projectId : null;
}

function assertLauncherEnvironment(env = process.env) {
  if (env.CONTEXT && env.CONTEXT !== "dev") {
    throw new Error(`E2E safety refusal: Netlify context ${env.CONTEXT} is not local dev`);
  }
  if (env.BRANCH === "main" || env.BRANCH === "staging") {
    throw new Error(`E2E safety refusal: Netlify branch ${env.BRANCH} is not a local E2E branch`);
  }
  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error("E2E safety refusal: GOOGLE_APPLICATION_CREDENTIALS must not be present");
  }
  if (env.GCE_METADATA_HOST && env.GCE_METADATA_HOST !== "127.0.0.1:1") {
    throw new Error("E2E safety refusal: metadata discovery must be disabled or pinned to loopback");
  }
  for (const key of PROJECT_ENV_KEYS) {
    if (env[key]) assertDemoProjectId(env[key]);
  }
  const configuredProject = projectIdFromFirebaseConfig(env.FIREBASE_CONFIG);
  if (configuredProject) assertDemoProjectId(configuredProject);
}

function assertExactHost(raw, expected, label) {
  if (raw !== expected) {
    throw new Error(`E2E safety refusal: ${label} must be exactly ${expected}`);
  }
}

function assertEmulatorEnvironment(env = process.env) {
  for (const key of PROJECT_ENV_KEYS) {
    assertDemoProjectId(env[key]);
  }
  assertExactHost(
    env.FIREBASE_AUTH_EMULATOR_HOST,
    `${TOPOLOGY.auth.host}:${TOPOLOGY.auth.port}`,
    "Auth Emulator host"
  );
  assertExactHost(
    env.FIRESTORE_EMULATOR_HOST,
    `${TOPOLOGY.firestore.host}:${TOPOLOGY.firestore.port}`,
    "Firestore Emulator host"
  );
  assertExactHost(
    env.FIREBASE_STORAGE_EMULATOR_HOST,
    `${TOPOLOGY.storage.host}:${TOPOLOGY.storage.port}`,
    "Storage Emulator host"
  );
}

function assertLoopbackBaseUrl(raw = BASE_URL) {
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.port !== "4173") {
    throw new Error("E2E safety refusal: browser base URL must be exactly http://127.0.0.1:4173");
  }
  return parsed.href.replace(/\/$/, "");
}

function isForbiddenFirebaseEndpoint(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) return false;
  if ([...FORBIDDEN_PROJECTS].some((projectId) => rawUrl.includes(projectId))) return true;
  return [
    "identitytoolkit.googleapis.com",
    "securetoken.googleapis.com",
    "firestore.googleapis.com",
    "firebasestorage.googleapis.com",
    "firebaseinstallations.googleapis.com",
    "fcmregistrations.googleapis.com",
  ].includes(parsed.hostname)
    || parsed.hostname.endsWith(".firebaseio.com")
    || parsed.hostname.endsWith(".firebasestorage.app")
    || parsed.hostname.endsWith(".firebaseapp.com");
}

module.exports = {
  FORBIDDEN_PROJECTS,
  assertDemoProjectId,
  assertLauncherEnvironment,
  assertEmulatorEnvironment,
  assertLoopbackBaseUrl,
  isForbiddenFirebaseEndpoint,
};
