// Real-packaging regression coverage for the "config/unknown-deploy-context" /
// "config/staging-not-configured" production incident on staging--edenatlas.netlify.app.
//
// Every other test in this repo that touches lib/build-context.js / lib/deploy-origin.js
// exercises them either as plain unbundled Node modules (staging-isolation-wiring.test.js) or via
// hand-built fixtures (assistant.test.js's "Deploy-context policy" section) — neither of those
// can catch a bug that only exists AFTER Netlify's real esbuild Function bundler has run, which is
// exactly what broke in production: `included_files` correctly copied the generated JSON into the
// deployed archive, but esbuild collapses every module a bundled entry point requires into ONE
// physical output file that keeps the ENTRY point's own relative path — so `__dirname` inside that
// bundle no longer matches the original per-module source file's directory, and an
// `__dirname`-relative fs read looked in the wrong place regardless of included_files. This file
// runs the REAL @netlify/zip-it-and-ship-it packaging pipeline (the same tool/bundler Netlify
// itself uses), extracts the resulting zip to a real temp directory, and executes the packaged
// handler from there — the same three checks the task that produced this file asked for: package
// with the configured bundler, extract, execute.
//
// Deliberately NOT folded into `npm test` / `test:functions` — this is a real, heavy build step
// (esbuild bundling firebase-admin + grpc + protobuf into a ~130k-line single-file bundle, several
// times over) with its own real devDependency (@netlify/zip-it-and-ship-it, ~190 transitive
// packages including native binaries) — the same reasoning that already keeps test:firestore-rules
// (a real Firestore Emulator, needing a JDK) out of the fast/dependency-free `npm test` path. Run
// with: `npm run test:staging-packaging` (or `npm run test:all`, which includes it).
//
// No real Firebase project, service account, or secret is used anywhere in this file — the
// "credential" fed to the packaged handler is a throwaway RSA keypair generated locally with
// Node's own crypto module (same technique assistant.test.js's VALID_SA fixture already uses),
// just structurally valid enough for firebase-admin's local, offline cert()/initializeApp() calls
// to succeed without ever making a network request — enforceDeployContextPolicy() (what this file
// is actually testing) runs and can reject a request before any of that credential material would
// ever be used for a real Admin API call.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const BUILD_CONTEXT_PATH = path.join(ROOT, "backend", "netlify", "functions", "lib", "build-context.generated.json");
const DEPLOY_ORIGIN_PATH = path.join(ROOT, "backend", "netlify", "functions", "lib", "deploy-origin.generated.json");
const ANILIST_SRC = path.join(ROOT, "backend", "netlify", "functions", "anilist.js");

const STAGING_PROJECT_ID = "edenatlas-staging"; // sourced the same way it always is: a value the
// caller (this test, matching the task's own requested env) supplies via STAGING_FIREBASE_PROJECT_ID
// — never hardcoded into any application source file, only into this test's own env fixture.

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

// ---- Derive the bundler netlify.toml actually configures, rather than hardcoding "esbuild" a
// second time — if [functions].node_bundler ever changes, this test packages with whatever is
// really configured, not a stale assumption. ----
function readConfiguredNodeBundler() {
  const toml = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
  const functionsBlockMatch = /\[functions\]([\s\S]*?)(?=\n\[|$)/.exec(toml);
  assert.ok(functionsBlockMatch, "netlify.toml has no [functions] block");
  const bundlerMatch = /node_bundler\s*=\s*"([^"]+)"/.exec(functionsBlockMatch[1]);
  assert.ok(bundlerMatch, "netlify.toml [functions] does not set node_bundler");
  return bundlerMatch[1];
}

// ---- Real RSA keypair, generated locally, never a real credential — see header comment. ----
const TEST_PRIVATE_KEY = crypto
  .generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" });

function fakeServiceAccountJson(projectId) {
  return JSON.stringify({
    project_id: projectId,
    client_email: "staging-packaging-test@example.invalid",
    private_key: TEST_PRIVATE_KEY,
  });
}

// ---- Generator env save/restore — same convention as scripts/__tests__/generate-build-info.test.js's
// withEnv() and staging-isolation-wiring.test.js's withGeneratorEnv(). ----
const GENERATOR_ENV_KEYS = ["CONTEXT", "BRANCH", "STAGING_FIREBASE_PROJECT_ID", "DEPLOY_PRIME_URL", "DEPLOY_URL"];
function withGeneratorEnv(overrides, fn) {
  const saved = {};
  GENERATOR_ENV_KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    GENERATOR_ENV_KEYS.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    });
  }
}

// ---- Back up / restore the two real generated files this test overwrites repeatedly, so this
// suite never leaves the checkout's own build artifacts in a surprising state for a later local
// `npm run build` — same hygiene staging-isolation-wiring.test.js already applies. ----
function backupFile(p) {
  return fs.existsSync(p) ? { existed: true, contents: fs.readFileSync(p, "utf8") } : { existed: false };
}
function restoreFile(p, backup) {
  if (backup.existed) fs.writeFileSync(p, backup.contents, "utf8");
  else if (fs.existsSync(p)) fs.unlinkSync(p);
}

// ---- Package the real anilist.js Function with the real, repo-configured bundler, into a fresh
// temp directory; extract the resulting zip with adm-zip into a second fresh temp directory;
// return the extracted directory's absolute path. Every call gets its own fresh temp dirs, so
// there is no cross-call module-cache concern the way an in-process require() would have — each
// packaged bundle is a physically distinct file on disk. ----
async function packageAndExtractAnilist() {
  const { zipFunction } = require("@netlify/zip-it-and-ship-it");
  const AdmZip = require("adm-zip");

  const zipDestDir = fs.mkdtempSync(path.join(os.tmpdir(), "eden-staging-pkg-zip-"));
  const result = await zipFunction(ANILIST_SRC, zipDestDir, {
    basePath: ROOT,
    config: { "*": { nodeBundler: readConfiguredNodeBundler() } },
  });
  assert.ok(result && result.path && fs.existsSync(result.path), "zipFunction did not produce a zip file");

  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "eden-staging-pkg-extract-"));
  new AdmZip(result.path).extractAllTo(extractDir, true);
  assert.ok(fs.existsSync(path.join(extractDir, "anilist.js")), "extracted package is missing its anilist.js entry point");
  return extractDir;
}

// ---- Execute the packaged handler exactly as AWS Lambda / Netlify would invoke it, with fake
// (never real) env vars just sufficient to get past the REQUIRED_ENV check — no network call is
// ever reachable from this test: enforceDeployContextPolicy() runs and can reject the request
// before parseServiceAccount()/cert()/initializeApp() ever touch the fake credential material,
// and even when it doesn't reject, cert()/initializeApp() themselves make no network call (see
// lib/firebase-admin.js's own header comment on this — confirmed against the real installed
// package, not assumed). Captures console.error so a test can inspect the exact
// stage=/code= this Function logs, since the HTTP response body itself is deliberately generic
// (`anilist_not_configured`) for every FirebaseConfigError, by design. ----
async function invokePackagedAnilist(extractDir, { projectId, event }) {
  const modPath = require.resolve(path.join(extractDir, "anilist.js"));
  delete require.cache[modPath]; // each extractDir is physically distinct anyway, but be explicit
  const savedEnv = {
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
    FIREBASE_SERVICE_ACCOUNT: process.env.FIREBASE_SERVICE_ACCOUNT,
    ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN,
  };
  process.env.FIREBASE_PROJECT_ID = projectId;
  process.env.FIREBASE_SERVICE_ACCOUNT = fakeServiceAccountJson(projectId);
  process.env.ALLOWED_ORIGIN = "https://staging--edenatlas.netlify.app";

  const loggedErrors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => loggedErrors.push(args.join(" "));

  try {
    const mod = require(modPath);
    const response = await mod.handler(event);
    return { response, loggedErrors };
  } finally {
    console.error = originalConsoleError;
    delete require.cache[modPath];
    Object.entries(savedEnv).forEach(([k, v]) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
  }
}

function optionsEvent(origin) {
  return { httpMethod: "OPTIONS", headers: { origin }, body: null };
}

(async () => {
  const buildContextBackup = backupFile(BUILD_CONTEXT_PATH);
  const deployOriginBackup = backupFile(DEPLOY_ORIGIN_PATH);

  try {
    // ---- Scenario 1: the exact Netlify staging branch-deploy env, correctly configured. ----
    console.log("\nScenario: correctly-configured staging branch-deploy (CONTEXT=branch-deploy BRANCH=staging STAGING_FIREBASE_PROJECT_ID=edenatlas-staging)");
    const DEPLOY_PREVIEW_URL = "https://deploy-preview-99--edenatlas.netlify.app";
    withGeneratorEnv(
      { CONTEXT: "branch-deploy", BRANCH: "staging", STAGING_FIREBASE_PROJECT_ID: STAGING_PROJECT_ID },
      () => require("../../../../scripts/generate-function-context.js").generate()
    );
    withGeneratorEnv(
      { DEPLOY_PRIME_URL: DEPLOY_PREVIEW_URL },
      () => require("../../../../scripts/generate-deploy-origin.js").generate()
    );

    let configuredExtractDir;
    await test("packaging the real anilist.js Function with the repo-configured bundler succeeds and produces an extractable zip", async () => {
      configuredExtractDir = await packageAndExtractAnilist();
    });

    if (configuredExtractDir) {
      await test("executing the packaged handler resolves the staging project id all the way through the real deploy-context policy (OPTIONS preflight returns 204, not a 500 config error)", async () => {
        const { response, loggedErrors } = await invokePackagedAnilist(configuredExtractDir, {
          projectId: STAGING_PROJECT_ID,
          event: optionsEvent("https://staging--edenatlas.netlify.app"),
        });
        assert.strictEqual(
          response.statusCode, 204,
          `expected a successful CORS preflight (204); got ${response.statusCode} ${response.body || ""} — logs: ${loggedErrors.join(" | ")}`
        );
      });

      await test("the packaged bundle also correctly resolves the inlined Deploy Preview origin from deploy-origin.generated.json (proves lib/deploy-origin.js's identical fix, not just lib/build-context.js's)", async () => {
        const { response, loggedErrors } = await invokePackagedAnilist(configuredExtractDir, {
          projectId: STAGING_PROJECT_ID,
          event: optionsEvent(DEPLOY_PREVIEW_URL),
        });
        assert.strictEqual(
          response.statusCode, 204,
          `expected the Deploy Preview origin (sourced only from the packaged deploy-origin.generated.json) to be allowed; got ${response.statusCode} ${response.body || ""} — logs: ${loggedErrors.join(" | ")}`
        );
      });

      await test("a genuinely disallowed origin is still rejected by the packaged bundle (the fix does not accidentally widen CORS)", async () => {
        const { response } = await invokePackagedAnilist(configuredExtractDir, {
          projectId: STAGING_PROJECT_ID,
          event: optionsEvent("https://not-a-real-deploy.example.com"),
        });
        assert.strictEqual(response.statusCode, 403);
      });
    }

    // ---- Scenario 2: the generated build-context file is entirely missing at packaging time
    // (a deliberately contrived worst case — in a real deploy `npm run build` always writes this
    // file, unconditionally, before Netlify ever bundles Functions). Must still fail closed. ----
    console.log("\nScenario: build-context.generated.json entirely missing at packaging time");
    if (fs.existsSync(BUILD_CONTEXT_PATH)) fs.unlinkSync(BUILD_CONTEXT_PATH);

    let missingFileExtractDir;
    await test("packaging still succeeds even with the generated file entirely absent (esbuild defers the failed require() to runtime rather than hard-failing the build, since it's wrapped in a try/catch)", async () => {
      missingFileExtractDir = await packageAndExtractAnilist();
    });

    if (missingFileExtractDir) {
      await test("the packaged handler still fails closed (500) when the generated file was missing at packaging time — never falls back to treating an unresolvable context as safe", async () => {
        const { response, loggedErrors } = await invokePackagedAnilist(missingFileExtractDir, {
          projectId: STAGING_PROJECT_ID,
          event: optionsEvent("https://staging--edenatlas.netlify.app"),
        });
        assert.strictEqual(response.statusCode, 500);
        assert.ok(
          loggedErrors.some((l) => l.includes("code=config/unknown-deploy-context")),
          `expected a config/unknown-deploy-context log line; got: ${loggedErrors.join(" | ")}`
        );
      });
    }

    // ---- Scenario 3: context/branch resolve correctly (Netlify's own automatic build metadata),
    // but STAGING_FIREBASE_PROJECT_ID itself was never configured — the exact scenario the
    // production incident's error code names. Must fail closed with the specific
    // config/staging-not-configured code, distinguishing it from scenario 2's total resolution
    // failure. ----
    console.log("\nScenario: staging branch-deploy context resolves, but STAGING_FIREBASE_PROJECT_ID is unset");
    withGeneratorEnv(
      { CONTEXT: "branch-deploy", BRANCH: "staging" },
      () => require("../../../../scripts/generate-function-context.js").generate()
    );

    let unconfiguredExtractDir;
    await test("packaging succeeds with context/branch set but no staging project id configured", async () => {
      unconfiguredExtractDir = await packageAndExtractAnilist();
    });

    if (unconfiguredExtractDir) {
      await test("the packaged handler fails closed with the specific config/staging-not-configured code — never silently permits an unconfigured staging deploy", async () => {
        const { response, loggedErrors } = await invokePackagedAnilist(unconfiguredExtractDir, {
          projectId: STAGING_PROJECT_ID,
          event: optionsEvent("https://staging--edenatlas.netlify.app"),
        });
        assert.strictEqual(response.statusCode, 500);
        assert.ok(
          loggedErrors.some((l) => l.includes("code=config/staging-not-configured")),
          `expected a config/staging-not-configured log line; got: ${loggedErrors.join(" | ")}`
        );
      });

      await test("the packaged handler never falls back to treating an unconfigured staging deploy as Production-trusted, even when handed Production's own project id", async () => {
        // Defense-in-depth: even if the caller's own FIREBASE_PROJECT_ID env var were somehow
        // Production's, an unconfigured staging build context must still refuse — PRE_PRODUCTION's
        // "never equal Production's project" check and its "staging must be configured" check are
        // both independent, unconditional refusals (see lib/firebase-admin.js's
        // enforceDeployContextPolicy()), not an either/or.
        const { response } = await invokePackagedAnilist(unconfiguredExtractDir, {
          projectId: "lfj-profolio",
          event: optionsEvent("https://staging--edenatlas.netlify.app"),
        });
        assert.strictEqual(response.statusCode, 500);
      });
    }
  } finally {
    restoreFile(BUILD_CONTEXT_PATH, buildContextBackup);
    restoreFile(DEPLOY_ORIGIN_PATH, deployOriginBackup);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    failures.forEach(({ name, err }) => console.error(`\n[FAILED] ${name}\n${err.stack || err}`));
    process.exit(1);
  }
})();
