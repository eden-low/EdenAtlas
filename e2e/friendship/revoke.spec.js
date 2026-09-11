const { test, expect } = require("../fixtures/emulator-test.js");
const { USERS } = require("../constants.js");
const { signInFromUi, assertLocalFirebaseRuntime } = require("../helpers/browser-auth.js");
const { firestoreOperation } = require("../helpers/browser-client.js");
const { seedFriendship } = require("../helpers/domain-fixtures.js");
const { getAdminServices } = require("../helpers/emulator-fixtures.js");

function friendshipRefs(db) {
  return {
    owner: db.collection("friendships").doc(USERS.owner.uid).collection("friends").doc(USERS.verifiedNonOwner.uid),
    verified: db.collection("friendships").doc(USERS.verifiedNonOwner.uid).collection("friends").doc(USERS.owner.uid),
    request: db.collection("friend_requests").doc(USERS.verifiedNonOwner.uid).collection("incoming").doc(USERS.owner.uid),
  };
}

async function expectRevoked(db) {
  const refs = friendshipRefs(db);
  await expect.poll(async () => {
    const [owner, verified, request] = await Promise.all([
      refs.owner.get(), refs.verified.get(), refs.request.get(),
    ]);
    return `${owner.exists}:${verified.exists}:${request.data()?.status}`;
  }).toBe("false:false:cancelled");
}

test("authorized participant revokes through the dashboard and stale reload cannot resurrect it", async ({ page }) => {
  await seedFriendship();
  await signInFromUi(page, USERS.owner, "dashboard.html");
  await assertLocalFirebaseRuntime(page, USERS.owner.uid);
  await expect(page.getByRole("button", { name: /remove friend/i })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /remove friend/i }).click();

  const { db } = getAdminServices();
  await expectRevoked(db);
  await page.reload({ waitUntil: "commit" });
  await expect(page.getByRole("button", { name: /remove friend/i })).toHaveCount(0);
  await expectRevoked(db);
});

for (const [missingMirrorFor, activeUser] of [
  ["verifiedNonOwner", USERS.owner],
  ["owner", USERS.verifiedNonOwner],
]) {
  test(`asymmetric ${missingMirrorFor} mirror is pruned and accepted request cannot self-heal`, async ({ page }) => {
    await seedFriendship({ missingMirrorFor });
    await signInFromUi(page, activeUser, "dashboard.html");
    await assertLocalFirebaseRuntime(page, activeUser.uid);
    const { db } = getAdminServices();
    await expectRevoked(db);
    await page.reload({ waitUntil: "commit" });
    await expectRevoked(db);
  });
}

test("unrelated and unauthenticated clients cannot revoke another pair", async ({ page }) => {
  await seedFriendship();
  const protectedMirror = `friendships/${USERS.owner.uid}/friends/${USERS.verifiedNonOwner.uid}`;

  await signInFromUi(page, USERS.unrelated);
  const unrelatedDelete = await firestoreOperation(page, "delete", protectedMirror);
  expect(unrelatedDelete.uid).toBe(USERS.unrelated.uid);
  expect(unrelatedDelete.ok).toBe(false);
  expect(unrelatedDelete.code).toContain("permission-denied");

  await page.evaluate(async () => {
    const { auth } = await import("/js/firebase-init.js");
    const { signOut } = await import("https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js");
    await signOut(auth);
  });
  await page.goto("/login.html", { waitUntil: "commit" });
  await assertLocalFirebaseRuntime(page, null);
  const anonymousDelete = await firestoreOperation(page, "delete", protectedMirror);
  expect(anonymousDelete.uid).toBeNull();
  expect(anonymousDelete.ok).toBe(false);
  expect(anonymousDelete.code).toContain("permission-denied");

  const { db } = getAdminServices();
  const refs = friendshipRefs(db);
  expect((await refs.owner.get()).exists).toBe(true);
  expect((await refs.verified.get()).exists).toBe(true);
  expect((await refs.request.get()).data().status).toBe("accepted");
});
