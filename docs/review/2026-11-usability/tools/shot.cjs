#!/usr/bin/env node
// Usage: node docs/review/2026-11-usability/tools/shot.cjs <url> <out.png> [--phone] [--light]
//        [--workspace <id>] [--citadel <id>] [--wait <ms>]
// Opens the Cockpit with the workspace/citadel/theme keys set before navigation, waits for #main-content,
// saves an element screenshot of #main-content (the Cockpit scrolls inside it, so the viewport is grown to
// fit its content, capped at 8000 px) and prints console errors and failed requests as JSON lines.
// Defaults: workspace = env REVIEW_WORKSPACE_ID or "default", citadel = env REVIEW_CITADEL_ID or "personal".
// Playwright is resolved from the worktree's installed packages; nothing is added.
const path = require("node:path");
const fs = require("node:fs");
const { createRequire } = require("node:module");

const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
const { chromium } = createRequire(path.join(repoRoot, "package.json"))("playwright");

function parseArgs(argv) {
  const flags = { phone: false, light: false, workspace: null, citadel: null, wait: 0 };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--phone") flags.phone = true;
    else if (a === "--light") flags.light = true;
    else if (a === "--workspace") flags.workspace = argv[++i];
    else if (a === "--citadel") flags.citadel = argv[++i];
    else if (a === "--wait") flags.wait = Number(argv[++i]) || 0;
    else positional.push(a);
  }
  return { flags, positional };
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const [url, out] = positional;
  if (!url || !out) {
    console.error("usage: shot.cjs <url> <out.png> [--phone] [--light] [--workspace id] [--citadel id] [--wait ms]");
    process.exit(2);
  }
  const workspaceId = flags.workspace || process.env.REVIEW_WORKSPACE_ID || "default";
  const citadelId = flags.citadel || process.env.REVIEW_CITADEL_ID || "personal";
  const theme = flags.light ? "light" : "dark";
  const viewport = flags.phone ? { width: 375, height: 812 } : { width: 1440, height: 900 };

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport,
    colorScheme: theme,
    ...(flags.phone ? { isMobile: true, hasTouch: true } : {}),
  });
  await context.addInitScript(
    ([ws, citadel, th]) => {
      window.localStorage.setItem("goatcitadel.ui.workspace_id.v1", ws);
      window.localStorage.setItem("goatcitadel.ui.citadel_id.v1", citadel);
      window.localStorage.setItem("goatcitadel.ui.theme.v1", th);
    },
    [workspaceId, citadelId, theme],
  );
  const page = await context.newPage();
  const emit = (record) => console.log(JSON.stringify(record));
  page.on("console", (msg) => {
    if (msg.type() === "error") emit({ kind: "console-error", text: msg.text(), url: msg.location().url });
  });
  page.on("pageerror", (error) => emit({ kind: "page-error", text: String(error && error.message ? error.message : error) }));
  page.on("requestfailed", (request) =>
    emit({ kind: "request-failed", method: request.method(), url: request.url(), error: request.failure() && request.failure().errorText }),
  );
  page.on("response", (response) => {
    if (response.status() >= 400) emit({ kind: "http-error", status: response.status(), method: response.request().method(), url: response.url() });
  });

  let exitCode = 0;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("#main-content", { timeout: 30000 });
    try {
      await page.waitForLoadState("networkidle", { timeout: 10000 });
    } catch {
      // Live streams keep the network busy; a screenshot after the selector is still valid.
    }
    if (flags.wait > 0) await page.waitForTimeout(flags.wait);
    const main = page.locator("#main-content");
    const sizes = await main.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
    if (sizes.scroll > sizes.client) {
      const height = Math.min(8000, viewport.height + (sizes.scroll - sizes.client));
      await page.setViewportSize({ width: viewport.width, height });
      await page.waitForTimeout(300);
    }
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    await main.screenshot({ path: out });
    emit({ kind: "saved", path: out, theme, viewport: flags.phone ? "phone" : "desktop" });
  } catch (error) {
    emit({ kind: "shot-failed", text: String(error && error.message ? error.message : error) });
    exitCode = 1;
  } finally {
    await browser.close();
  }
  process.exit(exitCode);
}

main();
