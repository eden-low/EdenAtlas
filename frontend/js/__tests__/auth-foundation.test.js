import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const CLIENT_SOURCE = fs.readFileSync(path.join(ROOT, "frontend", "js", "auth-client.js"), "utf8");
const LOGIN_SOURCE = fs.readFileSync(path.join(ROOT, "frontend", "pages", "login.html"), "utf8");
const { AUTH_ERROR, normalizeAuthError } = await import("../auth-errors.js");

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

const expectedMappings = new Map([
  ["auth/invalid-credential", AUTH_ERROR.INVALID_CREDENTIAL],
  ["auth/invalid-login-credentials", AUTH_ERROR.INVALID_CREDENTIAL],
  ["auth/user-not-found", AUTH_ERROR.INVALID_CREDENTIAL],
  ["auth/wrong-password", AUTH_ERROR.INVALID_CREDENTIAL],
  ["auth/email-already-in-use", AUTH_ERROR.EMAIL_IN_USE],
  ["auth/weak-password", AUTH_ERROR.WEAK_PASSWORD],
  ["auth/invalid-email", AUTH_ERROR.INVALID_EMAIL],
  ["auth/operation-not-allowed", AUTH_ERROR.PROVIDER_DISABLED],
  ["auth/configuration-not-found", AUTH_ERROR.PROVIDER_DISABLED],
  ["auth/popup-closed-by-user", AUTH_ERROR.POPUP_CANCELLED],
  ["auth/popup-blocked", AUTH_ERROR.POPUP_CANCELLED],
  ["auth/cancelled-popup-request", AUTH_ERROR.POPUP_CANCELLED],
  ["auth/too-many-requests", AUTH_ERROR.TOO_MANY_REQUESTS],
  ["auth/network-request-failed", AUTH_ERROR.NETWORK_ERROR],
  ["auth/account-exists-with-different-credential", AUTH_ERROR.ACCOUNT_LINK_REQUIRED],
]);

await test("Firebase Auth errors map to stable EdenAtlas categories", () => {
  for (const [code, category] of expectedMappings) {
    assert.strictEqual(normalizeAuthError({ code }).category, category, code);
  }
});

await test("unknown errors are sanitized and never expose raw Firebase details", () => {
  const normalized = normalizeAuthError({
    code: "auth/unexpected-new-code",
    message: "token=secret-value apiKey=private-value",
    credential: { accessToken: "secret-token" },
  });
  assert.deepStrictEqual(Object.keys(normalized).sort(), ["category", "message"]);
  assert.strictEqual(normalized.category, AUTH_ERROR.UNKNOWN);
  assert.ok(!JSON.stringify(normalized).includes("secret"));
});

await test("Email/Password registration, sign-in, reset, and verification capabilities are wired", () => {
  for (const symbol of [
    "createUserWithEmailAndPassword",
    "firebaseSignInWithEmailAndPassword",
    "sendPasswordResetEmail",
    "sendEmailVerification",
  ]) {
    assert.ok(CLIENT_SOURCE.includes(symbol), `missing ${symbol}`);
  }
  for (const exportedApi of [
    "registerWithEmailPassword",
    "signInWithEmailPassword",
    "requestPasswordReset",
    "sendCurrentUserVerificationEmail",
    "refreshCurrentUser",
    "getSignInMethodsForConflict",
  ]) {
    assert.match(CLIENT_SOURCE, new RegExp(`export async function ${exportedApi}\\b`));
  }
});

await test("account linking requires an authenticated current user and explicit confirmation", () => {
  assert.ok(CLIENT_SOURCE.includes("linkWithCredential(user, credential)"));
  assert.ok(CLIENT_SOURCE.includes("if (!user)"));
  assert.ok(CLIENT_SOURCE.includes("if (confirmed !== true)"));
  assert.ok(CLIENT_SOURCE.includes("AUTH_ACCOUNT_LINK_REQUIRED") === false,
    "the helper should use stable constants, not duplicate category strings");
  assert.ok(!/localStorage\.(?:setItem|getItem)[\s\S]{0,120}(?:credential|password|token)/i.test(CLIENT_SOURCE));
});

await test("existing Google popup, redirect, redirect-result, persistence, and allowlist flow remains intact", () => {
  for (const symbol of ["signInWithPopup", "signInWithRedirect", "getRedirectResult", "KNOWN_PRIVATE_PAGES"]) {
    assert.ok(LOGIN_SOURCE.includes(symbol), `Google/PWA login flow lost ${symbol}`);
  }
  assert.ok(LOGIN_SOURCE.includes("const safeError = normalizeAuthError(err)"));
  assert.ok(LOGIN_SOURCE.includes("safeError.category"));
  assert.ok(LOGIN_SOURCE.includes("safeError.message"));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
