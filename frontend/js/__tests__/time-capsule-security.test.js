import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import {
  parseFirebaseStorageObjectUrl,
  canonicalCapsuleObjectPath,
  isCanonicalCapsuleObjectPath,
} from "../storage-url-policy.js";
import {
  CAPSULE_MAX_ATTACHMENT_BYTES,
  CAPSULE_ALLOWED_ATTACHMENT_TYPES,
  validateCapsuleAttachment,
  resolveLegacyCapsulePath,
  prepareLegacyCapsuleAttachment,
  createCapsuleWithCleanup,
  deleteCapsuleWithAttachment,
} from "../capsule-attachment-lifecycle.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "frontend", "js", "time-capsule.js"), "utf8");
const HTML = fs.readFileSync(path.join(ROOT, "frontend", "pages", "time-capsule.html"), "utf8");
const BUCKET = "lfj-profolio.firebasestorage.app";
const UID = "owner-uid";
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

function extractFunctionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const braceStart = src.indexOf("{", start);
  let depth = 0;
  for (let index = braceStart; index < src.length; index++) {
    if (src[index] === "{") depth++;
    if (src[index] === "}" && --depth === 0) return src.slice(start, index + 1);
  }
  throw new Error(`${name} has no closing brace`);
}

function storageUrl(objectPath, bucket = BUCKET) {
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(objectPath)}?alt=media&token=legacy`;
}

function missingObject() {
  return Object.assign(new Error("missing"), { code: "storage/object-not-found" });
}

await test("legacy URLs accept only exact HTTPS Firebase Storage URLs for the configured bucket", () => {
  const valid = storageUrl(`capsules/${UID}/old-file.pdf`);
  assert.deepStrictEqual(parseFirebaseStorageObjectUrl(valid, BUCKET)?.objectPath, `capsules/${UID}/old-file.pdf`);
  assert.strictEqual(resolveLegacyCapsulePath(valid, BUCKET, UID), `capsules/${UID}/old-file.pdf`);
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "https://attacker.example/file",
    `https://user:pass@firebasestorage.googleapis.com/v0/b/${BUCKET}/o/file`,
    storageUrl(`capsules/${UID}/file`, "wrong-bucket.example"),
    `https://firebasestorage.googleapis.com.evil.example/v0/b/${BUCKET}/o/file`,
    "not a URL",
  ]) assert.strictEqual(parseFirebaseStorageObjectUrl(value, BUCKET), null, value);
  assert.strictEqual(resolveLegacyCapsulePath(storageUrl("capsules/another-user/file"), BUCKET, UID), null);
});

await test("canonical capsule identity is bound to the Firestore document id", () => {
  assert.strictEqual(canonicalCapsuleObjectPath(UID, "AbCdEfGhIjKlMnOpQrSt"), `capsules/${UID}/AbCdEfGhIjKlMnOpQrSt`);
  assert.strictEqual(isCanonicalCapsuleObjectPath(`capsules/${UID}/AbCdEfGhIjKlMnOpQrSt`, UID, "AbCdEfGhIjKlMnOpQrSt"), true);
  assert.strictEqual(isCanonicalCapsuleObjectPath(`capsules/${UID}/other`, UID, "AbCdEfGhIjKlMnOpQrSt"), false);
  assert.strictEqual(isCanonicalCapsuleObjectPath("capsules/other/AbCdEfGhIjKlMnOpQrSt", UID, "AbCdEfGhIjKlMnOpQrSt"), false);
});

await test("capsule client policy executes the same five MIME and 12 MiB limits as Storage Rules", () => {
  assert.strictEqual(CAPSULE_MAX_ATTACHMENT_BYTES, 12 * 1024 * 1024);
  assert.deepStrictEqual([...CAPSULE_ALLOWED_ATTACHMENT_TYPES], [
    "image/jpeg", "image/png", "image/webp", "application/pdf", "text/plain",
  ]);
  assert.strictEqual(validateCapsuleAttachment(new Blob(["x"], { type: "image/png" })), null);
  assert.strictEqual(validateCapsuleAttachment(new Blob([], { type: "image/png" })), "invalid-size");
  assert.strictEqual(validateCapsuleAttachment({ type: "image/png", size: 12 * 1024 * 1024 + 1 }), "invalid-size");
  assert.strictEqual(validateCapsuleAttachment(new Blob(["x"], { type: "text/html" })), "unsupported-type");
  const input = new JSDOM(HTML).window.document.getElementById("capsule-attachment");
  assert.strictEqual(input.dataset.maxBytes, String(CAPSULE_MAX_ATTACHMENT_BYTES));
  assert.deepStrictEqual(input.accept.split(","), [...CAPSULE_ALLOWED_ATTACHMENT_TYPES]);
});

await test("new upload cleans its canonical object after a failed Firestore create", async () => {
  const calls = [];
  const failure = new Error("firestore denied");
  await assert.rejects(createCapsuleWithCleanup({
    attachmentPath: `capsules/${UID}/AbCdEfGhIjKlMnOpQrSt`,
    file: new Blob(["safe"], { type: "application/pdf" }),
    uploadObject: async (objectPath) => calls.push(`upload:${objectPath}`),
    writeDocument: async () => { calls.push("write"); throw failure; },
    removeObject: async (objectPath) => calls.push(`delete:${objectPath}`),
  }), failure);
  assert.deepStrictEqual(calls, [
    `upload:capsules/${UID}/AbCdEfGhIjKlMnOpQrSt`, "write",
    `delete:capsules/${UID}/AbCdEfGhIjKlMnOpQrSt`,
  ]);
});

await test("successful new capsule creation preserves the uploaded object", async () => {
  const calls = [];
  await createCapsuleWithCleanup({
    attachmentPath: `capsules/${UID}/AbCdEfGhIjKlMnOpQrSt`,
    file: new Blob(["safe"], { type: "application/pdf" }),
    uploadObject: async () => calls.push("upload"),
    writeDocument: async () => calls.push("write"),
    removeObject: async () => calls.push("delete"),
  });
  assert.deepStrictEqual(calls, ["upload", "write"]);
});

await test("legacy capsule without attachment normalizes to canonical null state", async () => {
  const result = await prepareLegacyCapsuleAttachment({
    capsule: { id: "AbCdEfGhIjKlMnOpQrSt", attachmentUrl: null }, uid: UID, expectedBucket: BUCKET,
    readObject: async () => { throw new Error("must not read"); },
    writeObject: async () => { throw new Error("must not write"); },
    removeObject: async () => { throw new Error("must not delete"); },
  });
  assert.deepStrictEqual(result, { attachmentPath: null, attachmentType: null, classification: "no-attachment" });
});

await test("valid legacy attachment migrates to exact document identity and deletes only the decoded old object", async () => {
  const oldPath = `capsules/${UID}/1700000000000-report.pdf`;
  const targetPath = `capsules/${UID}/AbCdEfGhIjKlMnOpQrSt`;
  const calls = [];
  const blob = new Blob(["pdf"], { type: "application/pdf" });
  const result = await prepareLegacyCapsuleAttachment({
    capsule: { id: "AbCdEfGhIjKlMnOpQrSt", attachmentUrl: storageUrl(oldPath), attachmentType: "file" },
    uid: UID, expectedBucket: BUCKET,
    readObject: async (objectPath) => {
      calls.push(`read:${objectPath}`);
      if (objectPath === targetPath) throw missingObject();
      assert.strictEqual(objectPath, oldPath);
      return blob;
    },
    writeObject: async (objectPath, value, metadata) => {
      calls.push(`write:${objectPath}`);
      assert.strictEqual(value, blob);
      assert.strictEqual(metadata.contentType, "application/pdf");
    },
    removeObject: async (objectPath) => calls.push(`delete:${objectPath}`),
  });
  assert.deepStrictEqual(result, { attachmentPath: targetPath, attachmentType: "file", classification: "migrated" });
  assert.deepStrictEqual(calls, [
    `read:${targetPath}`, `read:${oldPath}`, `write:${targetPath}`, `delete:${oldPath}`,
  ]);
});

await test("legacy token already naming the canonical object is revoked by delete-and-recreate", async () => {
  const targetPath = `capsules/${UID}/AbCdEfGhIjKlMnOpQrSt`;
  const calls = [];
  const blob = new Blob(["image"], { type: "image/png" });
  const result = await prepareLegacyCapsuleAttachment({
    capsule: { id: "AbCdEfGhIjKlMnOpQrSt", attachmentUrl: storageUrl(targetPath), attachmentType: "image" },
    uid: UID, expectedBucket: BUCKET,
    readObject: async (objectPath) => { calls.push(`read:${objectPath}`); return blob; },
    writeObject: async (objectPath) => calls.push(`write:${objectPath}`),
    removeObject: async (objectPath) => calls.push(`delete:${objectPath}`),
  });
  assert.deepStrictEqual(result, { attachmentPath: targetPath, attachmentType: "image", classification: "migrated" });
  assert.deepStrictEqual(calls, [`read:${targetPath}`, `delete:${targetPath}`, `write:${targetPath}`]);
});

await test("missing legacy object is classified unrecoverable so edit/open is not blocked forever", async () => {
  const result = await prepareLegacyCapsuleAttachment({
    capsule: { id: "AbCdEfGhIjKlMnOpQrSt", attachmentUrl: storageUrl(`capsules/${UID}/missing.pdf`), attachmentType: "file" },
    uid: UID, expectedBucket: BUCKET,
    readObject: async () => { throw missingObject(); },
    writeObject: async () => { throw new Error("must not write"); },
    removeObject: async () => { throw new Error("must not delete"); },
  });
  assert.deepStrictEqual(result, { attachmentPath: null, attachmentType: null, classification: "unrecoverable-missing-object" });
});

await test("malformed, external, wrong-bucket and cross-user legacy URLs never trigger Storage operations", async () => {
  for (const attachmentUrl of [
    "%%%", "https://external.example/file", storageUrl(`capsules/${UID}/old`, "wrong.example"),
    storageUrl("capsules/another-user/old"),
  ]) {
    let touched = false;
    const result = await prepareLegacyCapsuleAttachment({
      capsule: { id: "AbCdEfGhIjKlMnOpQrSt", attachmentUrl, attachmentType: "file" },
      uid: UID, expectedBucket: BUCKET,
      readObject: async () => { touched = true; },
      writeObject: async () => { touched = true; },
      removeObject: async () => { touched = true; },
    });
    assert.strictEqual(touched, false);
    assert.deepStrictEqual(result, { attachmentPath: null, attachmentType: null, classification: "unrecoverable-url" });
  }
});

await test("legacy files outside canonical MIME policy are revoked rather than migrated", async () => {
  const oldPath = `capsules/${UID}/legacy.html`;
  const removed = [];
  const result = await prepareLegacyCapsuleAttachment({
    capsule: { id: "AbCdEfGhIjKlMnOpQrSt", attachmentUrl: storageUrl(oldPath), attachmentType: "file" },
    uid: UID, expectedBucket: BUCKET,
    readObject: async (objectPath) => {
      if (objectPath !== oldPath) throw missingObject();
      return new Blob(["<script>"], { type: "text/html" });
    },
    writeObject: async () => { throw new Error("must not upload"); },
    removeObject: async (objectPath) => removed.push(objectPath),
  });
  assert.deepStrictEqual(result, { attachmentPath: null, attachmentType: null, classification: "unrecoverable-unsupported-type" });
  assert.deepStrictEqual(removed, [oldPath]);
});

await test("canonical and resolvable legacy deletion remove the exact object before Firestore", async () => {
  const calls = [];
  await deleteCapsuleWithAttachment({
    cleanupPath: `capsules/${UID}/AbCdEfGhIjKlMnOpQrSt`,
    removeObject: async (objectPath) => calls.push(`object:${objectPath}`),
    deleteDocument: async () => calls.push("document"),
  });
  assert.deepStrictEqual(calls, [`object:capsules/${UID}/AbCdEfGhIjKlMnOpQrSt`, "document"]);
});

await test("unresolvable legacy deletion never guesses a path and still permits Firestore cleanup", async () => {
  const calls = [];
  await deleteCapsuleWithAttachment({
    cleanupPath: null,
    removeObject: async () => calls.push("object"),
    deleteDocument: async () => calls.push("document"),
  });
  assert.deepStrictEqual(calls, ["document"]);
});

await test("hostile capsule title/message render as text and unsafe legacy URLs are never linked", () => {
  const dom = new JSDOM("<body></body>");
  const sandbox = {
    document: dom.window.document, Date, t: (key) => key,
    openEditModal() {}, openCapsule() {}, deleteCapsule() {},
    BUCKET_BADGE: {
      sealed: { icon: "fa-lock", labelKey: "sealed", classes: "sealed" },
      ready: { icon: "fa-envelope", labelKey: "ready", classes: "ready" },
      opened: { icon: "fa-envelope-open", labelKey: "opened", classes: "opened" },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunctionSource(SOURCE, "parseOpenAt"), extractFunctionSource(SOURCE, "bucketOf"),
    extractFunctionSource(SOURCE, "formatDate"), extractFunctionSource(SOURCE, "statusBadge"),
    extractFunctionSource(SOURCE, "iconButton"), extractFunctionSource(SOURCE, "capsuleCard"),
    "globalThis.capsuleCard=capsuleCard;",
  ].join("\n"), sandbox);
  const payload = '<img src=x onerror="alert(1)"><script>alert(1)</script>';
  const card = sandbox.capsuleCard({
    id: "capsule", title: payload, message: payload, status: "opened", updatedAt: new Date(),
    _attachmentHref: null,
  });
  assert.strictEqual(card.querySelectorAll("script,img,[onerror],a").length, 0);
  assert.ok(card.textContent.includes(payload));
});

await test("protected attachments use authenticated SDK blobs and never render stored token URLs", () => {
  assert.ok(SOURCE.includes("getBlob(ref(storage"));
  assert.ok(SOURCE.includes("nextObjectUrls.create(blob)"));
  assert.ok(SOURCE.includes("previousObjectUrls.revokeAll()"));
  assert.ok(!SOURCE.includes("getDownloadURL"));
  assert.ok(!SOURCE.includes("link.href = capsule.attachmentUrl"));
  assert.ok(SOURCE.includes("attachmentUrl: deleteField()"));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
