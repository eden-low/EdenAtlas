#!/usr/bin/env node
// EdenAtlas deterministic source-to-publish build.
//
// Netlify publishes site/, never the repository root. This script keeps the existing public
// layout while the tracked source lives under frontend/: pages are flattened into site/, JS and
// asset directories retain their public directory names, and source-only/test files stay out.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const FRONTEND = path.join(ROOT, "frontend");
const OUT = path.join(ROOT, "site");

// Deliberately hardcoded rather than globbed: a new HTML utility under frontend/pages/ must not
// become public accidentally. Each mapped page lands at site/<name>, never site/pages/<name>.
const PAGE_FILES = [
  "atlas.html", "calendar.html", "collection-detail.html", "collections.html",
  "constellation.html", "contact.html", "dashboard.html", "discover.html", "expenses.html",
  "gallery.html", "habits.html", "home.html", "index.html", "journal.html", "login.html",
  "me.html", "notifications.html", "portfolio.html", "profile.html", "project.html",
  "reports.html", "resume.html", "settings.html", "time-capsule.html", "timeline.html",
  "assistant.html",
];

const SOURCE_FILE_MAPPINGS = [
  ...PAGE_FILES.map((name) => ({ source: path.join("frontend", "pages", name), target: name })),
  { source: path.join("frontend", "styles", "styles.css"), target: "styles.css" },
  { source: path.join("frontend", "manifest.json"), target: "manifest.json" },
  { source: path.join("frontend", "service-worker.js"), target: "service-worker.js" },
  // build:css intentionally generates this at repo root; its public location also stays root.
  { source: "tailwind.generated.css", target: "tailwind.generated.css" },
];

const SOURCE_DIR_MAPPINGS = [
  { source: path.join("frontend", "js"), target: "js", excludeTestScaffolding: true },
  { source: path.join("frontend", "images"), target: "images" },
  { source: path.join("frontend", "locales"), target: "locales" },
];

// Intentionally not mapped: docs, Firebase/Netlify config, rules source, backend/, scripts/,
// scripts/migrate-career.html, Tailwind input/config, package manifests, and all other files.

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyFile(mapping) {
  const src = path.join(ROOT, mapping.source);
  if (!fs.existsSync(src)) {
    throw new Error(`build-site: mapped source file is missing on disk: ${mapping.source}`);
  }
  const dest = path.join(OUT, mapping.target);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function isTestScaffolding(src) {
  const rel = path.relative(FRONTEND, src).split(path.sep).join("/");
  return /(^|\/)__tests__(\/|$)/.test(rel) || /(^|\/)package(-lock)?\.json$/.test(rel);
}

function copyDir(mapping) {
  const src = path.join(ROOT, mapping.source);
  if (!fs.existsSync(src)) {
    throw new Error(`build-site: mapped source directory is missing on disk: ${mapping.source}`);
  }
  const filter = mapping.excludeTestScaffolding
    ? (candidate) => !isTestScaffolding(candidate)
    : undefined;
  fs.cpSync(src, path.join(OUT, mapping.target), { recursive: true, filter });
}

// Prevent staging/preview pages from being indexed. Unknown/local contexts fail closed; only an
// explicit Production context omits this generated header, preserving the original behavior.
function writeRobotsHeader() {
  if (process.env.CONTEXT === "production") return;
  const contents = "/*\n  X-Robots-Tag: noindex, nofollow\n";
  fs.writeFileSync(path.join(OUT, "_headers"), contents, "utf8");
  console.log(
    `build-site: wrote _headers with X-Robots-Tag: noindex ` +
    `(CONTEXT=${process.env.CONTEXT || "unset"})`
  );
}

function build() {
  rmrf(OUT);
  fs.mkdirSync(OUT, { recursive: true });
  SOURCE_FILE_MAPPINGS.forEach(copyFile);
  SOURCE_DIR_MAPPINGS.forEach(copyDir);
  writeRobotsHeader();
  console.log(
    `build-site: copied ${SOURCE_FILE_MAPPINGS.length} mapped files + ` +
    `${SOURCE_DIR_MAPPINGS.length} mapped directories into ${path.relative(ROOT, OUT)}/`
  );
}

if (require.main === module) {
  build();
}

module.exports = {
  build,
  PAGE_FILES,
  SOURCE_FILE_MAPPINGS,
  SOURCE_DIR_MAPPINGS,
  ROOT,
  FRONTEND,
  OUT,
};
