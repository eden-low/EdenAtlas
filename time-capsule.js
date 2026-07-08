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
  doc,
  updateDoc,
  serverTimestamp,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-storage.js";
import { t } from "./js/i18n.js";

const authControl = document.getElementById("auth-control");
const accessNote = document.getElementById("capsule-access-note");
const newCapsuleBtn = document.getElementById("new-capsule-btn");
const capsuleModal = document.getElementById("capsule-modal");
const capsuleModalClose = document.getElementById("capsule-modal-close");
const capsuleModalBackdrop = document.getElementById("capsule-modal-backdrop");
const capsuleForm = document.getElementById("capsule-form");
const capsuleStatus = document.getElementById("capsule-status");
const emptyEl = document.getElementById("capsules-empty");
const readyEl = document.getElementById("capsules-ready");
const sealedEl = document.getElementById("capsules-sealed");
const openedEl = document.getElementById("capsules-opened");

let cachedCapsules = [];

function bucketOf(c) {
  if (c.status === "opened") return "opened";
  const openAt = c.openAt?.toDate ? c.openAt.toDate() : null;
  if (openAt && openAt <= new Date()) return "ready";
  return "sealed";
}

function formatDate(ts) {
  return ts?.toDate ? ts.toDate().toLocaleDateString(undefined, { dateStyle: "medium" }) : "";
}

function capsuleCard(c) {
  const bucket = bucketOf(c);
  const el = document.createElement("div");
  el.className = "reveal card-lift bg-cardBg/90 neon-border-purple rounded-2xl p-5";

  if (bucket === "sealed") {
    el.innerHTML = `
      <div class="flex items-center gap-2 mb-2 text-textGray"><i class="fa-solid fa-lock text-xs"></i><span class="text-sm font-semibold text-white truncate">${c.title}</span></div>
      <p class="text-xs font-code text-textGray">${t("time_capsule.locked_notice", { date: formatDate(c.openAt) })}</p>`;
  } else if (bucket === "ready") {
    el.innerHTML = `
      <div class="flex items-center gap-2 mb-2"><i class="fa-solid fa-envelope text-neonPurple text-xs"></i><span class="text-sm font-semibold text-white truncate">${c.title}</span></div>
      <button class="capsule-open-btn w-full mt-2 px-4 py-2 bg-gradient-to-r from-neonViolet to-neonPurple rounded-xl text-xs font-cyber font-bold tracking-wider text-white hover:scale-105 transition-all">${t("time_capsule.open_button")}</button>`;
    el.querySelector(".capsule-open-btn").addEventListener("click", () => openCapsule(c.id));
  } else {
    el.innerHTML = `
      <div class="flex items-center gap-2 mb-2"><i class="fa-solid fa-envelope-open text-emerald-400 text-xs"></i><span class="text-sm font-semibold text-white truncate">${c.title}</span></div>
      <p class="text-sm text-white/90 whitespace-pre-wrap">${c.message}</p>
      ${c.attachmentUrl ? `<a href="${c.attachmentUrl}" target="_blank" rel="noopener" class="inline-flex items-center gap-1.5 mt-3 text-xs text-neonPurple hover:underline"><i class="fa-solid fa-paperclip"></i> ${t("time_capsule.attachment_label")}</a>` : ""}
      <p class="text-[10px] font-code text-textGray mt-3">${t("time_capsule.opened_on", { date: formatDate(c.updatedAt) })}</p>`;
  }
  return el;
}

function renderCapsules() {
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
}

async function openCapsule(id) {
  try {
    await updateDoc(doc(db, "time_capsules", id), { status: "opened", updatedAt: serverTimestamp() });
    const c = cachedCapsules.find((x) => x.id === id);
    if (c) c.status = "opened";
    renderCapsules();
  } catch (err) {
    console.error("[time-capsule] open failed:", err.code || err);
  }
}

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
  try {
    const snap = await getDocs(query(collection(db, "time_capsules"), where("uid", "==", user.uid)));
    cachedCapsules = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    cachedCapsules.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
  } catch (err) {
    console.error("[time-capsule] fetch failed:", err.code || err);
    cachedCapsules = [];
  }
  renderCapsules();
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

function renderSignedIn(user) {
  authControl.innerHTML = `
    <span class="text-xs text-textGray font-code">${t("common.signed_in_as")} <span class="text-white">${user.displayName || user.email}</span></span>
    <button id="auth-signout-btn" class="px-4 py-2 bg-cardBg/70 border border-borderNeon rounded-xl text-xs font-cyber font-bold tracking-wider text-white hover:border-neonPurple transition-all">
      ${t("common.sign_out")}
    </button>`;
  document.getElementById("auth-signout-btn").addEventListener("click", () => signOut(auth));

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
    cachedCapsules = [];
    renderCapsules();
  }
});

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

  capsuleStatus.textContent = t("common.saving");
  try {
    let attachmentUrl = null;
    let attachmentType = null;
    if (file) {
      const storagePath = `capsules/${user.uid}/${Date.now()}-${file.name}`;
      const fileRef = ref(storage, storagePath);
      await uploadBytes(fileRef, file);
      attachmentUrl = await getDownloadURL(fileRef);
      attachmentType = file.type.startsWith("image/") ? "image" : "file";
    }

    await addDoc(collection(db, "time_capsules"), {
      uid: user.uid,
      title,
      message,
      openAt: Timestamp.fromDate(new Date(openDateVal)),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      status: "sealed",
      visibility: "private",
      attachmentUrl,
      attachmentType,
    });

    capsuleStatus.textContent = t("common.saved");
    setTimeout(closeModal, 500);
    fetchCapsules(user);
  } catch (err) {
    console.error("[time-capsule] save failed:", err.code || err);
    capsuleStatus.textContent = t("common.couldnt_save");
  }
});

document.addEventListener("eden:langchange", renderCapsules);
