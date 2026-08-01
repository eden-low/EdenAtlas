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

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    failures.forEach(({ name, err }) => console.error(`\n[FAILED] ${name}\n${err.stack || err}`));
    process.exit(1);
  }
})();
