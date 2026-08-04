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
// Run with: node netlify/functions/__tests__/staging-isolation-wiring.test.js (or
// `npm run test:functions`).

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const FUNCTIONS_WITH_ADMIN = [
  "anilist.js", "discover-ai.js", "assistant.js", "weather.js", "anime-airing-check.js",
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
    const src = fs.readFileSync(path.join(ROOT, "netlify", "functions", file), "utf8");

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

  await test("netlify/functions/lib/build-context.js: readGeneratedBuildContext() always returns a well-shaped object, even when the generated file is absent", () => {
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
    assert.ok(gitignore.includes("/netlify/functions/lib/build-context.generated.json"));
    assert.ok(gitignore.includes("/js/fcm-config.generated.js"));
  });

  // ---- Root-cause regression coverage: the "config/staging-not-configured" production
  // incident on staging--edenatlas.netlify.app. Diagnosis (see netlify.toml's `[functions]
  // included_files` comment for the full writeup): the esbuild Function bundler only follows
  // this codebase's require()/import graph — unlike Netlify's default (non-esbuild) bundler, it
  // does NOT statically detect a runtime `fs.readFileSync()` call and auto-include the file it
  // reads, so build-context.generated.json (read by lib/build-context.js, never require()'d as a
  // module) was not guaranteed to ship inside a deployed Function's bundle even though the build
  // step correctly wrote it to disk with the right content. The generator script itself and the
  // read-path module were both already correct — proven below by exercising them directly rather
  // than assuming — so a missing/absent file at Function runtime is a bundling gap, not a logic
  // bug in either of those two files. This section proves the REAL build wiring end to end (the
  // actual generate-function-context.js generate(), the actual bytes on disk, and the actual
  // readGeneratedBuildContext() import path every Function calls) — complementing, not
  // replacing, assistant.test.js's "Deploy-context policy" section, which unit-tests
  // enforceDeployContextPolicy()/resolveDeployRole() against hand-built fixtures rather than a
  // real generator round-trip. What this suite still cannot do, absent a real Netlify bundler in
  // this environment: prove the file ships inside an actual deployed Function .zip — the
  // included_files structural test at the end of this section is the closest available proxy.
  console.log("\nBuild-time staging project id — real generator + real import-path integration coverage");

  const { generate: generateFunctionContext, OUT_PATH: FUNCTION_CONTEXT_OUT_PATH } =
    require("../../../scripts/generate-function-context.js");
  const { readGeneratedBuildContext } = require("../lib/build-context.js");
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
    });

    await test("the real import path (readGeneratedBuildContext — the exact function every Firebase-Admin Function calls) exposes the just-generated staging project id", () => {
      // No require.cache invalidation needed: readGeneratedBuildContext() re-reads the file from
      // disk on every call (see lib/build-context.js) rather than caching parsed content at
      // require() time — this call is proof of that, not an assumption.
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
      const buildContext = readGeneratedBuildContext();
      assert.strictEqual(buildContext.expectedStagingProjectId, null);
      assert.throws(
        () => enforceDeployContextPolicy({ resolvedProjectId: "edenatlas-staging", buildContext, env: {} }),
        (err) => err instanceof FirebaseConfigError && err.code === "config/staging-not-configured"
      );
    });
  } finally {
    if (hadExistingGeneratedFile) {
      fs.writeFileSync(FUNCTION_CONTEXT_OUT_PATH, existingGeneratedFileContents, "utf8");
    } else if (fs.existsSync(FUNCTION_CONTEXT_OUT_PATH)) {
      fs.unlinkSync(FUNCTION_CONTEXT_OUT_PATH);
    }
  }

  await test("netlify.toml: [functions] declares included_files covering netlify/functions/lib/*.generated.json — the actual bundling fix, so build-context.generated.json/deploy-origin.generated.json are guaranteed to ship inside every deployed Function's esbuild bundle instead of depending on bundler auto-detection", () => {
    const toml = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
    const functionsBlockMatch = /\[functions\]([\s\S]*?)(?=\n\[|$)/.exec(toml);
    assert.ok(functionsBlockMatch, "netlify.toml has no [functions] block");
    const block = functionsBlockMatch[1];
    assert.ok(/node_bundler\s*=\s*"esbuild"/.test(block), 'expected node_bundler = "esbuild" inside [functions]');
    const includedFilesMatch = /included_files\s*=\s*\[([^\]]*)\]/.exec(block);
    assert.ok(includedFilesMatch, "[functions] does not declare included_files at all");
    assert.ok(
      /netlify\/functions\/lib\/\*\.generated\.json/.test(includedFilesMatch[1]),
      `included_files does not cover netlify/functions/lib/*.generated.json — found: ${includedFilesMatch[1]}`
    );
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    failures.forEach(({ name, err }) => console.error(`\n[FAILED] ${name}\n${err.stack || err}`));
    process.exit(1);
  }
})();
