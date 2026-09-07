import assert from "node:assert";
import { JSDOM } from "jsdom";
import { createExpenseRowElement } from "../expense-render.js";

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

await test("hostile merchant/note and tag text cannot create executable DOM", () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const hostileNote = '<img src=x onerror="globalThis.pwned=true"><script>globalThis.pwned=true</script>';
  const hostileTag = '</span><script>alert("tag")</script>';
  const row = createExpenseRowElement(dom.window.document, {
    expense: { note: hostileNote, tags: [hostileTag] },
    categoryMeta: { bg: "bg-safe", text: "text-safe", border: "border-safe" },
    categoryLabel: "Food",
    formattedDate: "20 Aug 2026",
    amountLabel: "RM 12.30",
    editTitle: "Edit metadata",
  });
  dom.window.document.body.append(row);

  assert.strictEqual(row.querySelector("script"), null);
  assert.strictEqual(row.querySelector("img"), null);
  assert.ok(row.textContent.includes(hostileNote));
  assert.ok(row.textContent.includes(`#${hostileTag}`));
  assert.ok(row.innerHTML.includes("&lt;script&gt;"));
  assert.strictEqual(dom.window.pwned, undefined);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
