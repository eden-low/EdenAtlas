// Pure parsing/identity helpers shared by Career and Time Capsule. A Firebase download URL is
// treated only as a legacy locator: callers must recover the exact object path and then use the
// authenticated Storage SDK. The long-lived URL itself is never rendered as the authorization
// mechanism for protected content.

export function parseFirebaseStorageObjectUrl(value, expectedBucket) {
  if (typeof value !== "string" || typeof expectedBucket !== "string" || !expectedBucket) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "firebasestorage.googleapis.com"
      || parsed.port || parsed.username || parsed.password || parsed.hash) return null;
  const prefix = `/v0/b/${encodeURIComponent(expectedBucket)}/o/`;
  if (!parsed.pathname.startsWith(prefix)) return null;
  const encodedPath = parsed.pathname.slice(prefix.length);
  if (!encodedPath) return null;
  let objectPath;
  try {
    objectPath = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
  if (!objectPath || objectPath.startsWith("/") || objectPath.endsWith("/")
      || objectPath.includes("//") || objectPath.includes("\\") || objectPath.includes("\0")) return null;
  return Object.freeze({ objectPath, href: parsed.href });
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isOwnCapsuleObjectPath(value, uid) {
  if (typeof value !== "string" || typeof uid !== "string" || !uid) return false;
  const match = value.match(new RegExp(`^capsules/${escapeRegex(uid)}/([^/]{1,512})$`));
  return !!match && match[1] !== "." && match[1] !== "..";
}

export function canonicalCapsuleObjectPath(uid, capsuleId) {
  return `capsules/${uid}/${capsuleId}`;
}

export function isCanonicalCapsuleObjectPath(value, uid, capsuleId) {
  return typeof uid === "string" && !!uid && typeof capsuleId === "string" && !!capsuleId
    && value === canonicalCapsuleObjectPath(uid, capsuleId);
}

export function canonicalCareerObjectPath(uid, collectionName, itemId, attachmentId) {
  return `career/${uid}/${collectionName}/${itemId}/${attachmentId}`;
}

export function isCanonicalCareerObjectPath(value, uid, collectionName, itemId) {
  if (!["career_projects", "career_experiences", "career_certificates", "career_awards"].includes(collectionName)) return false;
  if (![value, uid, itemId].every((part) => typeof part === "string" && !!part)) return false;
  const prefix = `career/${uid}/${collectionName}/${itemId}/`;
  const attachmentId = value.startsWith(prefix) ? value.slice(prefix.length) : "";
  return /^[A-Za-z0-9_-]{1,100}$/.test(attachmentId);
}

export function isOwnLegacyCareerObjectPath(value, uid) {
  if (typeof value !== "string" || typeof uid !== "string" || !uid) return false;
  return new RegExp(`^career/${escapeRegex(uid)}/(?:private|connections|public)/[^\\0]{1,900}$`).test(value)
    && !value.includes("//") && !value.includes("\\")
    && !value.split("/").some((part) => part === "." || part === "..");
}

// Move a legacy object to a canonical identity, or delete/recreate it when both identities are
// the same. The latter rotates Firebase's object generation/download token. Dependencies are
// injected so failure and cleanup ordering is unit-testable without production Firebase traffic.
export async function moveOrRotateStorageObject({
  sourcePath,
  targetPath,
  targetExists,
  readObject,
  writeObject,
  removeObject,
}) {
  if (sourcePath === targetPath) {
    const blob = await readObject(sourcePath);
    await removeObject(sourcePath);
    await writeObject(targetPath, blob);
    return;
  }

  let createdTarget = false;
  try {
    if (!(await targetExists(targetPath))) {
      const blob = await readObject(sourcePath);
      await writeObject(targetPath, blob);
      createdTarget = true;
    }
    await removeObject(sourcePath);
  } catch (error) {
    if (createdTarget) await removeObject(targetPath).catch(() => {});
    throw error;
  }
}
