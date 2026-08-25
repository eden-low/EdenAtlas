"use strict";

const assert = require("node:assert");
const {
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_CALENDAR_SCOPE,
  GOOGLE_CALENDAR_APP_CREATED_SCOPE,
  GOOGLE_CALENDAR_CAPABILITY_WRITE_AUTHORIZED,
  encryptRefreshToken,
} = require("../lib/google-calendar-oauth");
const {
  GOOGLE_CALENDAR_EVENTS_ENDPOINT,
  MAX_QUERY_WINDOW_MS,
  GOOGLE_PAGE_SIZE,
  MAX_GOOGLE_PAGES,
  MAX_RETURNED_EVENTS,
  MAX_SUMMARY_LENGTH,
  parseEventsRequest,
  normalizeGoogleEvent,
} = require("../lib/google-calendar-events");
const { createHandler } = require("../google-calendar-events");

const UID = "calendar-read-user";
const OTHER_UID = "other-calendar-user";
const ORIGIN = "https://staging--edenatlas.netlify.app";
const MASTER_KEY = Buffer.alloc(32, 41).toString("base64");
const REFRESH_TOKEN = "fake-refresh-token-never-log";
const ACCESS_TOKEN = "fake-access-token-never-return";
const CLIENT_SECRET = "fake-client-secret-never-return";
const START = "2026-08-01T00:00:00Z";
const END = "2026-09-01T00:00:00Z";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(err);
    failed += 1;
  }
}

function response(status, payload, headers = {}) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] || null },
    text: async () => text,
  };
}

function validTimedEvent(overrides = {}) {
  return {
    id: "timed-1",
    summary: "Planning <script>alert(1)</script>",
    start: { dateTime: "2026-08-04T09:00:00+08:00", timeZone: "Asia/Kuala_Lumpur" },
    end: { dateTime: "2026-08-04T10:00:00+08:00", timeZone: "Asia/Kuala_Lumpur" },
    status: "confirmed",
    attendees: [{ email: "must-not-return@example.com" }],
    organizer: { email: "must-not-return@example.com" },
    description: "raw html must not return",
    hangoutLink: "https://meet.google.com/secret",
    ...overrides,
  };
}

function validConnection() {
  return {
    uid: UID,
    status: "connected",
    reconnectRequired: false,
    grantedScopes: [GOOGLE_CALENDAR_SCOPE],
    encryptedRefreshToken: encryptRefreshToken({
      refreshToken: REFRESH_TOKEN,
      uid: UID,
      masterKeyRaw: MASTER_KEY,
      randomBytesImpl: () => Buffer.alloc(12, 7),
    }),
  };
}

function createHarness(options = {}) {
  const observed = {
    docUids: [],
    connectionWrites: [],
    tokenCalls: [],
    calendarCalls: [],
  };
  const connection = options.connection === undefined ? validConnection() : options.connection;
  const tokenResponses = [...(options.tokenResponses || [response(200, {
    access_token: ACCESS_TOKEN,
    token_type: "Bearer",
    scope: GOOGLE_CALENDAR_SCOPE,
  })])];
  const calendarResponses = [...(options.calendarResponses || [response(200, { items: [] })])];
  const connectionRef = {
    get: async () => ({ exists: !!connection, data: () => connection }),
    set: async (value, setOptions) => {
      observed.connectionWrites.push({ value, options: setOptions });
      if (connection) Object.assign(connection, value);
    },
  };
  const fetchImpl = async (url, fetchOptions) => {
    if (url === GOOGLE_TOKEN_ENDPOINT) {
      observed.tokenCalls.push({ url, options: fetchOptions });
      if (!tokenResponses.length) throw new Error("unexpected token request");
      return tokenResponses.shift();
    }
    observed.calendarCalls.push({ url, options: fetchOptions });
    if (!calendarResponses.length) throw new Error("unexpected calendar request");
    return calendarResponses.shift();
  };
  const deps = {
    env: { ALLOWED_ORIGIN: ORIGIN },
    getOAuthConfig: () => ({
      clientId: "fake-client-id",
      clientSecret: CLIENT_SECRET,
      masterKeyRaw: MASTER_KEY,
      environment: "staging",
    }),
    ensureFirebaseAdmin: async () => {},
    verifyIdToken: options.verifyIdToken || (async () => ({ uid: UID })),
    getDb: () => ({
      collection: () => ({
        doc: (uid) => {
          observed.docUids.push(uid);
          return connectionRef;
        },
      }),
    }),
    checkBurst: options.checkBurst || (() => ({ allowed: true })),
    now: () => new Date("2026-08-22T00:00:00Z"),
    fetchImpl,
  };
  return { handler: createHandler(deps), observed, connection };
}

function postEvent(body = { start: START, end: END }, overrides = {}) {
  return {
    httpMethod: "POST",
    headers: { origin: ORIGIN, authorization: "Bearer fake-firebase-id-token" },
    body: JSON.stringify(body),
    ...overrides,
  };
}

function bodyOf(result) {
  return JSON.parse(result.body);
}

async function captureErrors(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(" "));
  try {
    return { value: await fn(), lines };
  } finally {
    console.error = original;
  }
}

async function run() {
  console.log("\nGoogle Calendar read endpoint tests");

  await test("missing Bearer token is rejected", async () => {
    const { handler } = createHarness();
    const result = await handler(postEvent(undefined, { headers: { origin: ORIGIN } }));
    assert.strictEqual(result.statusCode, 401);
    assert.strictEqual(bodyOf(result).error, "missing_bearer_token");
  });

  await test("invalid Firebase token is rejected", async () => {
    const { handler } = createHarness({ verifyIdToken: async () => { throw new Error("invalid"); } });
    const result = await handler(postEvent());
    assert.strictEqual(result.statusCode, 401);
    assert.strictEqual(bodyOf(result).error, "invalid_or_expired_token");
  });

  await test("revoked Firebase token is rejected", async () => {
    const { handler } = createHarness({ verifyIdToken: async () => { const err = new Error("revoked"); err.code = "auth/id-token-revoked"; throw err; } });
    const result = await handler(postEvent());
    assert.strictEqual(result.statusCode, 401);
    assert.strictEqual(bodyOf(result).error, "invalid_or_expired_token");
  });

  await test("verified UID exclusively selects the connection document", async () => {
    const { handler, observed } = createHarness();
    const result = await handler(postEvent());
    assert.strictEqual(result.statusCode, 200);
    assert.deepStrictEqual(observed.docUids, [UID]);
    assert.ok(!observed.docUids.includes(OTHER_UID));
  });

  await test("body UID cannot override the verified UID", async () => {
    const { handler, observed } = createHarness();
    const result = await handler(postEvent({ start: START, end: END, uid: OTHER_UID }));
    assert.strictEqual(result.statusCode, 400);
    assert.strictEqual(bodyOf(result).error, "unknown_field");
    assert.deepStrictEqual(observed.docUids, []);
  });

  await test("missing, malformed, reversed, and excessive ranges are rejected", async () => {
    const cases = [
      [{ start: START }, "missing_time_range"],
      [{ start: "not-a-date", end: END }, "invalid_time_range"],
      [{ start: "2026-02-30T00:00:00Z", end: END }, "invalid_time_range"],
      [{ start: END, end: START }, "invalid_time_range"],
      [{ start: START, end: "2026-09-03T00:00:00Z" }, "time_range_too_large"],
    ];
    for (const [request, error] of cases) {
      const { handler } = createHarness();
      const result = await handler(postEvent(request));
      assert.strictEqual(result.statusCode, 400);
      assert.strictEqual(bodyOf(result).error, error);
    }
    assert.strictEqual(MAX_QUERY_WINDOW_MS, 32 * 24 * 60 * 60 * 1000);
  });

  await test("unsupported methods and disallowed origins fail closed", async () => {
    const { handler } = createHarness();
    const wrongMethod = await handler(postEvent(undefined, { httpMethod: "GET" }));
    assert.strictEqual(wrongMethod.statusCode, 405);
    const wrongOrigin = await handler(postEvent(undefined, { headers: { origin: "https://edenatlas.netlify.app", authorization: "Bearer fake" } }));
    assert.strictEqual(wrongOrigin.statusCode, 403);
  });

  await test("browser calendarId, maxResults, scope, and pageToken are rejected", async () => {
    for (const extra of [
      { calendarId: "attacker@example.com" },
      { maxResults: 9999 },
      { scope: "https://www.googleapis.com/auth/calendar" },
      { pageToken: "unbounded" },
    ]) {
      const { handler } = createHarness();
      const result = await handler(postEvent({ start: START, end: END, ...extra }));
      assert.strictEqual(result.statusCode, 400);
      assert.strictEqual(bodyOf(result).error, "unknown_field");
    }
  });

  await test("disconnected and reconnect-required connections return sanitized state without Google calls", async () => {
    const disconnected = createHarness({ connection: null });
    let result = await disconnected.handler(postEvent());
    assert.deepStrictEqual(bodyOf(result), { ok: true, connectionStatus: "disconnected", events: [] });
    assert.strictEqual(disconnected.observed.tokenCalls.length, 0);
    const record = validConnection();
    record.reconnectRequired = true;
    const reconnect = createHarness({ connection: record });
    result = await reconnect.handler(postEvent());
    assert.strictEqual(bodyOf(result).connectionStatus, "reconnect_required");
    assert.strictEqual(reconnect.observed.tokenCalls.length, 0);
  });

  await test("unapproved broad scope sets are rejected", async () => {
    const record = validConnection();
    record.grantedScopes.push("https://www.googleapis.com/auth/calendar");
    const { handler, observed } = createHarness({ connection: record });
    const result = await handler(postEvent());
    assert.strictEqual(bodyOf(result).connectionStatus, "reconnect_required");
    assert.strictEqual(observed.tokenCalls.length, 0);
    assert.strictEqual(observed.connectionWrites[0].value.lastErrorCode, "unexpected_scope_set");
  });

  await test("write-authorized users retain inbound reads and Primary is never an outbound target", async () => {
    const record = validConnection();
    record.grantedScopes = [GOOGLE_CALENDAR_SCOPE, GOOGLE_CALENDAR_APP_CREATED_SCOPE];
    record.capabilityStatus = GOOGLE_CALENDAR_CAPABILITY_WRITE_AUTHORIZED;
    const { handler, observed } = createHarness({
      connection: record,
      tokenResponses: [response(200, {
        access_token: ACCESS_TOKEN,
        token_type: "Bearer",
        scope: `${GOOGLE_CALENDAR_SCOPE} ${GOOGLE_CALENDAR_APP_CREATED_SCOPE}`,
      })],
    });
    const result = await handler(postEvent());
    assert.strictEqual(bodyOf(result).connectionStatus, "connected");
    assert.strictEqual(observed.calendarCalls.length, 1);
    assert.strictEqual(observed.calendarCalls[0].options.method, "GET");
    assert.strictEqual(new URL(observed.calendarCalls[0].url).pathname, "/calendar/v3/calendars/primary/events");
    assert.ok(observed.calendarCalls.every((call) => !["POST", "PUT", "PATCH", "DELETE"].includes(call.options.method)));
  });

  await test("server refreshes access and queries only primary with bounded parameters", async () => {
    const { handler, observed } = createHarness({ calendarResponses: [response(200, { items: [validTimedEvent()] })] });
    const result = await handler(postEvent());
    const body = bodyOf(result);
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(body.connectionStatus, "connected");
    assert.strictEqual(observed.tokenCalls.length, 1);
    assert.strictEqual(observed.calendarCalls.length, 1);
    const url = new URL(observed.calendarCalls[0].url);
    assert.strictEqual(`${url.origin}${url.pathname}`, GOOGLE_CALENDAR_EVENTS_ENDPOINT);
    assert.strictEqual(url.searchParams.get("timeMin"), START);
    assert.strictEqual(url.searchParams.get("timeMax"), END);
    assert.strictEqual(url.searchParams.get("singleEvents"), "true");
    assert.strictEqual(url.searchParams.get("orderBy"), "startTime");
    assert.strictEqual(url.searchParams.get("showDeleted"), "false");
    assert.strictEqual(Number(url.searchParams.get("maxResults")), GOOGLE_PAGE_SIZE);
    assert.ok(Number(url.searchParams.get("maxResults")) <= GOOGLE_PAGE_SIZE);
  });

  await test("timed, all-day, and recurring instances normalize without private fields", async () => {
    const allDay = {
      id: "all-day-1", summary: "Holiday", status: "confirmed",
      start: { date: "2026-08-10" }, end: { date: "2026-08-11" },
      attachments: [{ fileUrl: "private" }],
    };
    const recurringInstance = validTimedEvent({
      id: "recurring-instance-1",
      recurringEventId: "series-id-must-not-return",
      originalStartTime: { dateTime: "2026-08-11T09:00:00+08:00" },
    });
    const { handler } = createHarness({ calendarResponses: [response(200, {
      items: [validTimedEvent(), allDay, recurringInstance, validTimedEvent({ id: "cancelled", status: "cancelled" })],
    })] });
    const body = bodyOf(await handler(postEvent()));
    assert.strictEqual(body.events.length, 3);
    assert.strictEqual(body.events[0].allDay, false);
    assert.deepStrictEqual(body.events[1].start, { date: "2026-08-10" });
    assert.strictEqual(body.events[1].allDay, true);
    assert.strictEqual(body.events[2].id, "recurring-instance-1");
    const serialized = JSON.stringify(body);
    for (const forbidden of ["attendees", "organizer", "description", "hangoutLink", "attachments", "recurringEventId", "originalStartTime", "must-not-return@example.com"]) {
      assert.ok(!serialized.includes(forbidden));
    }
  });

  await test("provider default status and timezone-qualified local dateTime normalize without inventing a timezone", () => {
    const normalized = normalizeGoogleEvent({
      id: "timezone-local-event",
      summary: "Timezone event",
      start: { dateTime: "2026-08-04T09:00:00", timeZone: "Asia/Kuala_Lumpur" },
      end: { dateTime: "2026-08-04T10:00:00", timeZone: "Asia/Kuala_Lumpur" },
    });
    assert.strictEqual(normalized.status, "confirmed");
    assert.deepStrictEqual(normalized.start, { dateTime: "2026-08-04T09:00:00", timeZone: "Asia/Kuala_Lumpur" });
    assert.strictEqual(normalizeGoogleEvent({
      id: "missing-zone",
      start: { dateTime: "2026-08-04T09:00:00" },
      end: { dateTime: "2026-08-04T10:00:00" },
    }), null);
  });

  await test("oversized normalized strings are deterministically bounded", () => {
    const normalized = normalizeGoogleEvent(validTimedEvent({
      id: "i".repeat(800),
      summary: "s".repeat(500),
      start: { dateTime: "2026-08-04T09:00:00Z", timeZone: "z".repeat(200) },
      end: { dateTime: "2026-08-04T10:00:00Z", timeZone: "z".repeat(200) },
    }));
    assert.strictEqual(Array.from(normalized.id).length, 512);
    assert.strictEqual(Array.from(normalized.summary).length, MAX_SUMMARY_LENGTH);
    assert.strictEqual(Array.from(normalized.start.timeZone).length, 100);
  });

  await test("pagination is capped at two pages and 200 returned events", async () => {
    const makePage = (offset, nextPageToken) => response(200, {
      items: Array.from({ length: 100 }, (_, index) => validTimedEvent({ id: `event-${offset + index}` })),
      ...(nextPageToken ? { nextPageToken } : {}),
    });
    const { handler, observed } = createHarness({ calendarResponses: [makePage(0, "page-2"), makePage(100, "page-3")] });
    const body = bodyOf(await handler(postEvent()));
    assert.strictEqual(MAX_GOOGLE_PAGES, 2);
    assert.strictEqual(MAX_RETURNED_EVENTS, 200);
    assert.strictEqual(observed.calendarCalls.length, 2);
    assert.strictEqual(body.events.length, 200);
    assert.strictEqual(body.truncated, true);
    assert.strictEqual(new URL(observed.calendarCalls[1].url).searchParams.get("pageToken"), "page-2");
  });

  await test("invalid refresh grant marks only the verified user's connection reconnect-required", async () => {
    const { handler, observed } = createHarness({ tokenResponses: [response(400, { error: "invalid_grant", error_description: REFRESH_TOKEN })] });
    const result = await handler(postEvent());
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(bodyOf(result).connectionStatus, "reconnect_required");
    assert.deepStrictEqual(observed.docUids, [UID]);
    assert.strictEqual(observed.connectionWrites.length, 1);
    assert.strictEqual(observed.connectionWrites[0].value.lastErrorCode, "refresh_token_rejected");
  });

  await test("a refresh response carrying a broader scope is rejected and marked for reconnect", async () => {
    const { handler, observed } = createHarness({ tokenResponses: [response(200, {
      access_token: ACCESS_TOKEN,
      token_type: "Bearer",
      scope: `${GOOGLE_CALENDAR_SCOPE} https://www.googleapis.com/auth/calendar`,
    })] });
    const body = bodyOf(await handler(postEvent()));
    assert.strictEqual(body.connectionStatus, "reconnect_required");
    assert.strictEqual(observed.calendarCalls.length, 0);
    assert.strictEqual(observed.connectionWrites[0].value.lastErrorCode, "unexpected_scope_set");
  });

  await test("one Calendar API 401 gets one controlled token refresh retry", async () => {
    const { handler, observed } = createHarness({
      tokenResponses: [
        response(200, { access_token: "first-token", token_type: "Bearer", scope: GOOGLE_CALENDAR_SCOPE }),
        response(200, { access_token: "second-token", token_type: "Bearer", scope: GOOGLE_CALENDAR_SCOPE }),
      ],
      calendarResponses: [response(401, { error: "unauthorized" }), response(200, { items: [validTimedEvent()] })],
    });
    const body = bodyOf(await handler(postEvent()));
    assert.strictEqual(body.connectionStatus, "connected");
    assert.strictEqual(observed.tokenCalls.length, 2);
    assert.strictEqual(observed.calendarCalls.length, 2);
  });

  await test("a second Calendar API 401 marks reconnect-required and stops", async () => {
    const { handler, observed } = createHarness({
      tokenResponses: [
        response(200, { access_token: "first-token", token_type: "Bearer" }),
        response(200, { access_token: "second-token", token_type: "Bearer" }),
      ],
      calendarResponses: [response(401, {}), response(401, {})],
    });
    const body = bodyOf(await handler(postEvent()));
    assert.strictEqual(body.connectionStatus, "reconnect_required");
    assert.strictEqual(observed.calendarCalls.length, 2);
    assert.strictEqual(observed.connectionWrites[0].value.lastErrorCode, "calendar_api_unauthorized");
  });

  await test("Google 403, 429, 5xx, and malformed responses map to sanitized errors", async () => {
    const cases = [
      [response(403, { raw: REFRESH_TOKEN }), 403, "calendar_access_denied"],
      [response(429, { raw: ACCESS_TOKEN }), 429, "calendar_rate_limited"],
      [response(503, { raw: CLIENT_SECRET }), 503, "calendar_provider_unavailable"],
      [response(200, { notItems: [] }), 502, "calendar_invalid_response"],
      [response(200, "not-json"), 502, "calendar_invalid_response"],
    ];
    for (const [providerResponse, expectedStatus, expectedError] of cases) {
      const { handler } = createHarness({ calendarResponses: [providerResponse] });
      const captured = await captureErrors(() => handler(postEvent()));
      assert.strictEqual(captured.value.statusCode, expectedStatus);
      assert.strictEqual(bodyOf(captured.value).error, expectedError);
      const combined = `${captured.value.body}\n${captured.lines.join("\n")}`;
      for (const secret of [REFRESH_TOKEN, ACCESS_TOKEN, CLIENT_SECRET]) assert.ok(!combined.includes(secret));
    }
  });

  await test("tokens, credentials, and raw Google fields never enter a successful response", async () => {
    const { handler, connection } = createHarness({ calendarResponses: [response(200, { items: [validTimedEvent()] })] });
    const result = await handler(postEvent());
    const serialized = result.body;
    for (const forbidden of [
      REFRESH_TOKEN, ACCESS_TOKEN, CLIENT_SECRET, connection.encryptedRefreshToken.ciphertext,
      "encryptedRefreshToken", "access_token", "refresh_token", "authorization",
    ]) assert.ok(!serialized.includes(forbidden));
  });

  await test("burst limiting rejects before token refresh", async () => {
    const { handler, observed } = createHarness({ checkBurst: () => ({ allowed: false, retryAfterMs: 1200 }) });
    const result = await handler(postEvent());
    assert.strictEqual(result.statusCode, 429);
    assert.strictEqual(bodyOf(result).error, "rate_limited");
    assert.strictEqual(observed.tokenCalls.length, 0);
  });

  await test("request parser accepts a timezone-offset month boundary", () => {
    const parsed = parseEventsRequest(JSON.stringify({
      start: "2026-08-01T00:00:00+08:00",
      end: "2026-09-01T00:00:00+08:00",
    }));
    assert.ok(parsed.value);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

run().catch((err) => {
  console.error("[google-calendar-events.test.js] unexpected failure:", err);
  process.exitCode = 1;
});
