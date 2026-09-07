import assert from "node:assert";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../../pages/expenses.html", import.meta.url), "utf8");
const source = fs.readFileSync(new URL("../expenses.js", import.meta.url), "utf8");
const en = JSON.parse(fs.readFileSync(new URL("../../locales/en.json", import.meta.url), "utf8"));
const zh = JSON.parse(fs.readFileSync(new URL("../../locales/zh-CN.json", import.meta.url), "utf8"));
let pass = 0;
let fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`PASS  - ${name}`); }
  catch (err) { fail++; console.log(`FAIL  - ${name}`); console.log(`        ${err.message}`); }
}

await test("one-image input and explicit Qwen disclosure live inside the existing Expense form", () => {
  assert.strictEqual((html.match(/id="expense-form"/g) || []).length, 1);
  assert.match(html, /id="expense-receipt-file"[^>]*accept="image\/jpeg,image\/png,image\/webp"/);
  assert.ok(!/id="expense-receipt-file"[^>]*\bmultiple\b/.test(html));
  assert.match(html, /sent temporarily to Qwen/i);
  assert.match(html, /id="expense-receipt-extract"[^>]*type="button"/);
  assert.match(html, /id="expense-save-btn"[^>]*type="submit"/);
});

await test("AI calls the isolated endpoint and only the normal form submit writes an Expense", () => {
  assert.ok(source.includes('const RECEIPT_AI_ENDPOINT = "/.netlify/functions/expense-receipt-ai"'));
  assert.ok(source.includes("receiptSuggestionToExpenseDraft"));
  assert.strictEqual((source.match(/addDoc\(collection\(db, "expenses"\)/g) || []).length, 1);
  assert.ok(source.includes('expenseForm.addEventListener("submit"'));
  assert.ok(source.includes('receiptExtractBtn.addEventListener("click"'));
  assert.ok(!source.includes("firebase-storage"));
});

await test("normal Save still passes through the canonical validator after AI population", () => {
  const submitStart = source.indexOf('expenseForm.addEventListener("submit"');
  const editStart = source.indexOf("// ---- Edit metadata ----");
  const submitBlock = source.slice(submitStart, editStart);
  assert.ok(submitBlock.includes("buildExpenseCreatePayload"));
  assert.ok(submitBlock.includes("uid: user.uid"));
  assert.ok(submitBlock.includes("createdAt: serverTimestamp()"));
  assert.ok(!submitBlock.includes("suggestions.uid"));
});

await test("English and Chinese Finance dictionaries expose the same Screenshot AI keys", () => {
  const aiKeys = (dict) => Object.keys(dict.finance).filter((key) => key.startsWith("receipt_ai_")).sort();
  assert.deepStrictEqual(aiKeys(en), aiKeys(zh));
  assert.ok(aiKeys(en).length >= 20);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
