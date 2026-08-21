import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const firebaseInit = fs.readFileSync(path.join(root, "firebase-init.js"), "utf8");
const login = fs.readFileSync(path.join(root, "login.html"), "utf8");
const calendar = fs.readFileSync(path.join(root, "calendar.js"), "utf8");
const calendarHtml = fs.readFileSync(path.join(root, "calendar.html"), "utf8");
const buildInfoGenerator = fs.readFileSync(path.join(root, "scripts", "generate-build-info.js"), "utf8");

assert.ok(firebaseInit.includes("export const googleProvider = new GoogleAuthProvider();"));
assert.ok(!firebaseInit.includes("googleProvider.addScope"));
assert.ok(!firebaseInit.includes("calendar.events.readonly"));
assert.ok(!login.includes("credentialFromResult"));
assert.ok(calendar.includes('"/.netlify/functions/google-calendar-oauth-start"'));
assert.ok(calendar.includes('"/.netlify/functions/google-calendar-status"'));
assert.ok(!calendar.includes("calendar/v3"));
assert.ok(!calendar.includes("events.list"));
assert.ok(calendar.includes('authorizationUrl.origin !== "https://accounts.google.com"'));
assert.ok(calendarHtml.includes("Connect Google Calendar"));
assert.ok(calendarHtml.includes("READ ONLY"));
assert.ok(!buildInfoGenerator.includes("GOOGLE_CALENDAR_CLIENT_SECRET"));
assert.ok(!buildInfoGenerator.includes("GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY"));

console.log("google-calendar-ui.test.js: 14 assertions passed");
