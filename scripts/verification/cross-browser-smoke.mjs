#!/usr/bin/env node
/**
 * Loads every cockpit area in Firefox and WebKit against a running stack and reports page
 * errors, console errors and failed requests. Dev-only: start a sandbox with `pnpm testbench`.
 *
 * The engines are a separate download the operator approves first:
 *   pnpm exec playwright install firefox webkit
 *
 * Usage: node scripts/verification/cross-browser-smoke.mjs --ui <cockpit URL> [--engines firefox,webkit]
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, firefox, webkit } from "playwright";
import { repoRoot } from "./lib/shared.mjs";

export const SMOKE_PATHS = ["/chat", "/inbox", "/work", "/library", "/system/health", "/settings/general"];
const ENGINES = { chromium, firefox, webkit };

export function parseSmokeArgs(argv) {
  let ui = "";
  let engines = ["firefox", "webkit"];
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--ui" && value) {
      ui = value;
      index++;
    } else if (flag === "--engines" && value) {
      engines = value
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      index++;
    } else {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
  }
  if (!ui) throw new Error("--ui <cockpit URL> is required.");
  const url = new URL(ui);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("--ui must be an http or https URL.");
  if (engines.length === 0) throw new Error("--engines must name at least one engine.");
  // Own keys only: "constructor" and "toString" are not engines.
  for (const engine of engines) if (!Object.hasOwn(ENGINES, engine)) throw new Error(`Unknown engine: ${engine}`);
  return { ui: url.origin, engines };
}

export function smokeUrl(origin, routePath) {
  const url = new URL(routePath, origin);
  url.searchParams.set("shell", "cockpit");
  return url.toString();
}

function firstLine(error) {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0];
}

async function smokeRoute(browser, engine, origin, routePath, outDir) {
  // A fresh page per route. The cockpit keeps a live event stream open; reusing one page would abort that stream
  // during the next navigation and report the abort as a failed request on the wrong route.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems = [];
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  page.on("requestfailed", (request) =>
    problems.push(`request failed: ${request.method()} ${new URL(request.url()).pathname}`),
  );
  try {
    await page.goto(smokeUrl(origin, routePath), { waitUntil: "domcontentloaded" });
    await page.locator('[data-cockpit-ready="true"]').waitFor({ timeout: 30_000 });
    // The live event stream keeps a request open, so "network idle" never comes; settle briefly instead.
    await page.waitForTimeout(1_500);
    await page.screenshot({
      path: path.join(outDir, `${engine}${routePath.replaceAll("/", "-")}.png`),
      fullPage: true,
    });
  } catch (error) {
    problems.push(`load failed: ${firstLine(error)}`);
  }
  // Copy before closing: closing the page aborts its event stream, and that abort is not a finding.
  const observed = [...problems];
  await page.close().catch(() => undefined);
  return { engine, path: routePath, problems: observed };
}

async function smokeEngine(engine, origin, outDir) {
  const browser = await ENGINES[engine].launch({ headless: true });
  const results = [];
  try {
    for (const routePath of SMOKE_PATHS) results.push(await smokeRoute(browser, engine, origin, routePath, outDir));
  } finally {
    await browser.close();
  }
  return results;
}

async function main() {
  const { ui, engines } = parseSmokeArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(repoRoot, "artifacts", "verification", "cross-browser-smoke", stamp);
  await mkdir(outDir, { recursive: true });
  const results = [];
  for (const engine of engines) {
    try {
      results.push(...(await smokeEngine(engine, ui, outDir)));
    } catch (error) {
      // A missing engine or a crashed browser must not discard the other engines' results.
      results.push({
        engine,
        path: "(engine)",
        problems: [
          `engine failed: ${firstLine(error)}`,
          `if it is not installed, run: pnpm exec playwright install ${engine}`,
        ],
      });
    }
  }
  for (const result of results) {
    process.stdout.write(`${result.problems.length ? "FAIL" : "ok  "} ${result.engine.padEnd(8)} ${result.path}\n`);
    for (const problem of result.problems) process.stdout.write(`     ${problem}\n`);
  }
  process.stdout.write(`Screenshots: ${outDir}\n`);
  if (results.some((result) => result.problems.length)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
