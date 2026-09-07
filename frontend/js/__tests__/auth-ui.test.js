import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { AUTH_FORM_ERROR, validateEmailAuthInput } from "../auth-form-validation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const LOGIN_SOURCE = fs.readFileSync(path.join(ROOT, "frontend", "pages", "login.html"), "utf8");
const CLIENT_SOURCE = fs.readFileSync(path.join(ROOT, "frontend", "js", "auth-client.js"), "utf8");
const document = new JSDOM(LOGIN_SOURCE).window.document;

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

await test("login page exposes Google and Email/Password login", () => {
  assert.ok(document.querySelector("#signin-btn .fa-google"));
  assert.strictEqual(document.querySelector("#auth-email")?.type, "email");
  assert.strictEqual(document.querySelector("#auth-password")?.type, "password");
  assert.ok(document.querySelector("#email-auth-form"));
});

await test("signup mode exposes a required password confirmation", () => {
  const confirmation = document.querySelector("#auth-confirm-password");
  assert.ok(document.querySelector("#auth-mode-toggle"));
  assert.strictEqual(confirmation?.type, "password");
  assert.ok(LOGIN_SOURCE.includes("confirmPasswordInput.required = mode === \"signup\""));
});

await test("local validation rejects missing, malformed, weak, and mismatched credentials", () => {
  assert.strictEqual(validateEmailAuthInput({ mode: "signup", email: "", password: "", confirmation: "" }).error, AUTH_FORM_ERROR.REQUIRED);
  assert.strictEqual(validateEmailAuthInput({ mode: "login", email: "invalid", password: "secret" }).error, AUTH_FORM_ERROR.INVALID_EMAIL);
  assert.strictEqual(validateEmailAuthInput({ mode: "signup", email: "user@example.com", password: "short", confirmation: "short" }).error, AUTH_FORM_ERROR.PASSWORD_TOO_SHORT);
  assert.strictEqual(validateEmailAuthInput({ mode: "signup", email: "user@example.com", password: "secret1", confirmation: "secret2" }).error, AUTH_FORM_ERROR.PASSWORD_MISMATCH);
  assert.deepStrictEqual(validateEmailAuthInput({ mode: "signup", email: " user@example.com ", password: "secret1", confirmation: "secret1" }), {
    ok: true, email: "user@example.com", password: "secret1",
  });
});

await test("Email login, signup, and password reset call the canonical auth client", () => {
  assert.ok(LOGIN_SOURCE.includes("signInWithEmailPassword(form.email, form.password)"));
  assert.ok(LOGIN_SOURCE.includes("registerWithEmailPassword(form.email, form.password)"));
  assert.ok(LOGIN_SOURCE.includes("requestPasswordReset(email)"));
  assert.ok(document.querySelector("#forgot-password-btn"));
});

await test("verification UI supports resend, Firebase refresh, and logout", () => {
  for (const id of ["verification-panel", "resend-verification-btn", "check-verification-btn", "verification-logout-btn"]) {
    assert.ok(document.getElementById(id), `missing #${id}`);
  }
  assert.ok(LOGIN_SOURCE.includes("sendCurrentUserVerificationEmail()"));
  assert.ok(LOGIN_SOURCE.includes("refreshCurrentUser()"));
  assert.ok(LOGIN_SOURCE.includes("requiresEmailVerification(user)"));
  assert.ok(LOGIN_SOURCE.includes("await signOut(auth)"));
  assert.ok(CLIENT_SOURCE.includes("await reload(user)"));
});

await test("Google popup, redirect, PWA detection, and redirect result remain intact", () => {
  for (const symbol of ["signInWithPopup", "signInWithRedirect", "getRedirectResult", "isStandalone", "KNOWN_PRIVATE_PAGES"]) {
    assert.ok(LOGIN_SOURCE.includes(symbol), `missing ${symbol}`);
  }
});

await test("normalized errors are rendered without raw Firebase exceptions", () => {
  assert.ok(LOGIN_SOURCE.includes("normalizeAuthError(err)"));
  assert.ok(LOGIN_SOURCE.includes("setStatus(safeError.message, \"error\")"));
  assert.ok(!LOGIN_SOURCE.includes("statusEl.textContent = err"));
  assert.ok(!LOGIN_SOURCE.includes("setStatus(err"));
});

await test("provider conflict requires existing authentication and explicit linking confirmation", () => {
  assert.ok(document.querySelector("#account-link-panel"));
  assert.ok(document.querySelector("#confirm-google-link-btn"));
  assert.ok(LOGIN_SOURCE.includes("getSignInMethodsForConflict(error)"));
  assert.ok(LOGIN_SOURCE.includes("linkGoogleSignInErrorToCurrentUser(pendingGoogleLinkError, { confirmed: true })"));
  assert.ok(LOGIN_SOURCE.includes("await showGoogleConflict(pendingGoogleLinkError, true)"));
  assert.ok(document.querySelector("#confirm-email-link-btn"));
  assert.ok(LOGIN_SOURCE.includes("linkEmailPasswordToCurrentUser(pendingEmailLinkAddress, password, { confirmed: true })"));
  assert.ok(LOGIN_SOURCE.includes("!hasPasswordProvider && sameAuthenticatedEmail"));
});

await test("linking checks and preserves the authenticated Firebase UID", () => {
  assert.ok(LOGIN_SOURCE.includes("const currentUid = auth.currentUser?.uid"));
  assert.ok(LOGIN_SOURCE.includes("auth.currentUser?.uid !== currentUid"));
  assert.ok(LOGIN_SOURCE.includes("result.user?.uid !== currentUid"));
  assert.ok(!LOGIN_SOURCE.includes("deleteUser("));
  assert.ok(LOGIN_SOURCE.includes("clearLinkPasswords()"));
});

await test("passwords and Firebase tokens are never persisted", () => {
  const combined = `${LOGIN_SOURCE}\n${CLIENT_SOURCE}`;
  assert.ok(!/localStorage\.(?:setItem|getItem)\([^\n]*(?:password|credential|idToken|refreshToken)/i.test(combined));
  assert.ok(!/sessionStorage\.(?:setItem|getItem)\([^\n]*(?:password|credential|idToken|refreshToken)/i.test(combined));
  assert.ok(!/(?:setDoc|addDoc|updateDoc)\([^\n]*(?:password|credential|idToken|refreshToken)/i.test(combined));
  assert.ok(!/console\.(?:log|error|warn)\([^\n]*(?:password|credential|idToken|refreshToken)/i.test(combined));
});

await test("Firebase Auth state, not localStorage, drives login routing", () => {
  assert.ok(LOGIN_SOURCE.includes("onAuthStateChanged(auth, async (user)"));
  assert.ok(!/localStorage\.getItem\([^)]*\)[\s\S]{0,100}(?:transitionToApp|showVerification)/.test(LOGIN_SOURCE));
  assert.ok(LOGIN_SOURCE.includes("Firebase Auth remains the authentication source of truth") === false,
    "implementation should prove this structurally rather than rely on a comment");
});

await test("the canonical operation lock and resend cooldown prevent duplicate submissions", () => {
  assert.ok(LOGIN_SOURCE.includes("createAuthOperationLock(renderAuthOperationState)"));
  assert.ok(LOGIN_SOURCE.includes("authOperation.handoffToNavigation()"));
  assert.ok(LOGIN_SOURCE.includes("if (!authOperation.begin("));
  assert.ok(LOGIN_SOURCE.includes("startResendCooldown()"));
  assert.ok(LOGIN_SOURCE.includes("Date.now() < resendCooldownUntil"));
  assert.ok(!LOGIN_SOURCE.includes("setAuthBusy("));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
