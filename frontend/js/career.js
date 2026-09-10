import { auth, googleProvider, db, storage, isOwner } from "./firebase-init.js";
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import {
  collection,
  query,
  where,
  getDocs,
  addDoc,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  deleteField,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { ref, uploadBytes, getBlob, getMetadata, deleteObject } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-storage.js";
import { getLang, setLang, t as i18nT } from "./i18n.js";
import { resolveDisplayName } from "./identity.js";
import { createObjectUrlRegistry } from "./object-url-lifecycle.js";
// Canonical résumé content — single source of truth shared with portfolio.js.
import { PROFILE, EDUCATION, EXPERIENCE, PROJECTS, LEADERSHIP, RESUME_SKILLS } from "./resume-data.js";
import {
  parseFirebaseStorageObjectUrl,
  canonicalCareerObjectPath,
  isCanonicalCareerObjectPath,
  isOwnLegacyCareerObjectPath,
  moveOrRotateStorageObject,
} from "./storage-url-policy.js";

const authControl = document.getElementById("auth-control");

// Security audit fix: career CMS fields (role/company/dates/title/category/document names/
// project links) are Firestore-stored free text the Owner writes -- Career is Owner-only-write,
// but resume.html is reachable by unauthenticated HR visitors (isCareerReadable's public branch,
// see firestore.rules), so a payload planted here (e.g. via a session compromised elsewhere)
// would reach every visitor with no auth check at all. Same esc() implementation as calendar.js's
// pre-existing one; project links additionally get an http(s)-only scheme check before being
// used as an href, closing the javascript:-URI vector a plain esc() alone wouldn't.
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function safeHref(url) {
  try {
    const u = new URL(url, location.href);
    return u.protocol === "http:" || u.protocol === "https:" ? esc(u.href) : "";
  } catch {
    return "";
  }
}

// ---- Bilingual content helper ----
// Career docs store title_en/title_zh (etc.) as flat fields — this picks the active language,
// falling back to English so a partially-translated entry never renders blank.
function bi(obj, field) {
  const suffix = getLang() === "zh-CN" ? "_zh" : "_en";
  return obj[field + suffix] || obj[field + "_en"] || "";
}

// ---- Collections (v2.7): lets a project reference a life-chapter container, same
// duplicated-per-page pattern used on gallery/journal/expenses/timeline. ----
let cachedCollections = null;
async function loadMyCollectionOptions() {
  const user = auth.currentUser;
  if (!user) return [];
  if (cachedCollections) return cachedCollections;
  try {
    const snap = await getDocs(query(collection(db, "collections"), where("uid", "==", user.uid)));
    cachedCollections = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error("[career] collections fetch failed:", err.code || err);
    cachedCollections = [];
  }
  return cachedCollections;
}

function collectionLabel(c) {
  return (getLang() === "zh-CN" ? c.title_zh : c.title_en) || c.title_en || c.title_zh || "Untitled";
}

async function populateCollectionSelect(selectEl, selectedId) {
  const cols = await loadMyCollectionOptions();
  selectEl.innerHTML = `<option value="">${i18nT("common.uncategorized")}</option>` +
    cols.map((c) => `<option value="${c.id}">${collectionLabel(c)}</option>`).join("");
  selectEl.value = selectedId || "";
}

// ==================== v3.2.2: Public Career Profile / Resume Access ====================
//
// resume.html?u=username (preferred) or ?uid=userUid — the shareable HR link, resolved the same
// way profile.js resolves ?u=/?uid= for profile.html. With no param, falls back to the app's one
// Owner (career is still Owner-only to write — see firestore.rules — so in practice this almost
// always resolves to the Owner either way; the fallback just avoids hardcoding a uid).
//
// `public_profiles/{uid}.careerVisibility` is the owner-facing global policy. Each Career item
// carries a versioned effective snapshot of that policy so Storage Rules can combine the item and
// live UID friendship in two cross-service reads. The selector commits profile + every item in one
// batch; missing/invalid/unversioned item snapshots fail closed for all non-owner Storage reads.
const urlParams = new URLSearchParams(location.search);
const targetUsernameParam = (urlParams.get("u") || "").trim().toLowerCase();
const targetUidParam = urlParams.get("uid");
// Known synchronously, before any Firestore read — true only for an explicit shared-link visit
// (?u=/?uid=), never a bare resume.html open. Used below to decide chrome (sidebar/mobile-nav),
// not access itself (that's still computeAccess()/canEdit).
const hasTargetParam = !!(targetUsernameParam || targetUidParam);

let targetUid = null;
let targetIsOwner = false; // the résumé being viewed belongs to the app Owner (gates fallback content)
let canEdit = false; // true only when the signed-in user IS the app Owner AND is viewing their own uid
let access = { pageAccessible: false, includeConnections: false, includeAllMine: false };
let currentCareerVisibility = "private";
let currentCareerPolicyVersion = 0;

// v3.2.3: resume.html's viewer-mode shell fix. `resume-viewer-mode`/`resume-owner-mode` on
// <body> let styles.css hide the full private-app sidebar/mobile nav for anyone but the Owner
// editing their own resume — a shared HR/friend/connection link should read as a clean resume
// page, not the whole app shell. Deliberately scoped to an explicit ?u=/?uid= visit (or a
// signed-out one) rather than bare `!canEdit`: a non-owner opening bare resume.html directly
// (no shared link) keeps their normal role-based nav so they're never stranded without a way out.
const publicTopbar = document.getElementById("resume-public-topbar");
const publicTopbarProfileLink = document.getElementById("resume-public-view-profile");

function applyViewerModeClass(user) {
  const viewerMode = !canEdit && (hasTargetParam || !user);
  document.body.classList.toggle("resume-viewer-mode", viewerMode);
  document.body.classList.toggle("resume-owner-mode", !viewerMode);
  publicTopbar?.classList.toggle("hidden", !viewerMode);
  if (!viewerMode) publicTopbarProfileLink?.classList.add("hidden");
}

// v3.3.1: the shell's optional "View Profile" link — only meaningful for an explicit shared
// ?u=/?uid= link (never a bare resume.html open, which has no target to point at). Populated
// once targetUid is resolved, independent of whether access ends up granted below — it's a
// wayfinding link, not a second access gate.
function updatePublicTopbarProfileLink() {
  if (!publicTopbarProfileLink) return;
  if (!hasTargetParam || !targetUid) {
    publicTopbarProfileLink.classList.add("hidden");
    return;
  }
  publicTopbarProfileLink.href = targetUsernameParam
    ? `profile.html?u=${encodeURIComponent(targetUsernameParam)}`
    : `profile.html?uid=${encodeURIComponent(targetUid)}`;
  publicTopbarProfileLink.classList.remove("hidden");
}

// v3.2.2 hotfix: resolves an *explicit* ?u=/?uid= target only. The "no param at all" case is
// handled directly in initCareerAccess() — it must resolve to the signed-in user's own uid with
// zero Firestore reads, never through here, so a bare resume.html visit can never depend on
// public_profiles/usernames existing (public_profiles is only populated on a login.html visit,
// not every session-restore, which is what caused the "resume could not be found" regression for
// an already-signed-in Owner who reached resume.html without going through login.html again).
async function resolveTargetUid() {
  if (targetUsernameParam) {
    try {
      const handleSnap = await getDoc(doc(db, "usernames", targetUsernameParam));
      return handleSnap.exists() ? handleSnap.data().uid : null;
    } catch (err) {
      console.error("[career] username lookup failed:", err.code || err);
      return null;
    }
  }
  if (targetUidParam) return targetUidParam;
  return null;
}

// Canonical public résumé fallback: with no ?u=/?uid= param and nobody signed in, resume.html is
// the app's public recruiter résumé — resolve the one app Owner's uid so an anonymous HR visitor
// sees the Owner's public career profile instead of a "sign in to view" wall. public_profiles is
// world-readable (firestore.rules) and holds a `role` mirror, so this needs no auth. Only the
// Owner ever has role == "owner"; if somehow none is found we fall through to the not_found notice.
async function resolveOwnerUidFallback() {
  try {
    const snap = await getDocs(query(collection(db, "public_profiles"), where("role", "==", "owner")));
    if (!snap.empty) return snap.docs[0].id;
  } catch (err) {
    console.error("[career] owner fallback lookup failed:", err.code || err);
  }
  return null;
}

// Every viewer, including the owner, reads the canonical global policy from public_profiles.
// This prevents the private and public profile documents from silently disagreeing.
async function fetchPersonForTarget(uid) {
  try {
    const snap = await getDoc(doc(db, "public_profiles", uid));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.error("[career] person fetch failed:", err.code || err);
    return null;
  }
}

// Mirrors profile.js's isAcceptedFriendOfTarget — one getDoc against the target's own
// friendships subcollection, readable by either side per firestore.rules.
async function isAcceptedFriendOfTarget(uid) {
  const me = auth.currentUser;
  if (!me || me.uid === uid || me.emailVerified !== true) return false;
  try {
    const snap = await getDoc(doc(db, "friendships", uid, "friends", me.uid));
    return snap.exists();
  } catch (err) {
    console.error("[career] friendship check failed:", err.code || err);
    return false;
  }
}

function computeAccess({ isSelf, careerVisibility, isFriend }) {
  // Global privacy limits non-owner viewers only. The authenticated owner must retain a complete
  // archive/management view in every global mode, including private items. The separate public
  // portfolio and project pages remain the recruiter-facing public preview.
  if (isSelf) return { pageAccessible: true, includeConnections: true, includeAllMine: true };
  const vis = ["private", "connections", "public"].includes(careerVisibility)
    ? careerVisibility
    : "private";
  if (vis === "public") return { pageAccessible: true, includeConnections: isFriend, includeAllMine: false };
  if (vis === "connections") return { pageAccessible: isFriend, includeConnections: isFriend, includeAllMine: false };
  return { pageAccessible: false, includeConnections: false, includeAllMine: false };
}

const careerSubnav = document.getElementById("career-subnav");
const careerMain = document.getElementById("career-main");
const careerNotice = document.getElementById("career-access-notice");
const careerNoticeText = document.getElementById("career-access-notice-text");
let lastNoticeReason = null;

function noticeKey(reason) {
  if (reason === "not_found") return "career.resume_not_found";
  if (reason === "connections") return "career.resume_connections_notice";
  if (reason === "signin_required") return "career.signin_required_notice";
  return "career.resume_private_notice";
}

function showNotice(reason) {
  lastNoticeReason = reason;
  careerSubnav.classList.add("hidden");
  careerMain.classList.add("hidden");
  careerNotice.classList.remove("hidden");
  careerNoticeText.textContent = i18nT(noticeKey(reason));
}

function hideNotice() {
  lastNoticeReason = null;
  careerSubnav.classList.remove("hidden");
  careerMain.classList.remove("hidden");
  careerNotice.classList.add("hidden");
}

const visibilityCard = document.getElementById("career-visibility-card");
const visibilitySelect = document.getElementById("career-visibility-select");
const visibilityStatus = document.getElementById("career-visibility-status");

function updateVisibilityControl(careerVisibility) {
  visibilityCard.classList.toggle("hidden", !canEdit);
  if (!canEdit) return;
  visibilitySelect.value = careerVisibility || "private";
  visibilityStatus.textContent = "";
}

async function requestCareerPolicyTransition(value) {
  const user = auth.currentUser;
  if (!user || user.uid !== targetUid || !isOwner(user)) throw new Error("career-policy-owner-only");
  const token = await user.getIdToken();
  const postTransition = async (body) => {
    const response = await fetch("/.netlify/functions/career-policy-transition", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok !== true) throw new Error(payload.error || "career-policy-transition-failed");
    return payload;
  };

  // The server is the sole capability issuer. Keep its raw one-time secret in this stack frame
  // only; completion cannot create a marker, and the references are cleared on every exit path.
  let transitionId = null;
  let transitionSecret = null;
  try {
    const capability = await postTransition({ action: "begin", careerVisibility: value });
    transitionId = capability.transitionId;
    transitionSecret = capability.transitionSecret;
    if (typeof transitionId !== "string" || typeof transitionSecret !== "string") {
      throw new Error("career-policy-capability-invalid");
    }
    return await postTransition({
      action: "complete",
      careerVisibility: value,
      transitionId,
      transitionSecret,
    });
  } finally {
    transitionId = null;
    transitionSecret = null;
  }
}

visibilitySelect.addEventListener("change", async (event) => {
  if (!canEdit || !targetUid) return;
  const value = event.target.value;
  visibilityStatus.textContent = i18nT("common.saving");
  try {
    // Before tightening or widening the global policy, remove every legacy tokenized attachment
    // and bind its replacement to the current Firestore item. A failed normalization aborts the
    // policy change, so the UI never reports a privacy state that left an old public object live.
    await normalizeAllCachedCareerAttachments();
    const result = await requestCareerPolicyTransition(value);
    currentCareerVisibility = value;
    currentCareerPolicyVersion = result.careerPolicyVersion;
    for (const item of [cachedExperiences, cachedProjects, cachedCertificates, cachedAwards].flat()) {
      item.careerVisibility = value;
      item.careerPolicyVersion = result.careerPolicyVersion;
    }
    visibilityStatus.textContent = i18nT("career.visibility_saved");
  } catch (err) {
    console.error("[career] visibility save failed:", err.code || err);
    event.target.value = currentCareerVisibility;
    visibilityStatus.textContent = i18nT("common.couldnt_save");
  }
});

// ---- Fetch: same mine+public(+connections) merge pattern as journals/timeline/habits/
// profile.js, but scoped to `targetUid` (the resume being viewed) rather than every uid in the
// collection. Career write access is still Owner-only (see firestore.rules), so a non-Owner
// targetUid structurally has nothing to fetch here regardless of access level. ----
async function fetchByVisibility(name, uid, visibility) {
  try {
    const snap = await getDocs(query(collection(db, name), where("uid", "==", uid), where("visibility", "==", visibility)));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error(`[career] ${name} ${visibility} query failed:`, err.code || err);
    return [];
  }
}

async function fetchCareerFor(name) {
  if (!targetUid || !access.pageAccessible) return [];
  if (access.includeAllMine) {
    try {
      const snap = await getDocs(query(collection(db, name), where("uid", "==", targetUid)));
      return snap.docs.map((d) => ({ id: d.id, ...d.data(), _careerCollection: name }));
    } catch (err) {
      console.error(`[career] ${name} own query failed:`, err.code || err);
      return [];
    }
  }
  const [pub, connections] = await Promise.all([
    fetchByVisibility(name, targetUid, "public"),
    access.includeConnections ? fetchByVisibility(name, targetUid, "connections") : Promise.resolve([]),
  ]);
  const map = new Map();
  pub.forEach((d) => map.set(d.id, d));
  connections.forEach((d) => map.set(d.id, d));
  return [...map.values()].map((item) => ({ ...item, _careerCollection: name }));
}

let cachedExperiences = [];
let cachedProjects = [];
let cachedCertificates = [];
let cachedAwards = [];
let careerObjectUrls = createObjectUrlRegistry();
let careerLoadGeneration = 0;
let careerAccessGeneration = 0;
let activeProjectCategory = "all";

function clearCareerAttachmentState() {
  // Invalidate an in-flight load before removing the currently rendered generation. This is also
  // the auth-transition teardown: a private blob URL must not survive a same-page sign-out merely
  // because the next viewer fails access checks before loadAll() can replace the registry.
  careerLoadGeneration++;
  cachedExperiences = [];
  cachedProjects = [];
  cachedCertificates = [];
  cachedAwards = [];
  renderExperiences();
  renderProjects();
  renderCertificates();
  renderAwards();
  const previousObjectUrls = careerObjectUrls;
  careerObjectUrls = createObjectUrlRegistry();
  previousObjectUrls.revokeAll();
}

// ---- Canonical fallback content (single source: js/resume-data.js) ----
// The Career CMS is authoritative; these render ONLY when a collection returns no public items
// (today the deployed CMS is empty, so this is the live path). Adapted from the shared nested
// { en, zh } records into this page's flat CMS-doc render shape, so there is exactly ONE
// definition of each Experience/Project record (shared with portfolio.js). Marked `_fallback` so
// Owner edit/delete controls are suppressed (no real Firestore doc backs them); the Owner can
// still "Add Experience/Project" to create real docs that supersede these.

// Bilingual pick for a { en, zh } object (fallback content only; CMS docs use flat _en/_zh).
function biBullet(b) {
  return (getLang() === "zh-CN" ? (b.zh || b.en) : b.en) || "";
}

const FALLBACK_EXPERIENCES = EXPERIENCE.map((e) => ({
  id: "fallback-exp-" + (e.caseSlug || e.role.en),
  _fallback: true,
  role_en: e.role.en,
  role_zh: e.role.zh,
  company_en: e.company.en,
  company_zh: e.company.zh,
  datesText_en: e.dates.en,
  datesText_zh: e.dates.zh,
  location_en: e.location.en,
  location_zh: e.location.zh,
  bullets: e.bullets,
}));

const FALLBACK_PROJECTS = PROJECTS.map((p) => ({
  id: "fallback-proj-" + p.slug,
  _fallback: true,
  slug: p.slug,
  category: p.category,
  featured: !!p.featured,
  title_en: p.name.en,
  title_zh: p.name.zh,
  summary_en: p.tag.en,
  summary_zh: p.tag.zh,
  description_en: [p.problem?.en, p.role?.en, p.outcome?.en].filter(Boolean).join("\n\n"),
  description_zh: [p.problem?.zh, p.role?.zh, p.outcome?.zh].filter(Boolean).join("\n\n"),
  techStack: p.tech || [],
}));

// ---- Static résumé sections (Profile Summary / Education / Leadership / Skills & Languages),
// rendered from the shared bilingual source so the WHOLE résumé switches EN⇄中文 without a reload
// (re-run from the eden:langchange listener). These describe the app Owner, so they only populate
// for the Owner's résumé (targetIsOwner) — a non-owner viewing their own empty résumé gets blanks,
// never the Owner's prose. Section headers stay static data-i18n in resume.html. ----
function biObj(o) {
  if (!o) return "";
  return (getLang() === "zh-CN" ? (o.zh || o.en) : o.en) || "";
}

function renderResumeProfile() {
  const headline = document.getElementById("resume-headline");
  if (headline) headline.textContent = biObj(PROFILE.headline);
  const summary = document.getElementById("resume-summary");
  if (summary) summary.textContent = biObj(PROFILE.summary);
  const loc = document.getElementById("resume-location");
  if (loc) loc.textContent = biObj(PROFILE.location);
}

function renderEducation() {
  const listEl = document.getElementById("education-list");
  if (!listEl) return;
  listEl.replaceChildren(...EDUCATION.map((ed) => {
    const el = document.createElement("div");
    el.className = "bg-darkBg/60 border border-borderNeon rounded-xl p-5";
    const bullets = ed.bullets.map((b) => `<li>${biObj(b)}</li>`).join("");
    el.innerHTML = `
      <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-1">
        <div class="min-w-0">
          <p class="font-cyber font-bold text-sm text-white">${biObj(ed.degree)}</p>
          <p class="text-xs text-neonPurple font-code mt-0.5">${biObj(ed.institution)}</p>
        </div>
        <span class="text-[11px] font-code text-textGray flex-shrink-0">${ed.dates}</span>
      </div>
      ${bullets ? `<ul class="mt-3 text-xs text-textGray space-y-1 list-disc list-inside leading-relaxed">${bullets}</ul>` : ""}`;
    return el;
  }));
}

function renderLeadershipResume() {
  const listEl = document.getElementById("leadership-list");
  if (!listEl) return;
  // Entries with bullets render as a detailed card, entries without as compact divide-y rows —
  // matching resume.html's original featured-block + row-list layout (and its print selectors).
  const detailed = LEADERSHIP.filter((l) => l.bullets && l.bullets.length);
  const compact = LEADERSHIP.filter((l) => !(l.bullets && l.bullets.length));
  const parts = detailed.map((l) => {
    const bullets = l.bullets.map((b) => `<li>${biObj(b)}</li>`).join("");
    return `
      <div class="bg-darkBg/60 border border-borderNeon rounded-xl p-5">
        <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-1">
          <div class="min-w-0">
            <p class="font-cyber font-bold text-sm text-white">${biObj(l.role)}</p>
            <p class="text-xs text-neonPurple font-code mt-0.5">${biObj(l.event)}</p>
          </div>
          <span class="text-[11px] font-code text-textGray flex-shrink-0">${l.date}</span>
        </div>
        <ul class="mt-3 text-xs text-textGray space-y-1 list-disc list-inside leading-relaxed">${bullets}</ul>
      </div>`;
  });
  if (compact.length) {
    const rows = compact.map((l) => `
      <div class="flex items-center gap-3 py-3">
        <i class="fa-solid fa-user-group text-neonBlue text-sm flex-shrink-0"></i>
        <span class="text-sm text-white flex-1">${biObj(l.role)} &mdash; ${biObj(l.event)}</span>
        <span class="text-[11px] font-code text-textGray flex-shrink-0">${l.date}</span>
      </div>`).join("");
    parts.push(`<div class="mt-4 divide-y divide-borderNeon/40">${rows}</div>`);
  }
  listEl.innerHTML = parts.join("");
}

function renderResumeSkills() {
  const listEl = document.getElementById("skills-list");
  if (!listEl) return;
  listEl.innerHTML = RESUME_SKILLS.map((g) => {
    const pills = g.items.map((it) => {
      const label = typeof it === "string" ? it : biObj(it);
      return `<span class="px-3 py-1.5 rounded-full bg-darkBg/60 border border-borderNeon text-xs font-code text-textGray">${label}</span>`;
    }).join("");
    return `
      <div class="flex flex-col sm:flex-row sm:items-baseline gap-2 sm:gap-4">
        <span class="w-48 flex-shrink-0 font-cyber font-bold text-xs text-white tracking-wider">${i18nT(g.labelKey)}</span>
        <div class="flex flex-wrap gap-2">${pills}</div>
      </div>`;
  }).join("");
}

function renderStaticResumeSections() {
  if (!targetIsOwner) {
    const headline = document.getElementById("resume-headline");
    if (headline) headline.textContent = "";
    const summary = document.getElementById("resume-summary");
    if (summary) summary.textContent = "";
    const loc = document.getElementById("resume-location");
    if (loc) loc.textContent = "";
    document.getElementById("education-list")?.replaceChildren();
    document.getElementById("leadership-list")?.replaceChildren();
    document.getElementById("skills-list")?.replaceChildren();
    return;
  }
  renderResumeProfile();
  renderEducation();
  renderLeadershipResume();
  renderResumeSkills();
}

async function loadAll() {
  const loadGeneration = ++careerLoadGeneration;
  const nextObjectUrls = createObjectUrlRegistry();
  let replacedObjectUrls = null;
  try {
  let [experiences, projects, certificates, awards] = await Promise.all([
    fetchCareerFor("career_experiences"),
    fetchCareerFor("career_projects"),
    fetchCareerFor("career_certificates"),
    fetchCareerFor("career_awards"),
  ]);
  if (canEdit) await normalizeAllCachedCareerAttachments(projects, certificates);
  await Promise.all([
    ...projects.filter((item) => !item._fallback).map((item) => hydrateCareerAttachments(item, "career_projects", nextObjectUrls)),
    ...certificates.map((item) => hydrateCareerAttachments(item, "career_certificates", nextObjectUrls)),
  ]);
  // Per-collection fallback so partial CMS population never blanks an unrelated section — but only
  // for the app Owner's résumé (this fallback content is the Owner's; never show it as a non-owner's
  // own empty résumé).
  if (targetIsOwner) {
    if (!experiences.length) experiences = FALLBACK_EXPERIENCES;
    if (!projects.length) projects = FALLBACK_PROJECTS;
  }
  if (loadGeneration !== careerLoadGeneration) {
    nextObjectUrls.revokeAll();
    return;
  }
  const previousObjectUrls = careerObjectUrls;
  replacedObjectUrls = previousObjectUrls;
  careerObjectUrls = nextObjectUrls;
  [cachedExperiences, cachedProjects, cachedCertificates, cachedAwards] = [
    experiences, projects, certificates, awards,
  ];
  renderExperiences();
  renderProjects();
  renderCertificates();
  renderAwards();
  previousObjectUrls.revokeAll();
  } catch (error) {
    nextObjectUrls.revokeAll();
    replacedObjectUrls?.revokeAll();
    throw error;
  }
}

// Resolves the target uid, fetches their access-gating fields, and decides what this viewer may
// see — called once per auth-state change, before loadAll(). Replaces the old "just always fetch
// every public item + my own" behavior with per-target, per-viewer access control.
async function initCareerAccess(user) {
  const accessGeneration = ++careerAccessGeneration;
  canEdit = false;
  targetIsOwner = false;
  targetUid = null;
  access = { pageAccessible: false, includeConnections: false, includeAllMine: false };
  clearCareerAttachmentState();
  applyViewerModeClass(user);

  if (!hasTargetParam) {
    // No ?u=/?uid= at all: someone opening resume.html directly. Signed in -> their own resume,
    // resolved straight from auth with no Firestore read. Signed out -> this is the canonical
    // PUBLIC recruiter résumé route, so resolve the app Owner's uid and render their public
    // career profile (no login wall — objective of the Public-Résumé pass).
    if (!user) {
      const resolvedUid = await resolveOwnerUidFallback();
      if (accessGeneration !== careerAccessGeneration) return;
      targetUid = resolvedUid;
      if (!targetUid) {
        showNotice("not_found");
        return;
      }
    } else {
      targetUid = user.uid;
    }
  } else {
    const resolvedUid = await resolveTargetUid();
    if (accessGeneration !== careerAccessGeneration) return;
    targetUid = resolvedUid;
    if (!targetUid) {
      showNotice("not_found");
      return;
    }
  }

  updatePublicTopbarProfileLink();

  const isSelf = !!user && user.uid === targetUid;
  const person = await fetchPersonForTarget(targetUid);
  if (accessGeneration !== careerAccessGeneration) return;
  if (!person && !isSelf) {
    showNotice("not_found");
    return;
  }
  // Self mode remains available for editing even when the public profile has not been created;
  // all non-owner reads still fail closed until a valid global policy exists.

  // No multi-user Career CMS yet — only the app Owner has a resume. A shared link (?u=/?uid=)
  // resolving to anyone else (a friend's username, etc.) gets a clean "not found" notice instead
  // of an empty resume rendered around the Owner's static Profile/Education/Leadership prose.
  // Deliberately skipped for isSelf, so a possible users/{uid} getDoc race on the Owner's own
  // visit (person null/role missing) can never lock the Owner out of their own resume.
  if (hasTargetParam && !isSelf && person?.role !== "owner") {
    showNotice("not_found");
    return;
  }

  canEdit = isSelf && isOwner(user);
  // The Owner's résumé — the only résumé the app has content/fallbacks for. True for the app Owner
  // viewing their own uid, and for any recruiter/friend/anon viewing the Owner via ?u=/?uid=/the
  // no-param fallback (all of which resolve a person whose role is "owner").
  targetIsOwner = person?.role === "owner" || (isSelf && isOwner(user));
  applyViewerModeClass(user);

  let careerVisibility = person?.careerVisibility;
  currentCareerVisibility = ["private", "connections", "public"].includes(careerVisibility)
    ? careerVisibility
    : "private";
  currentCareerPolicyVersion = Number.isInteger(person?.careerPolicyVersion)
    && person.careerPolicyVersion >= 1
    ? person.careerPolicyVersion
    : 0;
  if (canEdit && currentCareerPolicyVersion === 0) {
    // Canonical initialization is deliberately private. A legacy public profile can never be
    // promoted into a versioned public attachment policy without a later explicit owner action.
    const initialized = await requestCareerPolicyTransition("private");
    if (accessGeneration !== careerAccessGeneration) return;
    currentCareerVisibility = initialized.careerVisibility;
    currentCareerPolicyVersion = initialized.careerPolicyVersion;
    careerVisibility = initialized.careerVisibility;
  }
  const isFriend = user && !isSelf ? await isAcceptedFriendOfTarget(targetUid) : false;
  if (accessGeneration !== careerAccessGeneration) return;
  access = computeAccess({ isSelf, careerVisibility, isFriend });
  updateVisibilityControl(careerVisibility);

  if (!access.pageAccessible) {
    showNotice(careerVisibility === "connections" ? "connections" : "private");
    return;
  }
  hideNotice();
  renderStaticResumeSections();
  await loadAll();
}

// Re-render bilingual content (not just chrome — see js/i18n.js's applyTranslations for that)
// whenever the language switcher fires.
document.addEventListener("eden:langchange", () => {
  renderStaticResumeSections();
  renderExperiences();
  renderProjects();
  renderCertificates();
  renderAwards();
  if (lastNoticeReason) careerNoticeText.textContent = i18nT(noticeKey(lastNoticeReason));
  syncResumeToolbarLang();
});

// ---- Public résumé toolbar (viewer mode: recruiter / friend / shared link). The private-app
// sidebar & mobile nav are hidden in viewer mode, so this is a recruiter's only language switch,
// print entry point and way back to the portfolio. Buttons live in resume.html's #resume-public-
// topbar; wired here since career.js already owns setLang and the viewer-mode state. ----
const resumeLangEn = document.getElementById("resume-lang-en");
const resumeLangZh = document.getElementById("resume-lang-zh");
function syncResumeToolbarLang() {
  const zh = getLang() === "zh-CN";
  resumeLangEn?.classList.toggle("text-white", !zh);
  resumeLangEn?.classList.toggle("text-textGray", zh);
  resumeLangZh?.classList.toggle("text-white", zh);
  resumeLangZh?.classList.toggle("text-textGray", !zh);
}
resumeLangEn?.addEventListener("click", () => setLang("en"));
resumeLangZh?.addEventListener("click", () => setLang("zh-CN"));
document.getElementById("resume-print-btn")?.addEventListener("click", () => window.print());
syncResumeToolbarLang();

// ---- Career attachment identity / bounded legacy normalization ----
// Canonical paths carry the Firestore collection + document id. Storage Rules re-read that item
// on every request, so changing its visibility changes authorization immediately without moving
// the object. Long-lived download URLs are never stored or rendered for protected content.
async function uploadCareerFile(file, collectionName, itemId, attachmentId = crypto.randomUUID()) {
  const user = auth.currentUser;
  const attachmentPath = canonicalCareerObjectPath(user.uid, collectionName, itemId, attachmentId);
  const fileRef = ref(storage, attachmentPath);
  await uploadBytes(fileRef, file);
  return { attachmentPath };
}

function currentCareerPolicySnapshot() {
  return currentCareerPolicyVersion >= 1
    ? {
        careerVisibility: currentCareerVisibility,
        careerPolicyVersion: currentCareerPolicyVersion,
      }
    : {};
}

async function normalizeAllCachedCareerAttachments(projects = cachedProjects, certificates = cachedCertificates) {
  if (!canEdit) return;
  for (const item of projects.filter((entry) => !entry._fallback)) {
    await normalizeCareerAttachments("career_projects", item);
  }
  for (const item of certificates) {
    await normalizeCareerAttachments("career_certificates", item);
  }
}

function careerItemFor(collectionName, id) {
  const source = {
    career_experiences: cachedExperiences,
    career_projects: cachedProjects,
    career_certificates: cachedCertificates,
    career_awards: cachedAwards,
  }[collectionName] || [];
  return source.find((item) => item.id === id);
}

function exactLegacyCareerPath(value, uid) {
  if (typeof value === "object" && value && isOwnLegacyCareerObjectPath(value.storagePath, uid)) return value.storagePath;
  const url = typeof value === "string" ? value : value?.url;
  const parsed = parseFirebaseStorageObjectUrl(url, storage.app.options.storageBucket);
  return parsed && isOwnLegacyCareerObjectPath(parsed.objectPath, uid) ? parsed.objectPath : null;
}

async function migrateCareerEntry(entry, collectionName, itemId, attachmentId) {
  const uid = auth.currentUser.uid;
  const canonicalExistingPath = entry && isCanonicalCareerObjectPath(
    entry.attachmentPath, uid, collectionName, itemId
  ) ? entry.attachmentPath : null;
  const hasLegacyLocator = typeof entry === "string"
    || (typeof entry === "object" && entry !== null
      && (Object.prototype.hasOwnProperty.call(entry, "url")
        || Object.prototype.hasOwnProperty.call(entry, "storagePath")));
  const canonicalEntry = canonicalExistingPath
    ? { attachmentPath: canonicalExistingPath, ...(entry?.name ? { name: entry.name } : {}) }
    : null;
  if (canonicalEntry && !hasLegacyLocator) return canonicalEntry;
  const oldPath = exactLegacyCareerPath(entry, uid);
  if (!oldPath) {
    if (entry) console.warn("[career] legacy attachment classified unrecoverable", { collectionName, itemId, attachmentId });
    // An untrusted extra URL cannot displace an already-valid canonical identity. Strip the URL
    // from Firestore, keep SDK-only access to the canonical object, and never act on the URL.
    return canonicalEntry;
  }
  const targetPath = canonicalExistingPath
    || canonicalCareerObjectPath(uid, collectionName, itemId, attachmentId);
  await moveOrRotateStorageObject({
    sourcePath: oldPath,
    targetPath,
    targetExists: async (path) => {
      try {
        await getMetadata(ref(storage, path));
        return true;
      } catch (error) {
        if (error?.code === "storage/object-not-found") return false;
        throw error;
      }
    },
    readObject: (path) => getBlob(ref(storage, path)),
    writeObject: (path, blob) => uploadBytes(
      ref(storage, path), blob, { contentType: blob.type || "application/octet-stream" }
    ),
    removeObject: (path) => deleteObject(ref(storage, path)),
  });
  return { attachmentPath: targetPath, ...(entry?.name ? { name: entry.name } : {}) };
}

async function normalizeCareerAttachments(collectionName, item) {
  if (!canEdit || !item || item._fallback) return item;
  if (collectionName === "career_projects") {
    const oldImages = Array.isArray(item.images) ? item.images : [];
    const oldDocuments = Array.isArray(item.documents) ? item.documents : [];
    const needsMigration = [...oldImages, ...oldDocuments].some((entry) =>
      !isCanonicalCareerObjectPath(entry?.attachmentPath, item.uid, collectionName, item.id)
      || Object.prototype.hasOwnProperty.call(entry || {}, "url")
      || Object.prototype.hasOwnProperty.call(entry || {}, "storagePath"));
    if (!needsMigration) return item;
    const images = (await Promise.all(oldImages.map((entry, index) =>
      migrateCareerEntry(entry, collectionName, item.id, `legacy-image-${index}`)))).filter(Boolean);
    const documents = (await Promise.all(oldDocuments.map((entry, index) =>
      migrateCareerEntry(entry, collectionName, item.id, `legacy-document-${index}`)))).filter(Boolean);
    await updateDoc(doc(db, collectionName, item.id), { images, documents, updatedAt: serverTimestamp() });
    item.images = images;
    item.documents = documents;
  } else if (collectionName === "career_certificates" && item.fileUrl) {
    const migrated = await migrateCareerEntry({
      attachmentPath: item.fileAttachmentPath,
      url: item.fileUrl,
    }, collectionName, item.id, "legacy-file");
    await updateDoc(doc(db, collectionName, item.id), {
      fileAttachmentPath: migrated?.attachmentPath || null,
      fileUrl: deleteField(),
      updatedAt: serverTimestamp(),
    });
    item.fileAttachmentPath = migrated?.attachmentPath || null;
    delete item.fileUrl;
  }
  return item;
}

async function hydrateCareerAttachments(item, collectionName, objectUrls = careerObjectUrls) {
  const loadPath = async (attachmentPath) => {
    if (!isCanonicalCareerObjectPath(attachmentPath, item.uid, collectionName, item.id)) return null;
    try {
      const blob = await getBlob(ref(storage, attachmentPath));
      return objectUrls.create(blob);
    } catch (error) {
      console.error("[career] attachment read failed:", error.code || error);
      return null;
    }
  };
  if (collectionName === "career_projects") {
    await Promise.all((item.images || []).map(async (entry) => { entry._href = await loadPath(entry.attachmentPath); }));
    await Promise.all((item.documents || []).map(async (entry) => { entry._href = await loadPath(entry.attachmentPath); }));
  } else if (collectionName === "career_certificates") {
    item._fileHref = await loadPath(item.fileAttachmentPath);
  }
  return item;
}

window.addEventListener("pagehide", () => careerObjectUrls.revokeAll());

async function deleteCareerItem(collectionName, id) {
  const item = careerItemFor(collectionName, id);
  const paths = [];
  if (collectionName === "career_projects") {
    for (const entry of [...(item?.images || []), ...(item?.documents || [])]) {
      const canonical = entry?.attachmentPath;
      const legacy = exactLegacyCareerPath(entry, auth.currentUser.uid);
      if (isCanonicalCareerObjectPath(canonical, auth.currentUser.uid, collectionName, id)) paths.push(canonical);
      else if (legacy) paths.push(legacy);
    }
  } else if (collectionName === "career_certificates") {
    if (isCanonicalCareerObjectPath(item?.fileAttachmentPath, auth.currentUser.uid, collectionName, id)) paths.push(item.fileAttachmentPath);
    else {
      const legacy = exactLegacyCareerPath(item?.fileUrl, auth.currentUser.uid);
      if (legacy) paths.push(legacy);
    }
  }
  for (const path of [...new Set(paths)]) {
    try { await deleteObject(ref(storage, path)); }
    catch (error) { if (error?.code !== "storage/object-not-found") throw error; }
  }
  await deleteDoc(doc(db, collectionName, id));
}

function ownerControlsHTML(id, collectionName) {
  return `
    <div class="flex items-center gap-2 flex-shrink-0">
      <button class="career-edit-btn text-textGray hover:text-neonPurple text-xs" data-id="${id}" data-collection="${collectionName}"><i class="fa-solid fa-pen"></i></button>
      <button class="career-delete-btn text-textGray hover:text-rose-400 text-xs" data-id="${id}" data-collection="${collectionName}"><i class="fa-solid fa-trash"></i></button>
    </div>`;
}

function wireOwnerControls(root, onEdit) {
  root.querySelectorAll(".career-edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => onEdit(btn.dataset.id));
  });
  root.querySelectorAll(".career-delete-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm(i18nT("common.delete_confirm"))) return;
      try {
        await deleteCareerItem(btn.dataset.collection, btn.dataset.id);
        // The object/document deletion has committed. Tear down the rendered generation before
        // refetching so a failed refresh cannot leave a deleted attachment's blob URL live.
        clearCareerAttachmentState();
        await loadAll();
      } catch (err) {
        console.error("[career] delete failed:", err.code || err);
      }
    });
  });
}

// ==================== Experience ====================

function renderExperiences() {
  const listEl = document.getElementById("experience-list");
  const emptyEl = document.getElementById("experience-empty");
  const owner = canEdit;
  document.getElementById("add-experience-btn").classList.toggle("hidden", !owner);
  emptyEl.classList.toggle("hidden", cachedExperiences.length > 0);

  const sorted = [...cachedExperiences].sort((a, b) => (b.startDate || "").localeCompare(a.startDate || ""));
  listEl.replaceChildren(
    ...sorted.map((exp) => {
      const el = document.createElement("div");
      el.className = "bg-darkBg/60 border border-borderNeon rounded-xl p-5";
      // Fallback entries carry bilingual company/location + a bilingual datesText_en/_zh pair;
      // CMS docs use a monolingual company/location string and startDate/endDate fields.
      const dates = esc(
        (exp.datesText_en || exp.datesText_zh)
          ? bi(exp, "datesText")
          : (exp.datesText || `${exp.startDate || ""} – ${exp.endDate || "Present"}`)
      );
      const company = esc((exp.company_en || exp.company_zh) ? bi(exp, "company") : (exp.company || ""));
      const loc = esc((exp.location_en || exp.location_zh) ? bi(exp, "location") : (exp.location || ""));
      const skills = (exp.skills || []).map((s) => `<span class="px-2 py-0.5 rounded-full border border-borderNeon text-[10px] font-code text-textGray">${esc(s)}</span>`).join(" ");
      // Fallback entries carry a bullets[] ({en,zh}) list; CMS docs use a single description field.
      const body = exp.bullets && exp.bullets.length
        ? `<ul class="mt-3 space-y-1.5 text-sm text-textGray leading-relaxed list-disc list-inside">${exp.bullets.map((b) => `<li>${esc(biBullet(b))}</li>`).join("")}</ul>`
        : `<p class="text-sm text-textGray mt-3 leading-relaxed">${esc(bi(exp, "description"))}</p>`;
      const itemOwner = owner && !exp._fallback;
      el.innerHTML = `
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="font-cyber font-bold text-sm text-white">${esc(bi(exp, "role"))}</p>
            <p class="text-xs text-neonPurple font-code mt-0.5">${company}</p>
            <p class="text-[11px] text-textGray font-code mt-0.5">${dates}${loc ? " · " + loc : ""}</p>
          </div>
          ${itemOwner ? ownerControlsHTML(exp.id, "career_experiences") : ""}
        </div>
        ${body}
        ${skills ? `<div class="flex flex-wrap gap-1.5 mt-3">${skills}</div>` : ""}`;
      return el;
    })
  );
  wireOwnerControls(listEl, openExperienceForm);
}

function openExperienceForm(id) {
  const exp = id ? cachedExperiences.find((e) => e.id === id) : null;
  document.getElementById("experience-form-id").value = id || "";
  document.getElementById("experience-company").value = exp?.company || "";
  document.getElementById("experience-role-en").value = exp?.role_en || "";
  document.getElementById("experience-role-zh").value = exp?.role_zh || "";
  document.getElementById("experience-start").value = exp?.startDate || "";
  document.getElementById("experience-end").value = exp?.endDate || "";
  document.getElementById("experience-location").value = exp?.location || "";
  document.getElementById("experience-description-en").value = exp?.description_en || "";
  document.getElementById("experience-description-zh").value = exp?.description_zh || "";
  document.getElementById("experience-skills").value = (exp?.skills || []).join(", ");
  document.querySelector(`#experience-form input[name="experience-visibility"][value="${exp?.visibility || "public"}"]`).checked = true;
  document.getElementById("experience-modal").classList.remove("hidden");
}

document.getElementById("add-experience-btn").addEventListener("click", () => openExperienceForm(null));
document.getElementById("experience-modal-close").addEventListener("click", () => document.getElementById("experience-modal").classList.add("hidden"));
document.getElementById("experience-modal-backdrop").addEventListener("click", () => document.getElementById("experience-modal").classList.add("hidden"));

document.getElementById("experience-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const user = auth.currentUser;
  if (!isOwner(user)) return;
  const id = document.getElementById("experience-form-id").value;
  const payload = {
    uid: user.uid,
    company: document.getElementById("experience-company").value.trim(),
    role_en: document.getElementById("experience-role-en").value.trim(),
    role_zh: document.getElementById("experience-role-zh").value.trim(),
    startDate: document.getElementById("experience-start").value,
    endDate: document.getElementById("experience-end").value,
    location: document.getElementById("experience-location").value.trim(),
    description_en: document.getElementById("experience-description-en").value.trim(),
    description_zh: document.getElementById("experience-description-zh").value.trim(),
    skills: document.getElementById("experience-skills").value.split(",").map((s) => s.trim()).filter(Boolean),
    visibility: document.querySelector('#experience-form input[name="experience-visibility"]:checked').value,
    ...currentCareerPolicySnapshot(),
    updatedAt: serverTimestamp(),
  };
  try {
    if (id) {
      await updateDoc(doc(db, "career_experiences", id), payload);
    } else {
      await addDoc(collection(db, "career_experiences"), { ...payload, createdAt: serverTimestamp() });
    }
    document.getElementById("experience-modal").classList.add("hidden");
    await loadAll();
  } catch (err) {
    console.error("[career] experience save failed:", err.code || err);
  }
});

// ==================== Projects ====================

const PROJECT_CATEGORIES = ["personal", "internship", "fyp", "coursework", "work"];

// The résumé has ONE Projects section — the #projects-list grid. It deliberately has no separate
// "Featured Projects" strip (that was a portfolio-style gallery that duplicated every card once the
// shared fallback marked all projects featured); the résumé shows each public project exactly once.
// replaceChildren keeps this idempotent across load / auth resolution / CMS+fallback / langchange.
function renderProjects() {
  const owner = canEdit;
  document.getElementById("add-project-btn").classList.toggle("hidden", !owner);

  const visible = activeProjectCategory === "all" ? cachedProjects : cachedProjects.filter((p) => p.category === activeProjectCategory);

  const emptyEl = document.getElementById("projects-empty");
  emptyEl.classList.toggle("hidden", visible.length > 0);
  document.getElementById("projects-list").replaceChildren(...visible.map((p) => projectCard(p, owner)));
}

function projectCard(project, owner) {
  const el = document.createElement("div");
  el.className = "card-lift bg-darkBg/60 border border-borderNeon rounded-xl overflow-hidden hover:border-neonPurple/40 transition-all cursor-pointer flex flex-col";
  const tech = (project.techStack || []).slice(0, 4).map((s) => `<span class="px-2 py-0.5 rounded-full border border-borderNeon text-[10px] font-code text-textGray">${esc(s)}</span>`).join(" ");
  const cover = project.images?.[0]?._href || null;
  const coverHTML = cover
    ? `<img src="${esc(cover)}" alt="" class="w-full h-36 object-cover">`
    : `<div class="w-full h-36 bg-darkBg/80 flex items-center justify-center text-textGray/50"><i class="fa-solid fa-diagram-project text-2xl"></i></div>`;
  el.innerHTML = `
    ${coverHTML}
    <div class="p-5 flex-1 flex flex-col">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="font-cyber font-bold text-sm text-white truncate">${esc(bi(project, "title"))}</p>
          <p class="text-[10px] font-code text-neonPurple mt-1 uppercase tracking-wider">${esc(project.category || "")}</p>
        </div>
        ${owner && !project._fallback ? ownerControlsHTML(project.id, "career_projects") : ""}
      </div>
      <p class="text-xs text-textGray mt-3 leading-relaxed flex-1">${esc(bi(project, "summary"))}</p>
      ${tech ? `<div class="flex flex-wrap gap-1.5 mt-3">${tech}</div>` : ""}
      <button type="button" class="view-details-btn mt-4 self-start flex items-center gap-1.5 text-xs font-code text-neonPurple hover:underline">
        View Details <i class="fa-solid fa-arrow-right text-[10px]"></i>
      </button>
    </div>`;
  el.addEventListener("click", (event) => {
    if (event.target.closest(".career-edit-btn, .career-delete-btn")) return;
    openProjectDetail(project);
  });
  wireOwnerControls(el, openProjectForm);
  return el;
}

document.querySelectorAll(".project-category-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    activeProjectCategory = btn.dataset.category;
    document.querySelectorAll(".project-category-tab").forEach((b) => b.classList.toggle("text-neonPurple", b === btn));
    renderProjects();
  });
});

function openProjectDetail(project) {
  const modal = document.getElementById("project-detail-modal");
  document.getElementById("project-detail-title").textContent = bi(project, "title");
  document.getElementById("project-detail-category").textContent = project.category || "";
  document.getElementById("project-detail-summary").textContent = bi(project, "summary");
  document.getElementById("project-detail-description").textContent = bi(project, "description");
  document.getElementById("project-detail-reflection").textContent = bi(project, "reflection");
  document.getElementById("project-detail-reflection-section").classList.toggle("hidden", !bi(project, "reflection"));

  const tech = (project.techStack || []).map((s) => `<span class="px-2 py-0.5 rounded-full border border-borderNeon text-[10px] font-code text-textGray">${esc(s)}</span>`).join(" ");
  document.getElementById("project-detail-tech").innerHTML = tech;

  const links = [];
  if (project.githubUrl && safeHref(project.githubUrl)) links.push(`<a href="${safeHref(project.githubUrl)}" target="_blank" rel="noopener" class="text-neonPurple hover:underline text-xs"><i class="fa-brands fa-github mr-1"></i>GitHub</a>`);
  if (project.demoUrl && safeHref(project.demoUrl)) links.push(`<a href="${safeHref(project.demoUrl)}" target="_blank" rel="noopener" class="text-neonPurple hover:underline text-xs"><i class="fa-solid fa-arrow-up-right-from-square mr-1"></i>Demo</a>`);
  document.getElementById("project-detail-links").innerHTML = links.join(" &middot; ");
  document.getElementById("project-detail-links-section").classList.toggle("hidden", links.length === 0);

  const images = (project.images || []).map((img) => img._href
    ? `<img src="${esc(img._href)}" class="w-full h-32 object-cover rounded-lg">`
    : "").join("");
  document.getElementById("project-detail-images").innerHTML = images;
  document.getElementById("project-detail-gallery-section").classList.toggle("hidden", !(project.images || []).length);

  const docs = (project.documents || []).map((d) => d._href
    ? `<a href="${esc(d._href)}" target="_blank" rel="noopener" class="flex items-center gap-2 text-xs text-neonPurple hover:underline"><i class="fa-solid fa-file"></i>${esc(d.name || "Document")}</a>`
    : "").join("");
  document.getElementById("project-detail-documents").innerHTML = docs;
  document.getElementById("project-detail-documents-section").classList.toggle("hidden", !(project.documents || []).length);

  modal.classList.remove("hidden");
}
document.getElementById("project-detail-close").addEventListener("click", () => document.getElementById("project-detail-modal").classList.add("hidden"));
document.getElementById("project-detail-backdrop").addEventListener("click", () => document.getElementById("project-detail-modal").classList.add("hidden"));

async function openProjectForm(id) {
  const project = id ? cachedProjects.find((p) => p.id === id) : null;
  document.getElementById("project-form-id").value = id || "";
  document.getElementById("project-title-en").value = project?.title_en || "";
  document.getElementById("project-title-zh").value = project?.title_zh || "";
  document.getElementById("project-summary-en").value = project?.summary_en || "";
  document.getElementById("project-summary-zh").value = project?.summary_zh || "";
  document.getElementById("project-description-en").value = project?.description_en || "";
  document.getElementById("project-description-zh").value = project?.description_zh || "";
  document.getElementById("project-reflection-en").value = project?.reflection_en || "";
  document.getElementById("project-reflection-zh").value = project?.reflection_zh || "";
  // Optional public case-study fields (v3.5) — all safe-default to "" for legacy projects.
  document.getElementById("project-slug").value = project?.slug || "";
  document.getElementById("project-role-en").value = project?.role_en || "";
  document.getElementById("project-role-zh").value = project?.role_zh || "";
  document.getElementById("project-challenge-en").value = project?.challenge_en || "";
  document.getElementById("project-challenge-zh").value = project?.challenge_zh || "";
  document.getElementById("project-actions-en").value = project?.actions_en || "";
  document.getElementById("project-actions-zh").value = project?.actions_zh || "";
  document.getElementById("project-outcome-en").value = project?.outcome_en || "";
  document.getElementById("project-outcome-zh").value = project?.outcome_zh || "";
  document.getElementById("project-tech-stack").value = (project?.techStack || []).join(", ");
  document.getElementById("project-tags").value = (project?.tags || []).join(", ");
  await populateCollectionSelect(document.getElementById("project-collection"), project?.collectionId);
  document.getElementById("project-category").value = project?.category || "personal";
  document.getElementById("project-github-url").value = project?.githubUrl || "";
  document.getElementById("project-demo-url").value = project?.demoUrl || "";
  document.getElementById("project-featured").checked = !!project?.featured;
  document.getElementById("project-images-existing").dataset.value = JSON.stringify(
    (project?.images || []).map(({ attachmentPath }) => ({ attachmentPath }))
  );
  document.getElementById("project-documents-existing").dataset.value = JSON.stringify(
    (project?.documents || []).map(({ attachmentPath, name }) => ({ attachmentPath, ...(name ? { name } : {}) }))
  );
  document.querySelector(`#project-form input[name="project-visibility"][value="${project?.visibility || "public"}"]`).checked = true;
  document.getElementById("project-status").textContent = "";
  document.getElementById("project-modal").classList.remove("hidden");
}

document.getElementById("add-project-btn").addEventListener("click", () => openProjectForm(null));
document.getElementById("project-modal-close").addEventListener("click", () => document.getElementById("project-modal").classList.add("hidden"));
document.getElementById("project-modal-backdrop").addEventListener("click", () => document.getElementById("project-modal").classList.add("hidden"));

document.getElementById("project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const user = auth.currentUser;
  if (!isOwner(user)) return;
  const statusEl = document.getElementById("project-status");
  const id = document.getElementById("project-form-id").value;
  const visibility = document.querySelector('#project-form input[name="project-visibility"]:checked').value;
  statusEl.textContent = "Saving…";
  const itemRef = id ? doc(db, "career_projects", id) : doc(collection(db, "career_projects"));
  const itemId = itemRef.id;
  const uploadedPaths = [];
  let placeholderCreated = false;
  let existingProject = null;
  try {
    if (id) {
      existingProject = careerItemFor("career_projects", id);
      if (existingProject) await normalizeCareerAttachments("career_projects", existingProject);
    } else {
      // A private placeholder gives Storage Rules a canonical item identity without briefly
      // exposing a partially uploaded public document.
      await setDoc(itemRef, {
        uid: user.uid, visibility: "private", images: [], documents: [],
        ...currentCareerPolicySnapshot(),
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      });
      placeholderCreated = true;
    }
    let images = existingProject
      ? (existingProject.images || []).map(({ attachmentPath }) => ({ attachmentPath }))
      : JSON.parse(document.getElementById("project-images-existing").dataset.value || "[]");
    let documents = existingProject
      ? (existingProject.documents || []).map(({ attachmentPath, name }) => ({ attachmentPath, ...(name ? { name } : {}) }))
      : JSON.parse(document.getElementById("project-documents-existing").dataset.value || "[]");

    const imageFiles = document.getElementById("project-image-files").files;
    for (const file of imageFiles) {
      const uploaded = await uploadCareerFile(file, "career_projects", itemId);
      uploadedPaths.push(uploaded.attachmentPath);
      images.push(uploaded);
    }
    const docFiles = document.getElementById("project-document-files").files;
    for (const file of docFiles) {
      const uploaded = await uploadCareerFile(file, "career_projects", itemId);
      uploadedPaths.push(uploaded.attachmentPath);
      documents.push({ ...uploaded, name: file.name });
    }

    const payload = {
      uid: user.uid,
      title_en: document.getElementById("project-title-en").value.trim(),
      title_zh: document.getElementById("project-title-zh").value.trim(),
      summary_en: document.getElementById("project-summary-en").value.trim(),
      summary_zh: document.getElementById("project-summary-zh").value.trim(),
      description_en: document.getElementById("project-description-en").value.trim(),
      description_zh: document.getElementById("project-description-zh").value.trim(),
      reflection_en: document.getElementById("project-reflection-en").value.trim(),
      reflection_zh: document.getElementById("project-reflection-zh").value.trim(),
      // v3.5 optional public case-study fields — stored lowercase/trimmed, empty strings are fine.
      slug: document.getElementById("project-slug").value.trim().toLowerCase().replace(/\s+/g, "-"),
      role_en: document.getElementById("project-role-en").value.trim(),
      role_zh: document.getElementById("project-role-zh").value.trim(),
      challenge_en: document.getElementById("project-challenge-en").value.trim(),
      challenge_zh: document.getElementById("project-challenge-zh").value.trim(),
      actions_en: document.getElementById("project-actions-en").value.trim(),
      actions_zh: document.getElementById("project-actions-zh").value.trim(),
      outcome_en: document.getElementById("project-outcome-en").value.trim(),
      outcome_zh: document.getElementById("project-outcome-zh").value.trim(),
      techStack: document.getElementById("project-tech-stack").value.split(",").map((s) => s.trim()).filter(Boolean),
      tags: document.getElementById("project-tags").value.split(",").map((s) => s.trim()).filter(Boolean),
      collectionId: document.getElementById("project-collection").value || null,
      category: document.getElementById("project-category").value,
      githubUrl: document.getElementById("project-github-url").value.trim(),
      demoUrl: document.getElementById("project-demo-url").value.trim(),
      images,
      documents,
      visibility,
      ...currentCareerPolicySnapshot(),
      featured: document.getElementById("project-featured").checked,
      updatedAt: serverTimestamp(),
    };

    await updateDoc(itemRef, payload);
    document.getElementById("project-modal").classList.add("hidden");
    await loadAll();
  } catch (err) {
    for (const path of uploadedPaths) await deleteObject(ref(storage, path)).catch(() => {});
    if (placeholderCreated) await deleteDoc(itemRef).catch(() => {});
    console.error("[career] project save failed:", err.code || err);
    statusEl.textContent = "Couldn't save — check console.";
  }
});

// ==================== Certificates ====================

function renderCertificates() {
  const listEl = document.getElementById("certificates-list");
  const emptyEl = document.getElementById("certificates-empty");
  const owner = canEdit;
  document.getElementById("add-certificate-btn").classList.toggle("hidden", !owner);
  emptyEl.classList.toggle("hidden", cachedCertificates.length > 0);

  const sorted = [...cachedCertificates].sort((a, b) => (b.issueDate || "").localeCompare(a.issueDate || ""));
  listEl.replaceChildren(
    ...sorted.map((cert) => {
      const el = document.createElement("div");
      el.className = "bg-darkBg/60 border border-borderNeon rounded-xl p-4";
      const link = safeHref(cert.credentialUrl || "") || cert._fileHref || "";
      el.innerHTML = `
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="font-cyber font-bold text-xs text-white">${esc(bi(cert, "title"))}</p>
            <p class="text-[11px] text-neonPurple font-code mt-0.5">${esc(cert.issuer || "")} ${cert.issueDate ? "· " + esc(cert.issueDate) : ""}</p>
            ${link ? `<a href="${link}" target="_blank" rel="noopener" class="text-[11px] text-textGray hover:text-neonPurple mt-1 inline-block"><i class="fa-solid fa-arrow-up-right-from-square mr-1"></i>View</a>` : ""}
          </div>
          ${owner ? ownerControlsHTML(cert.id, "career_certificates") : ""}
        </div>`;
      return el;
    })
  );
  wireOwnerControls(listEl, openCertificateForm);
}

function openCertificateForm(id) {
  const cert = id ? cachedCertificates.find((c) => c.id === id) : null;
  document.getElementById("certificate-form-id").value = id || "";
  document.getElementById("certificate-title-en").value = cert?.title_en || "";
  document.getElementById("certificate-title-zh").value = cert?.title_zh || "";
  document.getElementById("certificate-issuer").value = cert?.issuer || "";
  document.getElementById("certificate-issue-date").value = cert?.issueDate || "";
  document.getElementById("certificate-credential-url").value = cert?.credentialUrl || "";
  document.getElementById("certificate-file-existing").dataset.value = cert?.fileAttachmentPath || "";
  document.querySelector(`#certificate-form input[name="certificate-visibility"][value="${cert?.visibility || "public"}"]`).checked = true;
  document.getElementById("certificate-status").textContent = "";
  document.getElementById("certificate-modal").classList.remove("hidden");
}

document.getElementById("add-certificate-btn").addEventListener("click", () => openCertificateForm(null));
document.getElementById("certificate-modal-close").addEventListener("click", () => document.getElementById("certificate-modal").classList.add("hidden"));
document.getElementById("certificate-modal-backdrop").addEventListener("click", () => document.getElementById("certificate-modal").classList.add("hidden"));

document.getElementById("certificate-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const user = auth.currentUser;
  if (!isOwner(user)) return;
  const statusEl = document.getElementById("certificate-status");
  const id = document.getElementById("certificate-form-id").value;
  const visibility = document.querySelector('#certificate-form input[name="certificate-visibility"]:checked').value;
  statusEl.textContent = "Saving…";
  const itemRef = id ? doc(db, "career_certificates", id) : doc(collection(db, "career_certificates"));
  const itemId = itemRef.id;
  let uploadedPath = null;
  let previousPath = null;
  let placeholderCreated = false;
  try {
    if (id) {
      const existing = careerItemFor("career_certificates", id);
      if (existing) await normalizeCareerAttachments("career_certificates", existing);
      previousPath = existing?.fileAttachmentPath || null;
    } else {
      await setDoc(itemRef, {
        uid: user.uid, visibility: "private", fileAttachmentPath: null,
        ...currentCareerPolicySnapshot(),
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      });
      placeholderCreated = true;
    }
    let fileAttachmentPath = id
      ? careerItemFor("career_certificates", id)?.fileAttachmentPath || null
      : null;
    const file = document.getElementById("certificate-file").files[0];
    if (file) {
      const uploaded = await uploadCareerFile(file, "career_certificates", itemId);
      uploadedPath = uploaded.attachmentPath;
      fileAttachmentPath = uploadedPath;
    }
    const payload = {
      uid: user.uid,
      title_en: document.getElementById("certificate-title-en").value.trim(),
      title_zh: document.getElementById("certificate-title-zh").value.trim(),
      issuer: document.getElementById("certificate-issuer").value.trim(),
      issueDate: document.getElementById("certificate-issue-date").value,
      credentialUrl: document.getElementById("certificate-credential-url").value.trim(),
      fileAttachmentPath,
      visibility,
      ...currentCareerPolicySnapshot(),
      updatedAt: serverTimestamp(),
    };
    await updateDoc(itemRef, payload);
    if (uploadedPath && previousPath && uploadedPath !== previousPath) {
      await deleteObject(ref(storage, previousPath)).catch((error) => {
        if (error?.code !== "storage/object-not-found") console.error("[career] replaced certificate cleanup failed:", error.code || error);
      });
    }
    document.getElementById("certificate-modal").classList.add("hidden");
    await loadAll();
  } catch (err) {
    if (uploadedPath) await deleteObject(ref(storage, uploadedPath)).catch(() => {});
    if (placeholderCreated) await deleteDoc(itemRef).catch(() => {});
    console.error("[career] certificate save failed:", err.code || err);
    statusEl.textContent = "Couldn't save — check console.";
  }
});

// ==================== Awards ====================

function renderAwards() {
  const listEl = document.getElementById("awards-list");
  const emptyEl = document.getElementById("awards-empty");
  const owner = canEdit;
  document.getElementById("add-award-btn").classList.toggle("hidden", !owner);
  emptyEl.classList.toggle("hidden", cachedAwards.length > 0);

  const sorted = [...cachedAwards].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  listEl.replaceChildren(
    ...sorted.map((award) => {
      const el = document.createElement("div");
      el.className = "bg-darkBg/60 border border-borderNeon rounded-xl p-4 hover:border-amber-400/40 transition-all";
      el.innerHTML = `
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <i class="fa-solid fa-trophy text-amber-400 text-lg mb-2"></i>
            <p class="font-cyber font-bold text-xs text-white">${esc(bi(award, "title"))}</p>
            <p class="text-[11px] text-amber-400 font-code mt-0.5">${esc(award.issuer || "")} ${award.date ? "· " + esc(award.date) : ""}</p>
            <p class="text-xs text-textGray mt-2">${esc(bi(award, "description"))}</p>
          </div>
          ${owner ? ownerControlsHTML(award.id, "career_awards") : ""}
        </div>`;
      return el;
    })
  );
  wireOwnerControls(listEl, openAwardForm);
}

function openAwardForm(id) {
  const award = id ? cachedAwards.find((a) => a.id === id) : null;
  document.getElementById("award-form-id").value = id || "";
  document.getElementById("award-title-en").value = award?.title_en || "";
  document.getElementById("award-title-zh").value = award?.title_zh || "";
  document.getElementById("award-issuer").value = award?.issuer || "";
  document.getElementById("award-date").value = award?.date || "";
  document.getElementById("award-description-en").value = award?.description_en || "";
  document.getElementById("award-description-zh").value = award?.description_zh || "";
  document.querySelector(`#award-form input[name="award-visibility"][value="${award?.visibility || "public"}"]`).checked = true;
  document.getElementById("award-modal").classList.remove("hidden");
}

document.getElementById("add-award-btn").addEventListener("click", () => openAwardForm(null));
document.getElementById("award-modal-close").addEventListener("click", () => document.getElementById("award-modal").classList.add("hidden"));
document.getElementById("award-modal-backdrop").addEventListener("click", () => document.getElementById("award-modal").classList.add("hidden"));

document.getElementById("award-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const user = auth.currentUser;
  if (!isOwner(user)) return;
  const id = document.getElementById("award-form-id").value;
  const payload = {
    uid: user.uid,
    title_en: document.getElementById("award-title-en").value.trim(),
    title_zh: document.getElementById("award-title-zh").value.trim(),
    issuer: document.getElementById("award-issuer").value.trim(),
    date: document.getElementById("award-date").value,
    description_en: document.getElementById("award-description-en").value.trim(),
    description_zh: document.getElementById("award-description-zh").value.trim(),
    visibility: document.querySelector('#award-form input[name="award-visibility"]:checked').value,
    ...currentCareerPolicySnapshot(),
    updatedAt: serverTimestamp(),
  };
  try {
    if (id) {
      await updateDoc(doc(db, "career_awards", id), payload);
    } else {
      await addDoc(collection(db, "career_awards"), { ...payload, createdAt: serverTimestamp() });
    }
    document.getElementById("award-modal").classList.add("hidden");
    await loadAll();
  } catch (err) {
    console.error("[career] award save failed:", err.code || err);
  }
});

// ==================== Auth chrome (same pattern as every other page) ====================

function renderSignedOut() {
  authControl.innerHTML = `
    <button id="auth-signin-btn" class="px-4 py-2 bg-gradient-to-r from-neonViolet to-neonPurple rounded-xl text-xs font-cyber font-bold tracking-wider text-white hover:scale-105 transition-all">
      <i class="fa-brands fa-google mr-2"></i> SIGN IN
    </button>`;
  document.getElementById("auth-signin-btn").addEventListener("click", () => {
    signInWithPopup(auth, googleProvider).catch((err) => console.error("Sign-in failed", err));
  });
}

async function renderSignedIn(user) {
  const name = await resolveDisplayName(user);
  authControl.innerHTML = `
    <span class="text-xs text-textGray font-code">${i18nT("common.signed_in_as")} <span class="text-white">${name}</span></span>
    <button id="auth-signout-btn" class="px-4 py-2 bg-cardBg/70 border border-borderNeon rounded-xl text-xs font-cyber font-bold tracking-wider text-white hover:border-neonPurple transition-all">
      ${i18nT("common.sign_out")}
    </button>`;
  document.getElementById("auth-signout-btn").addEventListener("click", () => signOut(auth));
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    renderSignedIn(user);
  } else {
    renderSignedOut();
  }
  initCareerAccess(user);
});
