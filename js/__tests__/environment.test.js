// Deterministic tests for js/environment.js — the Development/Staging/Production detection this
// pass's whole Phase 1 safeguard set depends on (which Firebase project loads, whether Discover
// writes are blocked, the non-Production banner, the noindex header). resolveEnvironment() is
// tested as the pure function it is (explicit fixture inputs, no globals); getEnvironment()/
// isStaging()/isPreProduction()/mountNonProductionBanner() are tested against a real jsdom
// `window`/`document` so the actual window.__EDEN_BUILD__ wiring (not just the pure helper) is
// exercised.
//
// Run with: node js/__tests__/environment.test.js (or `npm run test:frontend`).

import assert from "node:assert";
import { JSDOM } from "jsdom";

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

const {
  ENV, resolveEnvironment, selectFirebaseConfig,
} = await import("../environment.js");

(async () => {
  // ---- resolveEnvironment(): pure function, every real Netlify context ----

  await test("Netlify production context resolves to PRODUCTION only on the configured Production branch (main)", async () => {
    assert.strictEqual(resolveEnvironment({ netlifyContext: "production", branch: "main", hostname: "edenatlas.netlify.app" }), ENV.PRODUCTION);
  });

  await test("Netlify production context on any OTHER branch is never trusted as PRODUCTION (deploy-context policy: 'never silently fall back')", async () => {
    assert.notStrictEqual(resolveEnvironment({ netlifyContext: "production", branch: "staging" }), ENV.PRODUCTION);
    assert.notStrictEqual(resolveEnvironment({ netlifyContext: "production", branch: "some-hotfix-branch" }), ENV.PRODUCTION);
  });

  await test("Netlify dev context resolves to ENV.DEV", async () => {
    assert.strictEqual(resolveEnvironment({ netlifyContext: "dev" }), ENV.DEV);
  });

  await test("branch-deploy + branch=staging resolves to STAGING", async () => {
    assert.strictEqual(resolveEnvironment({ netlifyContext: "branch-deploy", branch: "staging" }), ENV.STAGING);
  });

  await test("branch-deploy for any OTHER branch is DEPLOY_PREVIEW-like, never STAGING", async () => {
    assert.strictEqual(resolveEnvironment({ netlifyContext: "branch-deploy", branch: "feat/discover-staging-push" }), ENV.DEPLOY_PREVIEW);
    assert.strictEqual(resolveEnvironment({ netlifyContext: "branch-deploy", branch: "Staging" }), ENV.DEPLOY_PREVIEW); // case-sensitive on purpose
  });

  await test("deploy-preview context resolves to DEPLOY_PREVIEW", async () => {
    assert.strictEqual(resolveEnvironment({ netlifyContext: "deploy-preview", branch: "pr-123" }), ENV.DEPLOY_PREVIEW);
  });

  await test("no build info at all (never built) falls back to hostname, then DEVELOPMENT", async () => {
    assert.strictEqual(resolveEnvironment({ hostname: "edenatlas.netlify.app" }), ENV.PRODUCTION);
    assert.strictEqual(resolveEnvironment({ hostname: "localhost" }), ENV.DEVELOPMENT);
    assert.strictEqual(resolveEnvironment({}), ENV.DEVELOPMENT);
  });

  await test("an unrecognized netlifyContext string never accidentally resolves to PRODUCTION", async () => {
    assert.notStrictEqual(resolveEnvironment({ netlifyContext: "bogus", hostname: "example.com" }), ENV.PRODUCTION);
  });

  await test("Firebase config mapping isolates Development while preserving Production and pre-production selection", async () => {
    const configs = {
      productionConfig: { projectId: "production-project" },
      stagingConfig: { projectId: "staging-project" },
      preProductionPlaceholderConfig: { projectId: "preproduction-unconfigured" },
      developmentPlaceholderConfig: { projectId: "development-unconfigured" },
    };
    assert.strictEqual(selectFirebaseConfig({ ...configs, environment: ENV.PRODUCTION }).projectId, "production-project");
    assert.strictEqual(selectFirebaseConfig({ ...configs, environment: ENV.STAGING }).projectId, "staging-project");
    assert.strictEqual(selectFirebaseConfig({ ...configs, environment: ENV.DEPLOY_PREVIEW }).projectId, "staging-project");
    assert.strictEqual(selectFirebaseConfig({ ...configs, environment: ENV.DEV }).projectId, "development-unconfigured");
    assert.strictEqual(selectFirebaseConfig({ ...configs, environment: ENV.DEVELOPMENT }).projectId, "development-unconfigured");
    assert.notStrictEqual(
      selectFirebaseConfig({ ...configs, environment: ENV.DEVELOPMENT }).projectId,
      configs.productionConfig.projectId
    );
  });

  await test("Firebase config mapping fails closed when a pre-production config is missing", async () => {
    const selected = selectFirebaseConfig({
      environment: ENV.DEPLOY_PREVIEW,
      productionConfig: { projectId: "production-project" },
      stagingConfig: null,
      preProductionPlaceholderConfig: { projectId: "preproduction-unconfigured" },
      developmentPlaceholderConfig: { projectId: "development-unconfigured" },
    });
    assert.strictEqual(selected.projectId, "preproduction-unconfigured");
    assert.notStrictEqual(selected.projectId, "production-project");
  });

  // ---- getEnvironment()/isStaging()/isProduction()/isNonProduction() wired through a real
  // window.__EDEN_BUILD__ (jsdom), proving the actual module-level plumbing, not just the pure
  // helper in isolation. ----

  async function withBuildInfo(buildInfo, hostname, fn) {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: `https://${hostname}/` });
    global.window = dom.window;
    global.document = dom.window.document;
    global.location = dom.window.location;
    if (buildInfo) dom.window.__EDEN_BUILD__ = buildInfo;
    // Fresh module instance per test (Node ESM caches by specifier) isn't trivial without a
    // cache-buster; instead the module's own _resetBuildInfoCacheForTests() exists exactly for
    // this — re-import the SAME module instance and force it to re-read window.__EDEN_BUILD__.
    const mod = await import("../environment.js");
    mod._resetBuildInfoCacheForTests();
    try {
      await fn(mod);
    } finally {
      mod._resetBuildInfoCacheForTests();
      delete global.window;
      delete global.document;
      delete global.location;
    }
  }

  await test("getEnvironment()/isStaging() reflect a real window.__EDEN_BUILD__ staging snapshot", async () => {
    await withBuildInfo({ context: "branch-deploy", branch: "staging" }, "staging--edenatlas.netlify.app", async (mod) => {
      assert.strictEqual(mod.getEnvironment(), mod.ENV.STAGING);
      assert.strictEqual(mod.isStaging(), true);
      assert.strictEqual(mod.isProduction(), false);
      assert.strictEqual(mod.isNonProduction(), true);
    });
  });

  await test("getEnvironment() reflects a real window.__EDEN_BUILD__ production snapshot", async () => {
    await withBuildInfo({ context: "production", branch: "main" }, "edenatlas.netlify.app", async (mod) => {
      assert.strictEqual(mod.getEnvironment(), mod.ENV.PRODUCTION);
      assert.strictEqual(mod.isNonProduction(), false);
    });
  });

  await test("isPreProduction(): true for both the literal staging branch AND any other Deploy Preview/branch deploy — the deploy-context policy fix", async () => {
    await withBuildInfo({ context: "branch-deploy", branch: "staging" }, "staging--edenatlas.netlify.app", async (mod) => {
      assert.strictEqual(mod.isPreProduction(), true);
    });
    await withBuildInfo({ context: "deploy-preview", branch: "pr-42" }, "deploy-preview-42--edenatlas.netlify.app", async (mod) => {
      assert.strictEqual(mod.isPreProduction(), true);
    });
    await withBuildInfo({ context: "branch-deploy", branch: "feat/some-other-branch" }, "some-hash--edenatlas.netlify.app", async (mod) => {
      assert.strictEqual(mod.isPreProduction(), true);
    });
    await withBuildInfo({ context: "production", branch: "main" }, "edenatlas.netlify.app", async (mod) => {
      assert.strictEqual(mod.isPreProduction(), false);
    });
  });

  // ---- mountNonProductionBanner(): DOM behavior against a real jsdom document ----

  await test("mountNonProductionBanner() does nothing on Production", async () => {
    await withBuildInfo({ context: "production", branch: "main" }, "edenatlas.netlify.app", async (mod) => {
      const result = mod.mountNonProductionBanner(global.document);
      assert.strictEqual(result, null);
      assert.strictEqual(global.document.getElementById("eden-env-banner"), null);
    });
  });

  await test("mountNonProductionBanner() appends exactly one visible STAGING banner to <html>, and is idempotent", async () => {
    await withBuildInfo({ context: "branch-deploy", branch: "staging" }, "staging--edenatlas.netlify.app", async (mod) => {
      const first = mod.mountNonProductionBanner(global.document);
      assert.ok(first);
      assert.strictEqual(first.id, "eden-env-banner");
      assert.ok(/STAGING/.test(first.textContent));
      assert.strictEqual(first.parentElement, global.document.documentElement); // sibling of <body>, not inside it
      // A second call must not create a duplicate banner.
      const second = mod.mountNonProductionBanner(global.document);
      assert.strictEqual(second, null);
      assert.strictEqual(global.document.querySelectorAll("#eden-env-banner").length, 1);
    });
  });

  await test("mountNonProductionBanner() labels a non-staging branch deploy as DEPLOY PREVIEW, never STAGING", async () => {
    await withBuildInfo({ context: "branch-deploy", branch: "feat/discover-staging-push" }, "some-hash--edenatlas.netlify.app", async (mod) => {
      const banner = mod.mountNonProductionBanner(global.document);
      assert.ok(/DEPLOY PREVIEW/.test(banner.textContent));
      assert.ok(!/STAGING/.test(banner.textContent));
    });
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    failures.forEach(({ name, err }) => console.error(`\n[FAILED] ${name}\n${err.stack || err}`));
    process.exit(1);
  }
})();
