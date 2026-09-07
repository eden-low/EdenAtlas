// Pure local validation for the Login/Sign Up form. It does not retain input values and does
// not decide authentication; Firebase Auth remains the authentication source of truth.

export const AUTH_FORM_ERROR = Object.freeze({
  REQUIRED: "AUTH_FORM_REQUIRED",
  INVALID_EMAIL: "AUTH_FORM_INVALID_EMAIL",
  PASSWORD_TOO_SHORT: "AUTH_FORM_PASSWORD_TOO_SHORT",
  PASSWORD_MISMATCH: "AUTH_FORM_PASSWORD_MISMATCH",
});

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmailAuthInput({ mode, email, password, confirmation = "" }) {
  const normalizedEmail = String(email || "").trim();
  const passwordValue = String(password || "");
  const confirmationValue = String(confirmation || "");
  if (!normalizedEmail || !passwordValue || (mode === "signup" && !confirmationValue)) {
    return Object.freeze({ ok: false, error: AUTH_FORM_ERROR.REQUIRED });
  }
  if (!EMAIL_PATTERN.test(normalizedEmail)) {
    return Object.freeze({ ok: false, error: AUTH_FORM_ERROR.INVALID_EMAIL });
  }
  if (passwordValue.length < 6) {
    return Object.freeze({ ok: false, error: AUTH_FORM_ERROR.PASSWORD_TOO_SHORT });
  }
  if (mode === "signup" && passwordValue !== confirmationValue) {
    return Object.freeze({ ok: false, error: AUTH_FORM_ERROR.PASSWORD_MISMATCH });
  }
  return Object.freeze({ ok: true, email: normalizedEmail, password: passwordValue });
}
