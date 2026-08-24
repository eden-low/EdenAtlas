import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  DEFAULT_TIME_ZONE,
  MALAYSIA_UTC_OFFSET,
  isDateLiteral,
  normalizeDateLiteral,
  localDateString,
  malaysiaDateLiteralToInstant,
  nextDateLiteral,
  resolveJournalEntryDate,
  resolveJourneyDate,
} from "../date-utils.js";

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

function timestamp(iso) {
  return { toDate: () => new Date(iso) };
}

const journalSource = readFileSync(new URL("../../journal.js", import.meta.url), "utf8");
const journalHtml = readFileSync(new URL("../../journal.html", import.meta.url), "utf8");
const homeSource = readFileSync(new URL("../../home.html", import.meta.url), "utf8");
const timelineSource = readFileSync(new URL("../../timeline.js", import.meta.url), "utf8");
const calendarSource = readFileSync(new URL("../../calendar.js", import.meta.url), "utf8");

await test("source-date contract is fixed to Asia/Kuala_Lumpur and its explicit +08:00 offset", () => {
  assert.strictEqual(DEFAULT_TIME_ZONE, "Asia/Kuala_Lumpur");
  assert.strictEqual(MALAYSIA_UTC_OFFSET, "+08:00");
});

await test("literal YYYY-MM-DD validation is strict and never normalizes through UTC", () => {
  for (const value of ["2026-08-24", "2024-02-29"]) {
    assert.strictEqual(isDateLiteral(value), true);
    assert.strictEqual(normalizeDateLiteral(value), value);
  }
  for (const value of ["2026-8-24", "2026-02-29", "2026-02-30", "0000-01-01", "2026-13-01", null]) {
    assert.strictEqual(isDateLiteral(value), false);
    assert.throws(() => normalizeDateLiteral(value), /invalid_date_literal/);
  }
});

await test("Malaysia persistence adapter anchors a literal date at explicit Malaysia midnight", () => {
  const instant = malaysiaDateLiteralToInstant("2026-08-24");
  assert.strictEqual(instant.getTime(), Date.parse("2026-08-24T00:00:00+08:00"));
  assert.strictEqual(localDateString(instant), "2026-08-24");
});

await test("exclusive next-day calculation handles ordinary, leap, month, and year boundaries", () => {
  assert.strictEqual(nextDateLiteral("2026-08-24"), "2026-08-25");
  assert.strictEqual(nextDateLiteral("2024-02-28"), "2024-02-29");
  assert.strictEqual(nextDateLiteral("2024-02-29"), "2024-03-01");
  assert.strictEqual(nextDateLiteral("2026-12-31"), "2027-01-01");
});

await test("explicit Journal entryDate wins over createdAt and is marked non-legacy", () => {
  const result = resolveJournalEntryDate({
    entryDate: "2026-08-20",
    createdAt: timestamp("2026-08-24T18:00:00Z"),
  });
  assert.deepStrictEqual(result, { date: "2026-08-20", basis: "entryDate", isLegacyFallback: false });
});

await test("legacy Journal without entryDate remains readable via Malaysia-local createdAt fallback", () => {
  // 2026-08-24 16:30Z is already 2026-08-25 in Malaysia.
  const result = resolveJournalEntryDate({ createdAt: timestamp("2026-08-24T16:30:00Z") });
  assert.deepStrictEqual(result, { date: "2026-08-25", basis: "legacy_createdAt", isLegacyFallback: true });
});

await test("malformed explicit entryDate is distinguishable and never silently replaced by createdAt", () => {
  const result = resolveJournalEntryDate({
    entryDate: "2026-02-30",
    createdAt: timestamp("2026-02-20T00:00:00Z"),
  });
  assert.deepStrictEqual(result, { date: null, basis: "invalid_entryDate", isLegacyFallback: false });
});

await test("missing Journal lifecycle data remains readable as an explicit missing fallback", () => {
  assert.deepStrictEqual(resolveJournalEntryDate({}), {
    date: null,
    basis: "missing",
    isLegacyFallback: true,
  });
});

await test("Journey Timestamp resolves to exactly one Malaysia calendar day and exclusive next day", () => {
  const result = resolveJourneyDate({ date: timestamp("2026-08-24T16:30:00Z") });
  assert.deepStrictEqual(result, {
    date: "2026-08-25",
    endDateExclusive: "2026-08-26",
    allDay: true,
    basis: "date",
  });
});

await test("Journey literal compatibility remains single-day and does not infer a range", () => {
  assert.deepStrictEqual(resolveJourneyDate({ date: "2026-08-24" }), {
    date: "2026-08-24",
    endDateExclusive: "2026-08-25",
    allDay: true,
    basis: "date",
  });
});

await test("both Journal creation surfaces persist explicit entryDate alongside createdAt", () => {
  assert.match(journalSource, /entryDate:\s*normalizeDateLiteral\(entryDateValue\)/);
  assert.match(journalSource, /createdAt:\s*serverTimestamp\(\)/);
  assert.match(homeSource, /entryDate:\s*normalizeDateLiteral\(document\.getElementById\("qa-journal-entry-date"\)\.value\)/);
  assert.match(homeSource, /createdAt:\s*serverTimestamp\(\)/);
});

await test("Journal edit UI exposes entryDate and clearly labels legacy fallback before save", () => {
  assert.match(journalHtml, /id="journal-entry-date"[^>]*type="date"[^>]*required/);
  assert.match(journalHtml, /id="journal-edit-entry-date"[^>]*type="date"[^>]*required/);
  assert.match(journalHtml, /id="journal-edit-date-source"/);
  assert.match(journalSource, /resolveJournalEntryDate\(entry\)/);
  assert.match(journalSource, /entryDate:\s*normalizeDateLiteral\(entryDateValue\)/);
  assert.match(journalSource, /Legacy entry:[^"`]*createdAt/);
});

await test("EdenAtlas Calendar buckets Journal entries through the canonical source adapter", () => {
  assert.match(calendarSource, /projectJournalToCalendarEvent/);
  assert.match(calendarSource, /projectSource\(projectJournalToCalendarEvent,\s*j,\s*"Journal"\)/);
  assert.match(calendarSource, /addCanonicalEvent\(event,/);
  assert.doesNotMatch(calendarSource, /journals\.forEach\(\(j\)\s*=>\s*addItem\("createdAt"/);
});

await test("EdenAtlas Calendar includes single-day Journey through the canonical source adapter", () => {
  assert.match(calendarSource, /fetchMine\("life_events"\)/);
  assert.match(calendarSource, /projectSource\(projectJourneyToCalendarEvent,\s*journey,\s*"Journey"\)/);
  assert.match(calendarSource, /event\.start\.type === "date"/);
});

await test("Journey create/edit uses the explicit Malaysia adapter and adds no multi-day fields", () => {
  assert.match(timelineSource, /Timestamp\.fromDate\(malaysiaDateLiteralToInstant\(dateValue\)\)/);
  assert.doesNotMatch(timelineSource, /\bstartDate\b|\bendDate\b|\bstartTime\b|\bendTime\b/);
  assert.doesNotMatch(timelineSource, /new Date\(year,\s*month\s*-\s*1,\s*day\)/);
});

await test("source date paths never derive literal dates with UTC slicing or browser-local getters", () => {
  const combined = `${journalSource}\n${homeSource}\n${timelineSource}\n${calendarSource}`;
  assert.doesNotMatch(combined, /toISOString\(\)\.slice\(0,\s*10\)/);
  assert.match(journalSource, /function todayKey\(d = new Date\(\)\) \{\s*return localDateString\(d\);/);
});

await test("source lifecycle changes contain no provider synchronization or Google write path", () => {
  const combined = `${journalSource}\n${homeSource}\n${timelineSource}`;
  assert.doesNotMatch(combined, /calendar\.events\.(?:insert|update|patch|delete)|googleEventId|externalEventId/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFailures:");
  failures.forEach(({ name, err }) => console.log(`  - ${name}: ${err.message}`));
  process.exit(1);
}
