import { auth, db } from "./firebase-init.js";
import { getLang } from "./js/i18n.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { excludeDeleted } from "./js/memory-filters.js";
import { expenseCurrency, expenseTransactionTimestamp } from "./js/expense-model.js";

const monthLabel = document.getElementById("cal-month-label");
const calGrid = document.getElementById("cal-grid");
const calWeekdays = document.getElementById("cal-weekdays");
const prevBtn = document.getElementById("cal-prev");
const nextBtn = document.getElementById("cal-next");
const googleCalendarStatus = document.getElementById("google-calendar-status");
const googleCalendarAction = document.getElementById("google-calendar-action");

const GOOGLE_CALENDAR_START_ENDPOINT = "/.netlify/functions/google-calendar-oauth-start";
const GOOGLE_CALENDAR_STATUS_ENDPOINT = "/.netlify/functions/google-calendar-status";

let viewDate = new Date();
viewDate.setDate(1);

function readAndClearGoogleCalendarReturn() {
  const url = new URL(window.location.href);
  const result = url.searchParams.get("googleCalendar");
  if (!result) return null;
  url.searchParams.delete("googleCalendar");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  return result;
}

const googleCalendarReturn = readAndClearGoogleCalendarReturn();

function setGoogleCalendarUi({ message, actionLabel = null, disabled = false }) {
  if (googleCalendarStatus) googleCalendarStatus.textContent = message;
  if (!googleCalendarAction) return;
  googleCalendarAction.disabled = disabled;
  googleCalendarAction.textContent = actionLabel || "";
  googleCalendarAction.classList.toggle("hidden", !actionLabel);
}

async function callGoogleCalendarFunction(endpoint, user, forceRefresh = false) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await user.getIdToken(forceRefresh)}`,
    },
    body: "{}",
    cache: "no-store",
  });
  if (response.status === 401 && !forceRefresh) return callGoogleCalendarFunction(endpoint, user, true);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok || !body || body.ok !== true) {
    const error = new Error(body && body.error ? body.error : "google_calendar_request_failed");
    error.code = body && body.error ? body.error : "google_calendar_request_failed";
    throw error;
  }
  return body;
}

async function loadGoogleCalendarStatus(user) {
  if (googleCalendarReturn && googleCalendarReturn !== "connected") {
    setGoogleCalendarUi({
      message: googleCalendarReturn === "state_rejected"
        ? "The connection request expired or was already used. Please reconnect."
        : "Google Calendar needs to be connected again.",
      actionLabel: "Reconnect Google Calendar",
    });
  } else {
    setGoogleCalendarUi({ message: "Checking connection…", disabled: true });
  }
  try {
    const status = await callGoogleCalendarFunction(GOOGLE_CALENDAR_STATUS_ENDPOINT, user);
    if (status.connectionStatus === "connected") {
      setGoogleCalendarUi({ message: "Connected with read-only permission. Event access is not enabled in this checkpoint." });
      return;
    }
    if (status.connectionStatus === "reconnect_required" || googleCalendarReturn) {
      setGoogleCalendarUi({ message: "Google Calendar needs to be connected again.", actionLabel: "Reconnect Google Calendar" });
      return;
    }
    setGoogleCalendarUi({ message: "Not connected. EdenAtlas will request read-only event permission.", actionLabel: "Connect Google Calendar" });
  } catch (err) {
    const notConfigured = err && err.code === "google_calendar_not_configured";
    setGoogleCalendarUi({
      message: notConfigured
        ? "Google Calendar is not configured for this environment yet."
        : "Connection status is unavailable. Please try again.",
      actionLabel: notConfigured ? null : "Retry connection",
    });
  }
}

async function startGoogleCalendarConnection() {
  const user = auth.currentUser;
  if (!user || !googleCalendarAction) return;
  setGoogleCalendarUi({ message: "Preparing secure Google authorization…", actionLabel: "Connecting…", disabled: true });
  try {
    const result = await callGoogleCalendarFunction(GOOGLE_CALENDAR_START_ENDPOINT, user);
    const authorizationUrl = new URL(result.authorizationUrl);
    if (authorizationUrl.origin !== "https://accounts.google.com") throw new Error("invalid_authorization_origin");
    window.location.assign(authorizationUrl.toString());
  } catch {
    setGoogleCalendarUi({ message: "Could not start the secure connection. Please try again.", actionLabel: "Retry connection" });
  }
}

// Every other page's toLocaleDateString/toLocaleString call still passes `undefined` (browser
// default) rather than reading the app's own language choice — this is the one page asked to
// fix that, since a month grid full of English weekday/month names while the rest of the UI is
// in Chinese would be the most visible mismatch in the app.
function dateLocale() {
  return getLang() === "zh-CN" ? "zh-CN" : undefined;
}

// Journal titles are free-text user content interpolated into the day grid's innerHTML below
// (Production Hardening Phase 1, task D) — escape before rendering, same convention as
// profile.js/portfolio.js/home.html's own esc().
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function toDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Renders short weekday headers (Sun..Sat) in the app's current language. 1970-01-04 was a
// Sunday, so offsetting from it sidesteps needing today's actual weekday.
function renderWeekdayHeaders() {
  if (!calWeekdays) return;
  const fmt = new Intl.DateTimeFormat(dateLocale(), { weekday: "short" });
  const labels = Array.from({ length: 7 }, (_, i) => fmt.format(new Date(1970, 0, 4 + i)));
  calWeekdays.innerHTML = labels.map((l) => `<span>${l}</span>`).join("");
}

// Fetches the signed-in user's own docs only — no date-range filter server-side (an
// equality + range combo would need a composite index), bucketed by day client-side instead.
async function fetchMine(collectionName) {
  const user = auth.currentUser;
  if (!user) return [];
  try {
    const snap = await getDocs(query(collection(db, collectionName), where("uid", "==", user.uid)));
    // Trashed Memories never show up on the day grid — a no-op for expenses/journals, neither
    // of which carry deletedAt.
    return excludeDeleted(snap.docs.map((d) => d.data()));
  } catch (err) {
    console.error(`[calendar] ${collectionName} fetch failed:`, err.code || err);
    return [];
  }
}

let cachedMonthData = { expenses: [], photos: [], journals: [] };

async function loadMonth() {
  const [expenses, photos, journals] = await Promise.all([
    fetchMine("expenses"),
    fetchMine("photos"),
    fetchMine("journals"),
  ]);
  cachedMonthData = { expenses, photos, journals };
  renderMonth();
}

// Pure render from cachedMonthData — safe to call again on a language switch without
// re-fetching from Firestore.
function renderMonth() {
  monthLabel.textContent = viewDate.toLocaleDateString(dateLocale(), { month: "long", year: "numeric" });
  renderWeekdayHeaders();

  const { expenses, photos, journals } = cachedMonthData;
  const byDay = new Map();
  function addItem(dateField, item, render) {
    const d = item[dateField]?.toDate?.();
    if (!d || d.getFullYear() !== viewDate.getFullYear() || d.getMonth() !== viewDate.getMonth()) return;
    const key = toDateKey(d);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(render(item));
  }

  expenses.forEach((e) => {
    const transactionDate = expenseTransactionTimestamp(e);
    if (!transactionDate) return;
    addItem("transactionDate", { ...e, transactionDate }, (item) => `💰 ${expenseCurrency(item) === "MYR" ? "RM" : expenseCurrency(item)} ${Number(item.amount || 0).toFixed(0)}`);
  });
  photos.forEach((p) => addItem("uploadedAt", p, () => `📷 Photo`));
  journals.forEach((j) => addItem("createdAt", j, (item) => `📝 ${esc(item.title || "Entry")}`));

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstWeekday = new Date(year, month, 1).getDay();
  const todayKey = toDateKey(new Date());

  const cells = [];
  for (let i = 0; i < firstWeekday; i++) {
    cells.push(`<div class="min-h-[90px] rounded-lg bg-darkBg/20"></div>`);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const key = toDateKey(new Date(year, month, day));
    const items = byDay.get(key) || [];
    const isToday = key === todayKey;
    cells.push(`
      <div class="min-h-[90px] rounded-lg border ${isToday ? "border-neonPurple/60 bg-neonPurple/5" : "border-borderNeon/60 bg-darkBg/30"} p-1.5 flex flex-col gap-0.5 overflow-hidden">
        <span class="text-[10px] font-code ${isToday ? "text-neonPurple font-bold" : "text-textGray"}">${day}</span>
        ${items.slice(0, 3).map((t) => `<span class="text-[9px] text-white leading-tight truncate">${t}</span>`).join("")}
        ${items.length > 3 ? `<span class="text-[9px] text-textGray">+${items.length - 3} more</span>` : ""}
      </div>`);
  }

  calGrid.innerHTML = cells.join("");
}

prevBtn.addEventListener("click", () => {
  viewDate.setMonth(viewDate.getMonth() - 1);
  loadMonth();
});
nextBtn.addEventListener("click", () => {
  viewDate.setMonth(viewDate.getMonth() + 1);
  loadMonth();
});

onAuthStateChanged(auth, (user) => {
  if (!user) return;
  loadMonth();
  loadGoogleCalendarStatus(user);
});

if (googleCalendarAction) googleCalendarAction.addEventListener("click", startGoogleCalendarConnection);

// Re-render the month label, weekday headers, and grid from the already-fetched
// cachedMonthData whenever the language switcher fires — no Firestore re-fetch needed.
document.addEventListener("eden:langchange", () => {
  renderMonth();
});
