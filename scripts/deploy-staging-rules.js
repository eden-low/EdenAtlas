#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const APPROVED_PROJECT = "edenatlas-staging";
const PRODUCTION_PROJECT = "lfj-profolio";
const CONFIG_RELATIVE_PATH = ".rules-runtime/staging/firebase.json";
const FIRESTORE_RULES_RELATIVE_PATH = "firestore.rules";
const STORAGE_RULES_RELATIVE_PATH = "storage.rules";
const ONLY_TARGETS = "firestore:rules,storage";
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

class StagingRulesDeployError extends Error {
  constructor(code) {
    super(code);
    this.name = "StagingRulesDeployError";
    this.code = code;
  }
}

function refuse(code) {
  throw new StagingRulesDeployError(code);
}

function parseRequestedProject(argv) {
  const values = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--project") {
      values.push(index + 1 < argv.length ? argv[++index] : null);
    } else if (typeof argument === "string" && argument.startsWith("--project=")) {
      values.push(argument.slice("--project=".length));
    } else {
      refuse("staging-rules-deploy/unexpected-argument");
    }
  }

  if (values.length === 0) refuse("staging-rules-deploy/missing-project");
  if (values.length !== 1) refuse("staging-rules-deploy/conflicting-project-arguments");

  const requestedProject = values[0];
  if (typeof requestedProject !== "string" || requestedProject.length === 0) {
    refuse("staging-rules-deploy/empty-project");
  }
  if (requestedProject !== requestedProject.trim() || !PROJECT_ID_PATTERN.test(requestedProject)) {
    refuse("staging-rules-deploy/malformed-project");
  }
  if (requestedProject === PRODUCTION_PROJECT) refuse("staging-rules-deploy/production-rejected");
  if (["production", "staging", "default"].includes(requestedProject)) {
    refuse("staging-rules-deploy/alias-rejected");
  }
  if (requestedProject !== APPROVED_PROJECT) refuse("staging-rules-deploy/unapproved-project");
  return requestedProject;
}

function readJson(filePath, missingCode, invalidCode) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    refuse(missingCode);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) refuse(invalidCode);
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) refuse(invalidCode);
    return value;
  } catch (error) {
    if (error instanceof StagingRulesDeployError) throw error;
    refuse(invalidCode);
  }
}

function assertRegularFile(filePath, code) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    refuse(code);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) refuse(code);
}

function resolveDeploymentPaths(rootDir = ROOT) {
  const normalizedRoot = path.resolve(rootDir);
  const configPath = path.resolve(normalizedRoot, ...CONFIG_RELATIVE_PATH.split("/"));
  const configDirectory = path.dirname(configPath);
  return Object.freeze({
    rootDir: normalizedRoot,
    firebaseRcPath: path.resolve(normalizedRoot, ".firebaserc"),
    configPath,
    firestoreRulesPath: path.resolve(configDirectory, FIRESTORE_RULES_RELATIVE_PATH),
    storageRulesPath: path.resolve(configDirectory, STORAGE_RULES_RELATIVE_PATH),
  });
}

function preflight(requestedProject, { rootDir = ROOT } = {}) {
  if (requestedProject !== APPROVED_PROJECT || requestedProject === PRODUCTION_PROJECT) {
    refuse("staging-rules-deploy/unapproved-project");
  }

  const paths = resolveDeploymentPaths(rootDir);
  const firebaseRc = readJson(
    paths.firebaseRcPath,
    "staging-rules-deploy/missing-firebaserc",
    "staging-rules-deploy/invalid-firebaserc",
  );
  const projects = firebaseRc.projects;
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) {
    refuse("staging-rules-deploy/invalid-firebaserc");
  }
  if (Object.prototype.hasOwnProperty.call(projects, "default")) {
    refuse("staging-rules-deploy/default-project-rejected");
  }
  const aliases = Object.keys(projects).sort();
  if (aliases.length !== 2 || aliases[0] !== "production" || aliases[1] !== "staging"
      || projects.production !== PRODUCTION_PROJECT || projects.staging !== APPROVED_PROJECT) {
    refuse("staging-rules-deploy/invalid-project-aliases");
  }

  const config = readJson(
    paths.configPath,
    "staging-rules-deploy/missing-staging-config",
    "staging-rules-deploy/invalid-staging-config",
  );
  if (!config.firestore || config.firestore.rules !== FIRESTORE_RULES_RELATIVE_PATH
      || !config.storage || config.storage.rules !== STORAGE_RULES_RELATIVE_PATH) {
    refuse("staging-rules-deploy/unexpected-rules-path");
  }
  if (path.resolve(path.dirname(paths.configPath), config.firestore.rules) !== paths.firestoreRulesPath
      || path.resolve(path.dirname(paths.configPath), config.storage.rules) !== paths.storageRulesPath) {
    refuse("staging-rules-deploy/rules-path-escape");
  }
  assertRegularFile(paths.firestoreRulesPath, "staging-rules-deploy/missing-firestore-rules");
  assertRegularFile(paths.storageRulesPath, "staging-rules-deploy/missing-storage-rules");
  return paths;
}

function firebaseArguments() {
  return Object.freeze([
    "deploy",
    "--config", CONFIG_RELATIVE_PATH,
    "--project", APPROVED_PROJECT,
    "--only", ONLY_TARGETS,
  ]);
}

function runDeployment(argv, {
  rootDir = ROOT,
  spawnSync = childProcess.spawnSync,
  nodeExecutable = process.execPath,
  firebaseEntry = null,
} = {}) {
  const requestedProject = parseRequestedProject(argv);
  const paths = preflight(requestedProject, { rootDir });
  const cliEntry = firebaseEntry || require.resolve("firebase-tools/lib/bin/firebase.js");
  const effectiveFirebaseArguments = firebaseArguments();
  const result = spawnSync(
    nodeExecutable,
    [cliEntry, ...effectiveFirebaseArguments],
    { cwd: paths.rootDir, stdio: "inherit", shell: false },
  );
  if (result && result.error) refuse("staging-rules-deploy/firebase-cli-spawn-failed");
  if (!result || !Number.isInteger(result.status)) refuse("staging-rules-deploy/firebase-cli-no-status");
  return result.status;
}

if (require.main === module) {
  try {
    process.exitCode = runDeployment(process.argv.slice(2));
  } catch (error) {
    const code = error instanceof StagingRulesDeployError
      ? error.code
      : "staging-rules-deploy/unexpected-failure";
    console.error(`deploy-staging-rules: refused (${code})`);
    process.exitCode = 1;
  }
}

module.exports = {
  ROOT,
  APPROVED_PROJECT,
  PRODUCTION_PROJECT,
  CONFIG_RELATIVE_PATH,
  FIRESTORE_RULES_RELATIVE_PATH,
  STORAGE_RULES_RELATIVE_PATH,
  ONLY_TARGETS,
  StagingRulesDeployError,
  parseRequestedProject,
  resolveDeploymentPaths,
  preflight,
  firebaseArguments,
  runDeployment,
};
