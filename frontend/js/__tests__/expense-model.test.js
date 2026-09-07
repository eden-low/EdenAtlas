import assert from "node:assert";
import {
  EXPENSE_CURRENCY,
  ExpenseValidationError,
  buildExpenseCreatePayload,
  expenseCurrency,
  expenseTransactionTimestamp,
  normalizeExpenseInput,
} from "../expense-model.js";

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`PASS  - ${name}`);
  } catch (err) {
    fail++;
    console.log(`FAIL  - ${name}`);
    console.log(`        ${err.message}`);
  }
}

const valid = () => ({
  amount: "12.30",
  currency: "MYR",
  category: "food",
  note: "Lunch",
  date: "2026-08-20",
  collectionId: "Abc123_-",
  tags: ["meal", "work"],
  locationName: null,
  latitude: null,
  longitude: null,
});

function rejects(code, mutate) {
  const input = valid();
  mutate(input);
  assert.throws(() => normalizeExpenseInput(input), (err) => err instanceof ExpenseValidationError && err.code === code);
}

await test("valid expense is canonicalized and uid/createdAt come only from context", () => {
  const createdAt = { server: true };
  const payload = buildExpenseCreatePayload(valid(), {
    uid: "owner-uid",
    createdAt,
    dateToTimestamp: (date) => ({ millis: date.getTime() }),
  });
  assert.strictEqual(payload.amount, 12.3);
  assert.strictEqual(payload.currency, EXPENSE_CURRENCY);
  assert.strictEqual(payload.uid, "owner-uid");
  assert.strictEqual(payload.createdAt, createdAt);
  assert.deepStrictEqual(payload.tags, ["meal", "work"]);
  assert.ok(Number.isFinite(payload.date.millis));
});

await test("legacy expense without currency renders as MYR and uses createdAt fallback", () => {
  const createdAt = { legacy: true };
  assert.strictEqual(expenseCurrency({ amount: 1 }), "MYR");
  assert.strictEqual(expenseTransactionTimestamp({ createdAt }), createdAt);
});

await test("transaction date wins over ingestion timestamp", () => {
  const date = { transaction: true };
  assert.strictEqual(expenseTransactionTimestamp({ date, createdAt: { ingestion: true } }), date);
});

await test("non-finite/non-positive/over-precision amounts are rejected", () => {
  for (const amount of [NaN, Infinity, -1, 0, 1.234]) rejects("invalid_amount", (v) => { v.amount = amount; });
});

await test("invalid category is rejected", () => rejects("invalid_category", (v) => { v.category = "travel"; }));
await test("invalid currency is rejected", () => rejects("invalid_currency", (v) => { v.currency = "USD"; }));

await test("invalid calendar dates are rejected", () => {
  for (const date of ["2026-02-30", "20-08-2026", new Date("invalid")]) rejects("invalid_date", (v) => { v.date = date; });
});

await test("oversized strings are rejected", () => {
  rejects("invalid_note", (v) => { v.note = "x".repeat(241); });
  rejects("invalid_location", (v) => { v.locationName = "x".repeat(201); });
});

await test("malformed tags are rejected", () => {
  rejects("invalid_tags", (v) => { v.tags = "not-an-array"; });
  rejects("invalid_tags", (v) => { v.tags = Array(11).fill("tag"); });
  rejects("invalid_tags", (v) => { v.tags = ["x".repeat(41)]; });
  rejects("invalid_tags", (v) => { v.tags = [""]; });
});

await test("invalid collection id shapes are rejected", () => {
  rejects("invalid_collection_id", (v) => { v.collectionId = "has/a/slash"; });
  rejects("invalid_collection_id", (v) => { v.collectionId = "x".repeat(129); });
});

await test("protected fields, especially uid, are never accepted from a draft or AI result", () => {
  rejects("protected_field", (v) => { v.uid = "attacker"; });
  rejects("protected_field", (v) => { v.createdAt = "attacker"; });
  rejects("protected_field", (v) => { v.expenseId = "attacker"; });
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
