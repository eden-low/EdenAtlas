const {
  GOOGLE_TOKEN_ENDPOINT,
  normalizeGrantedScopes,
  grantedCapability,
} = require("./google-calendar-oauth");

const GOOGLE_CALENDAR_EVENTS_ENDPOINT = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const MAX_QUERY_WINDOW_MS = 32 * 24 * 60 * 60 * 1000;
const GOOGLE_PAGE_SIZE = 100;
const MAX_GOOGLE_PAGES = 2;
const MAX_RETURNED_EVENTS = GOOGLE_PAGE_SIZE * MAX_GOOGLE_PAGES;
const MAX_SUMMARY_LENGTH = 200;
const MAX_EVENT_ID_LENGTH = 512;
const MAX_TIME_ZONE_LENGTH = 100;
const MAX_REQUEST_BODY_BYTES = 1024;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const MAX_CALENDAR_RESPONSE_BYTES = 1024 * 1024;
const PROVIDER_TIMEOUT_MS = 10_000;

class GoogleCalendarReadError extends Error {
  constructor(code, statusCode = 502, { reconnectRequired = false } = {}) {
    super(code);
    this.name = "GoogleCalendarReadError";
    this.code = code;
    this.statusCode = statusCode;
    this.reconnectRequired = reconnectRequired;
  }
}

function daysInMonth(year, month) {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseRfc3339(value) {
  if (typeof value !== "string" || value.length > 64) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, , zone] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
      || hour > 23 || minute > 59 || second > 59) return null;
  if (zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return null;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? { value, milliseconds } : null;
}

function validFullDate(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function validProviderDateTime(value, hasTimeZone) {
  if (parseRfc3339(value)) return true;
  if (!hasTimeZone || typeof value !== "string" || value.length > 64) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
    && Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 59;
}

function parseEventsRequest(rawBody) {
  if (typeof rawBody !== "string" || Buffer.byteLength(rawBody, "utf8") > MAX_REQUEST_BODY_BYTES) {
    return { error: "invalid_request_body" };
  }
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { error: "invalid_json" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid_json" };
  const allowedFields = new Set(["start", "end"]);
  if (Object.keys(body).some((key) => !allowedFields.has(key))) return { error: "unknown_field" };
  if (!Object.prototype.hasOwnProperty.call(body, "start") || !Object.prototype.hasOwnProperty.call(body, "end")) {
    return { error: "missing_time_range" };
  }
  const start = parseRfc3339(body.start);
  const end = parseRfc3339(body.end);
  if (!start || !end) return { error: "invalid_time_range" };
  if (start.milliseconds >= end.milliseconds) return { error: "invalid_time_range" };
  if (end.milliseconds - start.milliseconds > MAX_QUERY_WINDOW_MS) return { error: "time_range_too_large" };
  return { value: { start: start.value, end: end.value } };
}

function hasApprovedReadScopeSet(scopes) {
  return grantedCapability(scopes) !== null;
}

function boundedString(value, maxLength) {
  if (typeof value !== "string") return "";
  return Array.from(value.replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, maxLength).join("");
}

function normalizeEventBoundary(value, allDay) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const normalized = {};
  const timeZone = boundedString(value.timeZone, MAX_TIME_ZONE_LENGTH);
  if (allDay) {
    if (!validFullDate(value.date)) return null;
    normalized.date = value.date;
  } else {
    if (!validProviderDateTime(value.dateTime, !!timeZone)) return null;
    normalized.dateTime = value.dateTime;
  }
  if (timeZone) normalized.timeZone = timeZone;
  return normalized;
}

function normalizeGoogleEvent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.status === "cancelled") return null;
  const status = raw.status == null ? "confirmed" : raw.status;
  if (status !== "confirmed" && status !== "tentative") return null;
  const allDay = !!(raw.start && raw.start.date) && !!(raw.end && raw.end.date);
  if (!allDay && (!raw.start || !raw.start.dateTime || !raw.end || !raw.end.dateTime)) return null;
  const start = normalizeEventBoundary(raw.start, allDay);
  const end = normalizeEventBoundary(raw.end, allDay);
  if (!start || !end) return null;
  if (allDay && start.date >= end.date) return null;
  const id = boundedString(raw.id, MAX_EVENT_ID_LENGTH);
  if (!id) return null;
  return {
    id,
    summary: boundedString(raw.summary, MAX_SUMMARY_LENGTH),
    start,
    end,
    allDay,
    status,
  };
}

async function readBoundedJson(response, maxBytes) {
  const declaredLength = Number(response && response.headers && response.headers.get
    ? response.headers.get("content-length")
    : NaN);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new GoogleCalendarReadError("calendar_invalid_response", 502);
  }
  let text;
  try {
    text = await response.text();
  } catch {
    throw new GoogleCalendarReadError("calendar_invalid_response", 502);
  }
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new GoogleCalendarReadError("calendar_invalid_response", 502);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GoogleCalendarReadError("calendar_invalid_response", 502);
  }
}

async function refreshGoogleAccessToken({ fetchImpl = fetch, config, refreshToken }) {
  let response;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }).toString(),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch {
    throw new GoogleCalendarReadError("calendar_provider_unavailable", 503);
  }
  if (!response) throw new GoogleCalendarReadError("calendar_provider_unavailable", 503);
  if (!response.ok) {
    let payload = null;
    try {
      payload = await readBoundedJson(response, MAX_TOKEN_RESPONSE_BYTES);
    } catch {
      payload = null;
    }
    if (response.status === 400 && payload && payload.error === "invalid_grant") {
      throw new GoogleCalendarReadError("reconnect_required", 401, { reconnectRequired: true });
    }
    if (response.status === 429) throw new GoogleCalendarReadError("calendar_rate_limited", 429);
    if (response.status >= 500) throw new GoogleCalendarReadError("calendar_provider_unavailable", 503);
    throw new GoogleCalendarReadError("calendar_provider_unavailable", 503);
  }
  const payload = await readBoundedJson(response, MAX_TOKEN_RESPONSE_BYTES);
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
  if (!accessToken || accessToken.length > 8192 || (payload.token_type && payload.token_type !== "Bearer")) {
    throw new GoogleCalendarReadError("calendar_invalid_response", 502);
  }
  if (payload.scope && !hasApprovedReadScopeSet(normalizeGrantedScopes(payload.scope))) {
    throw new GoogleCalendarReadError("unexpected_scope_set", 401, { reconnectRequired: true });
  }
  return accessToken;
}

function mapCalendarApiFailure(status) {
  if (status === 401) return new GoogleCalendarReadError("calendar_api_unauthorized", 401);
  if (status === 403) return new GoogleCalendarReadError("calendar_access_denied", 403);
  if (status === 429) return new GoogleCalendarReadError("calendar_rate_limited", 429);
  if (status >= 500) return new GoogleCalendarReadError("calendar_provider_unavailable", 503);
  return new GoogleCalendarReadError("calendar_provider_unavailable", 502);
}

async function fetchEventsPage({ fetchImpl, accessToken, start, end, pageToken, maxResults }) {
  const url = new URL(GOOGLE_CALENDAR_EVENTS_ENDPOINT);
  url.searchParams.set("timeMin", start);
  url.searchParams.set("timeMax", end);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("showDeleted", "false");
  url.searchParams.set("maxResults", String(maxResults));
  url.searchParams.set("fields", "nextPageToken,items(id,summary,start(date,dateTime,timeZone),end(date,dateTime,timeZone),status)");
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch {
    throw new GoogleCalendarReadError("calendar_provider_unavailable", 503);
  }
  if (!response || !response.ok) throw mapCalendarApiFailure(response ? response.status : 503);
  const payload = await readBoundedJson(response, MAX_CALENDAR_RESPONSE_BYTES);
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.items)) {
    throw new GoogleCalendarReadError("calendar_invalid_response", 502);
  }
  if (payload.nextPageToken != null
      && (typeof payload.nextPageToken !== "string" || !payload.nextPageToken || payload.nextPageToken.length > 4096)) {
    throw new GoogleCalendarReadError("calendar_invalid_response", 502);
  }
  return { items: payload.items, nextPageToken: payload.nextPageToken || null };
}

async function listPrimaryCalendarEvents({ fetchImpl = fetch, accessToken, start, end }) {
  const events = [];
  let pageToken = null;
  let truncated = false;
  const seenPageTokens = new Set();
  for (let page = 0; page < MAX_GOOGLE_PAGES; page += 1) {
    const remaining = MAX_RETURNED_EVENTS - events.length;
    const result = await fetchEventsPage({
      fetchImpl,
      accessToken,
      start,
      end,
      pageToken,
      maxResults: Math.min(GOOGLE_PAGE_SIZE, remaining),
    });
    for (const raw of result.items) {
      if (events.length >= MAX_RETURNED_EVENTS) {
        truncated = true;
        break;
      }
      const normalized = normalizeGoogleEvent(raw);
      if (normalized) events.push(normalized);
    }
    if (!result.nextPageToken) break;
    if (events.length >= MAX_RETURNED_EVENTS || seenPageTokens.has(result.nextPageToken)) {
      truncated = true;
      break;
    }
    seenPageTokens.add(result.nextPageToken);
    pageToken = result.nextPageToken;
    if (page === MAX_GOOGLE_PAGES - 1) truncated = true;
  }
  return { events, truncated };
}

module.exports = {
  GOOGLE_CALENDAR_EVENTS_ENDPOINT,
  MAX_QUERY_WINDOW_MS,
  GOOGLE_PAGE_SIZE,
  MAX_GOOGLE_PAGES,
  MAX_RETURNED_EVENTS,
  MAX_SUMMARY_LENGTH,
  GoogleCalendarReadError,
  parseRfc3339,
  parseEventsRequest,
  hasApprovedReadScopeSet,
  normalizeGoogleEvent,
  refreshGoogleAccessToken,
  listPrimaryCalendarEvents,
};
