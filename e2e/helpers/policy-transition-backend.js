const path = require("path");
const { getAuth } = require("firebase-admin/auth");
const { FieldValue, Timestamp, getFirestore } = require("firebase-admin/firestore");
const { BASE_URL, DEMO_PROJECT_ID, FUNCTION_ROOT } = require("../constants.js");
const { assertEmulatorEnvironment, assertLoopbackBaseUrl } = require("./safety.js");
const { getAdminApp } = require("./emulator-fixtures.js");

function createPolicyTransitionHandler() {
  assertEmulatorEnvironment(process.env);
  const allowedOrigin = assertLoopbackBaseUrl(BASE_URL);
  const implementationPath = path.join(FUNCTION_ROOT, "career-policy-transition.js");
  const implementation = require(implementationPath);
  const app = getAdminApp();
  const auth = getAuth(app);
  const db = getFirestore(app);

  return implementation.createHandler({
    env: {
      FIREBASE_PROJECT_ID: DEMO_PROJECT_ID,
      FIREBASE_SERVICE_ACCOUNT: "emulator-only-not-a-service-account",
      ALLOWED_ORIGIN: allowedOrigin,
      CONTEXT: "dev",
    },
    ensureFirebaseAdmin: async () => {
      assertEmulatorEnvironment(process.env);
    },
    verifyIdToken: (token) => auth.verifyIdToken(token, true),
    getUserDoc: async (uid) => {
      const snapshot = await db.collection("users").doc(uid).get();
      return snapshot.exists ? snapshot.data() : null;
    },
    nowMs: () => Date.now(),
    beginTransition: (args) => implementation.beginPolicyTransition({ db, Timestamp, ...args }),
    completeTransition: (args) => implementation.completePolicyTransition({
      db, FieldValue, Timestamp, ...args,
    }),
  });
}

module.exports = { createPolicyTransitionHandler };
