const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { PAGE_FILES } = require("../../scripts/build-site.js");
const { renderTemplate } = require("../../scripts/generate-owner-rules.js");
const {
  ROOT,
  RUNTIME_ROOT,
  SITE_ROOT,
  FUNCTION_ROOT,
  DEMO_PROJECT_ID,
  STORAGE_BUCKET,
  TOPOLOGY,
  USERS,
} = require("../constants.js");

function assertRuntimePath(target) {
  const resolved = path.resolve(target);
  if (resolved !== RUNTIME_ROOT && !resolved.startsWith(`${RUNTIME_ROOT}${path.sep}`)) {
    throw new Error(`E2E cleanup refusal: target escaped ${RUNTIME_ROOT}`);
  }
  return resolved;
}

function removeRuntime() {
  assertRuntimePath(RUNTIME_ROOT);
  fs.rmSync(RUNTIME_ROOT, { recursive: true, force: true });
}

function copyDirectory(source, target, filter = () => true) {
  fs.cpSync(source, target, {
    recursive: true,
    filter: (candidate) => filter(path.relative(source, candidate).split(path.sep).join("/")),
  });
}

function generateTailwind() {
  const packageRoot = path.dirname(require.resolve("tailwindcss/package.json"));
  const cli = path.join(packageRoot, "lib", "cli.js");
  const result = spawnSync(process.execPath, [
    cli,
    "-c", path.join(ROOT, "tailwind.config.js"),
    "-i", path.join(ROOT, "frontend", "styles", "tailwind-input.css"),
    "-o", path.join(SITE_ROOT, "tailwind.generated.css"),
    "--minify",
  ], { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) throw new Error("E2E Tailwind generation failed");
}

function renderOwnerRules(sourcePath, outputPath) {
  const source = fs.readFileSync(sourcePath, "utf8");
  const principal = { projectId: DEMO_PROJECT_ID, uid: USERS.owner.uid, email: USERS.owner.email };
  fs.writeFileSync(outputPath, renderTemplate(source, principal), "utf8");
}

function prepareRuntime() {
  removeRuntime();
  fs.mkdirSync(SITE_ROOT, { recursive: true });

  for (const page of PAGE_FILES) {
    fs.copyFileSync(path.join(ROOT, "frontend", "pages", page), path.join(SITE_ROOT, page));
  }
  fs.copyFileSync(path.join(ROOT, "frontend", "styles", "styles.css"), path.join(SITE_ROOT, "styles.css"));
  fs.copyFileSync(path.join(ROOT, "frontend", "manifest.json"), path.join(SITE_ROOT, "manifest.json"));
  fs.copyFileSync(path.join(ROOT, "frontend", "service-worker.js"), path.join(SITE_ROOT, "service-worker.js"));
  copyDirectory(
    path.join(ROOT, "frontend", "js"),
    path.join(SITE_ROOT, "js"),
    (relative) => !/(^|\/)__tests__(\/|$)/.test(relative)
      && !/(^|\/)package(?:-lock)?\.json$/.test(relative)
  );
  copyDirectory(path.join(ROOT, "frontend", "images"), path.join(SITE_ROOT, "images"));
  copyDirectory(path.join(ROOT, "frontend", "locales"), path.join(SITE_ROOT, "locales"));
  generateTailwind();

  const buildInfo = {
    context: "dev",
    branch: "local-e2e",
    url: "http://127.0.0.1:4173",
    deployPrimeUrl: "http://127.0.0.1:4173",
    stagingFirebaseConfig: null,
    ownerPrincipal: null,
    vapidPublicKey: null,
    builtAt: new Date(0).toISOString(),
  };
  fs.writeFileSync(
    path.join(SITE_ROOT, "js", "build-info.generated.js"),
    `window.__EDEN_BUILD__ = Object.freeze(${JSON.stringify(buildInfo)});\n`
      + `window.__EDEN_E2E__ = Object.freeze(${JSON.stringify({ enabled: true, projectId: DEMO_PROJECT_ID })});\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(SITE_ROOT, "js", "fcm-config.generated.js"),
    `self.__EDEN_FCM_CONFIG__ = Object.freeze(${JSON.stringify({
      firebaseConfig: {
        apiKey: "demo-only-not-a-live-key",
        authDomain: "127.0.0.1",
        projectId: DEMO_PROJECT_ID,
        storageBucket: STORAGE_BUCKET,
        messagingSenderId: "0",
        appId: "1:0:web:demo-edenatlas-e2e",
      },
      vapidPublicKey: null,
    })});\n`,
    "utf8"
  );

  renderOwnerRules(path.join(ROOT, "firestore.rules"), path.join(RUNTIME_ROOT, "firestore.rules"));
  renderOwnerRules(path.join(ROOT, "storage.rules"), path.join(RUNTIME_ROOT, "storage.rules"));

  // Run the real policy-transition handler in the loopback harness. Only this disposable demo
  // runtime receives the pinned Tier-1 principal; the handler's parser, authentication checks,
  // and transition logic are otherwise the production source.
  fs.mkdirSync(FUNCTION_ROOT, { recursive: true });
  copyDirectory(
    path.join(ROOT, "backend", "netlify", "functions", "lib"),
    path.join(FUNCTION_ROOT, "lib")
  );
  copyDirectory(path.join(ROOT, "shared"), path.join(RUNTIME_ROOT, "shared"));
  fs.copyFileSync(
    path.join(ROOT, "backend", "netlify", "functions", "career-policy-transition.js"),
    path.join(FUNCTION_ROOT, "career-policy-transition.js")
  );

  const firebaseConfig = {
    firestore: { rules: "firestore.rules" },
    storage: { rules: "storage.rules" },
    emulators: {
      auth: TOPOLOGY.auth,
      firestore: TOPOLOGY.firestore,
      storage: TOPOLOGY.storage,
      ui: { enabled: false },
      singleProjectMode: true,
    },
  };
  fs.writeFileSync(path.join(RUNTIME_ROOT, "firebase.json"), `${JSON.stringify(firebaseConfig, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    path.join(RUNTIME_ROOT, "safety.json"),
    `${JSON.stringify({ projectId: DEMO_PROJECT_ID, topology: TOPOLOGY }, null, 2)}\n`,
    "utf8"
  );
  return RUNTIME_ROOT;
}

module.exports = { prepareRuntime, removeRuntime, assertRuntimePath };
