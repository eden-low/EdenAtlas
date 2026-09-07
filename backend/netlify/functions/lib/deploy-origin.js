// backend/netlify/functions/lib/deploy-origin.js — reads the build-time Deploy Preview origin snapshot
// scripts/generate-deploy-origin.js wrote before Functions were bundled (see that file's header
// comment for why DEPLOY_PRIME_URL/DEPLOY_URL can't just be read from process.env here directly —
// confirmed against Netlify's own docs that they're build-step-only, not Function-runtime env).
//
// This is the one place backend/netlify/functions/anilist.js reads that generated file. Degrades to
// {deployPrimeUrl: null, deployUrl: null} — never throws — if the file is missing (a fresh
// checkout before the first `npm run build`, or any environment that never ran the build step):
// Discover still works from the production origin and any ALLOWED_ORIGIN-configured origin, it
// just can't also allow a Deploy Preview origin until a real build has run.
//
// Uses the exact same require()-with-a-literal-specifier fix as lib/build-context.js, for the
// exact same proven root cause — see that file's header comment for the full diagnosis (verified
// against the real @netlify/zip-it-and-ship-it + esbuild packaging output, not assumed): the old
// fs.readFileSync(path.join(__dirname, ...)) approach broke once esbuild bundled this module's
// code into backend/netlify/functions/anilist.js's single output file, because __dirname inside that
// bundle reflects the bundle's own location (backend/netlify/functions/), not this file's original
// location (backend/netlify/functions/lib/) — one directory below where `included_files` actually placed
// the copied JSON. A literal `require("./x.json")` sidesteps the whole problem: esbuild inlines
// the parsed JSON directly into the bundle at build time, so there is no runtime path to resolve
// at all.

function readGeneratedDeployOrigins() {
  let parsed;
  try {
    // Literal specifier required — see lib/build-context.js's identical comment for why a
    // variable or path.join()-built path would defeat esbuild's static bundling here.
    parsed = require("./deploy-origin.generated.json");
  } catch {
    return { deployPrimeUrl: null, deployUrl: null };
  }
  if (!parsed || typeof parsed !== "object") {
    return { deployPrimeUrl: null, deployUrl: null };
  }
  return {
    deployPrimeUrl: typeof parsed.deployPrimeUrl === "string" ? parsed.deployPrimeUrl : null,
    deployUrl: typeof parsed.deployUrl === "string" ? parsed.deployUrl : null,
  };
}

// Test-only escape hatch — see lib/build-context.js's invalidateCache() for the full reasoning
// (identical: Node's require() cache would otherwise hide a mid-test file rewrite).
function invalidateCache() {
  let resolved;
  try {
    resolved = require.resolve("./deploy-origin.generated.json");
  } catch {
    return;
  }
  delete require.cache[resolved];
}

module.exports = { readGeneratedDeployOrigins, invalidateCache };
