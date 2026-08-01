// EdenAtlas — Phase 4: opt-in per-anime airing push reminders (Firebase Cloud Messaging).
//
// Why FCM rather than raw Web Push + a hand-rolled `web-push` server library: this app already
// has a Firebase project, an existing Firebase Admin credential on the server
// (netlify/functions/lib/firebase-admin.js), and Firebase's own "Web Push certificates" ARE a
// VAPID key pair under the hood — so this reuses infrastructure that already exists instead of
// adding a second push provider. Concretely: the PUBLIC half of that key pair is safe to embed
// in the browser build (see scripts/generate-build-info.js's header comment — same "public by
// design" category as firebase-init.js's own Web apiKey) and the PRIVATE half is never touched by
// this app at all — sending a push goes through admin.messaging().send() using the same service-
// account credential the server already has, not a raw VAPID private key. There is structurally
// no "push private key" for this module to ever expose to browser code.
//
// STRICT lifecycle rule this whole module exists to enforce: notification permission is NEVER
// requested on page load, NEVER requested merely because the Owner opened My List, and NEVER
// requested as a side effect of any other action. subscribeThisDevice() below is only ever called
// from a real click handler (discover.js's bell button) — see that call site's own comment for
// why the async chain in between is safe for the browser's "user activation" requirement.

import { auth, db, isOwner, isStagingWritesUnsafe, app, firebaseConfig } from "../firebase-init.js";
import { getBuildInfo } from "./environment.js";
import {
  collection, doc, getDoc, getDocs, query, where, setDoc, updateDoc, deleteDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const MESSAGING_SDK_URL = "https://www.gstatic.com/firebasejs/12.15.0/firebase-messaging.js";

export const SUBSCRIBE_REASON = Object.freeze({
  OK: "ok",
  UNSUPPORTED: "unsupported",
  NOT_CONFIGURED: "not_configured",
  NOT_OWNER: "not_owner",
  STAGING_UNSAFE: "staging_unsafe",
  PERMISSION_DENIED: "permission_denied",
  PERMISSION_DISMISSED: "permission_dismissed",
  TOKEN_FAILED: "token_failed",
  ERROR: "error",
});

export function isPushApiSupported() {
  return (
    typeof window !== "undefined" &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

// The VAPID public key is a build-time snapshot (see scripts/generate-build-info.js) — until an
// Owner sets FIREBASE_VAPID_PUBLIC_KEY in Netlify (a real Firebase Console value this environment
// cannot invent), this stays null and every subscribe attempt fails closed with NOT_CONFIGURED
// rather than silently no-op'ing or fabricating a key. See CLAUDE.md/the completion report for
// the exact manual Console step.
export function isPushConfigured() {
  const info = getBuildInfo();
  return !!(info && info.vapidPublicKey);
}

export function getPermissionState() {
  if (!isPushApiSupported()) return "unsupported";
  return Notification.permission; // "default" | "granted" | "denied"
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let messagingModulePromise = null;
async function loadMessagingModule() {
  if (!messagingModulePromise) messagingModulePromise = import(MESSAGING_SDK_URL);
  return messagingModulePromise;
}

function subscriptionDocId(uid, tokenHash) {
  return `${uid}_${tokenHash}`;
}

// Every followed_anime uid belongs to the single app Owner (Discover is Owner-only end to end —
// see CLAUDE.md), so "my subscriptions" is always exactly this signed-in user's own docs, scoped
// the same isOwner()-gated way followed_anime itself is.
export async function fetchMySubscriptions() {
  const user = auth.currentUser;
  if (!user || !isOwner(user)) return new Map();
  const snap = await getDocs(query(collection(db, "push_subscriptions"), where("uid", "==", user.uid)));
  const map = new Map();
  snap.forEach((d) => map.set(d.id, { id: d.id, ...d.data() }));
  return map;
}

// Requirement: "Request permission only after the Owner explicitly taps a bell/notification
// control." Callers MUST invoke this synchronously from within a click handler — every check
// before the Notification.requestPermission() call itself is either synchronous or a fast local
// read, so the browser's "recent user activation" window is never exhausted by an intervening
// network round trip.
export async function subscribeThisDevice() {
  if (!isPushApiSupported()) return { ok: false, reason: SUBSCRIBE_REASON.UNSUPPORTED };
  if (!isPushConfigured()) return { ok: false, reason: SUBSCRIBE_REASON.NOT_CONFIGURED };
  const user = auth.currentUser;
  if (!user || !isOwner(user)) return { ok: false, reason: SUBSCRIBE_REASON.NOT_OWNER };
  if (isStagingWritesUnsafe()) return { ok: false, reason: SUBSCRIBE_REASON.STAGING_UNSAFE };

  const permission = await Notification.requestPermission();
  if (permission === "denied") return { ok: false, reason: SUBSCRIBE_REASON.PERMISSION_DENIED };
  if (permission !== "granted") return { ok: false, reason: SUBSCRIBE_REASON.PERMISSION_DISMISSED };

  try {
    const { getMessaging, getToken } = await loadMessagingModule();
    const registration = await navigator.serviceWorker.ready;
    const messaging = getMessaging(app);
    const vapidKey = getBuildInfo().vapidPublicKey;
    const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration });
    if (!token) return { ok: false, reason: SUBSCRIBE_REASON.TOKEN_FAILED };

    const tokenHash = await sha256Hex(token);
    const ref = doc(db, "push_subscriptions", subscriptionDocId(user.uid, tokenHash));
    const existing = await getDoc(ref);
    if (existing.exists()) {
      // Same device/token already registered — only the "last seen" timestamp needs refreshing;
      // uid/tokenHash/token/platform/createdAt are all immutable per firestore.rules, so this is
      // a partial update, never a full replace.
      await updateDoc(ref, { updatedAt: serverTimestamp() });
    } else {
      await setDoc(ref, {
        uid: user.uid,
        tokenHash,
        token,
        platform: "web",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    return { ok: true, reason: SUBSCRIBE_REASON.OK, tokenHash };
  } catch (err) {
    console.error("[push-notifications] subscribe failed:", err && (err.code || err.message) || err);
    return { ok: false, reason: SUBSCRIBE_REASON.ERROR };
  }
}

// Unsubscribe THIS device/browser only — deletes its local FCM token registration and its own
// Firestore doc, leaving any other subscribed device untouched.
export async function unsubscribeThisDevice() {
  const user = auth.currentUser;
  if (!user || !isOwner(user)) return { ok: false, reason: SUBSCRIBE_REASON.NOT_OWNER };
  if (isStagingWritesUnsafe()) return { ok: false, reason: SUBSCRIBE_REASON.STAGING_UNSAFE };
  try {
    if (isPushApiSupported()) {
      const { getMessaging, deleteToken, getToken } = await loadMessagingModule();
      const registration = await navigator.serviceWorker.ready;
      const messaging = getMessaging(app);
      const vapidKey = isPushConfigured() ? getBuildInfo().vapidPublicKey : undefined;
      try {
        const token = vapidKey
          ? await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration })
          : null;
        if (token) {
          const tokenHash = await sha256Hex(token);
          await deleteDoc(doc(db, "push_subscriptions", subscriptionDocId(user.uid, tokenHash)));
        }
        await deleteToken(messaging);
      } catch (innerErr) {
        console.error("[push-notifications] local token cleanup failed (continuing):", innerErr);
      }
    }
    return { ok: true, reason: SUBSCRIBE_REASON.OK };
  } catch (err) {
    console.error("[push-notifications] unsubscribe failed:", err && (err.code || err.message) || err);
    return { ok: false, reason: SUBSCRIBE_REASON.ERROR };
  }
}

// "Disable all" — deletes EVERY subscribed device's Firestore doc (not just this one) and turns
// off notifyOnAiring on every one of the Owner's followed_anime docs, so a stale toggle can't
// silently keep expecting reminders once there's nowhere left to deliver them. Best-effort: a
// failed per-doc delete is logged and skipped rather than aborting the whole operation, since a
// partial cleanup is still strictly better than none.
export async function disableAllNotifications() {
  const user = auth.currentUser;
  if (!user || !isOwner(user)) return { ok: false, reason: SUBSCRIBE_REASON.NOT_OWNER };
  if (isStagingWritesUnsafe()) return { ok: false, reason: SUBSCRIBE_REASON.STAGING_UNSAFE };

  const [subs, followed] = await Promise.all([
    fetchMySubscriptions(),
    getDocs(query(collection(db, "followed_anime"), where("uid", "==", user.uid))),
  ]);

  const deletions = [...subs.keys()].map((id) =>
    deleteDoc(doc(db, "push_subscriptions", id)).catch((err) =>
      console.error("[push-notifications] failed to delete subscription", id, err)
    )
  );
  const toggles = [];
  followed.forEach((d) => {
    if (d.data().notifyOnAiring) {
      toggles.push(
        updateDoc(doc(db, "followed_anime", d.id), { notifyOnAiring: false, updatedAt: serverTimestamp() }).catch(
          (err) => console.error("[push-notifications] failed to clear notifyOnAiring for", d.id, err)
        )
      );
    }
  });
  await Promise.all([...deletions, ...toggles]);
  await unsubscribeThisDevice();
  return { ok: true, reason: SUBSCRIBE_REASON.OK };
}

// Foreground messages: FCM delivers a data-only or notification payload to a page that has the
// tab open and focused via onMessage() instead of the service worker's background handler (that
// path is exercised by service-worker.js's own onBackgroundMessage — see that file). `cb`
// receives the raw FCM payload; the caller (discover.js) decides how to surface it (a toast).
export async function onForegroundAiringMessage(cb) {
  if (!isPushApiSupported() || !isPushConfigured()) return () => {};
  try {
    const { getMessaging, onMessage } = await loadMessagingModule();
    const messaging = getMessaging(app);
    return onMessage(messaging, cb);
  } catch (err) {
    console.error("[push-notifications] onMessage wiring failed:", err);
    return () => {};
  }
}
