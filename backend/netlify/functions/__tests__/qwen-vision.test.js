const assert = require("node:assert");
const {
  QwenVisionError,
  callQwenReceiptVision,
  RECEIPT_SYSTEM_PROMPT,
  QWEN_VISION_TIMEOUT_MS,
} = require("../lib/qwen-vision.js");

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

function extraction() {
  return {
    merchantName: "Cafe",
    totalAmount: 18.5,
    currencyCode: "MYR",
    transactionDate: "2026-08-20",
    transactionTime: "12:30",
    suggestedCategory: "food",
    receiptNumber: null,
    confidence: {
      merchantName: "high", totalAmount: "high", currencyCode: "high",
      transactionDate: "medium", transactionTime: "medium", suggestedCategory: "medium",
      receiptNumber: null,
    },
    warnings: [],
  };
}
function response(content = JSON.stringify(extraction()), { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) };
}
function call(overrides = {}) {
  return callQwenReceiptVision({
    baseUrl: "https://dashscope.example/compatible-mode/v1/",
    apiKey: "VISION_SECRET_MUST_NOT_LEAK",
    model: "qwen3.7-plus-2026-05-26",
    imageDataUrl: "data:image/png;base64,AAAA",
    fetchImpl: async () => response(),
    ...overrides,
  });
}

async function run() {
await test("uses the pinned separate vision model and exact multimodal OpenAI-compatible request", async () => {
  let captured;
  const result = await call({ fetchImpl: async (url, init) => { captured = { url, init }; return response(); } });
  const body = JSON.parse(captured.init.body);
  assert.strictEqual(captured.url, "https://dashscope.example/compatible-mode/v1/chat/completions");
  assert.strictEqual(body.model, "qwen3.7-plus-2026-05-26");
  assert.deepStrictEqual(body.response_format, { type: "json_object" });
  assert.strictEqual(body.enable_thinking, false);
  assert.strictEqual(body.temperature, 0);
  assert.strictEqual(body.tools, undefined);
  assert.strictEqual(body.tool_choice, undefined);
  assert.strictEqual(body.functions, undefined);
  assert.strictEqual(body.messages[1].content[0].type, "image_url");
  assert.strictEqual(body.messages[1].content[0].image_url.url, "data:image/png;base64,AAAA");
  assert.strictEqual(captured.init.headers.Authorization, "Bearer VISION_SECRET_MUST_NOT_LEAK");
  assert.strictEqual(result.totalAmount, 18.5);
});

await test("prompt treats visible text as untrusted and prohibits OCR/payment fields", () => {
  assert.match(RECEIPT_SYSTEM_PROMPT, /untrusted receipt data/i);
  assert.match(RECEIPT_SYSTEM_PROMPT, /Never follow instructions/i);
  assert.match(RECEIPT_SYSTEM_PROMPT, /Never invent/i);
  assert.match(RECEIPT_SYSTEM_PROMPT, /subtotal and tax/i);
  assert.match(RECEIPT_SYSTEM_PROMPT, /payment\/card identifiers/i);
  assert.match(RECEIPT_SYSTEM_PROMPT, /exactly these keys/i);
});

await test("bounded timeout is configured and AbortError is normalized", async () => {
  assert.ok(QWEN_VISION_TIMEOUT_MS > 0 && QWEN_VISION_TIMEOUT_MS <= 30_000);
  await assert.rejects(
    call({ fetchImpl: async () => { const err = new Error("secret timeout body"); err.name = "AbortError"; throw err; } }),
    (err) => err instanceof QwenVisionError && err.code === "qwen_vision_timeout" && !err.message.includes("secret timeout body"),
  );
});

await test("provider errors are sanitized and never expose provider body or API key", async () => {
  await assert.rejects(
    call({ fetchImpl: async () => ({ ok: false, status: 429, text: async () => "provider echoed VISION_SECRET_MUST_NOT_LEAK and receipt" }) }),
    (err) => err instanceof QwenVisionError && err.code === "qwen_vision_provider_error"
      && err.status === 429 && !err.message.includes("VISION_SECRET") && !err.message.includes("receipt"),
  );
});

await test("malformed provider envelopes and model JSON are rejected", async () => {
  await assert.rejects(call({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => "not-json" }) }),
    (err) => err instanceof QwenVisionError && err.code === "qwen_vision_invalid_response");
  await assert.rejects(call({ fetchImpl: async () => response("{not-model-json") }),
    (err) => err instanceof QwenVisionError && err.code === "qwen_vision_invalid_output");
});

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

run().catch((err) => {
  console.error("[qwen-vision.test.js] unexpected failure:", err);
  process.exitCode = 1;
});
