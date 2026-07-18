// Minimal server-side health check for EdenAtlas's future Netlify Functions.
//
// Deliberately does nothing beyond confirming the Functions runtime itself is up:
// no env vars are read, no Firebase Admin SDK is loaded, no Firestore/network call is made.
// This is the first Netlify Function in the repo — it exists to prove the deploy pipeline
// (netlify.toml's `functions = "netlify/functions"`) works before any authenticated or
// AI-backed function is built on top of it. See docs/ai-architecture.md for what those
// future functions will need to do differently (auth, ownership checks, rate limits).
//
// Classic Netlify Functions (AWS Lambda-compatible) handler format — chosen over the newer
// Web-standard `export default` v2 format because this repo has no package.json (no build
// step, no `"type": "module"` declaration), so a plain CommonJS `exports.handler` is the
// least ambiguous, most broadly compatible option without adding any project tooling.

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        Allow: "GET",
      },
      body: JSON.stringify({ ok: false, error: "method_not_allowed" }),
    };
  }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    // Intentionally the entire payload: no timestamps, request IDs, deployment IDs, region,
    // internal paths, or env-derived values — nothing here should ever need to be scrubbed
    // before this response is safe to return to an unauthenticated caller.
    body: JSON.stringify({ ok: true, service: "edenatlas-functions" }),
  };
};
