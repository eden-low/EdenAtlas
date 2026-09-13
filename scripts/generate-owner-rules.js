#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { PROJECTS, resolveOwnerPrincipal } = require("../shared/owner-principal");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT = path.join(ROOT, ".rules-runtime");
const TOKENS = Object.freeze({ uid: "__OWNER_UID_REQUIRED__", email: "__OWNER_EMAIL_REQUIRED__" });

function renderTemplate(source, principal) {
  if (!source.includes(TOKENS.uid) || !source.includes(TOKENS.email)) {
    throw new Error("owner-rules/template-missing-placeholder");
  }
  const rendered = source.split(TOKENS.uid).join(principal.uid).split(TOKENS.email).join(principal.email);
  if (rendered.includes(TOKENS.uid) || rendered.includes(TOKENS.email)) {
    throw new Error("owner-rules/unresolved-placeholder");
  }
  return rendered;
}

function generateOwnerRules({ projectId, values = process.env, outputDir = DEFAULT_OUTPUT, stagingOnly = false } = {}) {
  if (stagingOnly && projectId === PROJECTS.PRODUCTION) {
    throw new Error("owner-rules/staging-path-rejected-production");
  }
  const principal = resolveOwnerPrincipal(projectId, values, { allowTier1: projectId === PROJECTS.TIER1 });
  const files = ["firestore.rules", "storage.rules"];
  fs.mkdirSync(outputDir, { recursive: true });
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    fs.writeFileSync(path.join(outputDir, file), renderTemplate(source, principal), "utf8");
  }
  const firebaseConfig = {
    firestore: { rules: "firestore.rules" },
    storage: { rules: "storage.rules" },
    emulators: {
      auth: { host: "127.0.0.1", port: 9099 },
      firestore: { host: "127.0.0.1", port: 8080 },
      storage: { host: "127.0.0.1", port: 9199 },
      ui: { enabled: false },
      singleProjectMode: true,
    },
  };
  fs.writeFileSync(path.join(outputDir, "firebase.json"), `${JSON.stringify(firebaseConfig, null, 2)}\n`, "utf8");
  return Object.freeze({ projectId: principal.projectId, outputDir });
}

function parseCli(argv) {
  const projectIndex = argv.indexOf("--project");
  const outIndex = argv.indexOf("--out");
  return {
    projectId: projectIndex >= 0 ? argv[projectIndex + 1] : null,
    outputDir: outIndex >= 0 ? path.resolve(argv[outIndex + 1]) : DEFAULT_OUTPUT,
    stagingOnly: argv.includes("--staging-only"),
  };
}

if (require.main === module) {
  try {
    const result = generateOwnerRules({ ...parseCli(process.argv.slice(2)), values: process.env });
    console.log(`generate-owner-rules: wrote deterministic rules for project=${result.projectId}`);
  } catch (error) {
    console.error(`generate-owner-rules: refused (${error.code || error.message})`);
    process.exitCode = 1;
  }
}

module.exports = { ROOT, DEFAULT_OUTPUT, TOKENS, renderTemplate, generateOwnerRules, parseCli };
