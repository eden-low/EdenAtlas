import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_OPERATION_PHASE, createAuthOperationLock } from "../auth-operation-lock.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const LOGIN_SOURCE = fs.readFileSync(path.join(ROOT, "frontend", "pages", "login.html"), "utf8");

let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok  - ${name}`);
  } catch (error) {
    fail++;
    console.log(`FAIL  - ${name}`);
    console.log(`        ${error.message}`);
  }
}

function assertSecondActionIgnored(first, second) {
  const lock = createAuthOperationLock();
  assert.strictEqual(lock.begin(first), true);
  assert.strictEqual(lock.begin(second), false);
  assert.deepStrictEqual(lock.snapshot(), { phase: AUTH_OPERATION_PHASE.RUNNING, operation: first });
}

await test("a second Email/Password login submission is ignored", () => {
  assertSecondActionIgnored("email-sign-in", "email-sign-in");
});

await test("a second Email/Password signup submission is ignored", () => {
  assertSecondActionIgnored("email-sign-up", "email-sign-up");
});

await test("a second password-reset request is ignored", () => {
  assertSecondActionIgnored("password-reset", "password-reset");
});

await test("a second verification resend is ignored", () => {
  assertSecondActionIgnored("verification-resend", "verification-resend");
});

await test("linking and continue-without-linking actions are mutually single-flight", () => {
  assertSecondActionIgnored("google-account-link", "continue-without-google-link");
  assertSecondActionIgnored("email-account-link", "continue-without-email-link");
  assertSecondActionIgnored("google-account-link", "google-account-link");
  assertSecondActionIgnored("email-account-link", "email-account-link");
  assertSecondActionIgnored("continue-without-google-link", "continue-without-google-link");
  assertSecondActionIgnored("continue-without-email-link", "continue-without-email-link");
});

await test("repeated Google initiation is ignored while authentication is active", () => {
  assertSecondActionIgnored("google-sign-in", "google-sign-in");
});

await test("a navigation handoff remains locked after Firebase success", () => {
  const phases = [];
  const lock = createAuthOperationLock(({ phase }) => phases.push(phase));
  assert.strictEqual(lock.begin("email-sign-in"), true);
  assert.strictEqual(lock.handoffToNavigation(), true);
  assert.strictEqual(lock.release(), false);
  assert.strictEqual(lock.begin("email-sign-in"), false);
  assert.deepStrictEqual(lock.snapshot(), {
    phase: AUTH_OPERATION_PHASE.COMPLETING,
    operation: "email-sign-in",
  });
  assert.deepStrictEqual(phases, [AUTH_OPERATION_PHASE.RUNNING, AUTH_OPERATION_PHASE.COMPLETING]);
  assert.ok(LOGIN_SOURCE.includes('authActionControls.forEach((control) => { control.disabled = locked; })'));
  assert.ok(LOGIN_SOURCE.includes('loginCard.toggleAttribute("inert", phase === AUTH_OPERATION_PHASE.COMPLETING)'));
});

await test("recoverable failures return the operation state to actionable", () => {
  const lock = createAuthOperationLock();
  assert.strictEqual(lock.begin("email-sign-in"), true);
  assert.strictEqual(lock.release(), true);
  assert.strictEqual(lock.isActive(), false);
  assert.strictEqual(lock.begin("email-sign-in"), true);
});

await test("normal repeated errors do not leave controls permanently locked", () => {
  const lock = createAuthOperationLock();
  for (const action of ["email-sign-in", "email-sign-up", "password-reset", "verification-resend"]) {
    assert.strictEqual(lock.begin(action), true);
    assert.strictEqual(lock.release(), true);
  }
  assert.deepStrictEqual(lock.snapshot(), { phase: AUTH_OPERATION_PHASE.IDLE, operation: null });
});

await test("every interactive auth path uses the shared operation lock", () => {
  for (const operation of [
    "google-sign-in",
    "password-reset",
    "verification-resend",
    "verification-refresh",
    "verification-logout",
    "google-account-link",
    "continue-without-google-link",
    "email-account-link",
    "continue-without-email-link",
  ]) {
    assert.ok(LOGIN_SOURCE.includes(`authOperation.begin(\"${operation}\")`), `missing ${operation}`);
  }
  assert.ok(LOGIN_SOURCE.includes('authMode === "signup" ? "email-sign-up" : "email-sign-in"'));
});

await test("password inputs are cleared on local rejection and remote completion", () => {
  assert.ok(LOGIN_SOURCE.includes("function clearPrimaryPasswords()"));
  assert.ok(LOGIN_SOURCE.includes("function clearLinkPasswords()"));
  assert.match(LOGIN_SOURCE, /if \(!form\.ok\) \{\s*clearPrimaryPasswords\(\)/);
  assert.match(LOGIN_SOURCE, /const confirmation = linkEmailConfirmInput\.value;\s*clearLinkPasswords\(\)/);
  assert.ok(!/localStorage\.(?:setItem|getItem)\([^\n]*(?:password|credential|idToken|refreshToken)/i.test(LOGIN_SOURCE));
  assert.ok(!/sessionStorage\.(?:setItem|getItem)\([^\n]*(?:password|credential|idToken|refreshToken)/i.test(LOGIN_SOURCE));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
