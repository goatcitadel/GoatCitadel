#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const host = process.env.GOATCITADEL_UI_HOST || "127.0.0.1";
const port = Number(process.env.GOATCITADEL_UI_PORT || 5173);
const distDir = process.env.GOATCITADEL_UI_DIST_DIR
  ? path.resolve(process.env.GOATCITADEL_UI_DIST_DIR)
  : path.resolve(process.cwd(), "mission-control", "dist");

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

if (!fs.existsSync(path.join(distDir, "index.html"))) {
  throw new Error(`Mission Control dist directory is missing: ${distDir}`);
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url || "/", `http://${host}:${port}`);

  if (requestUrl.pathname === "/health") {
    return sendJson(response, 200, { status: "ok" });
  }

  const requestedPath = requestUrl.pathname === "/"
    ? path.join(distDir, "index.html")
    : path.resolve(distDir, `.${decodeURIComponent(requestUrl.pathname)}`);

  const safeRoot = `${distDir}${path.sep}`;
  if (!requestedPath.startsWith(safeRoot) && requestedPath !== path.join(distDir, "index.html")) {
    return sendJson(response, 403, { error: "Forbidden" });
  }

  const finalPath = resolveStaticPath(requestedPath);
  if (!finalPath) {
    return sendJson(response, 404, { error: "Not found" });
  }
  const extension = path.extname(finalPath).toLowerCase();
  response.writeHead(200, {
    "Content-Type": contentTypes[extension] || "application/octet-stream",
    "Cache-Control": resolveCacheControl(finalPath, requestUrl),
  });
  fs.createReadStream(finalPath).pipe(response);
});

server.listen(port, host, () => {
  process.stdout.write(`[goatcitadel] Mission Control static server listening on http://${host}:${port}\n`);
});

function resolveStaticPath(candidatePath) {
  if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
    return candidatePath;
  }
  if (path.extname(candidatePath)) {
    return null;
  }
  return path.join(distDir, "index.html");
}

function resolveCacheControl(finalPath, requestUrl) {
  const pathname = requestUrl.pathname.toLowerCase();
  if (finalPath.endsWith(".html") || pathname.endsWith("/sw.js") || pathname.endsWith("/manifest.webmanifest")) {
    return "no-store, max-age=0, must-revalidate";
  }
  return "public, max-age=31536000, immutable";
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0, must-revalidate",
  });
  response.end(JSON.stringify(payload));
}
