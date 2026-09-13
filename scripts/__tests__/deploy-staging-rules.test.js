"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  APPROVED_PROJECT,
  CONFIG_RELATIVE_PATH,
  ONLY_TARGETS,
  StagingRulesDeployError,
  firebaseArguments,
  runDeployment,
} = require("../deploy-staging-rules");

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok  - ${name}`);
  } catch (error) {
    fail++;
    console.log(`FAIL  - ${name}`);
    console.log(`        ${error?.message || error}`);
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eden-staging-rules-deploy-"));
  writeJson(path.join(root, ".firebaserc"), {
    projects: { production: "lfj-profolio", staging: APPROVED_PROJECT },
  });
  writeJson(path.join(root, ...CONFIG_RELATIVE_PATH.split("/")), {
    firestore: { rules: "firestore.rules" },
    storage: { rules: "storage.rules" },
  });
  const artifactDirectory = path.join(root, ".rules-runtime", "staging");
  fs.writeFileSync(path.join(artifactDirectory, "firestore.rules"), "rules_version = '2';\n", "utf8");
  fs.writeFileSync(path.join(artifactDirectory, "storage.rules"), "rules_version = '2';\n", "utf8");
  return root;
}

function expectRefusal(argv, mutate, expectedCode) {
  const root = createFixture();
  let spawnCount = 0;
  try {
    if (mutate) mutate(root);
    assert.throws(
      () => runDeployment(argv, {
        rootDir: root,
        firebaseEntry: path.join(root, "fake-firebase.js"),
        spawnSync() {
          spawnCount++;
          return { status: 0 };
        },
      }),
      (error) => error instanceof StagingRulesDeployError && error.code === expectedCode,
    );
    assert.equal(spawnCount, 0, "Firebase CLI must not be spawned after preflight refusal");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("missing project is rejected before Firebase CLI spawn", () => {
  expectRefusal([], null, "staging-rules-deploy/missing-project");
});
test("empty project is rejected before Firebase CLI spawn", () => {
  expectRefusal(["--project", ""], null, "staging-rules-deploy/empty-project");
});
test("Production project ID is explicitly rejected before Firebase CLI spawn", () => {
  expectRefusal(["--project", "lfj-profolio"], null, "staging-rules-deploy/production-rejected");
});
test("production alias is rejected before Firebase CLI spawn", () => {
  expectRefusal(["--project", "production"], null, "staging-rules-deploy/alias-rejected");
});
test("staging alias is rejected before Firebase CLI spawn", () => {
  expectRefusal(["--project", "staging"], null, "staging-rules-deploy/alias-rejected");
});
test("default alias is rejected before Firebase CLI spawn", () => {
  expectRefusal(["--project", "default"], null, "staging-rules-deploy/alias-rejected");
});
test("unknown valid-looking project is rejected before Firebase CLI spawn", () => {
  expectRefusal(["--project", "another-firebase-project"], null, "staging-rules-deploy/unapproved-project");
});
test("malformed project is rejected before Firebase CLI spawn", () => {
  expectRefusal(["--project", "bad project"], null, "staging-rules-deploy/malformed-project");
});
test("duplicate conflicting project arguments are rejected before Firebase CLI spawn", () => {
  expectRefusal(
    ["--project", APPROVED_PROJECT, "--project", "lfj-profolio"],
    null,
    "staging-rules-deploy/conflicting-project-arguments",
  );
});
test("reintroduced .firebaserc default is rejected before Firebase CLI spawn", () => {
  expectRefusal(["--project", APPROVED_PROJECT], (root) => {
    writeJson(path.join(root, ".firebaserc"), {
      projects: { default: "lfj-profolio", production: "lfj-profolio", staging: APPROVED_PROJECT },
    });
  }, "staging-rules-deploy/default-project-rejected");
});
test("missing generated Staging firebase.json is rejected before Firebase CLI spawn", () => {
  expectRefusal(["--project", APPROVED_PROJECT], (root) => {
    fs.rmSync(path.join(root, ...CONFIG_RELATIVE_PATH.split("/")));
  }, "staging-rules-deploy/missing-staging-config");
});
test("unexpected Rules paths are rejected before Firebase CLI spawn", () => {
  expectRefusal(["--project", APPROVED_PROJECT], (root) => {
    writeJson(path.join(root, ...CONFIG_RELATIVE_PATH.split("/")), {
      firestore: { rules: "../../firestore.rules" },
      storage: { rules: "../../storage.rules" },
    });
  }, "staging-rules-deploy/unexpected-rules-path");
});

test("exact Staging target produces only the pinned Firebase CLI invocation", () => {
  const root = createFixture();
  const calls = [];
  try {
    const status = runDeployment(["--project", APPROVED_PROJECT], {
      rootDir: root,
      nodeExecutable: "test-node",
      firebaseEntry: path.join(root, "fake-firebase.js"),
      spawnSync(command, args, options) {
        calls.push({ command, args, options });
        return { status: 0 };
      },
    });
    assert.equal(status, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "test-node");
    assert.deepEqual(calls[0].args.slice(1), [
      "deploy",
      "--config", ".rules-runtime/staging/firebase.json",
      "--project", "edenatlas-staging",
      "--only", "firestore:rules,storage",
    ]);
    assert.equal(calls[0].options.cwd, path.resolve(root));
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.stdio, "inherit");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("working directory cannot redirect the pinned config or deployment cwd", () => {
  const root = createFixture();
  const unrelated = fs.mkdtempSync(path.join(os.tmpdir(), "eden-unrelated-cwd-"));
  const originalCwd = process.cwd();
  let invocation;
  try {
    process.chdir(unrelated);
    runDeployment(["--project", APPROVED_PROJECT], {
      rootDir: root,
      nodeExecutable: "test-node",
      firebaseEntry: path.join(root, "fake-firebase.js"),
      spawnSync(command, args, options) {
        invocation = { command, args, options };
        return { status: 0 };
      },
    });
    assert.equal(invocation.options.cwd, path.resolve(root));
    assert.equal(invocation.args[invocation.args.indexOf("--config") + 1], CONFIG_RELATIVE_PATH);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(unrelated, { recursive: true, force: true });
  }
});

test("repository package and Firebase configuration expose only the guarded canonical path", () => {
  const repositoryRoot = path.resolve(__dirname, "..", "..");
  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
  const firebaseRc = JSON.parse(fs.readFileSync(path.join(repositoryRoot, ".firebaserc"), "utf8"));
  assert.equal(
    packageJson.scripts["deploy:rules:staging"],
    "node scripts/deploy-staging-rules.js --project edenatlas-staging",
  );
  assert.equal(Object.prototype.hasOwnProperty.call(firebaseRc.projects, "default"), false);
  assert.deepEqual(firebaseRc.projects, {
    production: "lfj-profolio",
    staging: "edenatlas-staging",
  });
  const deploymentScripts = Object.entries(packageJson.scripts)
    .filter(([name]) => name.startsWith("deploy:"));
  assert.deepEqual(deploymentScripts, [[
    "deploy:rules:staging",
    "node scripts/deploy-staging-rules.js --project edenatlas-staging",
  ]]);
  assert.deepEqual(firebaseArguments(), [
    "deploy",
    "--config", CONFIG_RELATIVE_PATH,
    "--project", APPROVED_PROJECT,
    "--only", ONLY_TARGETS,
  ]);
});

console.log(`\nStaging Rules deploy guard: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
