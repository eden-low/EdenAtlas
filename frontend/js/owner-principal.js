// Browser-side Owner principal validation. This controls UX only; Firebase Rules and Netlify
// Functions independently resolve and enforce the same project-bound principal.

function normalizeEmail(value) {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

export function resolveFrontendOwnerPrincipal(projectId, candidate) {
  if (!candidate || candidate.projectId !== projectId) return null;
  const uid = typeof candidate.uid === "string" ? candidate.uid.trim() : "";
  const email = normalizeEmail(candidate.email);
  if (!uid || uid.length > 128 || !/^[A-Za-z0-9_-]+$/.test(uid)) return null;
  if (!email || email.length > 254 || /[\\'\r\n]/.test(email)
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return Object.freeze({ projectId, uid, email });
}
