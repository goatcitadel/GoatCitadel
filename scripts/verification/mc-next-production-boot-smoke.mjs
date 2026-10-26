#!/usr/bin/env node
/**
 * Production boot smoke for apps/mission-control-next.
 *
 * Serves the built `dist` over HTTP (SPA fallback to index.html), opens each route in headless
 * Chromium with no gateway running, and fails when the React root never mounts or any uncaught
 * page error is raised. Unit tests and the dev server never execute the production chunk graph, so
 * a chunk cycle that leaves the page blank (for example `reading 'useLayoutEffect'`) only shows up
 * here.
 *
 * No gateway is started: the cockpit mounts its shell and shows its offline/connecting state when
 * API calls are refused, so the root still mounts. Failed fetches are console/network noise, not
 * page errors, and are intentionally ignored.
 *
 * Usage: node scripts/verification/mc-next-production-boot-smoke.mjs [--dist <dir>] [--timeout-ms 20000]
 * Build first: pnpm --filter "@goatcitadel/mission-control-next..." --workspace-concurrency=1 build
 */
/* global document -- evaluated in Chromium by Playwright. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./lib/shared.mjs";

export const DEFAULT_DIST_DIR = path.join(repoRoot, "apps", "mission-control-next", "dist");
export const DEFAULT_MOUNT_TIMEOUT_MS = 20_000;
export const SETTLE_AFTER_MOUNT_MS = 2_000;
export const BOOT_ROUTES = Object.freeze(["/chat?shell=cockpit", "/"]);

const CONTENT_TYPES = Object.freeze({
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
});

export function parseBootSmokeArgs(argv, defaults = {}) {
  const options = {
    dist: defaults.dist ?? DEFAULT_DIST_DIR,
    timeoutMs: defaults.timeoutMs ?? DEFAULT_MOUNT_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--dist" && value) {
      options.dist = path.resolve(value);
      index += 1;
    } else if (flag === "--timeout-ms" && value) {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`--timeout-ms must be a positive integer, got "${value}".`);
      }
      options.timeoutMs = parsed;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
  }
  return options;
}

function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Resolves a request path inside `distDir`, or null (the caller then serves index.html). */
export function resolveStaticFile(distDir, pathname, exists = fileExists) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const root = path.resolve(distDir);
  const candidate = path.resolve(root, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return null;
  return exists(candidate) ? candidate : null;
}

/** Formats a Playwright page error as a short, readable block. */
export function describePageError(error) {
  const message = error?.message ?? String(error);
  const stack = String(error?.stack ?? "")
    .split("\n")
    .filter((line) => line.trim() && !line.includes(message) && !message.includes(line.trim()))
    .slice(0, 3)
    .join("\n");
  return stack ? `${message}\n${stack}` : message;
}

/** Pure verdict for one route: it passes only when the root mounted and no page error was seen. */
export function evaluateBootResult({ route, rootChildCount, pageErrors, navigationError }) {
  const problems = [];
  if (navigationError) problems.push(`navigation failed: ${navigationError}`);
  if (!(rootChildCount > 0)) problems.push("React root (#root) never mounted any content");
  for (const error of pageErrors) problems.push(`page error: ${error}`);
  return { route, ok: problems.length === 0, problems };
}

export function summarizeBootResults(results) {
  const failed = results.filter((result) => !result.ok);
  const lines = results.map((result) => `${result.ok ? "PASS" : "FAIL"} ${result.route}`);
  for (const result of failed) {
    lines.push(`\n${result.route}`);
    for (const problem of result.problems) lines.push(`  - ${problem.replaceAll("\n", "\n    ")}`);
  }
  return { ok: failed.length === 0, text: lines.join("\n") };
}

export function createDistServer(distDir) {
  const indexFile = path.join(distDir, "index.html");
  return http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const file = resolveStaticFile(distDir, url.pathname) ?? indexFile;
    response.writeHead(200, { "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(response);
  });
}

async function probeRoute(browser, origin, route, timeoutMs) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const pageErrors = [];
  let navigationError;
  let rootChildCount = -1;
  try {
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(describePageError(error)));
    try {
      await page.goto(`${origin}${route}`, { waitUntil: "load", timeout: timeoutMs });
      await page
        .waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0, undefined, {
          timeout: timeoutMs,
        })
        .catch(() => undefined);
      // Lazy chunks can throw just after the first paint; give them a moment.
      await page.waitForTimeout(SETTLE_AFTER_MOUNT_MS);
      rootChildCount = await page.evaluate(() => document.getElementById("root")?.childElementCount ?? -1);
    } catch (error) {
      navigationError = error instanceof Error ? error.message : String(error);
    }
  } finally {
    await context.close();
  }
  return evaluateBootResult({ route, rootChildCount, pageErrors, navigationError });
}

export async function runBootSmoke({ dist, timeoutMs }) {
  if (!fileExists(path.join(dist, "index.html"))) {
    throw new Error(
      `No production build found at ${dist}. Build it first:\n  pnpm --filter "@goatcitadel/mission-control-next..." --workspace-concurrency=1 build`,
    );
  }
  const { chromium } = await import("playwright");
  const server = createDistServer(dist);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  // The listening server must close even when Chromium never launches (for example, a missing browser
  // binary); otherwise it keeps Node alive and the check hangs instead of failing.
  let browser;
  try {
    browser = await chromium.launch();
    const results = [];
    for (const route of BOOT_ROUTES) results.push(await probeRoute(browser, origin, route, timeoutMs));
    return results;
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  const options = parseBootSmokeArgs(process.argv.slice(2));
  const summary = summarizeBootResults(await runBootSmoke(options));
  console.log(summary.text);
  if (summary.ok) {
    console.log("\nmission-control-next production boot smoke passed.");
  } else {
    console.error("\nmission-control-next production boot smoke FAILED.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
