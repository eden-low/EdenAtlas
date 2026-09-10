import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createObjectUrlRegistry } from "../object-url-lifecycle.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pass = 0; let fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ok  - ${name}`); }
  catch (error) { fail++; console.log(`FAIL  - ${name}`); console.log(`        ${error.message}`); }
}

function extractFunctionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} has no closing brace`);
}

async function run() {
  const created = []; const revoked = [];
  const urlApi = {
    createObjectURL(blob) { const value = `blob:test-${created.length + 1}`; created.push({ blob, value }); return value; },
    revokeObjectURL(value) { revoked.push(value); },
  };

  await test("registry creates URLs and explicit cleanup revokes once", () => {
    const registry = createObjectUrlRegistry(urlApi);
    const url = registry.create({ bytes: 1 });
    assert.strictEqual(registry.size, 1);
    registry.revoke(url);
    registry.revoke(url);
    assert.strictEqual(registry.size, 0);
    assert.deepStrictEqual(revoked, [url]);
  });

  await test("replacement registry keeps old URL alive through render then revokes it", () => {
    const events = [];
    const oldRegistry = createObjectUrlRegistry({
      createObjectURL: () => "blob:old",
      revokeObjectURL: (url) => events.push(`revoke:${url}`),
    });
    const nextRegistry = createObjectUrlRegistry({
      createObjectURL: () => "blob:new",
      revokeObjectURL: (url) => events.push(`revoke:${url}`),
    });
    oldRegistry.create({});
    nextRegistry.create({});
    events.push("render:new");
    oldRegistry.revokeAll();
    assert.deepStrictEqual(events, ["render:new", "revoke:blob:old"]);
    nextRegistry.revokeAll();
    assert.deepStrictEqual(events, ["render:new", "revoke:blob:old", "revoke:blob:new"]);
  });

  await test("error cleanup revokes every partially-created URL", () => {
    const registry = createObjectUrlRegistry(urlApi);
    const first = registry.create({}); const second = registry.create({});
    registry.revokeAll();
    assert.ok(revoked.includes(first));
    assert.ok(revoked.includes(second));
    assert.strictEqual(registry.size, 0);
  });

  await test("Career and Capsule swap after render and clean error/pagehide paths", () => {
    const career = fs.readFileSync(path.resolve(__dirname, "..", "career.js"), "utf8");
    const capsule = fs.readFileSync(path.resolve(__dirname, "..", "time-capsule.js"), "utf8");
    assert.ok(career.includes("nextObjectUrls.revokeAll()"));
    assert.ok(career.includes('window.addEventListener("pagehide", () => careerObjectUrls.revokeAll())'));
    assert.ok(career.indexOf("renderAwards();") < career.indexOf("previousObjectUrls.revokeAll();"));
    assert.ok(capsule.includes("nextObjectUrls.revokeAll()"));
    assert.ok(capsule.includes("replacedObjectUrls?.revokeAll()"));
    assert.ok(capsule.includes('window.addEventListener("pagehide", () => capsuleObjectUrls.revokeAll())'));
    assert.ok(capsule.indexOf("capsuleObjectUrls = nextObjectUrls;") < capsule.indexOf("previousObjectUrls.revokeAll();"));
  });

  await test("Career auth teardown revokes protected URLs before every access re-evaluation", () => {
    const career = fs.readFileSync(path.resolve(__dirname, "..", "career.js"), "utf8");
    const clearState = extractFunctionSource(career, "clearCareerAttachmentState");
    const initAccess = extractFunctionSource(career, "initCareerAccess");
    assert.ok(clearState.includes("careerLoadGeneration++"));
    assert.ok(clearState.includes("cachedProjects = []"));
    assert.ok(clearState.includes("careerObjectUrls = createObjectUrlRegistry()"));
    assert.ok(clearState.includes("previousObjectUrls.revokeAll()"));
    assert.ok(initAccess.includes("clearCareerAttachmentState()"));
    assert.ok(initAccess.includes("const accessGeneration = ++careerAccessGeneration"));
    assert.ok(initAccess.includes("accessGeneration !== careerAccessGeneration"));
  });

  await test("successful Career deletion tears down URLs before a fallible refresh", () => {
    const career = fs.readFileSync(path.resolve(__dirname, "..", "career.js"), "utf8");
    const deleteCall = 'await deleteCareerItem(btn.dataset.collection, btn.dataset.id);';
    const teardown = "clearCareerAttachmentState();";
    const reload = "await loadAll();";
    const start = career.indexOf(deleteCall);
    assert.ok(start >= 0);
    const teardownIndex = career.indexOf(teardown, start);
    const reloadIndex = career.indexOf(reload, start);
    assert.ok(teardownIndex > start && reloadIndex > teardownIndex);
  });

  console.log(`\nObject URL lifecycle tests: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}
run();
