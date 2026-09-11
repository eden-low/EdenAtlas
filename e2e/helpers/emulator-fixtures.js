const { getApps, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const { DEMO_PROJECT_ID, STORAGE_BUCKET, TOPOLOGY, USERS } = require("../constants.js");
const { assertDemoProjectId, assertEmulatorEnvironment } = require("./safety.js");

function emulatorUrl(service, pathname) {
  const endpoint = TOPOLOGY[service];
  return `http://${endpoint.host}:${endpoint.port}${pathname}`;
}

async function deleteEndpoint(url, label, { allowUnavailable = false } = {}) {
  try {
    const response = await fetch(url, { method: "DELETE" });
    if (!response.ok && response.status !== 404) {
      throw new Error(`${label} cleanup returned HTTP ${response.status}`);
    }
  } catch (error) {
    if (!allowUnavailable) throw error;
  }
}

async function cleanupStorage({ allowUnavailable = false } = {}) {
  try {
    // Firebase Tools exposes this only on the loopback Storage Emulator. It clears the emulator's
    // in-memory persistence without requiring a client token or weakening storage.rules.
    const response = await fetch(emulatorUrl("storage", "/internal/reset"), { method: "POST" });
    if (!response.ok) throw new Error(`Storage Emulator reset returned HTTP ${response.status}`);
  } catch (error) {
    if (!allowUnavailable) throw error;
  }
}

async function cleanupAll(options = {}) {
  assertDemoProjectId(DEMO_PROJECT_ID);
  await Promise.all([
    deleteEndpoint(
      emulatorUrl("auth", `/emulator/v1/projects/${DEMO_PROJECT_ID}/accounts`),
      "Auth Emulator",
      options
    ),
    deleteEndpoint(
      emulatorUrl("firestore", `/emulator/v1/projects/${DEMO_PROJECT_ID}/databases/(default)/documents`),
      "Firestore Emulator",
      options
    ),
    cleanupStorage(options),
  ]);
}

function getAdminApp() {
  assertEmulatorEnvironment(process.env);
  return getApps().find((candidate) => candidate.name === "edenatlas-tier1-e2e")
    || initializeApp({ projectId: DEMO_PROJECT_ID }, "edenatlas-tier1-e2e");
}

function getAdminServices() {
  const app = getAdminApp();
  return {
    app,
    auth: getAuth(app),
    db: getFirestore(app),
  };
}

async function putStorageObject(objectPath, content, contentType = "text/plain") {
  assertEmulatorEnvironment(process.env);
  const url = emulatorUrl(
    "storage",
    `/upload/storage/v1/b/${encodeURIComponent(STORAGE_BUCKET)}/o?uploadType=media&name=${encodeURIComponent(objectPath)}`
  );
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer owner", "Content-Type": contentType },
    body: content,
  });
  if (!response.ok) throw new Error(`Storage Emulator fixture upload returned HTTP ${response.status}`);
}

async function storageObjectExists(objectPath) {
  assertEmulatorEnvironment(process.env);
  const url = emulatorUrl(
    "storage",
    `/storage/v1/b/${encodeURIComponent(STORAGE_BUCKET)}/o/${encodeURIComponent(objectPath)}`
  );
  const response = await fetch(url, { headers: { Authorization: "Bearer owner" } });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Storage Emulator fixture lookup returned HTTP ${response.status}`);
  return true;
}

async function seedIdentities() {
  const { auth } = getAdminServices();
  for (const user of Object.values(USERS)) {
    await auth.createUser({
      uid: user.uid,
      email: user.email,
      password: user.password,
      emailVerified: user.emailVerified,
      displayName: user.displayName,
    });
  }
}

async function resetFixtures() {
  assertEmulatorEnvironment(process.env);
  await cleanupAll();
  await seedIdentities();
}

module.exports = {
  cleanupAll,
  resetFixtures,
  seedIdentities,
  getAdminApp,
  getAdminServices,
  putStorageObject,
  storageObjectExists,
};
