// Structural regression guards for Gap 1 (Staging/Production Firebase Admin isolation): proves,
// by reading the actual shipped source of every Function that initializes Firebase Admin, that
// each one actually wires the new buildContext-aware deploy-context policy through — not just
// that lib/firebase-admin.js's enforceDeployContextPolicy()/resolveDeployRole() exist and work in
// isolation (see assistant.test.js's own dedicated "Deploy-context policy" section for that). A
// future new Function (or an edit to an existing one) that forgets to pass `buildContext` would
// silently fall into DEPLOY_ROLE.UNKNOWN, which now ALWAYS fails closed regardless of context —
// so the failure mode for a missing wire-up is "this Function never works at all," not a silent
// security gap, but it's still worth catching here directly rather than via a confusing runtime
// failure.
//
// Run with: node backend/netlify/functions/__tests__/staging-isolation-wiring.test.js (or
// `npm run test:functions`).

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const FUNCTIONS_WITH_ADMIN = [
  "anilist.js", "discover-ai.js", "assistant.js", "weather.js", "anime-airing-check.js",
  "expense-receipt-ai.js",
];

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

(async () => {
  for (const file of FUNCTIONS_WITH_ADMIN) {
    const src = fs.readFileSync(path.join(ROOT, "backend", "netlify", "functions", file), "utf8");

    await test(`${file}: requires lib/build-context.js and passes readGeneratedBuildContext() as buildContext into initializeFirebaseAdmin()`, () => {
      assert.ok(/require\(["']\.\/lib\/build-context["']\)/.test(src), `${file} does not require ./lib/build-context`);
      assert.ok(/readGeneratedBuildContext\s*\(\s*\)/.test(src), `${file} never calls readGeneratedBuildContext()`);
      // The initializeFirebaseAdmin({...}) call block itself must reference buildContext — either
      // inline (`buildContext: readGeneratedBuildContext()`) or via a local variable that was
      // itself assigned from readGeneratedBuildContext() (`const buildContext =
      // readGeneratedBuildContext(); ... initializeFirebaseAdmin({ ..., buildContext, ... })`,
      // anime-airing-check.js's own shape — it also exposes buildContext on the returned deps
      // object for its own dry-run-default logic, so a single read is reused for both purposes).
      // Matched as a contiguous slice from "initializeFirebaseAdmin({" to the next "});" so this
      // can't pass merely because the strings appear SOMEWHERE unrelated in the file.
      const callMatch = /initializeFirebaseAdmin\(\{[\s\S]*?\}\);/.exec(src);
      assert.ok(callMatch, `${file}: could not find an initializeFirebaseAdmin({...}) call block`);
      const referencesBuildContext = /\bbuildContext\b\s*[:,}]/.test(callMatch[0]);
      assert.ok(referencesBuildContext, `${file}: initializeFirebaseAdmin({...}) call block does not reference buildContext at all`);
      if (/buildContext:\s*readGeneratedBuildContext\(\)/.test(callMatch[0])) {
        return; // inline form — already proven directly
      }
      // Shorthand/variable form — confirm the variable actually originates from
      // readGeneratedBuildContext(), not some unrelated local named buildContext.
      assert.ok(
        /const\s+buildContext\s*=\s*readGeneratedBuildContext\(\)/.test(src),
        `${file}: a "buildContext" variable is referenced but never assigned from readGeneratedBuildContext()`
      );
    });

    await test(`${file}: every Firestore/Auth/Messaging call site is scoped to getX(ensureApp()) — never a second, independently-initialized Admin app`, () => {
      // A literal-substring check, not a generic paren-matching regex — deliberately: `getX(...)`
      // calls in this codebase always take ensureApp() as their sole argument
      // (getFirestore(ensureApp()), getAuth(ensureApp()), getMessaging(ensureApp())), and a
      // naive `[^)]*` capture group breaks the moment the argument itself contains a nested `()`
      // (exactly what ensureApp() is). For each service actually imported in this file, every
      // bare `getX(` call site must be immediately followed by `ensureApp())` — proving Owner-
      // token verification and Firestore/FCM reads/writes are all scoped to the SAME app
      // instance the isolation check above already validated.
      ["getFirestore", "getAuth", "getMessaging"].forEach((fn) => {
        const importLine = src.split("\n").find((l) => new RegExp(`\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*=\\s*require\\("firebase-admin/`).test(l));
        if (!importLine) return; // this Function doesn't use this service at all — nothing to check
        // `const { getFirestore } = require(...)` never matches `getFirestore(` (no open paren
        // right after the name there), so every match below is a genuine call site.
        const callSites = [...src.matchAll(new RegExp(`\\b${fn}\\(`, "g"))];
        assert.ok(callSites.length > 0, `${file}: imports ${fn} but never calls it`);
        callSites.forEach((m) => {
          const after = src.slice(m.index, m.index + fn.length + "(ensureApp())".length);
          assert.strictEqual(after, `${fn}(ensureApp())`, `${file}: a "${fn}(" call site is not immediately "${fn}(ensureApp())" — found "${after}"`);
        });
      });
    });
  }

  await test("backend/netlify/functions/lib/build-context.js: readGeneratedBuildContext() always returns a well-shaped object, even when the generated file is absent", () => {
    const { readGeneratedBuildContext } = require("../lib/build-context.js");
    const info = readGeneratedBuildContext();
    assert.ok(info && typeof info === "object");
    ["context", "branch", "expectedStagingProjectId"].forEach((key) => {
      assert.ok(info[key] === null || typeof info[key] === "string", `${key} must be null or a string, got ${typeof info[key]}`);
    });
  });

  await test("isStagingBuildContext(): only true for context=branch-deploy AND branch=staging — same rule as js/environment.js's resolveEnvironment()", () => {
    const { isStagingBuildContext } = require("../lib/build-context.js");
    assert.strictEqual(isStagingBuildContext({ context: "branch-deploy", branch: "staging" }), true);
    assert.strictEqual(isStagingBuildContext({ context: "branch-deploy", branch: "some-other-branch" }), false);
    assert.strictEqual(isStagingBuildContext({ context: "production", branch: "staging" }), false);
    assert.strictEqual(isStagingBuildContext(null), false);
    assert.strictEqual(isStagingBuildContext({}), false);
  });

  await test(".gitignore covers the new generated build-context/fcm-config files, matching every other generated-output entry's treatment", () => {
    const gitignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
    assert.ok(gitignore.includes("/backend/netlify/functions/lib/build-context.generated.json"));
    assert.ok(gitignore.includes("/frontend/js/fcm-config.generated.js"));
  });

  // ---- Root-cause regression coverage: the "config/unknown-deploy-context" /
  // "config/staging-not-configured" production incident on staging--edenatlas.netlify.app.
  // Diagnosis (see lib/build-context.js's/lib/deploy-origin.js's header comments for the full
  // writeup, proven against the real @netlify/zip-it-and-ship-it + esbuild packaging output, not
  // assumed — see backend/netlify/functions/__tests__/staging-packaging.test.js for that heavier,
  // dedicated proof): an EARLIER fix attempt added `included_files` to netlify.toml, on the
  // (reasonable but ultimately wrong) theory that the generated JSON simply wasn't being copied
  // into the deployed archive at all. It WAS being copied — but esbuild collapses every module a
  // bundled entry point requires into ONE physical output file that keeps the ENTRY point's own
  // relative path, so `__dirname` inside that bundle no longer matches the original per-module
  // source file's directory, and a `path.join(__dirname, "...")`-based fs read ends up looking one
  // directory too high regardless of included_files. The actual fix: require() the JSON with a
  // literal, statically-analyzable specifier, which esbuild inlines directly into the bundle at
  // build time — no runtime file path left to get wrong. This section proves the REAL build wiring
  // end to end at the SOURCE/IMPORT level (the actual generate-function-context.js generate(), the
  // actual bytes on disk, and the actual readGeneratedBuildContext() import path every Function
  // calls) — complementing, not replacing, assistant.test.js's "Deploy-context policy" section
  // (hand-built fixtures) and staging-packaging.test.js (the real packaged-bundle proof).
  //
  // Module-cache note (Node's require() cache, not a bug): readGeneratedBuildContext() now loads
  // the generated JSON via require(), which Node caches by resolved path — calling it again after
  // this suite rewrites the file on disk would otherwise keep returning the FIRST value forever.
  // invalidateCache() (exported by lib/build-context.js specifically for this) is called after
  // every regeneration below, immediately before the next read — this is NOT needed in production
  // (a deployed Function's bundle has exactly one, build-time-frozen copy of this data; nothing
  // ever rewrites it mid-process), only in a test process that mutates the file live.
  console.log("\nBuild-time staging project id — real generator + real import-path integration coverage");

  const { generate: generateFunctionContext, OUT_PATH: FUNCTION_CONTEXT_OUT_PATH } =
    require("../../../../scripts/generate-function-context.js");
  const { readGeneratedBuildContext, invalidateCache: invalidateBuildContextCache } = require("../lib/build-context.js");
  const { enforceDeployContextPolicy, FirebaseConfigError } = require("../lib/firebase-admin.js");

  const GENERATOR_ENV_KEYS = ["CONTEXT", "BRANCH", "STAGING_FIREBASE_PROJECT_ID"];
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

  // Preserve whatever build-context.generated.json already exists on disk (e.g. left over from a
  // real `npm run build` in this checkout) so this suite never leaves a surprising staging-shaped
  // file behind for a later local build/deploy to accidentally pick up stale — same hygiene
  // scripts/__tests__/generate-build-info.test.js's withEnv() already applies to env vars, applied
  // here to a file instead.
  const hadExistingGeneratedFile = fs.existsSync(FUNCTION_CONTEXT_OUT_PATH);
  const existingGeneratedFileContents = hadExistingGeneratedFile
    ? fs.readFileSync(FUNCTION_CONTEXT_OUT_PATH, "utf8")
    : null;

  try {
    const STAGING_ENV = { CONTEXT: "branch-deploy", BRANCH: "staging", STAGING_FIREBASE_PROJECT_ID: "edenatlas-staging" };

    await test("real generate-function-context.js, given the exact Netlify staging branch-deploy env (CONTEXT=branch-deploy BRANCH=staging STAGING_FIREBASE_PROJECT_ID=edenatlas-staging), writes expectedStagingProjectId to disk", () => {
      const written = withGeneratorEnv(STAGING_ENV, () => generateFunctionContext());
      assert.strictEqual(written.context, "branch-deploy");
      assert.strictEqual(written.branch, "staging");
      assert.strictEqual(written.expectedStagingProjectId, "edenatlas-staging");
      const onDisk = JSON.parse(fs.readFileSync(FUNCTION_CONTEXT_OUT_PATH, "utf8"));
      assert.deepStrictEqual(onDisk, { context: "branch-deploy", branch: "staging", expectedStagingProjectId: "edenatlas-staging" });
      invalidateBuildContextCache();
    });

    await test("the real import path (readGeneratedBuildContext — the exact function every Firebase-Admin Function calls) exposes the just-generated staging project id", () => {
      const info = readGeneratedBuildContext();
      assert.deepStrictEqual(info, { context: "branch-deploy", branch: "staging", expectedStagingProjectId: "edenatlas-staging" });
    });

    await test("end to end: enforceDeployContextPolicy accepts the edenatlas-staging project once the real generator + real import path both round-trip it", () => {
      const buildContext = readGeneratedBuildContext();
      assert.doesNotThrow(() =>
        enforceDeployContextPolicy({ resolvedProjectId: "edenatlas-staging", buildContext, env: {} })
      );
    });

    await test("fail-closed is retained through the real generator: a staging branch-deploy with STAGING_FIREBASE_PROJECT_ID unset still writes expectedStagingProjectId:null, and enforceDeployContextPolicy still rejects it (config/staging-not-configured)", () => {
      const written = withGeneratorEnv({ CONTEXT: "branch-deploy", BRANCH: "staging" }, () => generateFunctionContext());
      assert.strictEqual(written.expectedStagingProjectId, null);
      invalidateBuildContextCache();
      const buildContext = readGeneratedBuildContext();
      assert.strictEqual(buildContext.expectedStagingProjectId, null);
      assert.throws(
        () => enforceDeployContextPolicy({ resolvedProjectId: "edenatlas-staging", buildContext, env: {} }),
        (err) => err instanceof FirebaseConfigError && err.code === "config/staging-not-configured"
      );
    });

    await test("readGeneratedBuildContext() returns a fresh read after invalidateCache() — proves the cache-busting helper itself works, not just that this suite happens to pass", () => {
      withGeneratorEnv(STAGING_ENV, () => generateFunctionContext());
      invalidateBuildContextCache();
      const first = readGeneratedBuildContext();
      assert.strictEqual(first.expectedStagingProjectId, "edenatlas-staging");
      // Overwrite on disk WITHOUT going through the real generator or busting the cache — a
      // stand-in for "the file changed underneath an already-warm require() cache."
      fs.writeFileSync(FUNCTION_CONTEXT_OUT_PATH, JSON.stringify({ context: "branch-deploy", branch: "staging", expectedStagingProjectId: "changed-mid-test" }), "utf8");
      const stale = readGeneratedBuildContext();
      assert.strictEqual(stale.expectedStagingProjectId, "edenatlas-staging", "require() cache should still hold the pre-overwrite value until invalidated");
      invalidateBuildContextCache();
      const fresh = readGeneratedBuildContext();
      assert.strictEqual(fresh.expectedStagingProjectId, "changed-mid-test", "invalidateCache() should force the next read to reflect the on-disk change");
    });
  } finally {
    invalidateBuildContextCache();
    if (hadExistingGeneratedFile) {
      fs.writeFileSync(FUNCTION_CONTEXT_OUT_PATH, existingGeneratedFileContents, "utf8");
    } else if (fs.existsSync(FUNCTION_CONTEXT_OUT_PATH)) {
      fs.unlinkSync(FUNCTION_CONTEXT_OUT_PATH);
    }
    invalidateBuildContextCache();
  }

  await test("lib/build-context.js and lib/deploy-origin.js both load their generated JSON via a literal, statically-analyzable require() — never an __dirname-relative fs.readFileSync(), which is what actually broke under esbuild bundling (see staging-packaging.test.js for the real-packaged-bundle proof of this)", () => {
    // Comments deliberately narrate the OLD, broken __dirname-relative pattern for future
    // readers — strip them first (same technique assistant.test.js's stripComments() already
    // uses) so this check inspects only live code, not its own explanatory prose.
    const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const buildContextSrc = stripComments(fs.readFileSync(path.join(ROOT, "backend", "netlify", "functions", "lib", "build-context.js"), "utf8"));
    const deployOriginSrc = stripComments(fs.readFileSync(path.join(ROOT, "backend", "netlify", "functions", "lib", "deploy-origin.js"), "utf8"));
    assert.ok(/require\(["']\.\/build-context\.generated\.json["']\)/.test(buildContextSrc), "build-context.js must require('./build-context.generated.json') with a literal specifier");
    assert.ok(/require\(["']\.\/deploy-origin\.generated\.json["']\)/.test(deployOriginSrc), "deploy-origin.js must require('./deploy-origin.generated.json') with a literal specifier");
    assert.ok(!/path\.join\(__dirname,\s*["']build-context\.generated\.json["']\)/.test(buildContextSrc), "build-context.js must not go back to an __dirname-relative fs path for the generated file");
    assert.ok(!/path\.join\(__dirname,\s*["']deploy-origin\.generated\.json["']\)/.test(deployOriginSrc), "deploy-origin.js must not go back to an __dirname-relative fs path for the generated file");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    failures.forEach(({ name, err }) => console.error(`\n[FAILED] ${name}\n${err.stack || err}`));
    process.exit(1);
  }
})();
