import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  canonicalCareerObjectPath,
  isCanonicalCareerObjectPath,
  isOwnLegacyCareerObjectPath,
  moveOrRotateStorageObject,
} from "../storage-url-policy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const CAREER = read("frontend/js/career.js");
const PORTFOLIO = read("frontend/js/portfolio.js");
const PROJECT = read("frontend/js/project.js");
const COLLECTIONS = read("frontend/js/collections.js");
const COLLECTION_DETAIL = read("frontend/js/collection-detail.js");
const PROFILE = read("frontend/js/profile.js");
const INSIGHTS = read("frontend/js/insights.js");
const CONSTELLATION = read("frontend/js/constellation.js");
const DASHBOARD = read("frontend/js/dashboard.js");
const POLICY_FUNCTION = read("backend/netlify/functions/career-policy-transition.js");
const RESUME = read("frontend/pages/resume.html");
const EN = JSON.parse(read("frontend/locales/en.json"));
const ZH = JSON.parse(read("frontend/locales/zh-CN.json"));
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
  const bodyMarker = src.indexOf(") {", start);
  assert.ok(bodyMarker >= 0, `${name} body not found`);
  const braceStart = bodyMarker + 2;
  let depth = 0;
  for (let index = braceStart; index < src.length; index++) {
    if (src[index] === "{") depth++;
    if (src[index] === "}" && --depth === 0) return src.slice(start, index + 1);
  }
  throw new Error(`${name} has no closing brace`);
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${extractFunctionSource(CAREER, "computeAccess")}\nglobalThis.computeAccess=computeAccess;`, sandbox);

await test("Career UI global policy fails closed and preserves the owner's complete archive view", () => {
  assert.deepStrictEqual({ ...sandbox.computeAccess({ isSelf: false, careerVisibility: undefined, isFriend: false }) }, {
    pageAccessible: false, includeConnections: false, includeAllMine: false,
  });
  assert.deepStrictEqual({ ...sandbox.computeAccess({ isSelf: false, careerVisibility: "invalid", isFriend: true }) }, {
    pageAccessible: false, includeConnections: false, includeAllMine: false,
  });
  assert.deepStrictEqual({ ...sandbox.computeAccess({ isSelf: true }) }, {
    pageAccessible: true, includeConnections: true, includeAllMine: true,
  });
});

await test("connections access requires a verified accepted UID connection", () => {
  assert.strictEqual(sandbox.computeAccess({ isSelf: false, careerVisibility: "connections", isFriend: true }).pageAccessible, true);
  assert.strictEqual(sandbox.computeAccess({ isSelf: false, careerVisibility: "connections", isFriend: false }).pageAccessible, false);
  assert.ok(CAREER.includes("me.emailVerified !== true"));
  assert.ok(CAREER.includes('doc(db, "friendships", uid, "friends", me.uid)'));
});

await test("missing policy is never upgraded to public by the client", () => {
  assert.ok(!CAREER.includes("resolvedViaOwnerFallback"));
  assert.ok(!CAREER.includes('careerVisibility = "public"'));
  assert.ok(!CAREER.includes("default visibility upgrade"));
  assert.ok(CAREER.includes('getDoc(doc(db, "public_profiles", uid))'));
});

await test("public portfolio CMS queries bind global policy and item reads to the Owner UID", () => {
  for (const source of [PORTFOLIO, PROJECT]) {
    assert.ok(source.includes('collection(db, "public_profiles")'));
    assert.ok(source.includes('where("role", "==", "owner")'));
    assert.ok(source.includes('where("careerVisibility", "==", "public")'));
    assert.ok(source.includes('where("uid", "==", ownerUid)'));
    assert.ok(source.includes('where("visibility", "==", "public")'));
  }
});

await test("Collections and Collection Detail use the exact UID-bound career_projects query shape", () => {
  for (const [name, source] of [["collections.js", COLLECTIONS], ["collection-detail.js", COLLECTION_DETAIL]]) {
    assert.ok(source.includes('if (name === "career_projects")'), `${name}: Career must have a dedicated query`);
    assert.ok(source.includes('where("careerVisibility", "==", "public")'), `${name}: global public policy must be bound`);
    assert.ok(source.includes("const canonicalTargetUid"), `${name}: canonical target must come from Owner profile`);
    assert.ok(source.includes('where("uid", "==", canonicalTargetUid)'), `${name}: public Career query must be UID-bound`);
    assert.ok(source.includes('where("visibility", "==", "public")'), `${name}: public item visibility must be constrained`);
    assert.ok(source.includes('where("uid", "==", user.uid)'), `${name}: signed-in own query must use auth UID`);
  }
});

await test("all remaining Career read surfaces are UID-bound or intentionally static", () => {
  assert.ok(CAREER.includes('where("uid", "==", uid)'));
  assert.ok(CAREER.includes('where("uid", "==", targetUid)'));
  assert.ok(PROFILE.includes('where("uid", "==", uid)'));
  assert.ok(PORTFOLIO.includes('where("uid", "==", ownerUid)'));
  assert.ok(PROJECT.includes('where("uid", "==", ownerUid)'));
  assert.ok(INSIGHTS.includes('where("uid", "==", user.uid)'));
  assert.ok(CONSTELLATION.includes('where("uid", "==", user.uid)'));
  assert.ok(PORTFOLIO.includes("intentionally public content"));
});

await test("Career attachment object identity is canonical and traversal-safe", () => {
  const pathValue = canonicalCareerObjectPath("owner", "career_projects", "project-id", "attachment_id-1");
  assert.strictEqual(pathValue, "career/owner/career_projects/project-id/attachment_id-1");
  assert.strictEqual(isCanonicalCareerObjectPath(pathValue, "owner", "career_projects", "project-id"), true);
  assert.strictEqual(isCanonicalCareerObjectPath("career/owner/career_projects/other/attachment", "owner", "career_projects", "project-id"), false);
  assert.strictEqual(isCanonicalCareerObjectPath("career/owner/career_projects/project-id/../private", "owner", "career_projects", "project-id"), false);
  assert.strictEqual(isCanonicalCareerObjectPath("career/owner/unknown/project-id/attachment", "owner", "unknown", "project-id"), false);
  assert.strictEqual(isOwnLegacyCareerObjectPath("career/owner/public/projects/images/old.png", "owner"), true);
  assert.strictEqual(isOwnLegacyCareerObjectPath("career/other/public/projects/images/old.png", "owner"), false);
});

await test("protected Career attachments use Storage SDK blobs and never persistent download URLs", () => {
  assert.ok(CAREER.includes("getBlob(ref(storage, attachmentPath))"));
  assert.ok(CAREER.includes("objectUrls.create(blob)"));
  assert.ok(CAREER.includes("previousObjectUrls.revokeAll()"));
  assert.ok(!CAREER.includes("getDownloadURL"));
  assert.ok(CAREER.includes("fileAttachmentPath"));
  assert.ok(CAREER.includes("attachmentPath"));
  assert.ok(CAREER.includes("fileUrl: deleteField()"));
});

await test("a legacy token for the canonical Career object is revoked by exact delete-and-recreate", async () => {
  const objectPath = "career/owner/career_projects/item/attachment";
  const events = [];
  await moveOrRotateStorageObject({
    sourcePath: objectPath,
    targetPath: objectPath,
    targetExists: async () => { throw new Error("same-path rotation must not probe metadata"); },
    readObject: async (pathValue) => { events.push(`read:${pathValue}`); return { type: "image/png" }; },
    removeObject: async (pathValue) => { events.push(`delete:${pathValue}`); },
    writeObject: async (pathValue) => { events.push(`write:${pathValue}`); },
  });
  assert.deepStrictEqual(events, [
    `read:${objectPath}`,
    `delete:${objectPath}`,
    `write:${objectPath}`,
  ]);
});

await test("visibility changes normalize legacy Career attachments before policy writes", () => {
  const normalize = CAREER.indexOf("await normalizeAllCachedCareerAttachments();");
  const transitionRequest = CAREER.indexOf("await requestCareerPolicyTransition(value)");
  assert.ok(normalize >= 0 && transitionRequest > normalize);
  assert.ok(CAREER.includes("await moveOrRotateStorageObject({"));
  assert.ok(CAREER.includes("if (placeholderCreated) await deleteDoc(itemRef).catch(() => {})"));
});

await test("global Career policy and every item snapshot commit atomically", () => {
  const requestTransition = extractFunctionSource(CAREER, "requestCareerPolicyTransition");
  assert.ok(CAREER.includes('/.netlify/functions/career-policy-transition'));
  assert.ok(requestTransition.includes('action: "begin"'));
  assert.ok(requestTransition.includes('action: "complete"'));
  assert.ok(requestTransition.includes("let transitionSecret = null"));
  assert.ok(requestTransition.includes("finally"));
  assert.ok(!requestTransition.includes("crypto.randomUUID"));
  assert.ok(!requestTransition.includes("localStorage"));
  assert.ok(!CAREER.includes("careerPolicyTransition: deleteField()"));
  assert.ok(POLICY_FUNCTION.includes("MAX_CAREER_ITEMS = 498"));
  assert.ok(POLICY_FUNCTION.includes("crypto.randomUUID()"));
  assert.ok(POLICY_FUNCTION.includes('crypto.randomBytes(32).toString("base64url")'));
  assert.ok(POLICY_FUNCTION.includes("beginPolicyTransition"));
  assert.ok(POLICY_FUNCTION.includes("completePolicyTransition"));
  assert.ok(POLICY_FUNCTION.includes("await transaction.get(db.collection(collectionName).where"));
  assert.ok(POLICY_FUNCTION.includes("snapshotMatchesPolicy"));
  assert.ok(POLICY_FUNCTION.includes("careerPolicyTransition: FieldValue.delete()"));
  assert.ok(POLICY_FUNCTION.includes("careerPolicyLastConsumed: consumed"));
  assert.ok(POLICY_FUNCTION.includes('PolicyTransitionError("transition_already_consumed")'));
  assert.ok(POLICY_FUNCTION.includes("transaction.update(item.ref"));
  assert.ok(POLICY_FUNCTION.includes("markerMatches(active"));
  assert.ok(CAREER.includes("event.target.value = currentCareerVisibility"));
});

await test("all four Career item writers carry the effective policy snapshot", () => {
  assert.ok(CAREER.includes("function currentCareerPolicySnapshot()"));
  assert.strictEqual((CAREER.match(/\.\.\.currentCareerPolicySnapshot\(\)/g) || []).length, 6);
  for (const name of ["career_experiences", "career_projects", "career_certificates", "career_awards"]) {
    assert.ok(CAREER.includes(name));
  }
});

await test("connection revocation removes both friendship mirrors atomically", () => {
  const removeFriend = extractFunctionSource(DASHBOARD, "removeFriend");
  const revoke = extractFunctionSource(DASHBOARD, "revokeFriendshipState");
  const prune = extractFunctionSource(DASHBOARD, "pruneStaleFriendships");
  assert.ok(removeFriend.includes("await revokeFriendshipState(friendUid)"));
  assert.ok(prune.includes("await revokeFriendshipState(friendUid)"));
  assert.ok(revoke.includes('doc(db, "friend_requests", user.uid, "incoming", friendUid)'));
  assert.ok(revoke.includes('doc(db, "friend_requests", friendUid, "incoming", user.uid)'));
  assert.ok(revoke.includes("await runTransaction(db"));
  assert.ok(revoke.includes("transaction.delete(friendshipRef)"));
  assert.ok(revoke.includes('status: "cancelled", updatedAt: serverTimestamp()'));
});

await test("Career privacy copy does not claim static bundled fallback content is protected", () => {
  assert.match(EN.career.visibility_hint, /Firestore/i);
  assert.match(EN.career.visibility_hint, /fallback content remains public/i);
  assert.match(ZH.career.visibility_hint, /Firestore/i);
  assert.ok(RESUME.includes("career.visibility_hint"));
  assert.ok(PORTFOLIO.includes("intentionally public content"));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
