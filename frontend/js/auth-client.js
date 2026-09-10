// Firebase Authentication capability layer for the future Login/Sign Up UI. Credentials stay
// with Firebase Auth: this module never writes passwords, tokens, or provider credentials to
// Firestore/localStorage. Every operation returns a stable result and a sanitized error.

import { auth } from "./firebase-init.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword as firebaseSignInWithEmailAndPassword,
  sendPasswordResetEmail,
  sendEmailVerification,
  reload,
  getIdToken,
  fetchSignInMethodsForEmail,
  EmailAuthProvider,
  GoogleAuthProvider,
  linkWithCredential,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { AUTH_ERROR, authError, normalizeAuthError } from "./auth-errors.js";

function publicUser(user) {
  return user ? Object.freeze({
    uid: user.uid,
    email: user.email || null,
    emailVerified: user.emailVerified === true,
    providerIds: Object.freeze((user.providerData || []).map((item) => item.providerId)),
  }) : null;
}

function success(user, extra = {}) {
  return Object.freeze({ ok: true, user: publicUser(user), ...extra });
}

function failure(error) {
  return Object.freeze({ ok: false, error: normalizeAuthError(error) });
}

export async function registerWithEmailPassword(email, password) {
  try {
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    try {
      await sendEmailVerification(credential.user);
      return success(credential.user, { verificationSent: true });
    } catch (verificationError) {
      // Account creation already succeeded. Report verification delivery separately so the UI
      // does not encourage a duplicate signup attempt.
      return success(credential.user, {
        verificationSent: false,
        verificationError: normalizeAuthError(verificationError),
      });
    }
  } catch (error) {
    return failure(error);
  }
}

export async function signInWithEmailPassword(email, password) {
  try {
    const credential = await firebaseSignInWithEmailAndPassword(auth, email, password);
    return success(credential.user);
  } catch (error) {
    return failure(error);
  }
}

export async function requestPasswordReset(email) {
  try {
    await sendPasswordResetEmail(auth, email);
    return Object.freeze({ ok: true });
  } catch (error) {
    return failure(error);
  }
}

export async function sendCurrentUserVerificationEmail() {
  const user = auth.currentUser;
  if (!user) return Object.freeze({ ok: false, error: authError(AUTH_ERROR.NOT_AUTHENTICATED) });
  try {
    await sendEmailVerification(user);
    return success(user, { verificationSent: true });
  } catch (error) {
    return failure(error);
  }
}

export function requiresEmailVerification(user = auth.currentUser) {
  return !!user
    && user.emailVerified !== true
    && (user.providerData || []).some((provider) => provider.providerId === "password");
}

export async function refreshCurrentUser() {
  const user = auth.currentUser;
  if (!user) return Object.freeze({ ok: false, error: authError(AUTH_ERROR.NOT_AUTHENTICATED) });
  try {
    await reload(user);
    await getIdToken(auth.currentUser, true);
    return success(auth.currentUser);
  } catch (error) {
    return failure(error);
  }
}

// Provider discovery is deliberately limited to the Firebase conflict error path. Firebase may
// return no methods when Email Enumeration Protection is enabled; callers must then show a
// generic "use your existing method" message rather than guessing an identity provider.
export async function getSignInMethodsForConflict(signInError) {
  if (signInError?.code !== "auth/account-exists-with-different-credential") {
    return failure(signInError);
  }
  const email = typeof signInError.customData?.email === "string"
    ? signInError.customData.email
    : "";
  if (!email) return Object.freeze({ ok: true, signInMethods: Object.freeze([]) });
  try {
    const methods = await fetchSignInMethodsForEmail(auth, email);
    const safeMethods = methods.filter((method) => method === "password" || method === "google.com");
    return Object.freeze({ ok: true, signInMethods: Object.freeze(safeMethods) });
  } catch (error) {
    return failure(error);
  }
}

async function linkConfirmedCredential(credential, confirmed) {
  const user = auth.currentUser;
  if (!user) return Object.freeze({ ok: false, error: authError(AUTH_ERROR.NOT_AUTHENTICATED) });
  if (confirmed !== true) {
    return Object.freeze({ ok: false, error: authError(AUTH_ERROR.CONFIRMATION_REQUIRED) });
  }
  try {
    const result = await linkWithCredential(user, credential);
    return success(result.user);
  } catch (error) {
    return failure(error);
  }
}

// Safe Email/Password linking: the caller must first authenticate the existing account and get
// explicit user confirmation. Linking preserves the current Firebase UID/EdenAtlas identity.
export async function linkEmailPasswordToCurrentUser(email, password, { confirmed = false } = {}) {
  const credential = EmailAuthProvider.credential(email, password);
  return linkConfirmedCredential(credential, confirmed);
}

// For auth/account-exists-with-different-credential from a Google attempt. The pending Google
// credential is extracted and used only in memory after the existing account is authenticated
// and the user explicitly confirms. No automatic merge or account deletion occurs.
export async function linkGoogleSignInErrorToCurrentUser(signInError, { confirmed = false } = {}) {
  if (signInError?.code !== "auth/account-exists-with-different-credential") {
    return failure(signInError);
  }
  const credential = GoogleAuthProvider.credentialFromError(signInError);
  if (!credential) return failure(null);
  return linkConfirmedCredential(credential, confirmed);
}
