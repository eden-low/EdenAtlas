const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { createHandler, MAX_BODY_BYTES, DAILY_COLLECTION } = require("../expense-receipt-ai.js");
const { QwenVisionError } = require("../lib/qwen-vision.js");
const {
  checkAndIncrementDailyUsage,
  BURST_LIMIT,
  BURST_WINDOW_MS,
} = require("../lib/rate-limit.js");

const ORIGIN = "https://edenatlas.netlify.app";
const OWNER_EMAIL = "jjun8647@gmail.com";
const OWNER_UID = "owner-receipt-uid";
const SECRET = "RECEIPT_VISION_SECRET_NEVER_EXPOSE";
let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    fail++;
    console.log(`FAIL  - ${name}`);
    console.log(`        ${err.message}`);
  }
}

function pngDataUrl(extraBytes = 0) {
  const bytes = Buffer.alloc(24 + extraBytes);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(400, 16);
  bytes.writeUInt32BE(600, 20);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function suggestions() {
  return {
    merchantName: "Cafe", totalAmount: 12.3, currencyCode: "MYR",
    transactionDate: "2026-08-20", transactionTime: "12:30", suggestedCategory: "food",
    receiptNumber: null,
    confidence: {
      merchantName: "high", totalAmount: "high", currencyCode: "high",
      transactionDate: "medium", transactionTime: "medium", suggestedCategory: "medium",
      receiptNumber: null,
    },
    warnings: [],
  };
}

function deps(overrides = {}) {
  return {
    env: {
      FIREBASE_PROJECT_ID: "test-project",
      FIREBASE_SERVICE_ACCOUNT: "test-service-account",
      ALLOWED_ORIGIN: ORIGIN,
      DASHSCOPE_API_KEY: SECRET,
      QWEN_VISION_MODEL: "qwen3.7-plus-2026-05-26",
      QWEN_BASE_URL: "https://dashscope.invalid/v1",
    },
    ensureFirebaseAdmin: async () => {},
    verifyIdToken: async () => ({ uid: OWNER_UID, email: OWNER_EMAIL }),
    getUserDoc: async () => ({ role: "owner", email: OWNER_EMAIL }),
    getDb: () => ({ rateOnly: true }),
    checkBurst: () => ({ allowed: true }),
    checkDaily: async () => ({ allowed: true, limit: 10 }),
    callVision: async () => suggestions(),
    now: () => new Date("2026-08-20T04:00:00Z"),
    ...overrides,
  };
}

function event(overrides = {}) {
  return {
    httpMethod: "POST",
    headers: { origin: ORIGIN, authorization: "Bearer valid-token" },
    body: JSON.stringify({ imageDataUrl: pngDataUrl() }),
    ...overrides,
  };
}
function bodyOf(response) { return JSON.parse(response.body); }

async function run() {
  await test("QWEN_VISION_MODEL is required separately while QWEN_MODEL is not required", async () => {
    let adminCalled = false;
    const missingEnv = deps({ ensureFirebaseAdmin: async () => { adminCalled = true; } });
    delete missingEnv.env.QWEN_VISION_MODEL;
    const response = await createHandler(missingEnv)(event());
    assert.strictEqual(response.statusCode, 500);
    assert.strictEqual(adminCalled, false);
    assert.ok(!response.body.includes(SECRET));
  });

  await test("anonymous requests return 401 before parsing or provider use", async () => {
    let called = false;
    const handler = createHandler(deps({ callVision: async () => { called = true; } }));
    const response = await handler(event({ headers: { origin: ORIGIN } }));
    assert.strictEqual(response.statusCode, 401);
    assert.strictEqual(called, false);
  });

  await test("authenticated non-Owner requests return 403", async () => {
    const handler = createHandler(deps({ getUserDoc: async () => ({ role: "friend", email: OWNER_EMAIL }) }));
    assert.strictEqual((await handler(event())).statusCode, 403);
  });

  await test("invalid or revoked token verification returns 401", async () => {
    const handler = createHandler(deps({ verifyIdToken: async () => { throw Object.assign(new Error("revoked"), { code: "auth/id-token-revoked" }); } }));
    const response = await handler(event());
    assert.strictEqual(response.statusCode, 401);
    assert.strictEqual(bodyOf(response).error, "invalid_or_expired_token");
  });

  await test("only POST and allowed-origin OPTIONS are accepted", async () => {
    const handler = createHandler(deps());
    let response = await handler(event({ httpMethod: "OPTIONS", body: null }));
    assert.strictEqual(response.statusCode, 204);
    assert.strictEqual(response.headers["Access-Control-Allow-Origin"], ORIGIN);
    assert.strictEqual(response.headers["Cache-Control"], "no-store");
    response = await handler(event({ httpMethod: "GET", body: null }));
    assert.strictEqual(response.statusCode, 405);
  });

  await test("invalid origin is rejected exactly with no permissive CORS header", async () => {
    let verified = false;
    const handler = createHandler(deps({ verifyIdToken: async () => { verified = true; } }));
    const response = await handler(event({ headers: { origin: "https://evil.example", authorization: "Bearer valid-token" } }));
    assert.strictEqual(response.statusCode, 403);
    assert.strictEqual(response.headers["Access-Control-Allow-Origin"], undefined);
    assert.strictEqual(verified, false);
  });

  await test("malformed requests and client uid fields are rejected", async () => {
    const handler = createHandler(deps());
    assert.strictEqual((await handler(event({ body: "{" }))).statusCode, 400);
    const withUid = JSON.stringify({ imageDataUrl: pngDataUrl(), uid: "attacker" });
    const response = await handler(event({ body: withUid }));
    assert.strictEqual(response.statusCode, 400);
    assert.strictEqual(bodyOf(response).error, "unknown_field");
  });

  await test("oversized request bodies and decoded images return 400", async () => {
    const handler = createHandler(deps());
    let response = await handler(event({ body: "x".repeat(MAX_BODY_BYTES + 1) }));
    assert.strictEqual(response.statusCode, 400);
    assert.strictEqual(bodyOf(response).error, "request_too_large");
    const overTwoMiB = pngDataUrl(2 * 1024 * 1024);
    response = await handler(event({ body: JSON.stringify({ imageDataUrl: overTwoMiB }) }));
    assert.strictEqual(response.statusCode, 400);
    assert.strictEqual(bodyOf(response).error, "image_too_large");
  });

  await test("invalid image signatures return 400 without provider use", async () => {
    let called = false;
    const handler = createHandler(deps({ callVision: async () => { called = true; } }));
    const bad = `data:image/png;base64,${Buffer.alloc(100).toString("base64")}`;
    const response = await handler(event({ body: JSON.stringify({ imageDataUrl: bad }) }));
    assert.strictEqual(response.statusCode, 400);
    assert.strictEqual(called, false);
  });

  await test("provider failures and malformed provider output are sanitized", async () => {
    for (const code of ["qwen_vision_provider_error", "qwen_vision_invalid_output"]) {
      const handler = createHandler(deps({ callVision: async () => { throw new QwenVisionError(code, { status: 500 }); } }));
      const response = await handler(event());
      assert.strictEqual(response.statusCode, 502);
      assert.deepStrictEqual(bodyOf(response), { ok: false, error: "expense_receipt_ai_upstream_error" });
      assert.ok(!response.body.includes(SECRET));
    }
  });

  await test("valid Owner extraction returns suggestions only and uses the separate model", async () => {
    let args;
    let daily;
    const handler = createHandler(deps({
      checkDaily: async (...values) => { daily = values; return { allowed: true }; },
      callVision: async (value) => { args = value; return suggestions(); },
    }));
    const response = await handler(event());
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(bodyOf(response), { ok: true, suggestions: suggestions() });
    assert.strictEqual(args.model, "qwen3.7-plus-2026-05-26");
    assert.strictEqual(args.apiKey, SECRET);
    assert.strictEqual(daily[1], OWNER_UID);
    assert.strictEqual(daily[2].collectionName, DAILY_COLLECTION);
    assert.strictEqual(daily[2].limit, 10);
    assert.strictEqual(daily[2].now.toISOString(), "2026-08-20T04:00:00.000Z");
  });

  await test("the sole operational write is atomic quota metadata at verifiedUid_serverUtcDate", async () => {
    const observed = { transactionRuns: 0, sets: [] };
    const ref = { rateLimitRef: true };
    const db = {
      collection(name) {
        observed.collectionName = name;
        return {
          doc(id) {
            observed.documentId = id;
            return ref;
          },
        };
      },
      async runTransaction(callback) {
        observed.transactionRuns++;
        return callback({
          get: async (actualRef) => {
            assert.strictEqual(actualRef, ref);
            return { exists: false };
          },
          set: (...args) => observed.sets.push(args),
        });
      },
    };
    const serverNow = new Date("2026-08-20T23:59:59.000Z");
    const result = await checkAndIncrementDailyUsage(db, OWNER_UID, {
      now: serverNow,
      limit: 10,
      collectionName: DAILY_COLLECTION,
    });

    assert.strictEqual(result.allowed, true);
    assert.strictEqual(observed.transactionRuns, 1);
    assert.strictEqual(observed.collectionName, "ai_usage_expense_receipt");
    assert.strictEqual(observed.documentId, `${OWNER_UID}_2026-08-20`);
    assert.strictEqual(observed.sets.length, 1);
    assert.strictEqual(observed.sets[0][0], ref);
    assert.deepStrictEqual(observed.sets[0][1], {
      uid: OWNER_UID,
      day: "2026-08-20",
      count: 1,
      updatedAt: serverNow.toISOString(),
    });
    assert.deepStrictEqual(observed.sets[0][2], { merge: true });
    assert.deepStrictEqual(Object.keys(observed.sets[0][1]).sort(), ["count", "day", "uid", "updatedAt"]);
    const persisted = JSON.stringify(observed.sets[0][1]);
    for (const forbidden of ["imageDataUrl", "merchantName", "totalAmount", "note", "tags", "suggestions", "expenseId"]) {
      assert.ok(!persisted.includes(forbidden));
    }
  });

  await test("burst and daily rate limits return 429 before provider use", async () => {
    let called = false;
    let handler = createHandler(deps({
      checkBurst: () => ({ allowed: false, retryAfterMs: 5000 }),
      callVision: async () => { called = true; },
    }));
    let response = await handler(event());
    assert.strictEqual(response.statusCode, 429);
    assert.strictEqual(response.headers["Retry-After"], "5");
    handler = createHandler(deps({
      checkDaily: async () => ({ allowed: false, limit: 10 }),
      callVision: async () => { called = true; },
    }));
    response = await handler(event());
    assert.strictEqual(response.statusCode, 429);
    assert.strictEqual(bodyOf(response).scope, "daily");
    assert.strictEqual(called, false);
  });

  await test("secrets are absent from errors and from browser-published source", async () => {
    const handler = createHandler(deps({ callVision: async () => { throw new Error(SECRET); } }));
    const response = await handler(event());
    assert.strictEqual(response.statusCode, 500);
    assert.ok(!response.body.includes(SECRET));
    const buildSite = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "scripts", "build-site.js"), "utf8");
    const allowlistCode = buildSite.slice(buildSite.indexOf("const ALLOW_FILES"), buildSite.indexOf("// NOT copied"));
    assert.ok(!/["']netlify(?:\/|["'])/.test(allowlistCode));
  });

  await test("production wiring permits only rate-limit metadata, never Expense/receipt/content or Storage writes", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "..", "expense-receipt-ai.js"), "utf8");
    const executable = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    assert.match(source, /verifyIdToken\(token, true\)/);
    assert.match(source, /checkDaily:\s*checkAndIncrementDailyUsage/);
    assert.match(source, /const DAILY_COLLECTION = ["']ai_usage_expense_receipt["']/);
    assert.deepStrictEqual(
      [...executable.matchAll(/\.collection\(["']([^"']+)["']\)/g)].map((match) => match[1]),
      ["users"],
      "the entry point may directly read users/{verifiedUid}; quota mutation stays isolated in the reviewed helper",
    );
    assert.ok(!/\.(?:add|create|set|update|delete|runTransaction)\s*\(/.test(executable));
    assert.ok(!/collection\(["']expenses["']\)/.test(executable));
    assert.ok(!/firebase-admin\/storage/.test(executable));
    assert.ok(!/\.bucket\(/.test(executable));
    assert.ok(!/\bQWEN_MODEL\b/.test(executable));
    assert.match(source, /no Expense, receipt, or user-content Firestore writes; operational\s+\/\/ rate-limit metadata write is allowed/);
  });

  await test("Expense Receipt keeps the reviewed 5-per-60s burst and 10-per-day quota contract", () => {
    assert.strictEqual(BURST_LIMIT, 5);
    assert.strictEqual(BURST_WINDOW_MS, 60_000);
    assert.strictEqual(DAILY_COLLECTION, "ai_usage_expense_receipt");
    const source = fs.readFileSync(path.resolve(__dirname, "..", "expense-receipt-ai.js"), "utf8");
    assert.match(source, /const DAILY_LIMIT = 10;/);
    assert.match(source, /checkBurst\(`\$\{BURST_KEY_PREFIX\}\$\{decoded\.uid\}`/);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

run().catch((err) => {
  console.error("[expense-receipt-ai.test.js] unexpected failure:", err);
  process.exitCode = 1;
});
