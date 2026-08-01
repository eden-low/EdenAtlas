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

const fs = require("fs");
const path = require("path");

const GENERATED_PATH = path.join(__dirname, "build-context.generated.json");

function readGeneratedBuildContext() {
  try {
    const raw = fs.readFileSync(GENERATED_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      context: typeof parsed.context === "string" ? parsed.context : null,
      branch: typeof parsed.branch === "string" ? parsed.branch : null,
      expectedStagingProjectId: typeof parsed.expectedStagingProjectId === "string" ? parsed.expectedStagingProjectId : null,
    };
  } catch {
    return { context: null, branch: null, expectedStagingProjectId: null };
  }
}

// True only for the one real, stable Staging branch-deploy — mirrors js/environment.js's
// resolveEnvironment() logic exactly (an ad-hoc branch deploy for some OTHER branch is
// deliberately NOT treated as Staging, same reasoning as that file).
function isStagingBuildContext(buildContext) {
  return !!buildContext && buildContext.context === "branch-deploy" && buildContext.branch === "staging";
}

module.exports = { readGeneratedBuildContext, isStagingBuildContext, GENERATED_PATH };
