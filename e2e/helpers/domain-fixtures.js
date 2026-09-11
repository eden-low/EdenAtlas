const { Timestamp } = require("firebase-admin/firestore");
const { USERS } = require("../constants.js");
const { getAdminServices, putStorageObject } = require("./emulator-fixtures.js");

const CAREER_COLLECTIONS = [
  "career_projects", "career_experiences", "career_certificates", "career_awards",
];
const CAREER_IDS = Object.freeze({
  career_projects: "e2e-career-project",
  career_experiences: "e2e-career-experience",
  career_certificates: "e2e-career-certificate",
  career_awards: "e2e-career-award",
});
const CAREER_ATTACHMENT_PATH = `career/${USERS.owner.uid}/career_projects/${CAREER_IDS.career_projects}/attachment-1`;
const LEGACY_CAREER_PATH = `career/${USERS.owner.uid}/public/historical-attachment.txt`;
const CAPSULE_ID = "CapsuleFixture000001";
const CAPSULE_ATTACHMENT_PATH = `capsules/${USERS.owner.uid}/${CAPSULE_ID}`;
const LEGACY_CAPSULE_PATH = `capsules/${USERS.owner.uid}/LegacyCapsuleFile001`;

function roleFor(key) {
  return key === "owner" ? "owner" : "viewer";
}

async function seedIdentityProfiles({ careerVisibility = "private", careerPolicyVersion = 7 } = {}) {
  const { db } = getAdminServices();
  const batch = db.batch();
  const createdAt = Timestamp.fromMillis(1_700_000_000_000);
  for (const [key, user] of Object.entries(USERS)) {
    const userData = {
      uid: user.uid,
      email: user.email,
      role: roleFor(key),
      displayName: user.displayName,
      photoURL: "",
      createdAt,
      ...(key === "owner" ? { careerVisibility } : {}),
    };
    const publicData = {
      uid: user.uid,
      role: roleFor(key),
      displayName: user.displayName,
      username: `e2e-${key.toLowerCase()}`,
      photoURL: "",
      createdAt,
      ...(key === "owner" ? { careerVisibility, careerPolicyVersion } : {}),
    };
    batch.set(db.collection("users").doc(user.uid), userData);
    batch.set(db.collection("public_profiles").doc(user.uid), publicData);
  }
  await batch.commit();
}

function careerDocument(collectionName, visibility, version) {
  const base = {
    uid: USERS.owner.uid,
    visibility,
    careerVisibility: visibility,
    careerPolicyVersion: version,
    createdAt: Timestamp.fromMillis(1_700_000_000_000),
    updatedAt: Timestamp.fromMillis(1_700_000_000_000),
  };
  if (collectionName === "career_projects") return {
    ...base, title_en: "E2E Career Project", title_zh: "", summary_en: "Domain fixture",
    summary_zh: "", description_en: "Domain fixture", description_zh: "", reflection_en: "",
    reflection_zh: "", category: "personal", techStack: [], tags: [], images: [], documents: [],
    githubUrl: "", demoUrl: "", featured: false,
  };
  if (collectionName === "career_experiences") return {
    ...base, company: "E2E Company", role_en: "E2E Role", role_zh: "", startDate: "2026-01",
    endDate: "", location: "Local Emulator", description_en: "Fixture", description_zh: "", skills: [],
  };
  if (collectionName === "career_certificates") return {
    ...base, name_en: "E2E Certificate", name_zh: "", issuer: "E2E", issueDate: "2026-01",
    credentialId: "", credentialUrl: "", fileAttachmentPath: null,
  };
  return {
    ...base, title_en: "E2E Award", title_zh: "", issuer: "E2E", date: "2026-01",
    description_en: "Fixture", description_zh: "",
  };
}

async function seedCareerDomain({ visibility = "private", version = 7, withAttachment = true } = {}) {
  await seedIdentityProfiles({ careerVisibility: visibility, careerPolicyVersion: version });
  const { db } = getAdminServices();
  const batch = db.batch();
  for (const collectionName of CAREER_COLLECTIONS) {
    batch.set(db.collection(collectionName).doc(CAREER_IDS[collectionName]), careerDocument(collectionName, visibility, version));
  }
  await batch.commit();
  if (withAttachment) {
    await Promise.all([
      putStorageObject(CAREER_ATTACHMENT_PATH, "career attachment"),
      putStorageObject(LEGACY_CAREER_PATH, "historical career attachment"),
    ]);
  }
}

async function seedFriendship({
  fromKey = "owner",
  toKey = "verifiedNonOwner",
  missingMirrorFor = null,
  profileOptions = {},
} = {}) {
  await seedIdentityProfiles(profileOptions);
  const { db } = getAdminServices();
  const from = USERS[fromKey];
  const to = USERS[toKey];
  const timestamp = Timestamp.fromMillis(1_700_000_000_000);
  const batch = db.batch();
  batch.set(db.collection("friend_requests").doc(to.uid).collection("incoming").doc(from.uid), {
    fromUid: from.uid,
    toUid: to.uid,
    status: "accepted",
    fromDisplayName: from.displayName,
    fromUsername: `e2e-${fromKey.toLowerCase()}`,
    fromPhotoURL: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  for (const [ownerKey, friendKey] of [[fromKey, toKey], [toKey, fromKey]]) {
    const owner = USERS[ownerKey];
    const friend = USERS[friendKey];
    if (missingMirrorFor === ownerKey) continue;
    batch.set(db.collection("friendships").doc(owner.uid).collection("friends").doc(friend.uid), {
      uid: owner.uid,
      friendUid: friend.uid,
      friendDisplayName: friend.displayName,
      friendUsername: `e2e-${friendKey.toLowerCase()}`,
      friendPhotoURL: null,
      createdAt: timestamp,
      sourceRequestFromUid: from.uid,
      sourceRequestToUid: to.uid,
    });
  }
  await batch.commit();
  return { from, to };
}

async function seedTimeCapsule() {
  await seedIdentityProfiles();
  const { db } = getAdminServices();
  const timestamp = Timestamp.fromMillis(1_700_000_000_000);
  await db.collection("time_capsules").doc(CAPSULE_ID).set({
    uid: USERS.owner.uid,
    title: "E2E Protected Capsule",
    message: "Emulator-only protected message",
    openAt: Timestamp.fromMillis(1_600_000_000_000),
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "opened",
    visibility: "private",
    attachmentPath: CAPSULE_ATTACHMENT_PATH,
    attachmentType: "file",
  });
  await Promise.all([
    putStorageObject(CAPSULE_ATTACHMENT_PATH, "capsule attachment"),
    putStorageObject(LEGACY_CAPSULE_PATH, "legacy capsule attachment"),
  ]);
}

module.exports = {
  CAREER_COLLECTIONS,
  CAREER_IDS,
  CAREER_ATTACHMENT_PATH,
  LEGACY_CAREER_PATH,
  CAPSULE_ID,
  CAPSULE_ATTACHMENT_PATH,
  LEGACY_CAPSULE_PATH,
  seedIdentityProfiles,
  seedCareerDomain,
  seedFriendship,
  seedTimeCapsule,
};
