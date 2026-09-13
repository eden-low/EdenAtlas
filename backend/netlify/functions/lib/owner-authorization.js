"use strict";

const {
  normalizeEmail,
  validatePrincipal,
  resolveOwnerPrincipal,
} = require("../../../../shared/owner-principal");

class OwnerAuthorizationError extends Error {
  constructor(code, statusCode) {
    super(code);
    this.name = "OwnerAuthorizationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function assertOwnerAuthorization({ decoded, userDoc, projectId, ownerPrincipal }) {
  let principal;
  try {
    principal = validatePrincipal(ownerPrincipal || {});
  } catch {
    throw new OwnerAuthorizationError("owner_principal_not_configured", 500);
  }
  if (projectId !== principal.projectId) {
    throw new OwnerAuthorizationError("owner_project_mismatch", 500);
  }
  if (!decoded || !decoded.uid) {
    throw new OwnerAuthorizationError("invalid_or_expired_token", 401);
  }
  const tokenEmail = normalizeEmail(decoded.email);
  const storedEmail = normalizeEmail(userDoc && userDoc.email);
  const authorized = decoded.uid === principal.uid
    && decoded.email_verified === true
    && tokenEmail === principal.email
    && !!userDoc
    && userDoc.uid === decoded.uid
    && userDoc.role === "owner"
    && storedEmail === tokenEmail;
  if (!authorized) throw new OwnerAuthorizationError("owner_only", 403);
  return Object.freeze({ uid: decoded.uid, decoded, userDoc, principal });
}

function resolveConfiguredOwnerPrincipal(projectId, values = process.env, options) {
  return resolveOwnerPrincipal(projectId, values, options);
}

module.exports = {
  OwnerAuthorizationError,
  assertOwnerAuthorization,
  resolveConfiguredOwnerPrincipal,
};
