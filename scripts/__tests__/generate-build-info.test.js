// Deterministic tests for scripts/generate-build-info.js — specifically Gap 2's requirement:
// "Add tests proving that staging and Production builds generate different project IDs and that
// secrets are never emitted." Calls the real generate() function (not a reimplementation) against
// mutated process.env, and inspects both its return value and the actual bytes written to
// js/fcm-config.generated.js / js/build-info.generated.js — these are gitignored, regenerated-
// on-every-build files, so writing them here is the same as any real `npm run build` invocation
// would; `npm run build` (already part of this repo's own verification routine) regenerates them
// again afterward with this environment's real values.
//
// Run with: node scripts/__tests__/generate-build-info.test.js (or `npm run test:functions` —
// wired in alongside the other scripts/__tests__ suite for consistency, even though this one
// lives under scripts/, since it tests a scripts/ file the Netlify build pipeline runs).

const assert = require("node:assert");
const fs = require("node:fs");

const { generate, OUT_PATH, FCM_CONFIG_OUT_PATH, PRODUCTION_FIREBASE_CONFIG } = require("../generate-build-info.js");

let pass = 0;
let fail = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, err });
    console.log(`FAIL  - ${name}`);
    console.log(`        ${err.message}`);
  }
}

const ENV_KEYS = [
  "CONTEXT", "BRANCH", "URL", "DEPLOY_PRIME_URL", "FIREBASE_VAPID_PUBLIC_KEY",
  "STAGING_FIREBASE_API_KEY", "STAGING_FIREBASE_AUTH_DOMAIN", "STAGING_FIREBASE_PROJECT_ID",
  "STAGING_FIREBASE_STORAGE_BUCKET", "STAGING_FIREBASE_MESSAGING_SENDER_ID", "STAGING_FIREBASE_APP_ID",
  // Deliberately included even though generate-build-info.js never reads these — the "secrets
  // never emitted" tests below plant fake values under these names to prove they can't leak
  // through by accident (e.g. via an errant `...process.env` spread this file doesn't have, but
  // a future edit might introduce).
  "DASHSCOPE_API_KEY", "FIREBASE_SERVICE_ACCOUNT", "QWEN_BASE_URL",
];

function withEnv(overrides, fn) {
  const saved = {};
  ENV_KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    ENV_KEYS.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    });
  }
}

const FULL_STAGING_ENV = {
  CONTEXT: "branch-deploy",
  BRANCH: "staging",
  STAGING_FIREBASE_API_KEY: "staging-api-key",
  STAGING_FIREBASE_AUTH_DOMAIN: "edenatlas-staging.firebaseapp.com",
  STAGING_FIREBASE_PROJECT_ID: "edenatlas-staging",
  STAGING_FIREBASE_STORAGE_BUCKET: "edenatlas-staging.firebasestorage.app",
  STAGING_FIREBASE_MESSAGING_SENDER_ID: "999999999999",
  STAGING_FIREBASE_APP_ID: "1:999999999999:web:staging",
};

(async () => {
  await test("Production context (CONTEXT=production): fcm-config.generated.js resolves to the hardcoded PRODUCTION project, regardless of any staging vars being set", () => {
    withEnv({ ...FULL_STAGING_ENV, CONTEXT: "production", BRANCH: "main" }, () => {
      // CONTEXT/BRANCH spread AFTER FULL_STAGING_ENV so they win — Production overrides Staging.
      const info = generate();
      assert.strictEqual(info.context, "production");
      const fcmConfig = JSON.parse(fs.readFileSync(FCM_CONFIG_OUT_PATH, "utf8").replace(/^.*self\.__EDEN_FCM_CONFIG__\s*=\s*/s, "").replace(/;\s*$/, ""));
      assert.strictEqual(fcmConfig.firebaseConfig.projectId, PRODUCTION_FIREBASE_CONFIG.projectId);
    });
  });

  await test("a genuine Staging build (CONTEXT=branch-deploy, BRANCH=staging, all six STAGING_FIREBASE_* set) resolves fcm-config.generated.js to a DIFFERENT project id than Production", () => {
    withEnv(FULL_STAGING_ENV, () => {
      const info = generate();
      assert.strictEqual(info.context, "branch-deploy");
      const fcmConfig = JSON.parse(fs.readFileSync(FCM_CONFIG_OUT_PATH, "utf8").replace(/^.*self\.__EDEN_FCM_CONFIG__\s*=\s*/s, "").replace(/;\s*$/, ""));
      assert.strictEqual(fcmConfig.firebaseConfig.projectId, "edenatlas-staging");
      assert.notStrictEqual(fcmConfig.firebaseConfig.projectId, PRODUCTION_FIREBASE_CONFIG.projectId);
    });
  });

  await test("a Staging build with only a PARTIAL staging config (e.g. missing STAGING_FIREBASE_APP_ID) falls back to Production's project, never a half-populated config", () => {
    const partial = { ...FULL_STAGING_ENV };
    delete partial.STAGING_FIREBASE_APP_ID;
    withEnv(partial, () => {
      const info = generate();
      assert.strictEqual(info.stagingFirebaseConfig, null);
      const fcmConfig = JSON.parse(fs.readFileSync(FCM_CONFIG_OUT_PATH, "utf8").replace(/^.*self\.__EDEN_FCM_CONFIG__\s*=\s*/s, "").replace(/;\s*$/, ""));
      assert.strictEqual(fcmConfig.firebaseConfig.projectId, PRODUCTION_FIREBASE_CONFIG.projectId);
    });
  });

  await test("a Deploy Preview (or any non-staging branch-deploy) never uses a staging config, even if all six staging vars happen to be set", () => {
    withEnv({ ...FULL_STAGING_ENV, CONTEXT: "branch-deploy", BRANCH: "some-other-feature-branch" }, () => {
      const fcmConfig = JSON.parse(fs.readFileSync(FCM_CONFIG_OUT_PATH, "utf8").replace(/^.*self\.__EDEN_FCM_CONFIG__\s*=\s*/s, "").replace(/;\s*$/, ""));
      assert.strictEqual(fcmConfig.firebaseConfig.projectId, PRODUCTION_FIREBASE_CONFIG.projectId);
    });
  });

  await test("secrets are never emitted into either generated file — fake DashScope key, service-account JSON shape, and PEM markers never appear, even when present in process.env", () => {
    const FAKE_SECRET = "FAKE_DASHSCOPE_SECRET_DO_NOT_LEAK_9f3c1a";
    const FAKE_SERVICE_ACCOUNT = JSON.stringify({ type: "service_account", project_id: "lfj-profolio", private_key: "-----BEGIN PRIVATE KEY-----\nFAKEFAKEFAKE\n-----END PRIVATE KEY-----\n" });
    withEnv({ ...FULL_STAGING_ENV, DASHSCOPE_API_KEY: FAKE_SECRET, FIREBASE_SERVICE_ACCOUNT: FAKE_SERVICE_ACCOUNT, QWEN_BASE_URL: "https://fake-workspace-id.example.com" }, () => {
      generate();
      const buildInfoText = fs.readFileSync(OUT_PATH, "utf8");
      const fcmConfigText = fs.readFileSync(FCM_CONFIG_OUT_PATH, "utf8");
      [buildInfoText, fcmConfigText].forEach((text) => {
        assert.ok(!text.includes(FAKE_SECRET), "DashScope-shaped key leaked into a generated file");
        assert.ok(!text.includes("BEGIN PRIVATE KEY"), "a PEM private-key marker leaked into a generated file");
        assert.ok(!text.includes("service_account"), "a service-account JSON shape leaked into a generated file");
        assert.ok(!text.includes("fake-workspace-id"), "a Qwen base URL leaked into a generated file");
      });
    });
  });

  await test("fcm-config.generated.js contains ONLY the allowlisted shape: firebaseConfig (6 known keys) + vapidPublicKey, nothing else", () => {
    withEnv({ ...FULL_STAGING_ENV, FIREBASE_VAPID_PUBLIC_KEY: "BExampleVapidPublicKey123" }, () => {
      generate();
      const fcmConfig = JSON.parse(fs.readFileSync(FCM_CONFIG_OUT_PATH, "utf8").replace(/^.*self\.__EDEN_FCM_CONFIG__\s*=\s*/s, "").replace(/;\s*$/, ""));
      assert.deepStrictEqual(Object.keys(fcmConfig).sort(), ["firebaseConfig", "vapidPublicKey"]);
      assert.deepStrictEqual(
        Object.keys(fcmConfig.firebaseConfig).sort(),
        ["apiKey", "appId", "authDomain", "messagingSenderId", "projectId", "storageBucket"]
      );
      assert.strictEqual(fcmConfig.vapidPublicKey, "BExampleVapidPublicKey123");
    });
  });

  await test("fcm-config.generated.js sets self.__EDEN_FCM_CONFIG__ (not window.*) — usable via importScripts() in a worker with no `window` global", () => {
    withEnv(FULL_STAGING_ENV, () => {
      generate();
      const text = fs.readFileSync(FCM_CONFIG_OUT_PATH, "utf8");
      assert.ok(/self\.__EDEN_FCM_CONFIG__\s*=/.test(text));
      assert.ok(!/window\.__EDEN_FCM_CONFIG__/.test(text));
    });
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    failures.forEach(({ name, err }) => console.error(`\n[FAILED] ${name}\n${err.stack || err}`));
    process.exit(1);
  }
})();
