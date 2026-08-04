// Minimal network-first service worker for offline shell caching.
// Deliberately bypasses Firebase/CDN/weather hosts so it never interferes with
// the auth flow, live Firestore/Storage reads, or third-party API calls.
// v38 (Staging/Production Firebase isolation follow-up, Gap 2 fix): the hardcoded PRODUCTION
// Firebase Web config this file's v37 pass shipped (see that entry below, and its own "KNOWN
// LIMITATION" note) is gone — replaced with an importScripts()-loaded js/fcm-config.generated.js,
// a build-time-generated file that resolves to Staging's config on a Staging build and
// Production's on a Production build, written by the SAME script/decision point
// firebase-init.js's browser-side config already goes through (scripts/generate-build-info.js) so
// the two can never disagree. Missing/partial config now disables background push entirely rather
// than ever falling back to a hardcoded default. Bumped because service-worker.js's own text
// changed and because an already-installed v37 worker (anywhere it was ever active) embedded the
// old hardcoded config directly in its script text — only a real version bump forces the browser's
// update-check to fetch and install this corrected version rather than keep running the stale one.
// v37 (Discover — opt-in per-anime airing push reminders, Owner-only, Phase 4): this file gained
// Firebase Cloud Messaging BACKGROUND handling (see the bottom of this file) — a real, working
// `firebase.messaging().onBackgroundMessage()` handler plus `notificationclick` routing back into
// discover.html's My List. Uses the classic/compat Firebase SDK via importScripts() (NOT the
// modular SDK the rest of this app uses) because that's what a service worker's background push
// handler requires per Firebase's own documented pattern for `firebase-messaging-sw.js` — a
// module-scoped `import()` can't run reliably in a service worker context the browser just woke
// up specifically to deliver one push event. The Firebase Web config below is hardcoded
// (Production project only, for now — see the completion report's "known limitation" note on
// this needing a build-time-templated worker before a dedicated Staging Firebase project can send
// its own pushes) — these are the exact same PUBLIC config values already public in
// firebase-init.js, not a new secret. js/environment.js, js/push-notifications.js, and
// js/build-info.generated.js are added to PRECACHE below (three new same-origin browser modules);
// discover.html/discover.js were already precached and don't need re-adding, just this version
// bump so their changed content (the notify-settings modal, the per-card bell toggle) actually
// reaches an already-installed worker.
// v36 (Discover AI — Qwen Chinese translation + "For You" recommendations, Owner-only): discover.js
// changed (Translate to Chinese/View Original controls, a new For You tab, a localStorage
// translation cache) — discover.html/discover.js were already in PRECACHE from v33, so no new
// entries were needed, only the version bump so the changed discover.js actually reaches an
// already-installed worker. The new Function, netlify/functions/discover-ai.js, is never a static
// browser asset (structurally excluded from the deployed site by scripts/build-site.js, same as
// every other Function) and its production route, /.netlify/functions/discover-ai, is already
// covered by the existing NEVER_CACHE_PATH_PREFIXES rule below with no change needed.
// v33 (Discover — anime MVP, Owner-only): discover.html/discover.js added to PRECACHE (the new
// page's static client shell — same treatment as every other page/script here). The AniList
// proxy Function (netlify/functions/anilist.js) is never a static browser asset (Function source
// is structurally excluded from the deployed site by scripts/build-site.js's publish allowlist,
// same as every other Function) and its production route, /.netlify/functions/anilist, is
// already covered by the existing NEVER_CACHE_PATH_PREFIXES rule below with no change needed —
// every Function response (health, the AI assistant, weather, and now AniList) is always
// network-only. AniList's own endpoint (graphql.anilist.co) and its image CDN (s4.anilist.co)
// are never reachable from the browser at all in this design (only netlify/functions/anilist.js
// calls the GraphQL endpoint, server-side; cover images the browser DOES load directly are
// already excluded from Cache Storage by the fetch handler's unconditional cross-origin check,
// with no BYPASS_HOSTS entry needed) — not added to BYPASS_HOSTS since, unlike Qwen's
// aliyuncs.com entry, there is no in-scope request shape here that check wouldn't already catch.
// v32 (iOS standalone-PWA sign-in fix): login.html/firebase-init.js changed (see those files'
// own comments) — standalone PWAs now complete Google sign-in via signInWithRedirect against a
// same-origin-proxied authDomain instead of being punted out to Safari. This SW's fetch handler
// gained NEVER_INTERCEPT_PATH_PREFIXES ("/__/auth/") so the new same-origin OAuth handler path
// (proxied by netlify.toml) is left completely untouched, the same way cross-origin requests
// already are — intercepting it with fetch()-then-cache.put() would risk breaking the
// redirect/cookie handshake the OAuth flow depends on. Bumped so the changed login.html/
// firebase-init.js (both precached) actually reach an already-installed worker.
// v31 (Recent Memories invisible-click-target fix): home.html changed — memoryCard() (Home's
// "Recent Memories" widget) was assigning dynamically-created card anchors the `.reveal` class,
// but scripts.js's scroll-reveal IntersectionObserver only ever scans for `.reveal` elements
// once, at DOMContentLoaded, well before these Firestore-driven cards exist in the DOM. They
// were therefore never observed, so they stayed at `.reveal`'s base `opacity:0` permanently —
// fully clickable, correctly-routed anchors with no visible content, exactly matching this
// codebase's own documented convention (see gallery.js/journal.js/timeline.js/habits.js/
// expenses.js/notifications.js/collections.js/time-capsule.js) that any card appended after
// page load must use `is-visible`, never `reveal`. Pre-existing bug, not introduced by the v30
// Tailwind migration (byte-identical in the pre-migration commit) — bumped anyway because
// home.html is a precached asset and this fix must reach an already-installed worker.
// v30 (Tailwind local build migration): the runtime Tailwind Play CDN (cdn.tailwindcss.com) is
// replaced by a pinned local Tailwind v3.4.19 build — every page's `<script
// src="https://cdn.tailwindcss.com">` and inline `tailwind.config = {...}` block is gone,
// replaced by one `<link rel="stylesheet" href="tailwind.generated.css">` reading tokens from
// the new root-level tailwind.config.js (single source of truth, byte-identical values to what
// every page's inline config used to duplicate). tailwind.generated.css is a new same-origin,
// build-time-generated asset (never hand-edited, gitignored) and is added to PRECACHE below.
// cdn.tailwindcss.com is removed from BYPASS_HOSTS — the runtime dependency on that host no
// longer exists, so there is nothing left for this worker to bypass there; every other bypass
// host/path and cache rule is unchanged.
// v29 (Production Hardening Phase 1): home.html/me.js changed — the hardcoded, browser-exposed
// OpenWeatherMap API key is gone from both; weather now goes through a new authenticated Netlify
// Function (netlify/functions/weather.js, never part of PRECACHE — Function source is never a
// static browser asset, same as every other Function in this repo) via a new shared browser
// module, js/weather-client.js (added to PRECACHE below). Two more new shared browser modules
// also added: js/date-utils.js (Asia/Kuala_Lumpur-aware date-key helper) and js/reflection.js
// (Daily Reflection's save-payload/query-key logic) — both power home.html's fix for a real
// permission-denied bug on a day with no reflection yet (a direct getDoc()-by-ID against a rule
// that checks resource.data.uid throws when the document doesn't exist; replaced with a
// rules-provable where("uid",...)+where("dateKey",...) query) and a fix so editing an existing
// reflection no longer re-stamps its createdAt. calendar.js also changed (escaping a stored
// journal title before it's interpolated into the day grid's innerHTML — a defensive fix, not a
// behavior change); it's already in PRECACHE below, so this bump is what makes that fix actually
// reach an already-installed worker instead of being served stale from cache.
// v28 (strict collection-scope consent fix): assistant.html/assistant.js changed again — a new
// "Calendar also needs Memories and/or Journal selected" notice (and matching Send-disable) now
// fires whenever Calendar is checked without Memories or Journal, since Calendar is a
// date-organizing capability, never a data grant of its own (the actual bug this pass fixes was
// server-side — list_calendar used to always read BOTH Memories and Journal whenever Calendar
// alone was enabled, regardless of which of those two the Owner had actually checked — see
// netlify/functions/lib/tools.js/qwen.js, which aren't part of PRECACHE) — plus a new calendar
// scope hint line clarifying what Calendar actually does. locales/en.json+zh-CN.json gained the
// new assistant.scope_calendar_hint/calendar_needs_source_notice keys these render with.
// v27 (scope-change conversation isolation pass): assistant.js changed again (any scope checkbox
// change now aborts the in-flight request, clears the conversation + sessionStorage, and shows an
// accessible "Data access changed. A new chat was started." notice; zero scopes selected disables
// Send with a "Select at least one data source..." notice instead of ever calling Qwen) and
// locales/en.json+zh-CN.json gained the new assistant.scope_change_notice/select_scope_notice
// keys these render with. netlify/functions/assistant.js's system prompt also changed (scope
// authority instruction) but Function source was never part of PRECACHE (see prior entries).
// v26 (trust/provenance pass): assistant.js changed again (server-generated evidence-row
// rendering — "Searched: ...", "Sources: ...", source count, and a "0 matching records" empty
// state, all built ONLY from the server's own non-model-controlled `provenance` object, never
// from the model's free text) and locales/en.json+zh-CN.json gained the new
// assistant.evidence_* keys these render with. netlify/functions/**/*.js also changed
// (lib/qwen.js's provenance tracker, lib/tools.js's list_calendar fix, assistant.js's system
// prompt) but, as with every prior Function-only change, isn't part of PRECACHE — Function
// source is never a static browser asset (see scripts/build-site.js's publish allowlist).
// v23 (Qwen Atlas Assistant MVP): adds assistant.html/assistant.js to PRECACHE (the new
// Owner-only page's static client shell — same treatment as every other page/script here).
// Bumped from v22 specifically because v22 was already deployed as its own separate release
// before this pass (per this pass's own instructions: only reuse a version stamp when there is
// evidence it was never shipped on its own) — this guarantees the new assistant.html/assistant.js
// entries actually get fetched into the offline cache on update, rather than an already-active
// v22 service worker never re-running its install step. Also fixes a real (if latent) gap: the
// fetch handler below used to only bypass *cross-origin* requests by host — but
// /.netlify/functions/* is SAME-origin (it's this site's own domain), so a Function response
// (health, and now the AI assistant) would previously have been written into the Cache Storage
// API on every call, regardless of the HTTP `Cache-Control: no-store` header netlify.toml already
// sends (Cache Storage doesn't auto-respect that header — only an explicit fetch-handler bypass
// does). AI answers and any other Function response must always be network-only. The Qwen/
// Alibaba Model Studio endpoint itself is never fetched by the browser at all (only server-side,
// from netlify/functions/assistant.js) — nothing here can ever intercept that call — this SW's
// existing cross-origin bypass (line below) already covers it if that ever changes.
// v25 (date-correctness, calendar-semantics, safe-output and source-navigation pass): several
// already-precached browser files changed and need to be re-fetched, not served stale —
// assistant.js (safe DOM-based rendering replacing innerHTML, source-chip deep links, New Chat
// reset), gallery.js/journal.js/timeline.js (new ?memory=/?entry=/?event= deep-link handlers),
// styles.css (the new .eden-deep-link-highlight rule), and locales/en.json+zh-CN.json (new
// assistant.* i18n keys). netlify/functions/**/*.js also changed but was never part of PRECACHE
// to begin with (Function source isn't a static browser asset — see scripts/build-site.js's
// publish allowlist, which structurally excludes netlify/ from the deployed site).
// v24 (Atlas Assistant production auth fix): assistant.js's frontend changed (the
// withOneRetryOn401 token-refresh-and-retry policy) and is precached below, so the cache is
// bumped again to guarantee that change is actually fetched rather than served from an
// already-active v23 worker's stale copy. netlify/functions/assistant.js and its lib/ modules
// also changed, but Function source was never part of PRECACHE to begin with (it isn't a static
// asset the browser fetches — see scripts/build-site.js's publish allowlist, which structurally
// excludes netlify/ from the deployed site entirely) — the bump here is solely for the one
// changed client asset.
// Earlier: v23 (Qwen Atlas Assistant MVP — assistant.html/assistant.js added to PRECACHE, and
// /.netlify/functions/* excluded from Cache Storage writes), v22 ("Portfolio to root" routing
// change — index.html is now the public recruiter Portfolio, home.html is the private app
// landing page), v21 (Trash privacy fix), v20 (Memory Trash + location-edit fix), v19 (canonical
// location pipeline fix).
const CACHE = "eden-shell-v39";

const PRECACHE = [
  "index.html", "home.html", "resume.html", "gallery.html", "journal.html", "expenses.html",
  "timeline.html", "dashboard.html", "contact.html", "login.html", "settings.html",
  "habits.html", "notifications.html", "calendar.html", "reports.html",
  "profile.html", "atlas.html", "portfolio.html", "project.html", "assistant.html", "discover.html",
  "styles.css", "tailwind.generated.css", "scripts.js", "firebase-init.js", "auth-guard.js", "global-search.js",
  "gallery.js", "expenses.js", "journal.js", "timeline.js", "dashboard.js", "settings.js",
  "habits.js", "notifications.js", "export.js", "calendar.js", "insights.js",
  "profile.js", "career.js", "atlas.js", "portfolio.js", "project.js", "assistant.js", "discover.js",
  "js/i18n.js", "js/mobile-nav.js", "js/sidebar.js", "js/splash.js", "js/location-search.js",
  "js/location-fields.js", "js/memory-filters.js", "js/resume-data.js",
  "js/date-utils.js", "js/reflection.js", "js/weather-client.js",
  "js/environment.js", "js/push-notifications.js", "js/build-info.generated.js",
  "locales/en.json", "locales/zh-CN.json",
  "manifest.json", "images/icon-192.png", "images/icon-512.png", "images/logo-mark.png",
];

const BYPASS_HOSTS = [
  "gstatic.com",
  "googleapis.com",
  "firebaseapp.com",
  "openweathermap.org",
  "cdnjs.cloudflare.com",
  "cdn.jsdelivr.net",
  "unpkg.com",
  // Qwen / Alibaba Cloud Model Studio: never actually reachable from this service worker's
  // scope (the browser never calls it directly — only netlify/functions/assistant.js does,
  // server-side), listed anyway as an explicit, self-documenting guarantee rather than relying
  // solely on the cross-origin check below.
  "aliyuncs.com",
];

// Netlify Function invocations — same-origin, so the cross-origin check below does NOT catch
// these on its own. Every response here must be network-only: an AI answer, a rate-limit
// rejection, or an auth error must never be replayed from a cache.
const NEVER_CACHE_PATH_PREFIXES = ["/.netlify/functions/"];

// The Firebase Auth OAuth handler, proxied same-origin via netlify.toml (see that file's
// "Firebase Auth handler proxy" block and firebase-init.js's authDomain comment) so the iOS
// standalone-PWA sign-in fix can work at all. This path carries redirects, cookies, and
// postMessage handshakes the SW's fetch()-then-cache.put() dance must never sit in front of —
// it's handled exactly like a cross-origin request below (never event.respondWith at all, let
// the browser drive it natively), not merely excluded from caching.
const NEVER_INTERCEPT_PATH_PREFIXES = ["/__/auth/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isCrossOrigin = url.origin !== location.origin;
  const isBypassHost = BYPASS_HOSTS.some((host) => url.hostname.includes(host));
  const isNeverInterceptPath = NEVER_INTERCEPT_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
  const isNeverCachePath = NEVER_CACHE_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));

  if (isCrossOrigin || isBypassHost || isNeverInterceptPath) {
    return; // let the browser handle Auth/Firestore/Storage/weather/CDN/OAuth-handler requests untouched
  }

  if (isNeverCachePath) {
    // Plain pass-through fetch, no cache.put — Netlify Functions (health, the AI assistant, any
    // future one) are always network-only, matching their own `Cache-Control: no-store` header.
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// ---- Phase 4: opt-in per-anime airing push reminders (Owner-only, background delivery) ----
//
// Gap 2 fix (was: a hardcoded Production Firebase config baked directly into this file, which
// would have made a Staging deploy silently send/receive push against PRODUCTION's Firebase
// project). The Firebase Web config is now read from js/fcm-config.generated.js — a build-time-
// generated, gitignored, classic (importScripts-able) sibling of js/build-info.generated.js,
// written by the SAME script (scripts/generate-build-info.js) that already decides "is this
// build Staging or Production" for the rest of the app, so this worker's config can never
// independently disagree with what firebase-init.js resolved for normal page code. Loaded via
// importScripts() (synchronous, classic-script, same mechanism the two Firebase SDK imports
// below already use) rather than fetch()/import() specifically because a service worker woken to
// handle one `push` event must have Firebase already initialized at script-evaluation time — see
// that generated file's own header comment for the exact contents allowlist (public Firebase Web
// config + public VAPID key ONLY, never a secret).
//
// Missing/partial config (a fresh checkout with no build ever run, or a build somehow producing
// an incomplete config) NEVER falls back to a hardcoded default of any kind — background push is
// simply disabled for this worker instance, logged once, and every other part of this file
// (install/activate/fetch/offline shell) is completely unaffected.
let fcmConfig = null;
try {
  importScripts("js/fcm-config.generated.js");
  fcmConfig = self.__EDEN_FCM_CONFIG__ || null;
} catch (err) {
  console.error("[service-worker] js/fcm-config.generated.js unavailable (no build run yet?):", err);
}

function hasUsableFirebaseConfig(cfg) {
  return (
    !!cfg &&
    !!cfg.firebaseConfig &&
    typeof cfg.firebaseConfig.apiKey === "string" && cfg.firebaseConfig.apiKey.length > 0 &&
    typeof cfg.firebaseConfig.projectId === "string" && cfg.firebaseConfig.projectId.length > 0 &&
    typeof cfg.firebaseConfig.messagingSenderId === "string" && cfg.firebaseConfig.messagingSenderId.length > 0 &&
    typeof cfg.firebaseConfig.appId === "string" && cfg.firebaseConfig.appId.length > 0
  );
}

if (hasUsableFirebaseConfig(fcmConfig)) {
  // Uses the classic/compat SDK (firebase-messaging-compat.js), not the modular SDK the rest of
  // this app uses — this is Firebase's own documented requirement for a service worker background
  // handler, not a stylistic choice. Guarded by a try/catch: an offline install, a blocked CDN
  // request, or a future SDK URL change must never crash `install`/`activate`/`fetch` for the rest
  // of this worker — Discover's push feature degrading is far preferable to the whole offline shell
  // breaking.
  try {
    importScripts(
      "https://www.gstatic.com/firebasejs/12.15.0/firebase-app-compat.js",
      "https://www.gstatic.com/firebasejs/12.15.0/firebase-messaging-compat.js"
    );
    firebase.initializeApp(fcmConfig.firebaseConfig);
    const messaging = firebase.messaging();

    // The server (netlify/functions/anime-airing-check.js) always sends a DATA-only payload
    // (never a top-level `notification` field) specifically so FCM never auto-displays anything —
    // this handler is the one place that decides what the notification looks like and where a
    // click on it goes, matching Requirement 16's foreground/background/click-handling triad.
    messaging.onBackgroundMessage((payload) => {
      const data = (payload && payload.data) || {};
      const title = data.title || "EdenAtlas";
      const options = {
        body: data.body || "",
        icon: "images/icon-192.png",
        badge: "images/icon-192.png",
        tag: data.dedupeKey || undefined, // same episode -> same tag -> replaces, never stacks twice
        data: { url: data.url || "discover.html" },
      };
      self.registration.showNotification(title, options);
    });
  } catch (err) {
    // No console in every SW devtools view surfaces this reliably, but logging costs nothing and
    // helps local debugging — never rethrown, never blocks install/activate/fetch above.
    console.error("[service-worker] Firebase Messaging background handler failed to initialize:", err);
  }
} else {
  console.warn("[service-worker] no usable Firebase config for this build — background push reminders disabled.");
}

// Requirement 16: "Notification click should open the relevant Discover detail or My List
// entry." Focuses an already-open EdenAtlas tab (navigating it to the target URL) rather than
// always opening a new one, falling back to opening a new tab only when none is open.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "discover.html";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ("focus" in client) {
          client.navigate(targetUrl).catch(() => {});
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
