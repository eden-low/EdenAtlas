// Site-wide login gate. Drop `<script type="module" src="auth-guard.js"></script>` on any
// protected page (right after scripts.js) — no per-page wiring needed. Redirects to login.html
// if signed out; reveals the page (removes body.auth-check-pending, see styles.css) once resolved.
import { auth, db, getUserMode } from "./firebase-init.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const fallbackTimer = setTimeout(() => {
  document.body.classList.remove("auth-check-pending");
}, 6000);

// Unread-notification badge on the nav's Notifications link, present on every protected page.
// No-ops on any page that doesn't have the element (e.g. login.html has no nav at all). Every
// signed-in user has their own notifications now (v3.2 friend requests reach non-owners too),
// not just the owner.
async function updateNotifBadge(user) {
  const badge = document.getElementById("notif-badge");
  if (!badge) return;
  try {
    const snap = await getDocs(query(collection(db, "notifications"), where("uid", "==", user.uid), where("read", "==", false)));
    if (snap.size > 0) {
      badge.textContent = snap.size > 9 ? "9+" : String(snap.size);
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  } catch (err) {
    console.error("[auth-guard] notif badge query failed:", err.code || err);
  }
}

onAuthStateChanged(auth, (user) => {
  clearTimeout(fallbackTimer);
  if (!user) {
    // v3.2.2: a page opts out of the login redirect via `<body data-public-optional="true">`
    // (currently only resume.html) so an unauthenticated HR visitor can open a public resume
    // link — the page itself is responsible for only rendering content its own read rules
    // actually allow an anonymous request to see (see career.js's access-level gating).
    if (document.body.dataset.publicOptional === "true") {
      document.body.classList.remove("auth-check-pending");
      return;
    }
    const here = location.pathname.split("/").pop() || "home.html";
    location.href = "login.html?redirect=" + encodeURIComponent(here);
    return;
  }
  // v3.2: owner-heavy pages (Career/Finance/Reports/Time Capsule/Constellation) opt in via
  // `<body data-owner-only="true">` and redirect non-owners to Home with a warm notice, rather
  // than each page reimplementing the same check — see home.html's `?notice=private_space`
  // handling. Friend-mode navigation (js/sidebar.js, js/mobile-nav.js) already hides these links
  // for non-owners; this is the direct-URL backstop.
  if (document.body.dataset.ownerOnly === "true" && getUserMode() !== "OWNER") {
    location.href = "home.html?notice=private_space";
    return;
  }
  document.body.classList.remove("auth-check-pending");
  updateNotifBadge(user);
});

// A signed-out user hitting Back into a bfcache-restored protected page would otherwise see
// the cached DOM before a fresh auth check runs — force a reload so the gate re-evaluates.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
