const { test, expect } = require("../fixtures/emulator-test.js");
const { USERS } = require("../constants.js");
const { signInFromUi, assertLocalFirebaseRuntime } = require("../helpers/browser-auth.js");
const { seedCareerDomain, CAREER_COLLECTIONS, CAREER_IDS } = require("../helpers/domain-fixtures.js");
const { getAdminServices } = require("../helpers/emulator-fixtures.js");
const { Timestamp } = require("firebase-admin/firestore");

async function postTransition(page, body) {
  return page.evaluate(async (requestBody) => {
    const { auth } = await import("/js/firebase-init.js");
    const token = await auth.currentUser.getIdToken();
    const response = await fetch("/.netlify/functions/career-policy-transition", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    return { status: response.status, payload: await response.json() };
  }, body);
}

async function signOutInBrowser(page) {
  await page.evaluate(async () => {
    const { auth } = await import("/js/firebase-init.js");
    const { signOut } = await import("https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js");
    await signOut(auth);
  });
}

test("real Career UI completes a server-issued transition across all four collections", async ({ page }) => {
  await seedCareerDomain({ visibility: "private", version: 7 });
  await signInFromUi(page, USERS.owner, "resume.html");
  await assertLocalFirebaseRuntime(page, USERS.owner.uid);
  await expect(page.locator("#career-visibility-select")).toHaveValue("private");
  await page.locator("#career-visibility-select").selectOption("public");

  const { db } = getAdminServices();
  await expect.poll(async () => {
    const snapshot = await db.collection("public_profiles").doc(USERS.owner.uid).get();
    const data = snapshot.data();
    return `${data.careerVisibility}:${data.careerPolicyVersion}:${Boolean(data.careerPolicyTransition)}`;
  }).toBe("public:8:false");
  await expect(page.locator("#career-visibility-status")).not.toContainText("Couldn't");

  for (const collectionName of CAREER_COLLECTIONS) {
    const snapshot = await db.collection(collectionName).doc(CAREER_IDS[collectionName]).get();
    expect(snapshot.data().careerVisibility).toBe("public");
    expect(snapshot.data().careerPolicyVersion).toBe(8);
  }
  const profile = (await db.collection("public_profiles").doc(USERS.owner.uid).get()).data();
  expect(profile.careerPolicyTransition).toBeUndefined();
  expect(profile.careerPolicyLastConsumed.ownerUid).toBe(USERS.owner.uid);
  expect(profile.careerPolicyLastConsumed.targetVisibility).toBe("public");
  expect(profile.careerPolicyLastConsumed.secretHash).toMatch(/^[a-f0-9]{64}$/);
});

test("completed capability is rejected immediately and after a later restrictive transition", async ({ page }) => {
  await seedCareerDomain({ visibility: "private", version: 7 });
  await signInFromUi(page, USERS.owner);
  const first = await postTransition(page, { action: "begin", careerVisibility: "public" });
  expect(first.status).toBe(200);
  const firstCapability = {
    action: "complete",
    careerVisibility: "public",
    transitionId: first.payload.transitionId,
    transitionSecret: first.payload.transitionSecret,
  };
  expect((await postTransition(page, firstCapability)).status).toBe(200);
  const immediateReplay = await postTransition(page, firstCapability);
  expect(immediateReplay.status).toBe(409);
  expect(immediateReplay.payload.error).toBe("transition_already_consumed");

  const second = await postTransition(page, { action: "begin", careerVisibility: "private" });
  expect(second.status).toBe(200);
  expect((await postTransition(page, {
    action: "complete",
    careerVisibility: "private",
    transitionId: second.payload.transitionId,
    transitionSecret: second.payload.transitionSecret,
  })).status).toBe(200);

  const oldReplay = await postTransition(page, firstCapability);
  expect(oldReplay.status).toBe(409);
  const { db } = getAdminServices();
  const profile = (await db.collection("public_profiles").doc(USERS.owner.uid).get()).data();
  expect(profile.careerVisibility).toBe("private");
  expect(profile.careerPolicyVersion).toBe(9);
});

test("capability is UID-bound and target-bound", async ({ page }) => {
  await seedCareerDomain({ visibility: "private", version: 7 });
  await signInFromUi(page, USERS.owner);
  const begin = await postTransition(page, { action: "begin", careerVisibility: "public" });
  expect(begin.status).toBe(200);

  const wrongTarget = await postTransition(page, {
    action: "complete",
    careerVisibility: "connections",
    transitionId: begin.payload.transitionId,
    transitionSecret: begin.payload.transitionSecret,
  });
  expect(wrongTarget.status).toBe(409);
  expect(wrongTarget.payload.error).toBe("transition_target_mismatch");

  await signOutInBrowser(page);
  await signInFromUi(page, USERS.verifiedNonOwner);
  const wrongUser = await postTransition(page, {
    action: "complete",
    careerVisibility: "public",
    transitionId: begin.payload.transitionId,
    transitionSecret: begin.payload.transitionSecret,
  });
  expect(wrongUser.status).toBe(403);
  expect(wrongUser.payload.error).toBe("owner_only");
});

test("client-selected source, version, identity, or capability fields are rejected", async ({ page }) => {
  await seedCareerDomain({ visibility: "private", version: 7 });
  await signInFromUi(page, USERS.owner);
  for (const extra of [
    { sourceCareerVisibility: "public" },
    { sourceCareerPolicyVersion: 99 },
    { targetCareerPolicyVersion: 99 },
    { uid: USERS.owner.uid },
    { transitionId: "00000000-0000-4000-8000-000000000000" },
    { transitionSecret: "A".repeat(43) },
  ]) {
    const result = await postTransition(page, { action: "begin", careerVisibility: "public", ...extra });
    expect(result.status).toBe(400);
    expect(result.payload.error).toBe("unknown_field");
  }
  const invalid = await postTransition(page, {
    action: "complete",
    careerVisibility: "public",
    transitionId: "00000000-0000-4000-8000-000000000000",
    transitionSecret: "A".repeat(43),
  });
  expect(invalid.status).toBe(409);
  expect(invalid.payload.error).toBe("transition_not_active");
});

test("concurrent begin and complete requests allow exactly one winner", async ({ page }) => {
  await seedCareerDomain({ visibility: "private", version: 7 });
  await signInFromUi(page, USERS.owner);
  const result = await page.evaluate(async () => {
    const { auth } = await import("/js/firebase-init.js");
    const token = await auth.currentUser.getIdToken();
    const post = async (body) => {
      const response = await fetch("/.netlify/functions/career-policy-transition", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const begins = await Promise.all([
      post({ action: "begin", careerVisibility: "public" }),
      post({ action: "begin", careerVisibility: "public" }),
    ]);
    const winner = begins.find((entry) => entry.status === 200);
    const completion = {
      action: "complete",
      careerVisibility: "public",
      transitionId: winner.body.transitionId,
      transitionSecret: winner.body.transitionSecret,
    };
    const completes = await Promise.all([post(completion), post(completion)]);
    return {
      beginStatuses: begins.map((entry) => entry.status).sort(),
      completeStatuses: completes.map((entry) => entry.status).sort(),
      loserErrors: begins.filter((entry) => entry.status !== 200).map((entry) => entry.body.error),
      replayErrors: completes.filter((entry) => entry.status !== 200).map((entry) => entry.body.error),
    };
  });
  expect(result.beginStatuses).toEqual([200, 409]);
  expect(result.completeStatuses.filter((status) => status === 200)).toHaveLength(1);
  expect(result.completeStatuses.filter((status) => status >= 400)).toHaveLength(1);
  expect(result.loserErrors).toEqual(["transition_in_progress"]);
  expect(result.replayErrors).toHaveLength(1);
  const { db } = getAdminServices();
  const profile = (await db.collection("public_profiles").doc(USERS.owner.uid).get()).data();
  expect(profile.careerVisibility).toBe("public");
  expect(profile.careerPolicyVersion).toBe(8);
  expect(profile.careerPolicyTransition).toBeUndefined();
  for (const collectionName of CAREER_COLLECTIONS) {
    const snapshot = await db.collection(collectionName).doc(CAREER_IDS[collectionName]).get();
    expect(snapshot.data().careerPolicyVersion).toBe(8);
  }
});

test("expired active capability fails closed without changing policy", async ({ page }) => {
  await seedCareerDomain({ visibility: "private", version: 7 });
  await signInFromUi(page, USERS.owner);
  const begin = await postTransition(page, { action: "begin", careerVisibility: "public" });
  expect(begin.status).toBe(200);
  const { db } = getAdminServices();
  await db.collection("public_profiles").doc(USERS.owner.uid).update({
    "careerPolicyTransition.expiresAt": Timestamp.fromMillis(Date.now() - 1),
  });
  const expired = await postTransition(page, {
    action: "complete",
    careerVisibility: "public",
    transitionId: begin.payload.transitionId,
    transitionSecret: begin.payload.transitionSecret,
  });
  expect(expired.status).toBe(409);
  expect(expired.payload.error).toBe("transition_expired");
  const profile = (await db.collection("public_profiles").doc(USERS.owner.uid).get()).data();
  expect(profile.careerVisibility).toBe("private");
  expect(profile.careerPolicyVersion).toBe(7);
});
