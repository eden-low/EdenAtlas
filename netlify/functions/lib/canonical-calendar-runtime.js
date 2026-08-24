const crypto = require("node:crypto");
const { initializeApp, cert, getApps, getApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const { initializeFirebaseAdmin } = require("./firebase-admin");
const { readGeneratedBuildContext } = require("./build-context");
const { withGeneratedDeployOrigins } = require("./google-calendar-http");
const { createCalendarEventStore } = require("./calendar-event-store");

function buildCanonicalCalendarDeps() {
  const buildContext = readGeneratedBuildContext();
  const env = withGeneratedDeployOrigins(process.env);
  let app = null;
  let store = null;

  function ensureApp() {
    if (app) return app;
    app = initializeFirebaseAdmin({
      getApps,
      getApp,
      initializeApp,
      cert,
      projectId: process.env.FIREBASE_PROJECT_ID,
      serviceAccountRaw: process.env.FIREBASE_SERVICE_ACCOUNT,
      buildContext,
    });
    return app;
  }

  function getDb() {
    return getFirestore(ensureApp());
  }

  function getStore() {
    if (!store) {
      store = createCalendarEventStore({
        db: getDb(),
        now: () => new Date(),
        // Temporary opaque server ID only. Phase 3B.5 replaces this injected strategy with the
        // approved stable identity without changing repository/source semantics.
        generateId: () => `ce_${crypto.randomUUID().replace(/-/g, "")}`,
      });
    }
    return store;
  }

  return {
    env,
    ensureFirebaseAdmin: async () => { ensureApp(); },
    verifyIdToken: (token) => getAuth(ensureApp()).verifyIdToken(token, true),
    getDb,
    getStore,
  };
}

module.exports = { buildCanonicalCalendarDeps };
