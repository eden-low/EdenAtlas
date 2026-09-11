const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const RUNTIME_ROOT = path.join(ROOT, ".e2e-runtime");
const SITE_ROOT = path.join(RUNTIME_ROOT, "site");
const FUNCTION_ROOT = path.join(RUNTIME_ROOT, "backend", "netlify", "functions");
const DEMO_PROJECT_ID = "demo-edenatlas-e2e";
const STORAGE_BUCKET = `${DEMO_PROJECT_ID}.appspot.com`;
const BASE_URL = "http://127.0.0.1:4173";

const TOPOLOGY = Object.freeze({
  auth: Object.freeze({ host: "127.0.0.1", port: 9099 }),
  firestore: Object.freeze({ host: "127.0.0.1", port: 8080 }),
  storage: Object.freeze({ host: "127.0.0.1", port: 9199 }),
});

const USERS = Object.freeze({
  owner: Object.freeze({
    uid: "e2e-owner-uid",
    email: "owner@edenatlas-e2e.invalid",
    password: "E2eOnly-Owner-1701!",
    emailVerified: true,
    displayName: "E2E Owner",
  }),
  verifiedNonOwner: Object.freeze({
    uid: "e2e-verified-user-uid",
    email: "verified@edenatlas-e2e.invalid",
    password: "E2eOnly-Verified-1701!",
    emailVerified: true,
    displayName: "E2E Verified User",
  }),
  unverified: Object.freeze({
    uid: "e2e-unverified-user-uid",
    email: "unverified@edenatlas-e2e.invalid",
    password: "E2eOnly-Unverified-1701!",
    emailVerified: false,
    displayName: "E2E Unverified User",
  }),
  unrelated: Object.freeze({
    uid: "e2e-unrelated-user-uid",
    email: "unrelated@edenatlas-e2e.invalid",
    password: "E2eOnly-Unrelated-1701!",
    emailVerified: true,
    displayName: "E2E Unrelated User",
  }),
});

module.exports = {
  ROOT,
  RUNTIME_ROOT,
  SITE_ROOT,
  FUNCTION_ROOT,
  DEMO_PROJECT_ID,
  STORAGE_BUCKET,
  BASE_URL,
  TOPOLOGY,
  USERS,
};
