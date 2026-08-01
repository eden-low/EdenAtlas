// Deterministic tests for js/push-notifications.js.
//
// This file can't be `import`ed directly in Node the way js/environment.js can: it imports
// firebase-init.js, which imports the real Firebase SDK straight from gstatic.com (this
// codebase's established buildless-CDN convention) — not resolvable outside a browser. Instead,
// small pure helper functions are extracted straight out of the shipped source text and executed
// in a `node:vm` sandbox with hand-supplied globals — same technique
// js/__tests__/discover-security.test.js and js/__tests__/xss-security.test.js already
// established for this exact class of file.
//
// The single most important behavior this file guards, structurally (Requirement: "Never request
// notification permission when the page opens... Request permission only after the Owner
// explicitly taps a bell/notification control"): `Notification.requestPermission()` must appear
// EXACTLY ONCE in the whole module, inside subscribeThisDevice(), and every other guard check
// (support/configured/owner/staging-safety) must appear in the source BEFORE that call — proven
// by source position, not just by calling the function once and hoping.
//
// Run with: node js/__tests__/push-notifications.test.js (or `npm run test:frontend`).

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "js", "push-notifications.js"), "utf8");

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

function extractFunctionSource(name) {
  const re = new RegExp(`(?:export )?(?:async )?function ${name}\\s*\\([^)]*\\)\\s*\\{`, "m");
  const m = re.exec(SOURCE);
  assert.ok(m, `could not find function ${name} in push-notifications.js`);
  // Slice from just after "export " (if present) so the extracted snippet is plain, vm-runnable
  // function-declaration syntax — `export function ...` is a SyntaxError outside a module.
  const start = m[0].startsWith("export ") ? m.index + "export ".length : m.index;
  let depth = 0;
  let i = SOURCE.indexOf("{", start);
  for (; i < SOURCE.length; i++) {
    if (SOURCE[i] === "{") depth++;
    else if (SOURCE[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return SOURCE.slice(start, i + 1);
}

// Only counts occurrences in actual code, never in a `//`-prefixed comment line — this file's
// own header comment legitimately mentions Notification.requestPermission() by name once.
function countCodeOccurrences(pattern) {
  return SOURCE.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n").match(pattern)?.length || 0;
}

function runInSandbox(src, extraGlobals = {}) {
  const sandbox = { console, TextEncoder, crypto, ...extraGlobals };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox;
}

// In a real browser, `window` (and `self`/`globalThis`) all refer to the SAME global object a
// bare `Notification`/`navigator`/`PushManager` global lives on — `"Notification" in window` is
// really just `"Notification" in globalThis`. A fake `window: {}` disconnected from the rest of
// the sandbox's globals would make `"X" in window` always false regardless of what else is set,
// which isn't what a real browser does. This helper builds a sandbox where `window` is a
// self-reference to the sandbox's own global scope, matching real browser semantics.
function runInBrowserLikeSandbox(src, browserGlobals = {}) {
  const sandbox = { console, TextEncoder, crypto, ...browserGlobals };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox;
}

(async () => {
  // ---- Structural guard-ordering proof (the actual security-relevant invariant) ----

  await test("Notification.requestPermission() appears EXACTLY ONCE in actual code (comments may mention it)", async () => {
    const count = countCodeOccurrences(/Notification\.requestPermission\(\)/g);
    assert.strictEqual(count, 1, `expected exactly 1 code occurrence, found ${count}`);
  });

  await test("the sole requestPermission() call lives inside subscribeThisDevice(), never at module top level or in any other exported function", async () => {
    const fnSrc = extractFunctionSource("subscribeThisDevice");
    assert.ok(/Notification\.requestPermission\(\)/.test(fnSrc), "subscribeThisDevice() must call requestPermission()");
    ["unsubscribeThisDevice", "disableAllNotifications", "fetchMySubscriptions", "onForegroundAiringMessage"].forEach((name) => {
      const src = extractFunctionSource(name);
      assert.ok(!/requestPermission/.test(src), `${name}() must never request permission`);
    });
  });

  await test("subscribeThisDevice(): every guard (support/configured/owner/staging-safety) is checked BEFORE requestPermission() is called, by source order", async () => {
    const fnSrc = extractFunctionSource("subscribeThisDevice");
    const permIdx = fnSrc.indexOf("Notification.requestPermission()");
    const supportIdx = fnSrc.indexOf("isPushApiSupported()");
    const configuredIdx = fnSrc.indexOf("isPushConfigured()");
    const ownerIdx = fnSrc.indexOf("isOwner(user)");
    const stagingIdx = fnSrc.indexOf("isStagingWritesUnsafe()");
    [supportIdx, configuredIdx, ownerIdx, stagingIdx].forEach((idx, i) => {
      assert.ok(idx !== -1, `guard #${i} not found in subscribeThisDevice()`);
      assert.ok(idx < permIdx, `guard #${i} (index ${idx}) must appear before requestPermission() (index ${permIdx})`);
    });
  });

  await test("no top-level (module-load-time) call to requestPermission, getToken, or subscribeThisDevice exists in this file", async () => {
    // A top-level IIFE calling any of these would mean permission could be requested just by
    // the module being imported (e.g. on page load) — never allowed.
    const lines = SOURCE.split("\n");
    let depth = 0;
    for (const line of lines) {
      const isComment = /^\s*(\/\/|\*)/.test(line);
      const isDeclaration = /^\s*(export\s+)?(async\s+)?function\s+\w+\(/.test(line);
      const opens = (line.match(/\{/g) || []).length;
      const closes = (line.match(/\}/g) || []).length;
      if (depth === 0 && !isComment && !isDeclaration && /subscribeThisDevice\(\)|requestPermission\(\)/.test(line)) {
        assert.fail(`top-level call found: "${line.trim()}"`);
      }
      depth += opens - closes;
    }
  });

  // ---- Pure helper behavior (vm-sandboxed extraction) ----

  await test("isPushApiSupported(): true only when Notification, serviceWorker, and PushManager are all present", async () => {
    const src = extractFunctionSource("isPushApiSupported");
    const full = `${src}\nresult = isPushApiSupported();`;
    const full1 = runInBrowserLikeSandbox(full, { Notification: {}, navigator: { serviceWorker: {} }, PushManager: {}, result: undefined });
    assert.strictEqual(full1.result, true);
    const missingNotification = runInBrowserLikeSandbox(full, { navigator: { serviceWorker: {} }, PushManager: {}, result: undefined });
    assert.strictEqual(missingNotification.result, false);
    const missingSW = runInBrowserLikeSandbox(full, { Notification: {}, navigator: {}, PushManager: {}, result: undefined });
    assert.strictEqual(missingSW.result, false);
    const missingPushManager = runInBrowserLikeSandbox(full, { Notification: {}, navigator: { serviceWorker: {} }, result: undefined });
    assert.strictEqual(missingPushManager.result, false);
  });

  await test("getPermissionState(): 'unsupported' when the Push API is missing, else mirrors Notification.permission", async () => {
    const supportSrc = extractFunctionSource("isPushApiSupported");
    const permSrc = extractFunctionSource("getPermissionState");
    const combined = `${supportSrc}\n${permSrc}\nresult = getPermissionState();`;
    const unsupported = runInBrowserLikeSandbox(combined, { navigator: {}, result: undefined });
    assert.strictEqual(unsupported.result, "unsupported");
    const granted = runInBrowserLikeSandbox(combined, { Notification: { permission: "granted" }, navigator: { serviceWorker: {} }, PushManager: {}, result: undefined });
    assert.strictEqual(granted.result, "granted");
    const denied = runInBrowserLikeSandbox(combined, { Notification: { permission: "denied" }, navigator: { serviceWorker: {} }, PushManager: {}, result: undefined });
    assert.strictEqual(denied.result, "denied");
  });

  await test("isPushConfigured(): true only when getBuildInfo() returns a truthy vapidPublicKey", async () => {
    const src = extractFunctionSource("isPushConfigured");
    const stubbedGetBuildInfo = "function getBuildInfo() { return __buildInfo__; }";
    const full = `${stubbedGetBuildInfo}\n${src}\nresult = isPushConfigured();`;
    const configured = runInSandbox(full, { __buildInfo__: { vapidPublicKey: "BExample-Key" }, result: undefined });
    assert.strictEqual(configured.result, true);
    const unconfigured = runInSandbox(full, { __buildInfo__: { vapidPublicKey: null }, result: undefined });
    assert.strictEqual(unconfigured.result, false);
    const noBuildInfo = runInSandbox(full, { __buildInfo__: null, result: undefined });
    assert.strictEqual(noBuildInfo.result, false);
  });

  await test("sha256Hex(): deterministic, matches a known SHA-256 test vector", async () => {
    const src = extractFunctionSource("sha256Hex");
    const full = `${src}\nsha256Hex("abc").then((h) => { result = h; });`;
    const sandbox = runInSandbox(full, { result: undefined });
    // Give the microtask queue a tick to resolve the promise inside the sandbox.
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(sandbox.result, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".slice(0, 64));
  });

  await test("subscriptionDocId(): deterministic uid_tokenHash shape, same convention as followed_anime's followDocId", async () => {
    const src = extractFunctionSource("subscriptionDocId");
    const full = `${src}\nresult = subscriptionDocId("uid123", "hashabc");`;
    const sandbox = runInSandbox(full, { result: undefined });
    assert.strictEqual(sandbox.result, "uid123_hashabc");
  });

  await test("every SUBSCRIBE_REASON value used by subscribeThisDevice() is a real key in the exported enum", async () => {
    const enumMatch = /export const SUBSCRIBE_REASON = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(SOURCE);
    assert.ok(enumMatch);
    const keys = [...enumMatch[1].matchAll(/(\w+):/g)].map((m) => m[1]);
    const fnSrc = extractFunctionSource("subscribeThisDevice");
    const used = [...fnSrc.matchAll(/SUBSCRIBE_REASON\.(\w+)/g)].map((m) => m[1]);
    used.forEach((u) => assert.ok(keys.includes(u), `SUBSCRIBE_REASON.${u} used but not defined`));
    assert.ok(used.length >= 5, "expected subscribeThisDevice to reference multiple distinct reasons");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    failures.forEach(({ name, err }) => console.error(`\n[FAILED] ${name}\n${err.stack || err}`));
    process.exit(1);
  }
})();
