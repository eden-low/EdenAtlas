#!/usr/bin/env node
// EdenAtlas — build-time Netlify CONTEXT/BRANCH snapshot for Netlify Functions' server-side
// environment isolation (backend/netlify/functions/lib/firebase-admin.js's
// assertProjectMatchesBuildContext()).
//
// Same pattern, same reasoning as scripts/generate-deploy-origin.js (read that file's header
// first): CONTEXT/BRANCH are build-step-only Netlify variables, not available inside a deployed
// Function's own process.env at runtime — confirmed against Netlify's docs, already cited there.
// This script runs as part of `npm run build`, BEFORE Netlify bundles Functions with esbuild, so
// whatever it writes to disk here is already present when backend/netlify/functions/*.js is bundled.
//
// STAGING_FIREBASE_PROJECT_ID is read here too (not just by scripts/generate-build-info.js's
// client-side snapshot) so the SERVER side has an independent way to know "what project id should
// a genuinely-isolated Staging deploy be using" — see lib/firebase-admin.js's
// assertProjectMatchesBuildContext() for how this closes the "service-account project_id does not
// match the expected staging project" failure mode. Not a secret — it's a Firebase project id,
// the same public-config category as every other *_PROJECT_ID value in this codebase.
//
// Run: `node scripts/generate-function-context.js` (also what `npm run build` runs).

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(ROOT, "backend", "netlify", "functions", "lib", "build-context.generated.json");

function rawOrNull(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function generate() {
  const config = {
    context: rawOrNull(process.env.CONTEXT),
    branch: rawOrNull(process.env.BRANCH),
    expectedStagingProjectId: rawOrNull(process.env.STAGING_FIREBASE_PROJECT_ID),
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  console.log(
    `generate-function-context: wrote ${path.relative(ROOT, OUT_PATH)} ` +
    `(context=${config.context || "null"}, branch=${config.branch || "null"}, expectedStagingProjectId=${config.expectedStagingProjectId ? "set" : "unset"})`
  );
  return config;
}

if (require.main === module) {
  generate();
}

module.exports = { generate, OUT_PATH };
