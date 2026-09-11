const base = require("@playwright/test");
const { resetFixtures, cleanupAll } = require("../helpers/emulator-fixtures.js");
const { isForbiddenFirebaseEndpoint } = require("../helpers/safety.js");

const test = base.test.extend({
  emulatorFixtures: [async ({}, use) => {
    await resetFixtures();
    try {
      await use();
    } finally {
      await cleanupAll();
    }
  }, { auto: true }],
  firebaseNetworkIsolation: [async ({ context }, use) => {
    const blocked = [];
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (isForbiddenFirebaseEndpoint(url)) {
        blocked.push(new URL(url).origin);
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    try {
      await use();
    } finally {
      if (blocked.length) {
        throw new Error(`E2E safety refusal: non-loopback Firebase endpoint attempted (${[...new Set(blocked)].join(", ")})`);
      }
    }
  }, { auto: true }],
});

module.exports = { test, expect: base.expect };
