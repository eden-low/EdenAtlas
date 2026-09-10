import { auth, googleProvider, db, storage, canParticipate } from "./firebase-init.js";
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
  setDoc,
  doc,
  updateDoc,
  deleteDoc,
  deleteField,
  serverTimestamp,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { ref, uploadBytes, getBlob, deleteObject } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-storage.js";
import { t } from "./i18n.js";
import { resolveDisplayName } from "./identity.js";
import { createObjectUrlRegistry } from "./object-url-lifecycle.js";
import {
  parseFirebaseStorageObjectUrl,
  isOwnCapsuleObjectPath,
  canonicalCapsuleObjectPath,
  isCanonicalCapsuleObjectPath,
} from "./storage-url-policy.js";
import {
  validateCapsuleAttachment,
  resolveLegacyCapsulePath,
  prepareLegacyCapsuleAttachment,
  createCapsuleWithCleanup,
  deleteCapsuleWithAttachment,
} from "./capsule-attachment-lifecycle.js";

const authControl = document.getElementById("auth-control");
const accessNote = document.getElementById("capsule-access-note");
const newCapsuleBtn = document.getElementById("new-capsule-btn");
const capsuleModal = document.getElementById("capsule-modal");
const capsuleModalClose = document.getElementById("capsule-modal-close");
const capsuleModalBackdrop = document.getElementById("capsule-modal-backdrop");
const capsuleForm = document.getElementById("capsule-form");
const capsuleStatus = document.getElementById("capsule-status");
const capsuleEditModal = document.getElementById("capsule-edit-modal");
const capsuleEditModalClose = document.getElementById("capsule-edit-modal-close");
const capsuleEditModalBackdrop = document.getElementById("capsule-edit-modal-backdrop");
const capsuleEditForm = document.getElementById("capsule-edit-form");
const capsuleEditStatus = document.getElementById("capsule-edit-status");
const emptyEl = document.getElementById("capsules-empty");
const readyEl = document.getElementById("capsules-ready");
const sealedEl = document.getElementById("capsules-sealed");
const openedEl = document.getElementById("capsules-opened");
const countSealedEl = document.getElementById("capsule-count-sealed");
const countReadyEl = document.getElementById("capsule-count-ready");
const countOpenedEl = document.getElementById("capsule-count-opened");

let cachedCapsules = [];
let capsuleObjectUrls = createObjectUrlRegistry();
let capsuleLoadGeneration = 0;

function validateAttachmentFile(file) {
  return validateCapsuleAttachment(file);
}

// Firestore Timestamps come back as objects with a toDate() method, but a defensive
// fallback (raw {seconds}, a plain Date, or an ISO-ish string) keeps this from silently
// producing "Invalid Date" if a doc's openAt was ever written in a different shape.
function parseOpenAt(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (value.seconds) return new Date(value.seconds * 1000);
  if (value instanceof Date) return value;
  return new Date(value);
}

function bucketOf(c) {
  const status = c.status || "sealed";
  if (status === "opened") return "opened";
  const openAt = parseOpenAt(c.openAt);
  if (openAt && openAt <= new Date()) return "ready";
  return "sealed";
}

function formatDate(ts) {
  const d = parseOpenAt(ts);
  return d ? d.toLocaleDateString(undefined, { dateStyle: "medium" }) : "";
}

function dateInputValue(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const BUCKET_BADGE = {
  sealed: { icon: "fa-lock", labelKey: "time_capsule.sealed", classes: "text-textGray bg-textGray/10" },
  ready: { icon: "fa-envelope", labelKey: "time_capsule.ready_to_open", classes: "text-neonPurple bg-neonPurple/10" },
  opened: { icon: "fa-envelope-open", labelKey: "time_capsule.opened", classes: "text-emerald-400 bg-emerald-400/10" },
};

function statusBadge(bucket) {
  const meta = BUCKET_BADGE[bucket];
  const badge = document.createElement("span");
  badge.className = `inline-flex items-center gap-1.5 text-[10px] font-code uppercase tracking-wide ${meta.classes} px-2 py-0.5 rounded-full`;
  const icon = document.createElement("i");
  icon.className = `fa-solid ${meta.icon} text-[9px]`;
  badge.append(icon, document.createTextNode(t(meta.labelKey)));
  return badge;
}

function iconButton(className, iconClass, title, text = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.title = title;
  const icon = document.createElement("i");
  icon.className = iconClass;
  button.appendChild(icon);
  if (text) button.appendChild(document.createTextNode(` ${text}`));
  return button;
}

function capsuleCard(c) {
  const bucket = bucketOf(c);
  const el = document.createElement("div");
  // "is-visible" (not "reveal"): cards are appended after the page's one-time, load-time
  // IntersectionObserver scan (scripts.js), which never re-observes elements added later —
  // a "reveal" class here would stay at opacity:0 forever. Every other page that renders
  // cards from JS (gallery.js, journal.js, habits.js, etc.) already follows this convention.
  el.className = "is-visible card-lift bg-cardBg/90 neon-border-purple rounded-2xl p-5 flex flex-col gap-3";

  const header = document.createElement("div");
  header.className = "flex items-center justify-between gap-2";
  header.appendChild(statusBadge(bucket));
  const actions = document.createElement("div");
  actions.className = "flex items-center gap-3";
  if (bucket === "sealed") {
    const edit = iconButton("capsule-edit-btn text-textGray hover:text-neonPurple text-xs", "fa-solid fa-pen", t("common.edit_metadata"));
    edit.addEventListener("click", () => openEditModal(c));
    actions.appendChild(edit);
  }
  if (bucket === "ready") {
    const open = iconButton("capsule-open-btn px-3 py-1.5 bg-gradient-to-r from-neonViolet to-neonPurple rounded-lg text-[11px] font-cyber font-bold tracking-wider text-white hover:scale-105 transition-all", "fa-solid fa-envelope-open", t("time_capsule.open_button"), t("time_capsule.open_button"));
    open.addEventListener("click", () => openCapsule(c.id));
    actions.appendChild(open);
  }
  const remove = iconButton("capsule-delete-btn text-textGray hover:text-rose-400 text-xs", "fa-solid fa-trash", t("common.delete"));
  remove.addEventListener("click", () => deleteCapsule(c.id));
  actions.appendChild(remove);
  header.appendChild(actions);
  el.appendChild(header);

  const title = document.createElement("span");
  title.className = "text-sm font-semibold text-white truncate";
  title.textContent = typeof c.title === "string" ? c.title : "";
  el.appendChild(title);

  // Sealed capsules deliberately never render `c.message` (it's meant to stay hidden until
  // opened); only the opened bucket shows the actual content.
  if (bucket === "sealed") {
    const locked = document.createElement("p");
    locked.className = "text-xs font-code text-textGray";
    locked.textContent = t("time_capsule.locked_notice", { date: formatDate(c.openAt) });
    el.appendChild(locked);
  } else if (bucket === "opened") {
    const message = document.createElement("p");
    message.className = "text-sm text-white/90 whitespace-pre-wrap";
    message.textContent = typeof c.message === "string" ? c.message : "";
    el.appendChild(message);
    if (c._attachmentHref) {
      const link = document.createElement("a");
      link.href = c._attachmentHref;
      link.target = "_blank";
      link.rel = "noopener";
      link.className = "inline-flex items-center gap-1.5 text-xs text-neonPurple hover:underline";
      const icon = document.createElement("i");
      icon.className = "fa-solid fa-paperclip";
      link.append(icon, document.createTextNode(` ${t("time_capsule.attachment_label")}`));
      el.appendChild(link);
    }
  }

  if (bucket === "ready" || bucket === "opened") {
    const dateLine = document.createElement("p");
    dateLine.className = "text-[10px] font-code text-textGray";
    dateLine.textContent = bucket === "ready"
      ? `${t("time_capsule.open_date_label")}: ${formatDate(c.openAt)}`
      : t("time_capsule.opened_on", { date: formatDate(c.updatedAt) });
    el.appendChild(dateLine);
  }

  return el;
}

function renderCapsules() {
  try {
    const ready = cachedCapsules.filter((c) => bucketOf(c) === "ready");
    const sealed = cachedCapsules.filter((c) => bucketOf(c) === "sealed");
    const opened = cachedCapsules.filter((c) => bucketOf(c) === "opened");

    readyEl.replaceChildren(...ready.map(capsuleCard));
    sealedEl.replaceChildren(...sealed.map(capsuleCard));
    openedEl.replaceChildren(...opened.map(capsuleCard));

    readyEl.parentElement.classList.toggle("hidden", ready.length === 0);
    sealedEl.parentElement.classList.toggle("hidden", sealed.length === 0);
    openedEl.parentElement.classList.toggle("hidden", opened.length === 0);
    emptyEl.classList.toggle("hidden", cachedCapsules.length > 0);

    if (countSealedEl) countSealedEl.textContent = String(sealed.length);
    if (countReadyEl) countReadyEl.textContent = String(ready.length);
    if (countOpenedEl) countOpenedEl.textContent = String(opened.length);
  } catch (err) {
    console.error("[time-capsule] render failed:", err);
  }
}

async function openCapsule(id) {
  try {
    const legacy = cachedCapsules.find((item) => item.id === id);
    if (legacy && !await migrateLegacyCapsule(legacy)) return;
    await updateDoc(doc(db, "time_capsules", id), { status: "opened", updatedAt: serverTimestamp() });
    const c = cachedCapsules.find((x) => x.id === id);
    if (c) c.status = "opened";
    renderCapsules();
  } catch (err) {
    console.error("[time-capsule] open failed:", err.code || err);
  }
}

async function deleteCapsule(id) {
  if (!confirm(t("common.delete_confirm"))) return;
  const capsule = cachedCapsules.find((item) => item.id === id);
  try {
    const uid = auth.currentUser?.uid;
    let cleanupPath = capsule && isCanonicalCapsuleObjectPath(capsule.attachmentPath, uid, capsule.id)
      ? capsule.attachmentPath
      : null;
    if (!cleanupPath && capsule && Object.prototype.hasOwnProperty.call(capsule, "attachmentUrl")) {
      cleanupPath = resolveLegacyCapsulePath(capsule.attachmentUrl, storage.app.options.storageBucket, uid);
      if (capsule.attachmentUrl && !cleanupPath) {
        // The legacy record is deletable, but there is no trustworthy object identity to clean.
        // Classify this explicitly; never guess a path or keep the Firestore lifecycle blocked.
        alert(t("time_capsule.legacy_attachment_unrecoverable"));
      }
    }
    await deleteCapsuleWithAttachment({
      cleanupPath,
      removeObject: (path) => deleteObject(ref(storage, path)),
      deleteDocument: () => deleteDoc(doc(db, "time_capsules", id)),
    });
    const removedObjectUrl = capsule?._attachmentHref;
    cachedCapsules = cachedCapsules.filter((c) => c.id !== id);
    renderCapsules();
    capsuleObjectUrls.revoke(removedObjectUrl);
  } catch (err) {
    console.error("[time-capsule] delete failed:", err.code || err);
    alert(t("time_capsule.delete_retry"));
  }
}

function openEditModal(c) {
  document.getElementById("capsule-edit-id").value = c.id;
  document.getElementById("capsule-edit-title").value = c.title;
  document.getElementById("capsule-edit-message").value = c.message;
  const openAt = parseOpenAt(c.openAt);
  document.getElementById("capsule-edit-open-date").value = openAt ? dateInputValue(openAt) : "";
  capsuleEditStatus.textContent = "";
  capsuleEditModal.classList.remove("hidden");
}
function closeEditModal() {
  capsuleEditModal.classList.add("hidden");
  capsuleEditForm.reset();
  capsuleEditStatus.textContent = "";
}

capsuleEditModalClose.addEventListener("click", closeEditModal);
capsuleEditModalBackdrop.addEventListener("click", closeEditModal);

capsuleEditForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = document.getElementById("capsule-edit-id").value;
  const title = document.getElementById("capsule-edit-title").value.trim();
  const message = document.getElementById("capsule-edit-message").value.trim();
  const openDateVal = document.getElementById("capsule-edit-open-date").value;
  if (!id || !title || !message || !openDateVal) return;

  capsuleEditStatus.textContent = t("common.saving");
  try {
    const legacy = cachedCapsules.find((item) => item.id === id);
    if (legacy && !await migrateLegacyCapsule(legacy)) return;
    await updateDoc(doc(db, "time_capsules", id), {
      title,
      message,
      openAt: Timestamp.fromDate(new Date(openDateVal)),
      updatedAt: serverTimestamp(),
    });
    const c = cachedCapsules.find((x) => x.id === id);
    if (c) {
      c.title = title;
      c.message = message;
      c.openAt = Timestamp.fromDate(new Date(openDateVal));
    }
    capsuleEditStatus.textContent = t("common.saved");
    renderCapsules();
    setTimeout(closeEditModal, 500);
  } catch (err) {
    console.error("[time-capsule] edit save failed:", err.code || err);
    capsuleEditStatus.textContent = t("common.couldnt_save");
  }
});

async function checkCapsuleReadyNotifications(user) {
  const readyIds = cachedCapsules.filter((c) => bucketOf(c) === "ready").map((c) => c.id);
  for (const id of readyIds) {
    const key = `lfj:capsuleNotified:${id}`;
    if (localStorage.getItem(key)) continue;
    localStorage.setItem(key, "1");
    try {
      await addDoc(collection(db, "notifications"), {
        uid: user.uid,
        type: "capsule_ready",
        title: t("time_capsule.title"),
        message: t("time_capsule.home_ready_card"),
        read: false,
        createdAt: serverTimestamp(),
      });
    } catch (err) {
      console.error("[time-capsule] ready notification failed:", err.code || err);
    }
  }
}

async function fetchCapsules(user) {
  const loadGeneration = ++capsuleLoadGeneration;
  const nextObjectUrls = createObjectUrlRegistry();
  let replacedObjectUrls = null;
  try {
    const snap = await getDocs(query(collection(db, "time_capsules"), where("uid", "==", user.uid)));
    const capsules = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // Owner-load lazy migration is bounded by the exact legacy schema Rules allow. A failed
    // record stays legacy and inert for retry; it never blocks the rest of the capsule list.
    for (const capsule of capsules.filter((item) => Object.prototype.hasOwnProperty.call(item, "attachmentUrl"))) {
      await migrateLegacyCapsule(capsule);
    }
    const expectedBucket = storage.app.options.storageBucket;
    await Promise.all(capsules.map(async (capsule) => {
      if (isCanonicalCapsuleObjectPath(capsule.attachmentPath, user.uid, capsule.id)) {
        try {
          const blob = await getBlob(ref(storage, capsule.attachmentPath));
          capsule._attachmentHref = nextObjectUrls.create(blob);
        } catch (err) {
          console.error("[time-capsule] attachment URL failed:", err.code || err);
          capsule._attachmentHref = null;
        }
      } else {
        // A legacy URL is only a locator. Recover an exact own path and fetch through the
        // authenticated SDK; never render the long-lived tokenized URL itself.
        const parsed = parseFirebaseStorageObjectUrl(capsule.attachmentUrl, expectedBucket);
        if (parsed && isOwnCapsuleObjectPath(parsed.objectPath, user.uid)) {
          try {
            const blob = await getBlob(ref(storage, parsed.objectPath));
            capsule._attachmentHref = nextObjectUrls.create(blob);
          } catch (err) {
            console.error("[time-capsule] legacy attachment read failed:", err.code || err);
            capsule._attachmentHref = null;
          }
        } else {
          capsule._attachmentHref = null;
        }
      }
    }));
    capsules.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    if (loadGeneration !== capsuleLoadGeneration) {
      nextObjectUrls.revokeAll();
      return;
    }
    const previousObjectUrls = capsuleObjectUrls;
    replacedObjectUrls = previousObjectUrls;
    capsuleObjectUrls = nextObjectUrls;
    cachedCapsules = capsules;
    renderCapsules();
    previousObjectUrls.revokeAll();
  } catch (err) {
    console.error("[time-capsule] fetch failed:", err.code || err);
    nextObjectUrls.revokeAll();
    replacedObjectUrls?.revokeAll();
    if (loadGeneration !== capsuleLoadGeneration) return;
    const previousObjectUrls = capsuleObjectUrls;
    cachedCapsules = [];
    renderCapsules();
    previousObjectUrls.revokeAll();
  }
  checkCapsuleReadyNotifications(user);
}

function renderSignedOut() {
  authControl.innerHTML = `
    <button id="auth-signin-btn" class="px-4 py-2 bg-gradient-to-r from-neonViolet to-neonPurple rounded-xl text-xs font-cyber font-bold tracking-wider text-white hover:scale-105 transition-all">
      <i class="fa-brands fa-google mr-2"></i> ${t("common.sign_in")}
    </button>`;
  document.getElementById("auth-signin-btn").addEventListener("click", () => {
    signInWithPopup(auth, googleProvider).catch((err) => console.error("Sign-in failed", err));
  });
  accessNote.classList.add("hidden");
  newCapsuleBtn.classList.add("hidden");
}

async function renderSignedIn(user) {
  const displayLabel = await resolveDisplayName(user);
  const signedIn = document.createElement("span");
  signedIn.className = "text-xs text-textGray font-code";
  signedIn.appendChild(document.createTextNode(`${t("common.signed_in_as")} `));
  const label = document.createElement("span");
  label.className = "text-white truncate max-w-[10rem] inline-block align-bottom";
  label.textContent = displayLabel;
  signedIn.appendChild(label);
  const signOutButton = document.createElement("button");
  signOutButton.id = "auth-signout-btn";
  signOutButton.type = "button";
  signOutButton.className = "px-4 py-2 bg-cardBg/70 border border-borderNeon rounded-xl text-xs font-cyber font-bold tracking-wider text-white hover:border-neonPurple transition-all";
  signOutButton.textContent = t("common.sign_out");
  signOutButton.addEventListener("click", () => signOut(auth));
  authControl.replaceChildren(signedIn, signOutButton);

  const mayParticipate = canParticipate();
  newCapsuleBtn.classList.toggle("hidden", !mayParticipate);
  accessNote.classList.toggle("hidden", mayParticipate);
  maybeAutoOpenFromQuickAdd(mayParticipate);
}

let autoOpenedFromQuickAdd = false;
function maybeAutoOpenFromQuickAdd(mayParticipate) {
  if (autoOpenedFromQuickAdd || !mayParticipate) return;
  if (new URLSearchParams(location.search).get("new") === "1") {
    autoOpenedFromQuickAdd = true;
    openModal();
  }
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    renderSignedIn(user);
    fetchCapsules(user);
  } else {
    renderSignedOut();
    capsuleLoadGeneration++;
    cachedCapsules = [];
    renderCapsules();
    capsuleObjectUrls.revokeAll();
  }
});

window.addEventListener("pagehide", () => capsuleObjectUrls.revokeAll());

function openModal() {
  capsuleModal.classList.remove("hidden");
}
function closeModal() {
  capsuleModal.classList.add("hidden");
  capsuleForm.reset();
  capsuleStatus.textContent = "";
}

newCapsuleBtn.addEventListener("click", openModal);
capsuleModalClose.addEventListener("click", closeModal);
capsuleModalBackdrop.addEventListener("click", closeModal);

capsuleForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const user = auth.currentUser;
  if (!user || !canParticipate()) return;

  const title = document.getElementById("capsule-title").value.trim();
  const message = document.getElementById("capsule-message").value.trim();
  const openDateVal = document.getElementById("capsule-open-date").value;
  const file = document.getElementById("capsule-attachment").files[0];
  if (!title || !message || !openDateVal) return;

  const fileError = validateAttachmentFile(file);
  if (fileError) {
    capsuleStatus.textContent = fileError === "unsupported-type"
      ? "Choose a JPEG, PNG, WebP, PDF, or plain-text file."
      : "Attachment must be between 1 byte and 12 MiB.";
    return;
  }

  capsuleStatus.textContent = t("common.saving");
  let attachmentPath = null;
  const capsuleRef = doc(collection(db, "time_capsules"));
  try {
    let attachmentType = null;
    if (file) {
      attachmentPath = canonicalCapsuleObjectPath(user.uid, capsuleRef.id);
      attachmentType = file.type.startsWith("image/") ? "image" : "file";
    }

    await createCapsuleWithCleanup({
      attachmentPath,
      file,
      uploadObject: (path, blob, metadata) => uploadBytes(ref(storage, path), blob, metadata),
      removeObject: (path) => deleteObject(ref(storage, path)),
      writeDocument: () => setDoc(capsuleRef, {
        uid: user.uid,
        title,
        message,
        openAt: Timestamp.fromDate(new Date(openDateVal)),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        status: "sealed",
        visibility: "private",
        attachmentPath,
        attachmentType,
      }),
    });

    capsuleStatus.textContent = t("common.saved");
    setTimeout(closeModal, 500);
    fetchCapsules(user);
  } catch (err) {
    if (attachmentPath) {
      try {
        await deleteObject(ref(storage, attachmentPath));
      } catch (cleanupError) {
        if (cleanupError?.code !== "storage/object-not-found") {
          console.error("[time-capsule] orphan cleanup failed:", cleanupError.code || cleanupError);
        }
      }
    }
    console.error("[time-capsule] save failed:", err.code || err);
    capsuleStatus.textContent = t("common.couldnt_save");
  }
});

async function migrateLegacyCapsule(capsule) {
  if (!capsule || !Object.prototype.hasOwnProperty.call(capsule, "attachmentUrl")) return true;
  const user = auth.currentUser;
  if (!user || capsule.uid !== user.uid) return false;

  try {
    const migrated = await prepareLegacyCapsuleAttachment({
      capsule,
      uid: user.uid,
      expectedBucket: storage.app.options.storageBucket,
      readObject: (path) => getBlob(ref(storage, path)),
      writeObject: (path, blob, metadata) => uploadBytes(ref(storage, path), blob, metadata),
      removeObject: (path) => deleteObject(ref(storage, path)),
    });
    if (migrated.classification.startsWith("unrecoverable-")) {
      alert(t("time_capsule.legacy_attachment_unrecoverable"));
    }

    await updateDoc(doc(db, "time_capsules", capsule.id), {
      attachmentPath: migrated.attachmentPath,
      attachmentType: migrated.attachmentType,
      attachmentUrl: deleteField(),
      updatedAt: serverTimestamp(),
    });
    capsule.attachmentPath = migrated.attachmentPath;
    capsule.attachmentType = migrated.attachmentType;
    delete capsule.attachmentUrl;
    return true;
  } catch (error) {
    console.error("[time-capsule] legacy migration failed:", error.code || error);
    alert(t("time_capsule.legacy_migration_retry"));
    return false;
  }
}

document.addEventListener("eden:langchange", renderCapsules);
