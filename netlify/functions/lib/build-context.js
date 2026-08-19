// netlify/functions/lib/build-context.js — reads the build-time Netlify CONTEXT/BRANCH snapshot
// scripts/generate-function-context.js wrote before Functions were bundled.
//
// Why this exists: confirmed against Netlify's own docs (same source already cited in
// lib/deploy-origin.js's header comment) that only URL/SITE_NAME/SITE_ID are available to a
// Function at RUNTIME — CONTEXT and BRANCH are build-step-only variables, real inside `npm run
// build` but undefined inside the deployed Function's own process.env. Exactly the same problem
// lib/deploy-origin.js already solved for DEPLOY_PRIME_URL/DEPLOY_URL, solved the same way here:
// a small generator script runs during `npm run build` (before Netlify bundles Functions with
// esbuild) and snapshots the two values to disk, where they get bundled into the Function and are
// readable at runtime as a plain file.
//
// This is the server-side twin of js/environment.js's browser-side build-info snapshot — SAME
// underlying Netlify build metadata, captured into two separate generated files (one consumable
// by a browser <script> tag, one consumable by a bundled CommonJS Function) because a browser
// script and a Netlify Function have no way to share a single file at their respective runtimes.
//
// `expectedStagingProjectId` is the Firebase project id a genuinely-isolated Staging deploy
// SHOULD be using — sourced from the exact same STAGING_FIREBASE_PROJECT_ID build env var
// firebase-init.js's client-side override already reads (see generate-build-info.js), captured
// here too so netlify/functions/lib/firebase-admin.js's assertProjectMatchesBuildContext() can
// cross-check the server-side Admin credential's own project id against it — an INDEPENDENT
// signal from FIREBASE_PROJECT_ID/FIREBASE_SERVICE_ACCOUNT themselves, so a misconfiguration that
// mixes up which project those two vars point to is still caught.
//
// Degrades to {context: null, branch: null, expectedStagingProjectId: null} — never throws — if
// the file is missing (a fresh checkout before the first `npm run build`, or any environment that
// never ran the build step): every consumer treats a null context as "unknown, not verifiably
// Staging" and applies no Staging-specific restriction, matching Production's own unrestricted
// behavior (fail-open here would be wrong the other way around; see firebase-admin.js's own
// comment on why "unknown" is deliberately NOT treated as "assume Staging").
//
// Root cause of a real "config/unknown-deploy-context" production incident on the staging branch
// deploy, proven against the actual Netlify Function packaging mechanism (@netlify/zip-it-and-
// ship-it + esbuild), not assumed: this file used to compute
// `path.join(__dirname, "build-context.generated.json")` and read it with fs.readFileSync().
// esbuild bundles netlify/functions/anilist.js (and friends) into ONE output file that keeps the
// ENTRY file's own original relative path inside the deployed archive
// (netlify/functions/anilist.js) — but every module IT required, including this one, gets INLINED
// into that same physical file. At runtime, `__dirname` reflects where the file *actually sitting
// on disk* lives, not where the original per-module source file used to live — so inside the
// bundle, `__dirname` resolved to `netlify/functions/`, one directory ABOVE this file's real
// original location (`netlify/functions/lib/`). `included_files` (a prior fix attempt) DID
// correctly copy build-context.generated.json into the deployed archive — verified by unzipping a
// real packaged Function — but it preserves the file's ORIGINAL relative path
// (netlify/functions/lib/build-context.generated.json), which no longer matches the bundle's
// collapsed __dirname. The fix: require() the JSON with a literal, statically-analyzable
// specifier instead of reading it via fs at an __dirname-relative path. esbuild resolves and
// inlines a literal `require("./x.json")` directly into the bundle AT BUILD TIME as parsed data —
// there is no runtime file lookup left to get wrong, in either the bundled Function or a plain
// unbundled `node netlify/functions/...` invocation (Node's own require() resolves a JSON module
// relative to the requiring file exactly as `fs`+`__dirname` used to, which is why this still
// works identically for local test runs). Node's require() cache means the SAME already-loaded
// value is returned on every call within one process/bundle — correct and intentional here, since
// this value is fixed for the lifetime of one build/deploy — but a test that regenerates this file
// mid-run needs to bust that cache explicitly; invalidateCache() below exists for exactly that
// (see staging-isolation-wiring.test.js, which is also the reason this cache-busting logic lives
// here once rather than being reimplemented per test file).

function readGeneratedBuildContext() {
  let parsed;
  try {
    // Literal specifier required — esbuild only statically resolves/inlines a require() call
    // whose module path is a plain string constant written directly in the call itself, not one
    // built from a variable or path.join() at runtime.
    parsed = require("./build-context.generated.json");
  } catch {
    return { context: null, branch: null, expectedStagingProjectId: null };
  }
  if (!parsed || typeof parsed !== "object") {
    return { context: null, branch: null, expectedStagingProjectId: null };
  }
  return {
    context: typeof parsed.context === "string" ? parsed.context : null,
    branch: typeof parsed.branch === "string" ? parsed.branch : null,
    expectedStagingProjectId: typeof parsed.expectedStagingProjectId === "string" ? parsed.expectedStagingProjectId : null,
  };
}

// True only for the one real, stable Staging branch-deploy — mirrors js/environment.js's
// resolveEnvironment() logic exactly (an ad-hoc branch deploy for some OTHER branch is
// deliberately NOT treated as Staging, same reasoning as that file).
function isStagingBuildContext(buildContext) {
  return !!buildContext && buildContext.context === "branch-deploy" && buildContext.branch === "staging";
}

// Test-only escape hatch: Node's require() cache means a test that overwrites
// build-context.generated.json on disk (to exercise a second scenario in the same process) would
// otherwise keep seeing the FIRST value forever. Production code never calls this — a deployed
// Function's bundle has exactly one, build-time-frozen copy of this data by design (see the header
// comment above), so there is nothing to invalidate outside a test process that mutates the file
// live. No-ops safely if the module was never successfully required in the first place.
function invalidateCache() {
  let resolved;
  try {
    resolved = require.resolve("./build-context.generated.json");
  } catch {
    return;
  }
  delete require.cache[resolved];
}

module.exports = { readGeneratedBuildContext, isStagingBuildContext, invalidateCache };
