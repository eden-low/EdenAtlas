import {
  parseFirebaseStorageObjectUrl,
  isOwnCapsuleObjectPath,
  canonicalCapsuleObjectPath,
} from "./storage-url-policy.js";

export const CAPSULE_MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;
export const CAPSULE_ALLOWED_ATTACHMENT_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "text/plain",
]);

export function validateCapsuleAttachment(file) {
  if (!file) return null;
  if (!CAPSULE_ALLOWED_ATTACHMENT_TYPES.includes(file.type)) return "unsupported-type";
  if (!Number.isFinite(file.size) || file.size <= 0 || file.size > CAPSULE_MAX_ATTACHMENT_BYTES) {
    return "invalid-size";
  }
  return null;
}

export function resolveLegacyCapsulePath(attachmentUrl, expectedBucket, uid) {
  const parsed = parseFirebaseStorageObjectUrl(attachmentUrl, expectedBucket);
  return parsed && isOwnCapsuleObjectPath(parsed.objectPath, uid) ? parsed.objectPath : null;
}

function isMissingObject(error) {
  return error?.code === "storage/object-not-found";
}

// One-way legacy normalization. URLs are accepted only as exact locators; returned state contains
// a canonical object path (or null) and never retains a URL. Callers persist that state with the
// bounded Firestore legacy-to-canonical update rule.
export async function prepareLegacyCapsuleAttachment({
  capsule,
  uid,
  expectedBucket,
  readObject,
  writeObject,
  removeObject,
}) {
  const targetPath = canonicalCapsuleObjectPath(uid, capsule.id);
  if (capsule.attachmentUrl == null || capsule.attachmentUrl === "") {
    return { attachmentPath: null, attachmentType: null, classification: "no-attachment" };
  }

  const oldPath = resolveLegacyCapsulePath(capsule.attachmentUrl, expectedBucket, uid);
  if (!oldPath) {
    return { attachmentPath: null, attachmentType: null, classification: "unrecoverable-url" };
  }

  let blob;
  let uploadedTarget = false;
  try {
    blob = await readObject(targetPath);
    if (oldPath === targetPath) {
      // A legacy token URL that already points at the canonical name must still be revoked.
      // Recreate the object without carrying its old download token forward.
      await removeObject(targetPath);
      await writeObject(targetPath, blob, { contentType: blob.type });
      uploadedTarget = true;
    }
  } catch (targetError) {
    if (!isMissingObject(targetError)) throw targetError;
    try {
      blob = await readObject(oldPath);
    } catch (oldError) {
      if (isMissingObject(oldError)) {
        return { attachmentPath: null, attachmentType: null, classification: "unrecoverable-missing-object" };
      }
      throw oldError;
    }
    const policyError = validateCapsuleAttachment(blob);
    if (policyError) {
      if (oldPath !== targetPath) await removeObject(oldPath);
      return { attachmentPath: null, attachmentType: null, classification: `unrecoverable-${policyError}` };
    }
    await writeObject(targetPath, blob, { contentType: blob.type });
    uploadedTarget = true;
  }

  const policyError = validateCapsuleAttachment(blob);
  if (policyError) {
    await removeObject(oldPath).catch((error) => { if (!isMissingObject(error)) throw error; });
    if (targetPath !== oldPath) {
      await removeObject(targetPath).catch((error) => { if (!isMissingObject(error)) throw error; });
    }
    return { attachmentPath: null, attachmentType: null, classification: `unrecoverable-${policyError}` };
  }

  if (oldPath !== targetPath) {
    try {
      await removeObject(oldPath);
    } catch (deleteError) {
      if (!isMissingObject(deleteError)) {
        if (uploadedTarget) await removeObject(targetPath).catch(() => {});
        throw deleteError;
      }
    }
  }

  return {
    attachmentPath: targetPath,
    attachmentType: capsule.attachmentType === "image" || blob.type.startsWith("image/") ? "image" : "file",
    classification: "migrated",
  };
}

export async function createCapsuleWithCleanup({ attachmentPath, file, uploadObject, writeDocument, removeObject }) {
  let uploaded = false;
  try {
    if (file) {
      await uploadObject(attachmentPath, file, { contentType: file.type });
      uploaded = true;
    }
    await writeDocument();
  } catch (error) {
    if (uploaded) {
      try {
        await removeObject(attachmentPath);
      } catch (cleanupError) {
        if (!isMissingObject(cleanupError)) error.cleanupError = cleanupError;
      }
    }
    throw error;
  }
}

export async function deleteCapsuleWithAttachment({ cleanupPath, removeObject, deleteDocument }) {
  if (cleanupPath) {
    try {
      await removeObject(cleanupPath);
    } catch (error) {
      if (!isMissingObject(error)) throw error;
    }
  }
  await deleteDocument();
}
