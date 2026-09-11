const fs = require("fs");
const http = require("http");
const path = require("path");
const { SITE_ROOT, TOPOLOGY } = require("../constants.js");

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
};

function resolveRequestPath(rawUrl) {
  const pathname = decodeURIComponent(new URL(rawUrl, "http://127.0.0.1").pathname);
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(SITE_ROOT, requested);
  if (resolved !== SITE_ROOT && !resolved.startsWith(`${SITE_ROOT}${path.sep}`)) return null;
  return resolved;
}

function readRequestBody(request, maximumBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on("data", (chunk) => {
      length += chunk.length;
      if (length > maximumBytes) {
        reject(new Error("Local function request exceeded the E2E body limit"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function startStaticServer({ functionHandlers = {} } = {}) {
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    const functionHandler = functionHandlers[requestUrl.pathname];
    if (functionHandler) {
      try {
        const result = await functionHandler({
          httpMethod: request.method,
          headers: request.headers,
          body: await readRequestBody(request),
        });
        response.writeHead(result.statusCode, result.headers || {});
        response.end(result.body || "");
      } catch {
        response.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ ok: false, error: "local_function_failed" }));
      }
      return;
    }
    const target = resolveRequestPath(request.url || "/");
    if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": CONTENT_TYPES[path.extname(target).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(target).pipe(response);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(4173, TOPOLOGY.auth.host, () => resolve({
      server,
      close: () => new Promise((done, fail) => server.close((error) => error ? fail(error) : done())),
    }));
  });
}

module.exports = { startStaticServer, resolveRequestPath, readRequestBody };
