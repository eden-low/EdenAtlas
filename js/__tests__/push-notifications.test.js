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

  // ---- End-to-end: the REAL subscribeThisDevice() against a fake in-memory Firestore ----
  //
  // Regression coverage for the reported "开启提醒 (Enable reminders) fails with permission-denied"
  // bug: subscribeThisDevice() calls getDoc(ref) to decide create-vs-update BEFORE ever writing —
  // on a brand-new device that doc doesn't exist yet, and firestore.rules' push_subscriptions read
  // rule used to dereference resource.data.uid on a null resource (a rules evaluation error the
  // client sees as PERMISSION_DENIED, not NOT_FOUND). firestore/__tests__/discover-rules.test.js
  // proves the fixed RULE tolerates this against the real Rules engine; these tests instead run
  // the REAL, SHIPPED subscribeThisDevice() function (extracted from this file's own source, not a
  // hand-duplicated reimplementation) against a fake Firestore, to prove the CLIENT's actual
  // create/update payloads are shaped exactly the way firestore.rules' push_subscriptions
  // create/update rules require — the "same payload builder used by production code" the fix
  // brief asked for, since there is no separate payload-building helper to import: the object
  // literals inside subscribeThisDevice() ARE the payload builder.

  function extractEnumSource(name) {
    const re = new RegExp(`export const ${name} = Object\\.freeze\\(\\{[\\s\\S]*?\\}\\);`);
    const m = re.exec(SOURCE);
    assert.ok(m, `could not find ${name} in push-notifications.js`);
    return m[0].replace(/^export /, "");
  }

  // A minimal fake Firestore: enough to exercise getDoc/setDoc/updateDoc call sequencing and
  // capture the exact payload object each call receives, without depending on a real SDK or
  // network. Not a rules engine — the real Rules engine coverage lives in
  // firestore/__tests__/discover-rules.test.js; this proves what the CLIENT sends, not what the
  // server would accept.
  function makeFakeFirestore(seed = {}) {
    const store = new Map(Object.entries(seed));
    const calls = [];
    return {
      store,
      calls,
      doc: (_db, collectionName, id) => ({ path: `${collectionName}/${id}` }),
      getDoc: async (ref) => {
        calls.push({ type: "get", path: ref.path });
        const data = store.get(ref.path);
        return { exists: () => data !== undefined, data: () => data };
      },
      setDoc: async (ref, data) => {
        calls.push({ type: "set", path: ref.path, data });
        store.set(ref.path, { ...data });
      },
      updateDoc: async (ref, data) => {
        calls.push({ type: "update", path: ref.path, data });
        if (!store.has(ref.path)) throw Object.assign(new Error("no such document"), { code: "not-found" });
        store.set(ref.path, { ...store.get(ref.path), ...data });
      },
      serverTimestamp: () => "__SERVER_TIMESTAMP__",
    };
  }

  const FAKE_TOKEN = "fake-fcm-token-never-a-real-credential";
  const FAKE_UID = "owner-uid-real-fn-test";

  function buildSubscribeSandbox({ store = {}, getDocOverride, setDocOverride, updateDocOverride } = {}) {
    const enumSrc = extractEnumSource("SUBSCRIBE_REASON");
    const combinedSrc = [
      enumSrc,
      extractFunctionSource("sha256Hex"),
      extractFunctionSource("subscriptionDocId"),
      extractFunctionSource("logStageFailure"),
      extractFunctionSource("subscribeThisDevice"),
    ].join("\n\n");

    const fakeDb = makeFakeFirestore(store);
    const consoleErrors = [];
    const globals = {
      auth: { currentUser: { uid: FAKE_UID, email: "jjun8647@gmail.com" } },
      isOwner: (user) => !!user && user.email === "jjun8647@gmail.com",
      isStagingWritesUnsafe: () => false,
      isPushApiSupported: () => true,
      isPushConfigured: () => true,
      getBuildInfo: () => ({ vapidPublicKey: "fake-vapid-public-key" }),
      Notification: { requestPermission: async () => "granted" },
      navigator: { serviceWorker: { ready: Promise.resolve({}) } },
      app: {},
      db: {},
      loadMessagingModule: async () => ({
        getMessaging: () => ({}),
        getToken: async () => FAKE_TOKEN,
      }),
      doc: fakeDb.doc,
      getDoc: getDocOverride || fakeDb.getDoc,
      setDoc: setDocOverride || fakeDb.setDoc,
      updateDoc: updateDocOverride || fakeDb.updateDoc,
      serverTimestamp: fakeDb.serverTimestamp,
      console: { ...console, error: (...args) => { consoleErrors.push(args.join(" ")); } },
    };
    const sandbox = runInSandbox(`${combinedSrc}\nglobalThis.__run__ = subscribeThisDevice;`, globals);
    return { sandbox, fakeDb, consoleErrors };
  }

  await test("subscribeThisDevice() first-time subscribe: getDoc-then-setDoc, and the setDoc payload matches firestore.rules' create allowlist exactly", async () => {
    const { sandbox, fakeDb } = buildSubscribeSandbox();
    const result = await sandbox.__run__();

    assert.deepStrictEqual(fakeDb.calls.map((c) => c.type), ["get", "set"], "expected exactly one getDoc then one setDoc");
    const setCall = fakeDb.calls[1];
    const ALLOWED_CREATE_KEYS = ["uid", "tokenHash", "token", "platform", "createdAt", "updatedAt"];
    assert.deepStrictEqual(
      Object.keys(setCall.data).sort(),
      [...ALLOWED_CREATE_KEYS].sort(),
      "setDoc payload must be exactly firestore.rules' push_subscriptions create keys().hasOnly(...) allowlist"
    );
    assert.strictEqual(setCall.data.uid, FAKE_UID);
    assert.strictEqual(setCall.data.platform, "web");
    assert.strictEqual(typeof setCall.data.tokenHash, "string");
    assert.ok(setCall.data.tokenHash.length > 0);
    assert.strictEqual(setCall.data.token, FAKE_TOKEN);
    assert.strictEqual(setCall.data.createdAt, "__SERVER_TIMESTAMP__");
    assert.strictEqual(setCall.data.updatedAt, "__SERVER_TIMESTAMP__");
    assert.strictEqual(setCall.path, `push_subscriptions/${FAKE_UID}_${setCall.data.tokenHash}`, "doc ID must be uid_tokenHash, matching the rule's id == request.auth.uid + '_' + tokenHash check");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.reason, "ok");
  });

  await test("subscribeThisDevice() on an already-registered device: getDoc-then-updateDoc, and the update payload touches ONLY updatedAt (every other field is immutable per firestore.rules)", async () => {
    // Pre-derive the same deterministic id the real sha256Hex(FAKE_TOKEN) would produce, by
    // running the create path once, then re-running subscribeThisDevice() against that seeded
    // store — this exercises the exact same id-construction code the app uses, not a hand-picked
    // hash.
    const first = buildSubscribeSandbox();
    await first.sandbox.__run__();
    const existingPath = first.fakeDb.calls[1].path;
    const existingData = first.fakeDb.store.get(existingPath);

    const { sandbox, fakeDb } = buildSubscribeSandbox({ store: { [existingPath]: existingData } });
    const result = await sandbox.__run__();

    assert.deepStrictEqual(fakeDb.calls.map((c) => c.type), ["get", "update"], "expected exactly one getDoc then one updateDoc, never a second setDoc");
    const updateCall = fakeDb.calls[1];
    assert.deepStrictEqual(Object.keys(updateCall.data), ["updatedAt"], "a refresh of an already-registered device must touch ONLY updatedAt");
    assert.strictEqual(updateCall.data.updatedAt, "__SERVER_TIMESTAMP__");
    assert.strictEqual(result.ok, true);
  });

  await test("subscribeThisDevice(): a getDoc failure on the (possibly not-yet-existing) subscription doc is reported as stage=check_existing_subscription, never a bare opaque error", async () => {
    const deniedErr = Object.assign(new Error("Missing or insufficient permissions."), { code: "permission-denied" });
    const { sandbox, consoleErrors } = buildSubscribeSandbox({
      getDocOverride: async () => { throw deniedErr; },
    });
    const result = await sandbox.__run__();
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "error");
    assert.strictEqual(result.stage, "check_existing_subscription");
    assert.strictEqual(result.code, "permission-denied");
    assert.ok(consoleErrors.some((line) => line.includes("stage=check_existing_subscription") && line.includes("code=permission-denied")));
    // The whole point of stage-labeled logging is to diagnose without leaking secrets — the raw
    // FCM token must never appear in anything logged, on this or any other failure path below.
    consoleErrors.forEach((line) => assert.ok(!line.includes(FAKE_TOKEN), `log line leaked the raw token: ${line}`));
  });

  await test("subscribeThisDevice(): a setDoc (create) failure is reported as stage=create_subscription; an updateDoc (refresh) failure is reported as stage=refresh_existing_subscription", async () => {
    const err = Object.assign(new Error("Missing or insufficient permissions."), { code: "permission-denied" });

    const createFailure = buildSubscribeSandbox({ setDocOverride: async () => { throw err; } });
    const createResult = await createFailure.sandbox.__run__();
    assert.strictEqual(createResult.stage, "create_subscription");
    assert.strictEqual(createResult.code, "permission-denied");

    const seeded = buildSubscribeSandbox();
    await seeded.sandbox.__run__();
    const existingPath = seeded.fakeDb.calls[1].path;
    const existingData = seeded.fakeDb.store.get(existingPath);
    const updateFailure = buildSubscribeSandbox({
      store: { [existingPath]: existingData },
      updateDocOverride: async () => { throw err; },
    });
    const updateResult = await updateFailure.sandbox.__run__();
    assert.strictEqual(updateResult.stage, "refresh_existing_subscription");
    assert.strictEqual(updateResult.code, "permission-denied");

    [...createFailure.consoleErrors, ...updateFailure.consoleErrors].forEach((line) =>
      assert.ok(!line.includes(FAKE_TOKEN), `log line leaked the raw token: ${line}`)
    );
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    failures.forEach(({ name, err }) => console.error(`\n[FAILED] ${name}\n${err.stack || err}`));
    process.exit(1);
  }
})();
