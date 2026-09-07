// Stable, UI-facing authentication errors. Firebase SDK codes stay inside this boundary so
// future Login/Sign Up screens do not branch on vendor error strings or expose raw errors.

export const AUTH_ERROR = Object.freeze({
  INVALID_CREDENTIAL: "AUTH_INVALID_CREDENTIAL",
  EMAIL_IN_USE: "AUTH_EMAIL_IN_USE",
  WEAK_PASSWORD: "AUTH_WEAK_PASSWORD",
  INVALID_EMAIL: "AUTH_INVALID_EMAIL",
  PROVIDER_DISABLED: "AUTH_PROVIDER_DISABLED",
  POPUP_CANCELLED: "AUTH_POPUP_CANCELLED",
  TOO_MANY_REQUESTS: "AUTH_TOO_MANY_REQUESTS",
  NETWORK_ERROR: "AUTH_NETWORK_ERROR",
  ACCOUNT_LINK_REQUIRED: "AUTH_ACCOUNT_LINK_REQUIRED",
  CREDENTIAL_IN_USE: "AUTH_CREDENTIAL_IN_USE",
  ALREADY_LINKED: "AUTH_ALREADY_LINKED",
  NOT_AUTHENTICATED: "AUTH_NOT_AUTHENTICATED",
  CONFIRMATION_REQUIRED: "AUTH_CONFIRMATION_REQUIRED",
  UNKNOWN: "AUTH_UNKNOWN",
});

const SAFE_MESSAGES = Object.freeze({
  [AUTH_ERROR.INVALID_CREDENTIAL]: "The email or password is incorrect.",
  [AUTH_ERROR.EMAIL_IN_USE]: "An account already uses this email address.",
  [AUTH_ERROR.WEAK_PASSWORD]: "Choose a stronger password.",
  [AUTH_ERROR.INVALID_EMAIL]: "Enter a valid email address.",
  [AUTH_ERROR.PROVIDER_DISABLED]: "This sign-in method is not enabled.",
  [AUTH_ERROR.POPUP_CANCELLED]: "Sign-in was cancelled.",
  [AUTH_ERROR.TOO_MANY_REQUESTS]: "Too many attempts. Please wait and try again.",
  [AUTH_ERROR.NETWORK_ERROR]: "A network error interrupted sign-in.",
  [AUTH_ERROR.ACCOUNT_LINK_REQUIRED]: "Sign in to the existing account before linking this method.",
  [AUTH_ERROR.CREDENTIAL_IN_USE]: "This sign-in method is already linked to another account.",
  [AUTH_ERROR.ALREADY_LINKED]: "This sign-in method is already linked.",
  [AUTH_ERROR.NOT_AUTHENTICATED]: "Sign in before linking an account.",
  [AUTH_ERROR.CONFIRMATION_REQUIRED]: "Confirm account linking before continuing.",
  [AUTH_ERROR.UNKNOWN]: "Authentication could not be completed.",
});

const FIREBASE_CODE_MAP = Object.freeze({
  "auth/invalid-credential": AUTH_ERROR.INVALID_CREDENTIAL,
  "auth/invalid-login-credentials": AUTH_ERROR.INVALID_CREDENTIAL,
  "auth/wrong-password": AUTH_ERROR.INVALID_CREDENTIAL,
  "auth/user-not-found": AUTH_ERROR.INVALID_CREDENTIAL,
  "auth/email-already-in-use": AUTH_ERROR.EMAIL_IN_USE,
  "auth/weak-password": AUTH_ERROR.WEAK_PASSWORD,
  "auth/invalid-email": AUTH_ERROR.INVALID_EMAIL,
  "auth/operation-not-allowed": AUTH_ERROR.PROVIDER_DISABLED,
  "auth/configuration-not-found": AUTH_ERROR.PROVIDER_DISABLED,
  "auth/popup-closed-by-user": AUTH_ERROR.POPUP_CANCELLED,
  "auth/popup-blocked": AUTH_ERROR.POPUP_CANCELLED,
  "auth/cancelled-popup-request": AUTH_ERROR.POPUP_CANCELLED,
  "auth/user-cancelled": AUTH_ERROR.POPUP_CANCELLED,
  "auth/too-many-requests": AUTH_ERROR.TOO_MANY_REQUESTS,
  "auth/network-request-failed": AUTH_ERROR.NETWORK_ERROR,
  "auth/account-exists-with-different-credential": AUTH_ERROR.ACCOUNT_LINK_REQUIRED,
  "auth/credential-already-in-use": AUTH_ERROR.CREDENTIAL_IN_USE,
  "auth/provider-already-linked": AUTH_ERROR.ALREADY_LINKED,
});

export function authError(category) {
  const safeCategory = SAFE_MESSAGES[category] ? category : AUTH_ERROR.UNKNOWN;
  return Object.freeze({
    category: safeCategory,
    message: SAFE_MESSAGES[safeCategory],
  });
}

export function normalizeAuthError(error) {
  const firebaseCode = typeof error?.code === "string" ? error.code : "";
  return authError(FIREBASE_CODE_MAP[firebaseCode] || AUTH_ERROR.UNKNOWN);
}
