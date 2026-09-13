"use strict";

// Canonical project-bound Owner-principal resolver. Identity values are configuration, never
// credentials. Production keeps its existing email binding; its immutable UID must be supplied
// before a future deploy. Staging configuration remains mandatory and must exactly match its
// canonical dedicated identity. Local Tier-1 is the sole pinned test exception and is accepted
// only when the caller opts into it explicitly.

const PROJECTS = Object.freeze({
  PRODUCTION: "lfj-profolio",
  STAGING: "edenatlas-staging",
  TIER1: "demo-edenatlas-e2e",
});

const PRODUCTION_OWNER_EMAIL = "jjun8647@gmail.com";
const STAGING_OWNER = Object.freeze({
  projectId: PROJECTS.STAGING,
  uid: "31h2u5TY55hYB1MwtJMEBCZQtGw1",
  email: "lowfj1205@1utar.my",
});
const TIER1_OWNER = Object.freeze({
  projectId: PROJECTS.TIER1,
  uid: "e2e-owner-uid",
  email: "owner@edenatlas-e2e.invalid",
});

class OwnerPrincipalConfigError extends Error {
  constructor(code) {
    super(code);
    this.name = "OwnerPrincipalConfigError";
    this.code = code;
  }
}

function normalizedValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeEmail(value) {
  const email = normalizedValue(value);
  return email ? email.toLowerCase() : null;
}

function validatePrincipal({ projectId, uid, email }) {
  const normalizedProjectId = normalizedValue(projectId);
  const normalizedUid = normalizedValue(uid);
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedProjectId || !/^[a-z0-9][a-z0-9-]{3,62}$/.test(normalizedProjectId)) {
    throw new OwnerPrincipalConfigError("owner-principal/invalid-project");
  }
  if (!normalizedUid || normalizedUid.length > 128 || !/^[A-Za-z0-9_-]+$/.test(normalizedUid)) {
    throw new OwnerPrincipalConfigError("owner-principal/invalid-uid");
  }
  if (!normalizedEmail || normalizedEmail.length > 254 || /[\\'\r\n]/.test(normalizedEmail)
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new OwnerPrincipalConfigError("owner-principal/invalid-email");
  }
  return Object.freeze({ projectId: normalizedProjectId, uid: normalizedUid, email: normalizedEmail });
}

function resolveOwnerPrincipal(projectId, values = {}, { allowTier1 = false } = {}) {
  if (projectId === PROJECTS.TIER1) {
    if (!allowTier1) throw new OwnerPrincipalConfigError("owner-principal/tier1-not-allowed");
    return TIER1_OWNER;
  }
  if (projectId === PROJECTS.PRODUCTION) {
    const suppliedEmail = normalizeEmail(values.PRODUCTION_OWNER_EMAIL);
    if (suppliedEmail && suppliedEmail !== PRODUCTION_OWNER_EMAIL) {
      throw new OwnerPrincipalConfigError("owner-principal/production-email-mismatch");
    }
    return validatePrincipal({
      projectId,
      uid: values.PRODUCTION_OWNER_UID,
      email: PRODUCTION_OWNER_EMAIL,
    });
  }
  if (projectId === PROJECTS.STAGING) {
    const principal = validatePrincipal({
      projectId,
      uid: values.STAGING_OWNER_UID,
      email: values.STAGING_OWNER_EMAIL,
    });
    if (principal.email === PRODUCTION_OWNER_EMAIL) {
      throw new OwnerPrincipalConfigError("owner-principal/staging-cannot-use-production-owner");
    }
    if (principal.uid !== STAGING_OWNER.uid) {
      throw new OwnerPrincipalConfigError("owner-principal/staging-uid-mismatch");
    }
    if (principal.email !== STAGING_OWNER.email) {
      throw new OwnerPrincipalConfigError("owner-principal/staging-email-mismatch");
    }
    return STAGING_OWNER;
  }
  throw new OwnerPrincipalConfigError("owner-principal/unknown-project");
}

module.exports = {
  PROJECTS,
  PRODUCTION_OWNER_EMAIL,
  STAGING_OWNER,
  TIER1_OWNER,
  OwnerPrincipalConfigError,
  normalizeEmail,
  validatePrincipal,
  resolveOwnerPrincipal,
};
