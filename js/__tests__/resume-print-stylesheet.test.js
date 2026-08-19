// Regression test for the "recruiter-PDF print QA" pass on resume.html's @media print
// stylesheet (styles.css). Manual QA against a real Chrome print-to-PDF export of resume.html
// found 7 real defects; this test locks in the structural shape of each fix. Same convention
// js/__tests__/auth-pulse-scope.test.js already established -- a structural check on the real
// styles.css text (this repo has no CSS-parser/computed-style test infrastructure), not a live
// browser render. A real Chrome headless --print-to-pdf + pdftotext verification was also
// performed manually against an offline (no-Firebase) fixture during this pass -- see the PR
// description / completion report for that evidence; it's not re-runnable here since it needs a
// real Chrome binary at a specific path, which isn't a portable CI dependency.
//
// Run with: node js/__tests__/resume-print-stylesheet.test.js (or `npm run test:frontend`).

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const STYLES = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");

let pass = 0;
let fail = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, err });
    console.log(`FAIL  - ${name}`);
    console.log(`        ${err.message}`);
  }
}

// Same brace-balanced block extractor js/__tests__/auth-pulse-scope.test.js already established.
function extractRuleBlock(css, selector, fromIndex = 0) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{", "g");
  re.lastIndex = fromIndex;
  const match = re.exec(css);
  if (!match) return null;
  const braceStart = match.index + match[0].length - 1;
  let depth = 0;
  let i = braceStart;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return { block: css.slice(braceStart, i), fullMatch: css.slice(match.index, i), endIndex: i };
}

// Same idea as extractRuleBlock, but takes a raw regex source (no auto-escaping) for selectors
// that legitimately span multiple lines/whitespace in the real file (e.g. "html,\n  body {").
function extractRuleBlockByPattern(css, patternSource, fromIndex = 0) {
  const re = new RegExp(patternSource, "g");
  re.lastIndex = fromIndex;
  const match = re.exec(css);
  if (!match) return null;
  const braceStart = match.index + match[0].length - 1;
  let depth = 0;
  let i = braceStart;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return { block: css.slice(braceStart, i), fullMatch: css.slice(match.index, i), endIndex: i };
}

// Extracts the ENTIRE @media print { ... } block (brace-balanced), so every assertion below can
// confirm its target rule lives inside print media specifically, not merely somewhere in the file.
function extractMediaPrintBlock(css) {
  const marker = "@media print {";
  const start = css.indexOf(marker);
  assert.ok(start !== -1, "@media print block not found in styles.css");
  const braceStart = start + marker.length - 1;
  let depth = 0;
  let i = braceStart;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return css.slice(braceStart + 1, i - 1);
}

const PRINT = extractMediaPrintBlock(STYLES);

await test("sanity: styles.css has balanced braces (a malformed @media print edit would desync every rule after it)", () => {
  const open = (STYLES.match(/{/g) || []).length;
  const close = (STYLES.match(/}/g) || []).length;
  assert.strictEqual(open, close, `brace mismatch: ${open} '{' vs ${close} '}'`);
});

await test("@page sets A4 size with a real margin", () => {
  const rule = extractRuleBlock(PRINT, "@page");
  assert.ok(rule, "@page rule not found inside @media print");
  assert.match(rule.block, /size\s*:\s*A4\s*;/);
  assert.match(rule.block, /margin\s*:\s*\d+mm\s*;/);
});

// ---- Fix 2/3: the non-Production env banner (inline-styled position:fixed, not a class) ----

await test("[fix 2/3] #eden-env-banner (js/environment.js's inline-styled position:fixed banner) is hidden in print", () => {
  assert.match(
    PRINT,
    /#eden-env-banner\s*,/,
    "expected #eden-env-banner in the app-chrome display:none hide-list inside @media print"
  );
  // Confirm the hide-list rule this selector belongs to actually forces display:none !important --
  // required to beat the banner's own inline style.cssText, which carries no !important of its own.
  const idx = PRINT.indexOf("#eden-env-banner");
  const after = PRINT.slice(idx, idx + 600);
  assert.match(after, /display\s*:\s*none\s*!important/, "the hide-list block must use !important to beat the banner's inline style");
});

// ---- Fix 4: best-effort Netlify Deploy-Preview toolbar hide (documented as unreliable) ----

await test("[fix 4] a best-effort Netlify Deploy-Preview toolbar hide exists (documented in-file as unreliable -- see the surrounding comment)", () => {
  assert.match(PRINT, /netlify-toolbar/i);
  assert.match(STYLES, /Netlify's Deploy-Preview toolbar[\s\S]{0,400}not by any file in this repository/i, "expected the documented-unreliable caveat comment near the print block");
});

// ---- Fix 1: min-h-screen (min-height:100vh) blank-page bug ----

await test("[fix 1] html and body reset height:auto and min-height:0 in print -- the root cause of the reported 4-page blank-space bug (body's screen-only min-h-screen utility)", () => {
  const rule = extractRuleBlockByPattern(PRINT, "html,\\s*body\\s*\\{");
  assert.ok(rule, "expected a combined html, body rule inside @media print resetting height");
  assert.match(rule.block, /height\s*:\s*auto\s*!important/);
  assert.match(rule.block, /min-height\s*:\s*0\s*!important/);
});

// ---- Fix 7: backdrop-filter vs -webkit-backdrop-filter (the actual rasterization/no-text bug) ----

await test("[fix 7] #career-main and every descendant neutralize BOTH backdrop-filter and -webkit-backdrop-filter (the prefixed property is a separate leftover the prior print rule never touched, and was the real cause of unselectable/rasterized PDF text)", () => {
  const rule = extractRuleBlockByPattern(PRINT, "#career-main,\\s*#career-main \\*\\s*\\{");
  assert.ok(rule, "expected a #career-main, #career-main * universal-descendant reset rule inside @media print");
  assert.match(rule.block, /backdrop-filter\s*:\s*none\s*!important/);
  assert.match(rule.block, /-webkit-backdrop-filter\s*:\s*none\s*!important/);
  assert.match(rule.block, /filter\s*:\s*none\s*!important/);
  assert.match(rule.block, /transform\s*:\s*none\s*!important/);
});

await test("[fix 7 regression guard] the OLD rule shape (backdrop-filter neutralized only on <section>, never -webkit-backdrop-filter) is no longer the only place backdrop-filter is reset", () => {
  // The original #career-main section rule may still exist (harmless overlap), but it must not be
  // the ONLY neutralization -- there must be a broader descendant-level reset that also covers
  // -webkit-backdrop-filter, which #career-main section alone never did.
  const sectionRule = extractRuleBlock(PRINT, "#career-main section");
  if (sectionRule) {
    assert.ok(
      !/-webkit-backdrop-filter/.test(sectionRule.block) || PRINT.includes("-webkit-backdrop-filter"),
      "expected -webkit-backdrop-filter to be neutralized somewhere in print"
    );
  }
  assert.match(PRINT, /-webkit-backdrop-filter\s*:\s*none\s*!important/);
});

// ---- Fix 6: hide genuinely-empty sections via :has() on their own -empty placeholder ----

await test("[fix 6] Experience/Projects/Certificates/Awards sections are hidden outright in print when their own -empty placeholder is visible (not carrying .hidden)", () => {
  const pairs = [
    ["#experience", "#experience-empty"],
    ["#projects", "#projects-empty"],
    ["#certificates", "#certificates-empty"],
    ["#inventory", "#awards-empty"],
  ];
  pairs.forEach(([sectionId, emptyId]) => {
    const re = new RegExp(`${sectionId}:has\\(${emptyId}:not\\(\\.hidden\\)\\)`);
    assert.match(PRINT, re, `expected ${sectionId}:has(${emptyId}:not(.hidden)) in @media print`);
  });
  // Every one of those selectors must resolve to display:none !important.
  const idx = PRINT.search(/#experience:has\(#experience-empty:not\(\.hidden\)\)/);
  assert.ok(idx !== -1);
  assert.match(PRINT.slice(idx, idx + 400), /display\s*:\s*none\s*!important/);
});

// ---- Fixed-height project cover placeholder (a <div>, not an <img>, so an img-only selector missed it) ----

await test("the no-cover-image project placeholder (a fixed h-36 <div>, not an <img>) is hidden in print, not just the real <img> path", () => {
  assert.match(PRINT, /#projects-list\s*\[class\*="h-36"\]/, 'expected an attribute-substring selector catching the h-36 utility class on non-<img> elements too');
});

// ---- break-inside:avoid-page scoped to entries, never to whole sections ----

await test("break-inside uses the modern avoid-page value (not just legacy avoid) on individual entry cards", () => {
  assert.match(PRINT, /break-inside\s*:\s*avoid-page\s*;/);
});

await test("break-inside/page-break-inside is never applied to the whole #career-main section rule itself (would risk forcing large blank-page-inducing breaks -- the exact thing this pass fixed)", () => {
  const rule = extractRuleBlock(PRINT, "#career-main section");
  assert.ok(rule, "#career-main section rule not found");
  assert.ok(!/break-inside/.test(rule.block), `#career-main section must not carry break-inside. Found:\n${rule.block}`);
  assert.ok(!/page-break-inside/.test(rule.block), `#career-main section must not carry page-break-inside. Found:\n${rule.block}`);
});

// ---- Loading placeholders must never reach paper ----

await test(".skeleton placeholders are hidden inside #career-main in print (in case a print is triggered mid-fetch)", () => {
  assert.match(PRINT, /#career-main \.skeleton\s*\{\s*\n\s*display\s*:\s*none\s*!important/);
});

// ---- Text must stay recruiter-readable -- headings/body text sizes were never shrunk by this pass ----

await test("heading font-size stays at the pre-existing 13pt/20pt values -- this pass tightened SPACING only, never shrank text below the pre-existing readable sizes", () => {
  const heading = extractRuleBlock(PRINT, "#career-main section h1");
  assert.ok(heading);
  assert.match(heading.block, /font-size\s*:\s*13pt\s*!important/);
  const nameHeading = extractRuleBlock(PRINT, "#career-main #profile h1");
  assert.ok(nameHeading);
  assert.match(nameHeading.block, /font-size\s*:\s*20pt\s*!important/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  failures.forEach(({ name, err }) => console.error(`\nFAIL: ${name}\n${err.stack || err.message}`));
  process.exit(1);
}
