// Regression test for the "EdenAtlas Resume: 2026 internship update" pass.
//
// js/resume-data.js's EXPERIENCE[].dates changed shape from a bare preformatted string
// ("Jun 2026 – Present") to a bilingual { en, zh } object, so the résumé's date range can
// actually read "2026年6月 – 至今" when the page is switched to Chinese (previously it stayed
// English-only regardless of language, since nothing downstream ever translated it).
//
// That shape change has two real consumers, both duplicated-per-file per this repo's
// established convention (career.js's FALLBACK_EXPERIENCES / renderExperiences() render the
// résumé card; portfolio.js's experienceCard() renders the public portfolio's Experience card)
// — each needed updating to pick a language instead of interpolating the object directly, and
// each still has to keep working against a real Career-CMS Firestore doc's *plain string*
// dates (`${startDate} – ${endDate}`), which never changed shape. This test exercises the real
// extracted source of both files (same jsdom-real-DOM-with-extracted-real-source technique
// already established by frontend/js/__tests__/discover-card-actions-layout.test.js), not a
// reimplementation, so a future refactor that silently reintroduces "[object Object]" in either
// file's rendered date range is caught here.
//
// Run with: node frontend/js/__tests__/resume-experience-dates.test.js (or `npm run test:frontend`).

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

const { EXPERIENCE, RESUME_SKILLS } = await import("../resume-data.js");

const CAREER_SRC = fs.readFileSync(path.join(ROOT, "frontend", "js", "career.js"), "utf8");
const PORTFOLIO_SRC = fs.readFileSync(path.join(ROOT, "frontend", "js", "portfolio.js"), "utf8");

function extractFunctionSource(src, name, label) {
  const marker = `function ${name}(`;
  const markerStart = src.indexOf(marker);
  assert.ok(markerStart !== -1, `${name}() not found in ${label}`);
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
  return src.slice(markerStart, j);
}

// ==================== Part 1: data shape (js/resume-data.js is a pure module, safe to import) ====================

await test("EXPERIENCE[0].dates is a bilingual { en, zh } object, not a bare string", () => {
  assert.strictEqual(typeof EXPERIENCE[0].dates, "object");
  assert.strictEqual(EXPERIENCE[0].dates.en, "Jun 2026 – Present");
  assert.strictEqual(EXPERIENCE[0].dates.zh, "2026年6月 – 至今");
});

await test("the résumé's visible internship card carries at most 5 bullets", () => {
  assert.ok(EXPERIENCE[0].bullets.length <= 5, `expected <= 5 bullets, got ${EXPERIENCE[0].bullets.length}`);
  EXPERIENCE[0].bullets.forEach((b, idx) => {
    assert.ok(b.en && b.en.trim(), `bullet ${idx} missing English text`);
    assert.ok(b.zh && b.zh.trim(), `bullet ${idx} missing Chinese text`);
    assert.notStrictEqual(b.en.trim(), b.zh.trim(), `bullet ${idx}'s zh text looks untranslated (identical to en)`);
  });
});

await test("RESUME_SKILLS places the newly-added skills in the expected existing groups", () => {
  const byKey = Object.fromEntries(RESUME_SKILLS.map((g) => [g.labelKey, g.items]));
  const flat = (items) => items.map((it) => (typeof it === "string" ? it : it.en));

  assert.ok(flat(byKey["career.skills_programming"]).includes("TypeScript"));
  ["Vue.js", "Django REST Framework", "PostgreSQL", "Redis", "Celery", "MinIO"].forEach((s) => {
    assert.ok(flat(byKey["career.skills_platforms"]).includes(s), `skills_platforms missing ${s}`);
  });
  ["Docker", "Playwright", "API Testing", "Database Migration", "E2E Testing"].forEach((s) => {
    assert.ok(flat(byKey["career.skills_tools"]).includes(s), `skills_tools missing ${s}`);
  });
  // Git/GitHub were already present before this pass — confirm they weren't accidentally duplicated or dropped.
  assert.deepStrictEqual(
    flat(byKey["career.skills_tools"]).filter((s) => s === "Git" || s === "GitHub"),
    ["Git", "GitHub"]
  );
});

// ==================== Part 2: career.js résumé-card rendering ====================

function buildCareerHarness() {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <div id="experience-list"></div>
      <p id="experience-empty" class="hidden"></p>
      <button id="add-experience-btn" class="hidden"></button>
    </body></html>`,
    { runScripts: "outside-only", url: "https://edenatlas.netlify.app/resume.html" }
  );
  const ctx = dom.getInternalVMContext();
  ctx.console = console;
  let lang = "en";
  ctx.getLang = () => lang;
  ctx.i18nT = (key) => key;
  ctx.__setLang = (l) => { lang = l; };

  const ESC_SRC = extractFunctionSource(CAREER_SRC, "esc", "career.js");
  const OWNER_CONTROLS_SRC = extractFunctionSource(CAREER_SRC, "ownerControlsHTML", "career.js");
  const WIRE_OWNER_CONTROLS_SRC = extractFunctionSource(CAREER_SRC, "wireOwnerControls", "career.js");
  const RENDER_EXPERIENCES_SRC = extractFunctionSource(CAREER_SRC, "renderExperiences", "career.js");

  const biMatch = CAREER_SRC.match(/function bi\(obj, field\) \{[\s\S]*?\n\}/);
  assert.ok(biMatch, "bi() not found in career.js");
  const biBulletMatch = CAREER_SRC.match(/function biBullet\(b\) \{[\s\S]*?\n\}/);
  assert.ok(biBulletMatch, "biBullet() not found in career.js");

  const script = `
    let canEdit = false;
    let cachedExperiences = [];
    function openExperienceForm() {}
    ${ESC_SRC}
    ${biMatch[0]}
    ${biBulletMatch[0]}
    ${OWNER_CONTROLS_SRC}
    ${WIRE_OWNER_CONTROLS_SRC}
    ${RENDER_EXPERIENCES_SRC}
    globalThis.__harness = {
      renderExperiences,
      setCachedExperiences: (arr) => { cachedExperiences = arr; },
    };
  `;
  vm.runInContext(script, ctx);
  return { document: dom.window.document, ...ctx.__harness, setLang: ctx.__setLang };
}

// Mirrors career.js's own FALLBACK_EXPERIENCES mapping (career.js:329-340) exactly, so this test
// exercises the real integration shape, not a hand-picked fixture.
function toFallbackExperience(e) {
  return {
    id: "fallback-exp-" + (e.caseSlug || e.role.en),
    _fallback: true,
    role_en: e.role.en,
    role_zh: e.role.zh,
    company_en: e.company.en,
    company_zh: e.company.zh,
    datesText_en: e.dates.en,
    datesText_zh: e.dates.zh,
    location_en: e.location.en,
    location_zh: e.location.zh,
    bullets: e.bullets,
  };
}

function datesText(document) {
  const meta = document.querySelector("#experience-list .text-\\[11px\\]");
  assert.ok(meta, "expected the experience card's dates/location meta line to render");
  return meta.textContent;
}

await test("career.js renderExperiences(): the real EXPERIENCE[0] fallback entry shows the English date range in English mode", () => {
  const h = buildCareerHarness();
  h.setCachedExperiences([toFallbackExperience(EXPERIENCE[0])]);
  h.renderExperiences();
  const text = datesText(h.document);
  assert.ok(text.startsWith("Jun 2026 – Present"), `expected dates to start with "Jun 2026 – Present", got: ${text}`);
  assert.ok(!text.includes("[object Object]"), `dates line leaked a raw object: ${text}`);
});

await test("career.js renderExperiences(): the same fallback entry shows the Chinese date range in Chinese mode", () => {
  const h = buildCareerHarness();
  h.setLang("zh-CN");
  h.setCachedExperiences([toFallbackExperience(EXPERIENCE[0])]);
  h.renderExperiences();
  const text = datesText(h.document);
  assert.ok(text.startsWith("2026年6月 – 至今"), `expected dates to start with "2026年6月 – 至今", got: ${text}`);
  assert.ok(!text.includes("[object Object]"), `dates line leaked a raw object: ${text}`);
});

await test("career.js renderExperiences(): a real Career-CMS doc shape (startDate/endDate, no datesText_en/_zh) still falls back to the startDate–endDate string", () => {
  const h = buildCareerHarness();
  const cmsDoc = {
    id: "real-cms-doc-id",
    role_en: "Software Engineer Intern",
    role_zh: "软件工程实习生",
    company: "Some Company",
    location: "Kuching",
    startDate: "2026-01",
    endDate: "",
    description_en: "Did things.",
    description_zh: "做了一些事。",
    bullets: [],
    skills: [],
  };
  h.setCachedExperiences([cmsDoc]);
  h.renderExperiences();
  const text = datesText(h.document);
  assert.ok(text.startsWith("2026-01 – Present"), `expected the legacy startDate–endDate fallback, got: ${text}`);
});

// ==================== Part 3: portfolio.js public-portfolio Experience card ====================

function buildPortfolioHarness() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only", url: "https://edenatlas.netlify.app/" });
  const ctx = dom.getInternalVMContext();
  ctx.console = console;
  let lang = "en";
  ctx.getLang = () => lang;
  ctx.t = (key) => key;
  ctx.__setLang = (l) => { lang = l; };

  const L_MATCH = PORTFOLIO_SRC.match(/function L\(\) \{[\s\S]*?\n\}/);
  const PICK_MATCH = PORTFOLIO_SRC.match(/function pick\(obj\) \{[\s\S]*?\n\}/);
  assert.ok(L_MATCH && PICK_MATCH, "L()/pick() not found in portfolio.js");
  const H_SRC = extractFunctionSource(PORTFOLIO_SRC, "h", "portfolio.js");
  const FA_ICON_SRC = extractFunctionSource(PORTFOLIO_SRC, "faIcon", "portfolio.js");
  const PILL_SPAN_SRC = extractFunctionSource(PORTFOLIO_SRC, "pillSpan", "portfolio.js");
  const CASE_STUDY_LINK_SRC = extractFunctionSource(PORTFOLIO_SRC, "caseStudyLink", "portfolio.js");
  const EXPERIENCE_CARD_SRC = extractFunctionSource(PORTFOLIO_SRC, "experienceCard", "portfolio.js");

  const script = `
    ${L_MATCH[0]}
    ${PICK_MATCH[0]}
    ${H_SRC}
    ${FA_ICON_SRC}
    ${PILL_SPAN_SRC}
    ${CASE_STUDY_LINK_SRC}
    ${EXPERIENCE_CARD_SRC}
    globalThis.__harness = { experienceCard };
  `;
  vm.runInContext(script, ctx);
  return { experienceCard: ctx.__harness.experienceCard, setLang: ctx.__setLang };
}

function fallbackExperienceLike(e) {
  return { role: e.role, company: e.company, dates: e.dates, location: e.location, bullets: e.bullets, caseSlug: e.caseSlug };
}

await test("portfolio.js experienceCard(): the real EXPERIENCE[0] fallback ({ en, zh } dates) renders the English date range in English mode, never [object Object]", () => {
  const { experienceCard } = buildPortfolioHarness();
  const card = experienceCard(fallbackExperienceLike(EXPERIENCE[0]));
  const meta = card.querySelector("p.text-xs.text-neonPurple");
  assert.ok(meta, "expected a meta line with company/dates/location");
  assert.ok(meta.textContent.includes("Jun 2026 – Present"), `expected the English date range, got: ${meta.textContent}`);
  assert.ok(!meta.textContent.includes("[object Object]"), `meta line leaked a raw object: ${meta.textContent}`);
});

await test("portfolio.js experienceCard(): the same fallback renders the Chinese date range in Chinese mode", () => {
  const { experienceCard, setLang } = buildPortfolioHarness();
  setLang("zh-CN");
  const card = experienceCard(fallbackExperienceLike(EXPERIENCE[0]));
  const meta = card.querySelector("p.text-xs.text-neonPurple");
  assert.ok(meta.textContent.includes("2026年6月 – 至今"), `expected the Chinese date range, got: ${meta.textContent}`);
  assert.ok(!meta.textContent.includes("[object Object]"), `meta line leaked a raw object: ${meta.textContent}`);
});

await test("portfolio.js experienceCard(): a real CMS-normalized experience (plain preformatted dates string) still renders unchanged", () => {
  const { experienceCard } = buildPortfolioHarness();
  const cmsShaped = {
    role: { en: "Software Engineer Intern", zh: "软件工程实习生" },
    company: { en: "Some Company", zh: "Some Company" },
    dates: "2026-01 – Present", // normalizeExperience() in portfolio.js builds this as a plain string
    location: { en: "Kuching", zh: "Kuching" },
    body: { en: "Did things.", zh: "做了一些事。" },
    bullets: [],
    skills: [],
  };
  const card = experienceCard(cmsShaped);
  const meta = card.querySelector("p.text-xs.text-neonPurple");
  assert.ok(meta.textContent.includes("2026-01 – Present"), `expected the raw CMS dates string preserved, got: ${meta.textContent}`);
});

// ==================== Summary ====================

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  failures.forEach(({ name, err }) => console.error(`\nFAIL: ${name}\n${err.stack || err.message}`));
  process.exit(1);
}
