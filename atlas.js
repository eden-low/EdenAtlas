import { auth, db, getUserMode } from "./firebase-init.js";
import { getLang, t as i18nT } from "./js/i18n.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import {
  collection,
  query,
  where,
  getDocs,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const scopeTabs = document.querySelectorAll(".scope-tab");
const atlasCount = document.getElementById("atlas-count");
const atlasEmpty = document.getElementById("atlas-empty");
const detailPanel = document.getElementById("location-detail-panel");
const detailClose = document.getElementById("location-detail-close");

let map = null;
let markers = [];
let activeScope = "mine";
let mineClusters = null;
let connectionsClusters = null;
let cachedCollections = [];
let activeDetailCluster = null;

function bi(obj, field) {
  const suffix = getLang() === "zh-CN" ? "_zh" : "_en";
  return obj[field + suffix] || obj[field + "_en"] || obj[field + "_zh"] || "";
}

function itemMillis(item) {
  const ts = item.uploadedAt || item.createdAt || item.date;
  return ts?.toMillis?.() || 0;
}

async function fetchMyOnly(name) {
  const user = auth.currentUser;
  if (!user) return [];
  try {
    const snap = await getDocs(query(collection(db, name), where("uid", "==", user.uid)));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error(`[atlas] ${name} mine query failed:`, err.code || err);
    return [];
  }
}

async function fetchAllPublic(name) {
  try {
    const snap = await getDocs(query(collection(db, name), where("visibility", "==", "public")));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error(`[atlas] ${name} public query failed:`, err.code || err);
    return [];
  }
}

async function mergeMinePublic(name) {
  const user = auth.currentUser;
  const resultMap = new Map();
  (await fetchAllPublic(name)).forEach((d) => resultMap.set(d.id, d));
  if (user) (await fetchMyOnly(name)).forEach((d) => resultMap.set(d.id, d));
  return [...resultMap.values()];
}

function clusterItems(photos, journals, events, precision) {
  const clusters = new Map();
  function round(n) {
    return precision != null ? Number(n.toFixed(precision)) : n;
  }
  function addItem(item, type) {
    if (item.latitude == null || item.longitude == null) return;
    const lat = round(item.latitude);
    const lon = round(item.longitude);
    const key = (item.locationName || `${lat},${lon}`).trim().toLowerCase() || `${lat},${lon}`;
    if (!clusters.has(key)) {
      clusters.set(key, {
        name: item.locationName || `${lat}, ${lon}`,
        lat, lon,
        memories: 0, journal: 0, journey: 0,
        collectionIds: new Set(),
        photos: [],
        latest: 0,
      });
    }
    const c = clusters.get(key);
    if (type === "memories") { c.memories++; if (item.url) c.photos.push(item.url); }
    if (type === "journal") c.journal++;
    if (type === "journey") c.journey++;
    if (item.collectionId) c.collectionIds.add(item.collectionId);
    c.latest = Math.max(c.latest, itemMillis(item));
  }
  photos.forEach((p) => addItem(p, "memories"));
  journals.forEach((j) => addItem(j, "journal"));
  events.forEach((e) => addItem(e, "journey"));
  return [...clusters.values()];
}

async function loadMineClusters() {
  if (mineClusters) return mineClusters;
  const [photos, journals, events] = await Promise.all([
    fetchMyOnly("photos"),
    fetchMyOnly("journals"),
    fetchMyOnly("life_events"),
  ]);
  mineClusters = clusterItems(photos, journals, events, null);
  return mineClusters;
}

// Public-only content from the owner + approved friends (same role gating as Search People),
// capped to the 100 most recent items and rounded to ~1km precision — never exact addresses,
// never expenses. Lazily fetched only the first time this tab is opened.
async function loadConnectionsClusters() {
  if (connectionsClusters) return connectionsClusters;
  const me = auth.currentUser;
  let allowedUids = new Set();
  try {
    const usersSnap = await getDocs(collection(db, "users"));
    const mode = getUserMode();
    usersSnap.forEach((d) => {
      const u = d.data();
      if (me && u.uid === me.uid) return;
      if (mode === "VIEWER") {
        if (u.role === "owner") allowedUids.add(u.uid);
      } else {
        if (u.role === "owner" || u.role === "friend") allowedUids.add(u.uid);
      }
    });
  } catch (err) {
    console.error("[atlas] users fetch failed:", err.code || err);
  }

  const [photos, journals, events] = await Promise.all([
    fetchAllPublic("photos"),
    fetchAllPublic("journals"),
    fetchAllPublic("life_events"),
  ]);
  const inScope = (item) => allowedUids.has(item.uid);
  const recent = (list) => list.filter(inScope).sort((a, b) => itemMillis(b) - itemMillis(a)).slice(0, 100);

  connectionsClusters = clusterItems(recent(photos), recent(journals), recent(events), 2);
  return connectionsClusters;
}

function makeIcon(color) {
  return L.divIcon({
    className: "",
    html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 0 3px ${color}40"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

function collectionChips(collectionIds) {
  return [...collectionIds].map((id) => {
    const c = cachedCollections.find((x) => x.id === id);
    if (!c) return "";
    return `<a href="collection-detail.html?id=${id}" class="text-[10px] font-code px-2 py-0.5 rounded-full border border-borderNeon text-textGray hover:text-neonPurple hover:border-neonPurple transition-colors">${bi(c, "title")}</a>`;
  }).join("");
}

function openDetailPanel(cluster) {
  activeDetailCluster = cluster;
  document.getElementById("location-detail-name").textContent = cluster.name;
  document.getElementById("location-detail-counts").innerHTML = `
    <span><i class="fa-solid fa-images mr-1"></i>${cluster.memories} ${i18nT("atlas.legend_memories")}</span>
    <span><i class="fa-solid fa-book mr-1"></i>${cluster.journal} ${i18nT("atlas.legend_journal")}</span>
    <span><i class="fa-solid fa-timeline mr-1"></i>${cluster.journey} ${i18nT("atlas.legend_journey")}</span>`;
  document.getElementById("location-detail-collections").innerHTML = collectionChips(cluster.collectionIds);
  document.getElementById("location-detail-photos").innerHTML = cluster.photos.slice(0, 6)
    .map((url) => `<img src="${url}" alt="" class="w-full h-16 object-cover rounded-lg">`).join("");
  detailPanel.classList.remove("hidden");
  detailPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

detailClose.addEventListener("click", () => {
  activeDetailCluster = null;
  detailPanel.classList.add("hidden");
});

function renderClusters(clusters, color) {
  markers.forEach((m) => map.removeLayer(m));
  markers = [];
  activeDetailCluster = null;
  detailPanel.classList.add("hidden");

  atlasEmpty.classList.toggle("hidden", clusters.length > 0);
  atlasCount.textContent = clusters.length ? `${clusters.length} location${clusters.length === 1 ? "" : "s"}` : "";

  clusters.forEach((cluster) => {
    const marker = L.marker([cluster.lat, cluster.lon], { icon: makeIcon(color) }).addTo(map);
    marker.bindTooltip(cluster.name, { direction: "top", offset: [0, -8] });
    marker.on("click", () => openDetailPanel(cluster));
    markers.push(marker);
  });

  if (clusters.length) {
    const bounds = L.latLngBounds(clusters.map((c) => [c.lat, c.lon]));
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
  }
}

async function setScope(scope) {
  activeScope = scope;
  scopeTabs.forEach((btn) => {
    const active = btn.dataset.scope === scope;
    btn.classList.toggle("bg-neonPurple/15", active);
    btn.classList.toggle("text-white", active);
  });

  atlasCount.textContent = i18nT("common.loading");
  const clusters = scope === "mine" ? await loadMineClusters() : await loadConnectionsClusters();
  renderClusters(clusters, scope === "mine" ? "#a78bfa" : "#6ea8fe");
}

scopeTabs.forEach((btn) => btn.addEventListener("click", () => setScope(btn.dataset.scope)));

function initMap() {
  const isLight = document.documentElement.getAttribute("data-theme") === "light";
  map = L.map("atlas-map", { zoomControl: true }).setView([20, 0], 2);
  L.tileLayer(`https://{s}.basemaps.cartocdn.com/${isLight ? "light_all" : "dark_all"}/{z}/{x}/{y}{r}.png`, {
    attribution: `&copy; <a href="https://www.openstreetmap.org/copyright">${i18nT("atlas.provider_osm")}</a> contributors &copy; <a href="https://carto.com/attributions">${i18nT("atlas.provider_carto")}</a>`,
    maxZoom: 19,
    subdomains: "abcd",
  }).addTo(map);
}

onAuthStateChanged(auth, async (user) => {
  if (!map) initMap();
  cachedCollections = await mergeMinePublic("collections");
  await setScope("mine");
});

// Re-render whatever's already on screen — the collection chips (bilingual title_en/title_zh)
// and the open detail panel's legend labels both depend on the current language, and neither
// re-renders on its own from a plain data-i18n walk since they're injected via innerHTML.
document.addEventListener("eden:langchange", () => {
  const clusters = activeScope === "mine" ? mineClusters : connectionsClusters;
  const reopen = activeDetailCluster;
  if (clusters) renderClusters(clusters, activeScope === "mine" ? "#a78bfa" : "#6ea8fe");
  if (reopen) openDetailPanel(reopen);
});
