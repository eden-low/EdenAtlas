"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  PROJECTS,
  PRODUCTION_OWNER_EMAIL,
  STAGING_OWNER,
  TIER1_OWNER,
  resolveOwnerPrincipal,
} = require("../../shared/owner-principal");
const { assertOwnerAuthorization } = require("../../backend/netlify/functions/lib/owner-authorization");
const { generateOwnerRules } = require("../generate-owner-rules");

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

function rejectsCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code);
}

const productionValues = { PRODUCTION_OWNER_UID: "production-owner-uid" };
const stagingValues = {
  STAGING_OWNER_UID: STAGING_OWNER.uid,
  STAGING_OWNER_EMAIL: STAGING_OWNER.email,
};

function authInput(principal, overrides = {}) {
  const decoded = {
    uid: principal.uid,
    email: principal.email,
    email_verified: true,
    ...(overrides.decoded || {}),
  };
  return {
    projectId: principal.projectId,
    ownerPrincipal: principal,
    decoded,
    userDoc: {
      uid: decoded.uid,
      role: "owner",
      email: decoded.email,
      ...(overrides.userDoc || {}),
    },
    ...overrides.top,
  };
}

test("Production principal resolves only with its required UID slot", () => {
  const principal = resolveOwnerPrincipal(PROJECTS.PRODUCTION, productionValues);
  assert.equal(principal.projectId, PROJECTS.PRODUCTION);
  assert.equal(principal.uid, productionValues.PRODUCTION_OWNER_UID);
});
test("Production principal rejects a mismatched configured email", () => {
  rejectsCode(() => resolveOwnerPrincipal(PROJECTS.PRODUCTION, {
    ...productionValues, PRODUCTION_OWNER_EMAIL: "wrong@example.invalid",
  }), "owner-principal/production-email-mismatch");
});
test("Production principal rejects malformed UID", () => {
  rejectsCode(() => resolveOwnerPrincipal(PROJECTS.PRODUCTION, { PRODUCTION_OWNER_UID: "bad uid" }),
    "owner-principal/invalid-uid");
});
test("Production principal rejects missing UID", () => {
  rejectsCode(() => resolveOwnerPrincipal(PROJECTS.PRODUCTION, {}), "owner-principal/invalid-uid");
});
test("Staging principal resolves from dedicated required slots", () => {
  const principal = resolveOwnerPrincipal(PROJECTS.STAGING, stagingValues);
  assert.equal(principal, STAGING_OWNER);
});
test("Staging principal rejects the Production identity", () => {
  rejectsCode(() => resolveOwnerPrincipal(PROJECTS.STAGING, {
    ...stagingValues, STAGING_OWNER_EMAIL: PRODUCTION_OWNER_EMAIL,
  }), "owner-principal/staging-cannot-use-production-owner");
});
test("Staging principal rejects a missing UID", () => {
  rejectsCode(() => resolveOwnerPrincipal(PROJECTS.STAGING, {
    STAGING_OWNER_EMAIL: STAGING_OWNER.email,
  }), "owner-principal/invalid-uid");
});
test("Staging principal rejects a missing email", () => {
  rejectsCode(() => resolveOwnerPrincipal(PROJECTS.STAGING, {
    STAGING_OWNER_UID: STAGING_OWNER.uid,
  }), "owner-principal/invalid-email");
});
test("Staging principal rejects malformed email", () => {
  rejectsCode(() => resolveOwnerPrincipal(PROJECTS.STAGING, {
    ...stagingValues, STAGING_OWNER_EMAIL: "malformed",
  }), "owner-principal/invalid-email");
});
test("Staging principal rejects a well-formed but non-canonical UID", () => {
  rejectsCode(() => resolveOwnerPrincipal(PROJECTS.STAGING, {
    ...stagingValues, STAGING_OWNER_UID: productionValues.PRODUCTION_OWNER_UID,
  }), "owner-principal/staging-uid-mismatch");
});
test("Staging principal rejects a well-formed but non-canonical email", () => {
  rejectsCode(() => resolveOwnerPrincipal(PROJECTS.STAGING, {
    ...stagingValues, STAGING_OWNER_EMAIL: "other-owner@staging.invalid",
  }), "owner-principal/staging-email-mismatch");
});
test("Staging principal normalizes the canonical email", () => {
  assert.equal(resolveOwnerPrincipal(PROJECTS.STAGING, {
    ...stagingValues, STAGING_OWNER_EMAIL: `  ${STAGING_OWNER.email.toUpperCase()}  `,
  }), STAGING_OWNER);
});
test("Tier-1 principal is rejected without the explicit emulator option", () => {
  rejectsCode(() => resolveOwnerPrincipal(PROJECTS.TIER1), "owner-principal/tier1-not-allowed");
});
test("Tier-1 principal preserves the pinned emulator identity", () => {
  assert.equal(resolveOwnerPrincipal(PROJECTS.TIER1, {}, { allowTier1: true }), TIER1_OWNER);
});
test("Unknown project fails closed", () => {
  rejectsCode(() => resolveOwnerPrincipal("unknown-owner-project", stagingValues),
    "owner-principal/unknown-project");
});

const productionPrincipal = resolveOwnerPrincipal(PROJECTS.PRODUCTION, productionValues);
const stagingPrincipal = resolveOwnerPrincipal(PROJECTS.STAGING, stagingValues);

test("Backend accepts the complete Production Owner conjunction", () => {
  assert.equal(assertOwnerAuthorization(authInput(productionPrincipal)).uid, productionPrincipal.uid);
});
test("Backend accepts the complete Staging Owner conjunction", () => {
  assert.equal(assertOwnerAuthorization(authInput(stagingPrincipal)).uid, stagingPrincipal.uid);
});
test("Backend rejects wrong token email", () => {
  assert.throws(() => assertOwnerAuthorization(authInput(productionPrincipal, {
    decoded: { email: "wrong@example.invalid" },
  })), /owner_only/);
});
test("Backend rejects wrong token UID", () => {
  assert.throws(() => assertOwnerAuthorization(authInput(productionPrincipal, {
    decoded: { uid: "wrong-owner-uid" },
  })), /owner_only/);
});
test("Backend rejects unverified token email", () => {
  assert.throws(() => assertOwnerAuthorization(authInput(productionPrincipal, {
    decoded: { email_verified: false },
  })), /owner_only/);
});
test("Backend rejects a missing users document", () => {
  assert.throws(() => assertOwnerAuthorization(authInput(productionPrincipal, {
    top: { userDoc: null },
  })), /owner_only/);
});
test("Backend rejects non-owner stored role", () => {
  assert.throws(() => assertOwnerAuthorization(authInput(productionPrincipal, {
    userDoc: { role: "friend" },
  })), /owner_only/);
});
test("Backend rejects stored email mismatch", () => {
  assert.throws(() => assertOwnerAuthorization(authInput(productionPrincipal, {
    userDoc: { email: "wrong@example.invalid" },
  })), /owner_only/);
});
test("Backend rejects stored UID mismatch", () => {
  assert.throws(() => assertOwnerAuthorization(authInput(productionPrincipal, {
    userDoc: { uid: "wrong-owner-uid" },
  })), /owner_only/);
});
test("Backend rejects Production principal in Staging", () => {
  const input = authInput(productionPrincipal, { top: { projectId: PROJECTS.STAGING } });
  assert.throws(() => assertOwnerAuthorization(input), /owner_project_mismatch/);
});
test("Backend rejects Staging principal in Production", () => {
  const input = authInput(stagingPrincipal, { top: { projectId: PROJECTS.PRODUCTION } });
  assert.throws(() => assertOwnerAuthorization(input), /owner_project_mismatch/);
});
test("Backend rejects the Production UID on Staging", () => {
  assert.throws(() => assertOwnerAuthorization(authInput(stagingPrincipal, {
    decoded: { uid: productionPrincipal.uid },
    userDoc: { uid: productionPrincipal.uid },
  })), /owner_only/);
});
test("Backend rejects the Staging UID on Production", () => {
  assert.throws(() => assertOwnerAuthorization(authInput(productionPrincipal, {
    decoded: { uid: stagingPrincipal.uid },
    userDoc: { uid: stagingPrincipal.uid },
  })), /owner_only/);
});
test("Backend rejects the Staging email on Production", () => {
  assert.throws(() => assertOwnerAuthorization(authInput(productionPrincipal, {
    decoded: { email: stagingPrincipal.email },
    userDoc: { email: stagingPrincipal.email },
  })), /owner_only/);
});
test("Backend rejects an unverified canonical Staging identity", () => {
  assert.throws(() => assertOwnerAuthorization(authInput(stagingPrincipal, {
    decoded: { email_verified: false },
  })), /owner_only/);
});
test("Backend rejects missing principal as configuration failure", () => {
  const input = authInput(productionPrincipal, { top: { ownerPrincipal: null } });
  assert.throws(() => assertOwnerAuthorization(input), /owner_principal_not_configured/);
});

const functionNames = [
  "assistant.js", "anilist.js", "discover-ai.js", "expense-receipt-ai.js", "career-policy-transition.js",
];
test("All five Owner-only Functions use the shared helper", () => {
  for (const name of functionNames) {
    const source = fs.readFileSync(path.resolve(__dirname, "..", "..", "backend", "netlify", "functions", name), "utf8");
    assert.match(source, /assertOwnerAuthorization\s*\(/);
    assert.doesNotMatch(source, /const\s+OWNER_EMAIL\s*=/);
  }
});
test("All five production token verifiers remain revocation-aware", () => {
  for (const name of functionNames) {
    const source = fs.readFileSync(path.resolve(__dirname, "..", "..", "backend", "netlify", "functions", name), "utf8");
    assert.match(source, /verifyIdToken\(token, true\)/);
  }
});

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eden-owner-rules-"));
try {
  const productionOut = path.join(tempRoot, "production");
  const stagingOut = path.join(tempRoot, "staging");
  const tier1Out = path.join(tempRoot, "tier1");
  generateOwnerRules({ projectId: PROJECTS.PRODUCTION, values: productionValues, outputDir: productionOut });
  generateOwnerRules({ projectId: PROJECTS.STAGING, values: stagingValues, outputDir: stagingOut, stagingOnly: true });
  generateOwnerRules({ projectId: PROJECTS.TIER1, outputDir: tier1Out });

  const readPair = (dir) => ["firestore.rules", "storage.rules"]
    .map((name) => fs.readFileSync(path.join(dir, name), "utf8"));
  test("Production Rules artifacts contain only the Production principal", () => {
    for (const source of readPair(productionOut)) {
      assert.ok(source.includes(productionPrincipal.uid) && source.includes(productionPrincipal.email));
      assert.ok(!source.includes(stagingPrincipal.uid) && !source.includes(stagingPrincipal.email));
    }
  });
  test("Staging Rules artifacts contain only the Staging principal", () => {
    for (const source of readPair(stagingOut)) {
      assert.ok(source.includes(stagingPrincipal.uid) && source.includes(stagingPrincipal.email));
      assert.ok(!source.includes(productionPrincipal.uid) && !source.includes(productionPrincipal.email));
    }
  });
  test("Tier-1 Rules artifacts preserve the pinned emulator principal", () => {
    for (const source of readPair(tier1Out)) {
      assert.ok(source.includes(TIER1_OWNER.uid) && source.includes(TIER1_OWNER.email));
    }
  });
  test("Rules generation is deterministic", () => {
    const secondOut = path.join(tempRoot, "staging-second");
    generateOwnerRules({ projectId: PROJECTS.STAGING, values: stagingValues, outputDir: secondOut });
    assert.deepEqual(readPair(stagingOut), readPair(secondOut));
  });
  test("Staging-only Rules path explicitly rejects Production", () => {
    assert.throws(() => generateOwnerRules({
      projectId: PROJECTS.PRODUCTION,
      values: productionValues,
      outputDir: path.join(tempRoot, "rejected"),
      stagingOnly: true,
    }), /staging-path-rejected-production/);
  });
  test("Rules generation rejects unknown project", () => {
    assert.throws(() => generateOwnerRules({
      projectId: "unknown-owner-project", outputDir: path.join(tempRoot, "unknown"),
    }), /unknown-project/);
  });
  test("Staging Rules generation rejects a missing UID", () => {
    assert.throws(() => generateOwnerRules({
      projectId: PROJECTS.STAGING,
      values: { STAGING_OWNER_EMAIL: STAGING_OWNER.email },
      outputDir: path.join(tempRoot, "missing-staging-uid"),
      stagingOnly: true,
    }), /invalid-uid/);
  });
  test("Staging Rules generation rejects a missing email", () => {
    assert.throws(() => generateOwnerRules({
      projectId: PROJECTS.STAGING,
      values: { STAGING_OWNER_UID: STAGING_OWNER.uid },
      outputDir: path.join(tempRoot, "missing-staging-email"),
      stagingOnly: true,
    }), /invalid-email/);
  });
  test("Staging Rules generation rejects a noncanonical UID", () => {
    assert.throws(() => generateOwnerRules({
      projectId: PROJECTS.STAGING,
      values: { ...stagingValues, STAGING_OWNER_UID: "different-staging-owner-uid" },
      outputDir: path.join(tempRoot, "wrong-staging-uid"),
      stagingOnly: true,
    }), /staging-uid-mismatch/);
  });
  test("Staging Rules generation rejects a noncanonical email", () => {
    assert.throws(() => generateOwnerRules({
      projectId: PROJECTS.STAGING,
      values: { ...stagingValues, STAGING_OWNER_EMAIL: "different-staging-owner@example.invalid" },
      outputDir: path.join(tempRoot, "wrong-staging-email"),
      stagingOnly: true,
    }), /staging-email-mismatch/);
  });
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

test("Staging Rules command pins the target project and staging-only guard", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts["generate:owner-rules:staging"],
    "node scripts/generate-owner-rules.js --project edenatlas-staging --out .rules-runtime/staging --staging-only",
  );
});

test("Audited frontend discovery no longer selects Owner by role metadata", () => {
  const names = [
    "career.js", "portfolio.js", "project.js", "collections.js", "collection-detail.js",
    "atlas.js", "dashboard.js", "global-search.js",
  ];
  for (const name of names) {
    const source = fs.readFileSync(path.resolve(__dirname, "..", "..", "frontend", "js", name), "utf8");
    assert.doesNotMatch(source, /where\(\s*["']role["']\s*,\s*["']==["']\s*,\s*["']owner["']\s*\)/);
  }
});

test("Finance and Time Capsule restrict new records without hiding legacy participant data", () => {
  const expenses = fs.readFileSync(path.resolve(__dirname, "..", "..", "frontend", "js", "expenses.js"), "utf8");
  const capsules = fs.readFileSync(path.resolve(__dirname, "..", "..", "frontend", "js", "time-capsule.js"), "utf8");
  assert.match(expenses, /if \(user && canParticipate\(\)\)/);
  assert.match(expenses, /if \(!user \|\| !isOwner\(user\)\) return;/);
  assert.match(capsules, /fetchCapsules\(user\)/);
  assert.match(capsules, /if \(!user \|\| !isOwner\(user\)\) return;/);
});

console.log(`\nOwner principal: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
