// Minimal network-first service worker for offline shell caching.
// Deliberately bypasses Firebase/CDN/weather hosts so it never interferes with
// the auth flow, live Firestore/Storage reads, or third-party API calls.
// v22 ("Portfolio to root" routing change): index.html is now the public recruiter Portfolio
// (previously portfolio.html's content — see CLAUDE.md's routing-change history note) and the
// private Personal OS Home moved from index.html to the new home.html. portfolio.html is now a
// tiny compatibility redirect stub, kept in PRECACHE so old bookmarks/shared links still resolve
// offline. Cache bumped so an offline-fallback visit can never serve the pre-v22 index.html
// (which used to be the private Home) under its old meaning, and so every page whose <head> script
// tags changed (index.html, portfolio.html, resume.html, project.html) or whose JS changed
// (portfolio.js, auth-guard.js, js/sidebar.js, js/mobile-nav.js) is re-fetched fresh. Online
// behaviour unchanged (still network-first) — this only affects the offline-fallback path.
// Earlier: v21 (Trash privacy fix), v20 (Memory Trash + location-edit fix), v19 (canonical
// location pipeline fix).
const CACHE = "eden-shell-v22";

const PRECACHE = [
  "index.html", "home.html", "resume.html", "gallery.html", "journal.html", "expenses.html",
  "timeline.html", "dashboard.html", "contact.html", "login.html", "settings.html",
  "habits.html", "notifications.html", "calendar.html", "reports.html",
  "profile.html", "atlas.html", "portfolio.html", "project.html",
  "styles.css", "scripts.js", "firebase-init.js", "auth-guard.js", "global-search.js",
  "gallery.js", "expenses.js", "journal.js", "timeline.js", "dashboard.js", "settings.js",
  "habits.js", "notifications.js", "export.js", "calendar.js", "insights.js",
  "profile.js", "career.js", "atlas.js", "portfolio.js", "project.js",
  "js/i18n.js", "js/mobile-nav.js", "js/sidebar.js", "js/splash.js", "js/location-search.js",
  "js/location-fields.js", "js/memory-filters.js", "js/resume-data.js",
  "locales/en.json", "locales/zh-CN.json",
  "manifest.json", "images/icon-192.png", "images/icon-512.png", "images/logo-mark.png",
];

const BYPASS_HOSTS = [
  "gstatic.com",
  "googleapis.com",
  "firebaseapp.com",
  "openweathermap.org",
  "cdn.tailwindcss.com",
  "cdnjs.cloudflare.com",
  "cdn.jsdelivr.net",
];

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
  if (url.origin !== location.origin || BYPASS_HOSTS.some((host) => url.hostname.includes(host))) {
    return; // let the browser handle Auth/Firestore/Storage/weather/CDN requests untouched
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
