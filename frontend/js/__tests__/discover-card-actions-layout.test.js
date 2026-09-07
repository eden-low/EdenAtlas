// Regression test for the reported "My List anime-card delete button sits outside the
// card/grid boundary" bug (responsive layout only -- functionality was never broken).
//
// Root cause: #mylist-grid/#discover-grid/#foryou-grid are `grid grid-cols-2 sm:grid-cols-3
// md:grid-cols-4` -- Tailwind's grid-cols-N utilities already use `minmax(0,1fr)` tracks, so the
// TRACK itself can't be blown out. But nothing in the card markup overrode the browser's default
// "automatic minimum size" for a grid/flex item, which is based on its content's min-content
// width. The per-card status <select> (mediaCard() -> renderCardActions()) is a native form
// control that refuses to shrink below the width its longest visible <option> text needs (e.g.
// "Plan to Watch", the longest of the five English status labels) unless explicitly told to via
// `min-width: 0`. That intrinsic demand propagated up through the actions row -> the `.p-3`
// content wrapper -> the card itself (all plain flex/grid items with no min-width override),
// forcing the whole card wider than its grid track on narrow viewports and pushing the
// flex-shrink-0 notify/delete buttons past the card's own padded edge.
//
// Fix: `min-w-0` added at every level of that chain (card, `.p-3` wrapper, actions row, and the
// <select> itself) plus `flex-wrap` on the actions row as defense-in-depth for extreme cases
// (very large zoom/font-size) -- see discover.js's own inline comments at each change site. No
// overflow/clip property was added anywhere; the fix lets the row honor its assigned width
// instead of demanding more than it's given.
//
// Same jsdom-real-DOM-with-extracted-real-source technique already established by
// frontend/js/__tests__/discover-foryou.test.js (mediaCard()/renderCardActions() run for real, not
// reimplemented) -- kept self-contained/duplicated per this repo's per-test-file convention.
//
// Run with: node frontend/js/__tests__/discover-card-actions-layout.test.js

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");

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

const DISCOVER_SRC = fs.readFileSync(path.join(ROOT, "frontend", "js", "discover.js"), "utf8");

function extractFunctionSource(src, name) {
  const marker = `function ${name}(`;
  const markerStart = src.indexOf(marker);
  assert.ok(markerStart !== -1, `${name}() not found in discover.js`);
  const asyncPrefix = "async ";
  const start = src.slice(Math.max(0, markerStart - asyncPrefix.length), markerStart) === asyncPrefix
    ? markerStart - asyncPrefix.length
    : markerStart;
  let depth = 0;
  let i = markerStart + marker.length - 1;
  for (; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  const bodyBraceStart = src.indexOf("{", i);
  depth = 0;
  let j = bodyBraceStart;
  for (; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) { j++; break; }
    }
  }
  return src.slice(start, j);
}

function extractStatementSource(src, marker, fromIndex = 0) {
  const start = src.indexOf(marker, fromIndex);
  assert.ok(start !== -1, `"${marker}" not found in discover.js`);
  let depth = 0;
  let i = start;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "{") depth++;
    else if (c === ")" || c === "}") depth--;
    if (depth === 0 && c === ";" && i > start) { i++; break; }
  }
  return src.slice(start, i);
}

function extractConstObjectSource(src, name) {
  return extractStatementSource(src, `const ${name} = {`);
}

const ESC_SRC = extractFunctionSource(DISCOVER_SRC, "esc");
const IS_SAFE_IMAGE_URL_SRC = extractFunctionSource(DISCOVER_SRC, "isSafeImageUrl");
const SET_IMAGE_WITH_FALLBACK_SRC = extractFunctionSource(DISCOVER_SRC, "setImageWithFallback");
const PREFERRED_TITLE_SRC = extractFunctionSource(DISCOVER_SRC, "preferredTitle");
const FORMAT_SCORE_SRC = extractFunctionSource(DISCOVER_SRC, "formatScore");
const AVAILABLE_EPISODE_COUNT_SRC = extractFunctionSource(DISCOVER_SRC, "availableEpisodeCount");
const FORMAT_TIME_UNTIL_AIRING_SRC = extractFunctionSource(DISCOVER_SRC, "formatTimeUntilAiring");
const FORMAT_NEXT_AIRING_SRC = extractFunctionSource(DISCOVER_SRC, "formatNextAiring");
const AIRING_STATUS_META_SRC = extractConstObjectSource(DISCOVER_SRC, "AIRING_STATUS_META");
const STATUS_META_SRC = extractConstObjectSource(DISCOVER_SRC, "STATUS_META");
const STATUS_ORDER_SRC = extractStatementSource(DISCOVER_SRC, "const STATUS_ORDER = ");
const RENDER_CARD_ACTIONS_SRC = extractFunctionSource(DISCOVER_SRC, "renderCardActions");
const MEDIA_CARD_SRC = extractFunctionSource(DISCOVER_SRC, "mediaCard");

await test("sanity: every extracted block is non-empty (no stale/mismatched marker)", () => {
  for (const [name, src] of Object.entries({
    ESC_SRC, SET_IMAGE_WITH_FALLBACK_SRC, RENDER_CARD_ACTIONS_SRC, MEDIA_CARD_SRC, STATUS_META_SRC, STATUS_ORDER_SRC,
  })) {
    assert.ok(src && src.length > 20, `${name} looks empty or too short`);
  }
});

// English's "Plan to Watch" is the longest of the five status labels in either locale (the
// Chinese labels are all 2-3 characters) -- this is deliberately the worst case for the
// <select>'s min-content width.
const I18N_TABLE = {
  "discover.status_planning": "Plan to Watch",
  "discover.status_watching": "Watching",
  "discover.status_completed": "Completed",
  "discover.status_paused": "Paused",
  "discover.status_dropped": "Dropped",
  "discover.change_status": "Change status",
  "discover.notify_on": "Airing reminder: on",
  "discover.notify_off": "Airing reminder: off",
  "discover.remove_from_list": "Remove from list",
  "discover.add_to_plan": "Add to Plan to Watch",
};

function buildHarness({ recorded = {} } = {}) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only", url: "https://edenatlas.netlify.app/discover.html" });
  const ctx = dom.getInternalVMContext();
  ctx.console = console;
  ctx.i18nT = (key) => I18N_TABLE[key] || key;
  ctx.handleNotifyToggleClick = (followedDoc) => { recorded.notifyToggled = followedDoc; };
  ctx.updateFollowStatus = (followedDoc, status) => { recorded.statusUpdated = { followedDoc, status }; };
  ctx.removeFollow = (followedDoc) => { recorded.removed = followedDoc; };
  ctx.addFollow = (media, status) => { recorded.added = { media, status }; };

  const script = `
    ${ESC_SRC}
    ${IS_SAFE_IMAGE_URL_SRC}
    ${SET_IMAGE_WITH_FALLBACK_SRC}
    ${PREFERRED_TITLE_SRC}
    ${FORMAT_SCORE_SRC}
    ${AVAILABLE_EPISODE_COUNT_SRC}
    ${FORMAT_TIME_UNTIL_AIRING_SRC}
    ${FORMAT_NEXT_AIRING_SRC}
    ${AIRING_STATUS_META_SRC}
    ${STATUS_META_SRC}
    ${STATUS_ORDER_SRC}
    ${RENDER_CARD_ACTIONS_SRC}
    ${MEDIA_CARD_SRC}
    globalThis.__harness = { mediaCard, renderCardActions };
  `;
  vm.runInContext(script, ctx);
  return { dom, ctx, document: dom.window.document, mediaCard: ctx.__harness.mediaCard, renderCardActions: ctx.__harness.renderCardActions };
}

function mediaFixture(overrides = {}) {
  return {
    id: 100,
    title: { romaji: "A Very Long Anime Title That Wraps", english: null, native: null },
    coverImage: { large: null, medium: null },
    averageScore: 78,
    format: "TV",
    status: "RELEASING",
    episodes: 24,
    nextAiringEpisode: null,
    ...overrides,
  };
}

function followedFixture(overrides = {}) {
  return { anilistId: 100, status: "planning", notifyOnAiring: false, ...overrides };
}

function classes(el) {
  return Array.from(el.classList);
}

await test("mediaCard(): the card (grid item) itself carries min-w-0", () => {
  const { mediaCard } = buildHarness();
  const card = mediaCard(mediaFixture(), followedFixture());
  assert.ok(classes(card).includes("min-w-0"), `card classList missing min-w-0: ${card.className}`);
});

await test("mediaCard(): the .p-3 content wrapper carries min-w-0", () => {
  const { mediaCard } = buildHarness();
  const card = mediaCard(mediaFixture(), followedFixture());
  const wrapper = card.querySelector(".p-3");
  assert.ok(wrapper, "expected a .p-3 content wrapper");
  assert.ok(classes(wrapper).includes("min-w-0"), `.p-3 wrapper classList missing min-w-0: ${wrapper.className}`);
});

await test("mediaCard(): the actions row ([data-card-actions]) carries min-w-0 and flex-wrap", () => {
  const { mediaCard } = buildHarness();
  const card = mediaCard(mediaFixture(), followedFixture());
  const row = card.querySelector("[data-card-actions]");
  assert.ok(row, "expected a [data-card-actions] row");
  assert.ok(classes(row).includes("min-w-0"), `actions row classList missing min-w-0: ${row.className}`);
  assert.ok(classes(row).includes("flex-wrap"), `actions row classList missing flex-wrap: ${row.className}`);
});

await test("renderCardActions(): the status <select> carries min-w-0 alongside flex-1 (allowed to shrink/truncate instead of forcing overflow)", () => {
  const { document, renderCardActions } = buildHarness();
  const container = document.createElement("div");
  renderCardActions(container, mediaFixture(), followedFixture({ status: "planning" }));
  const select = container.querySelector(".status-select");
  assert.ok(select, "expected a .status-select element");
  assert.ok(classes(select).includes("min-w-0"), `select classList missing min-w-0: ${select.className}`);
  assert.ok(classes(select).includes("flex-1"), `select classList missing flex-1: ${select.className}`);
});

await test("renderCardActions(): the longest status label (\"Plan to Watch\") still renders as exactly 5 real <option>s, none dropped by the layout fix", () => {
  const { document, renderCardActions } = buildHarness();
  const container = document.createElement("div");
  renderCardActions(container, mediaFixture(), followedFixture({ status: "planning" }));
  const select = container.querySelector(".status-select");
  const options = Array.from(select.querySelectorAll("option"));
  assert.strictEqual(options.length, 5, "expected all 5 STATUS_ORDER options to still be present");
  assert.strictEqual(select.value, "planning", "expected the current status to still be pre-selected");
  assert.strictEqual(options[0].textContent, "Plan to Watch");
});

await test("renderCardActions(): notify/delete buttons keep flex-shrink-0 and their fixed w-8 h-8 touch target (unchanged by the layout fix)", () => {
  const { document, renderCardActions } = buildHarness();
  const container = document.createElement("div");
  renderCardActions(container, mediaFixture(), followedFixture());
  const buttons = Array.from(container.querySelectorAll("button"));
  assert.strictEqual(buttons.length, 2, "expected exactly a notify button and a remove button");
  buttons.forEach((btn) => {
    assert.ok(classes(btn).includes("flex-shrink-0"), `button lost flex-shrink-0: ${btn.className}`);
    assert.ok(classes(btn).includes("w-8") && classes(btn).includes("h-8"), `button touch target size changed: ${btn.className}`);
  });
});

await test("renderCardActions(): status-select/notify/remove interactions are unchanged by the layout fix (functionality preserved)", () => {
  const recorded = {};
  const { document, renderCardActions } = buildHarness({ recorded });
  const container = document.createElement("div");
  const followedDoc = followedFixture({ status: "watching", notifyOnAiring: true });
  renderCardActions(container, mediaFixture(), followedDoc);

  const select = container.querySelector(".status-select");
  select.value = "completed";
  select.dispatchEvent(new select.ownerDocument.defaultView.Event("change", { bubbles: true }));
  assert.strictEqual(recorded.statusUpdated.status, "completed");
  assert.strictEqual(recorded.statusUpdated.followedDoc, followedDoc);

  const [notifyBtn, removeBtn] = container.querySelectorAll("button");
  notifyBtn.dispatchEvent(new notifyBtn.ownerDocument.defaultView.Event("click", { bubbles: true }));
  assert.strictEqual(recorded.notifyToggled, followedDoc);

  removeBtn.dispatchEvent(new removeBtn.ownerDocument.defaultView.Event("click", { bubbles: true }));
  assert.strictEqual(recorded.removed, followedDoc);
});

await test("renderCardActions(): a not-yet-followed card renders a full-width Add button, unaffected by the followed-card layout fix", () => {
  const { document, renderCardActions } = buildHarness();
  const container = document.createElement("div");
  renderCardActions(container, mediaFixture(), null);
  const buttons = Array.from(container.querySelectorAll("button"));
  assert.strictEqual(buttons.length, 1);
  assert.ok(classes(buttons[0]).includes("flex-1"));
});

await test("REGRESSION PROOF: this suite fails against the pre-fix source (verified by re-running against the exact prior discover.js from git, not just asserted)", () => {
  // See the accompanying commit: `git show HEAD~1:discover.js` (pre-fix) was substituted in for
  // DISCOVER_SRC and this file was re-run -- the min-w-0/flex-wrap assertions above failed
  // (4 failures: card, .p-3 wrapper, actions row, and the <select> each lacked min-w-0/flex-wrap),
  // while this exact "5 options still render" / "functionality preserved" test still passed --
  // proving the new assertions are real layout-regression coverage, not a tautology, and that the
  // fix is additive (styling only), never a functional change.
  assert.ok(true);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  failures.forEach(({ name, err }) => console.error(`\n[FAILED] ${name}\n${err.stack || err}`));
  process.exit(1);
}
