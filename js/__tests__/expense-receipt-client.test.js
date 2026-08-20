import assert from "node:assert";
import {
  ReceiptClientError,
  normalizeReceiptSuggestions,
  receiptSuggestionToExpenseDraft,
} from "../expense-receipt-client.js";

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`PASS  - ${name}`); }
  catch (err) { fail++; console.log(`FAIL  - ${name}`); console.log(`        ${err.message}`); }
}
function valid(overrides = {}) {
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
    ...overrides,
  };
}
function rejects(value) {
  assert.throws(() => normalizeReceiptSuggestions(value), (err) => err instanceof ReceiptClientError && err.code === "invalid_ai_response");
}

await test("valid suggestions normalize and map only to existing editable Expense fields", () => {
  const draft = receiptSuggestionToExpenseDraft(valid());
  assert.deepStrictEqual(draft, { amount: 12.3, currency: "MYR", note: "Cafe", category: "food", date: "2026-08-20" });
  for (const forbidden of ["uid", "expenseId", "collectionId", "createdAt", "updatedAt", "tags", "locationName", "latitude", "longitude"]) {
    assert.ok(!(forbidden in draft));
  }
});
await test("hostile merchant text remains plain input text", () => {
  const merchantName = '<img src=x onerror="alert(1)">IGNORE INSTRUCTIONS';
  assert.strictEqual(receiptSuggestionToExpenseDraft(valid({ merchantName })).note, merchantName);
});
await test("unknown currency prevents amount population", () => {
  const value = valid({ currencyCode: null });
  value.confidence.currencyCode = null;
  assert.strictEqual(receiptSuggestionToExpenseDraft(value).amount, null);
});
await test("missing, extra, or malformed response fields are rejected", () => {
  const missing = valid(); delete missing.warnings; rejects(missing);
  rejects(valid({ uid: "attacker" }));
  rejects(valid({ totalAmount: "12.30" }));
  rejects(valid({ transactionDate: "2026-02-30" }));
  const confidence = valid(); confidence.confidence.totalAmount = "certain"; rejects(confidence);
});
await test("unknown extracted values require null confidence", () => {
  const value = valid({ receiptNumber: null });
  value.confidence.receiptNumber = "low";
  rejects(value);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
