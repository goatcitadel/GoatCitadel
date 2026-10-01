import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const app = path.join(repo, "apps/mission-control-next");
const requireApp = createRequire(path.join(app, "package.json"));
const requireTailwind = createRequire(requireApp.resolve("@tailwindcss/vite"));
const { compile } = requireTailwind("@tailwindcss/node");
const candidates = ["text-xs", "text-sm", "text-base", "text-md", "text-lg", "text-xl", "text-2xl", "font-medium",
  "font-semibold", "font-sans", "font-display", "font-mono", "bg-raised", "text-fg", "bg-accent", "text-accent-ink"];
let browser, cockpitCss, classicCss;
async function styles(files) {
  const imports = files.map((file) => `@import "./src/${file}";`).join("\n");
  const compiler = await compile(imports, { base: app, onDependency() {} });
  return compiler.build(candidates);
}
before(async () => {
  cockpitCss = await styles(["cockpit/styles/cockpit.css"]);
  classicCss = await styles(["styles/mission-control-next-tokens.css", "styles/mission-control-next-foundation.css",
    "styles/mission-control-next-theme-bridge.css", "styles/mission-control-next.css", "features/native-routes/primitives/primitives.css"]);
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); });

async function snapshot(page) {
  return page.evaluate(() => Object.fromEntries(["body", "#button", "#input", "#textarea", "#display"].map((selector) => {
    const computed = getComputedStyle(document.querySelector(selector));
    return [selector, Object.fromEntries(["color", "backgroundColor", "fontFamily", "fontSize", "fontWeight", "lineHeight"].map((field) => [field, computed[field]]))];
  })));
}
async function fixture(theme, shell) {
  const page = await browser.newPage();
  // Font binaries are irrelevant to computed CSS and this proof makes no network requests.
  await page.route("**/*", (route) => route.abort());
  await page.setContent(`<html data-shell="${shell}" data-theme="${theme}"><body>
    <button id="button" class="text-sm font-medium font-sans bg-accent text-accent-ink mc-next-button">Review</button>
    <input id="input" class="text-xs font-semibold font-mono bg-raised text-fg" value="Retained input">
    <textarea id="textarea" class="text-base font-sans bg-raised text-fg">Retained notes</textarea>
    <div id="display" class="text-xl font-display">Owner review</div></body></html>`);
  // Compare the settled cascade rather than intermediate transition colors.
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });
  if (shell === "classic") await page.evaluate((value) => {
    document.documentElement.className = value;
    document.body.className = value;
  }, theme === "dark" ? "theme-signal-noir" : "theme-citadel-light");
  return page;
}

describe("same-document shell CSS coexistence in Chromium", () => {
  for (const theme of ["light", "dark"]) {
    it(`keeps cockpit body and control typography/colors after a cancelled classic load (${theme})`, async () => {
      const page = await fixture(theme, "cockpit");
      try {
        // Use cockpit classes only; classic controls intentionally have their own styles.
        await page.locator("#button").evaluate((button) => button.classList.remove("mc-next-button"));
        await page.addStyleTag({ content: cockpitCss });
        const before = await snapshot(page);
        assert.equal(before.body.fontSize, "14px");
        assert.equal(before["#button"].fontSize, "13px");
        assert.equal(before["#button"].fontWeight, "500");
        assert.equal(before["#input"].fontSize, "12px");
        assert.equal(before["#display"].fontSize, "24px");
        await page.addStyleTag({ content: classicCss });
        assert.deepEqual(await snapshot(page), before, "Loading classic styles changed the still-active cockpit.");
      } finally { await page.close(); }
    });
    it(`keeps classic body and controls equivalent with cockpit styles retained (${theme})`, async () => {
      const page = await fixture(theme, "classic");
      try {
        // Classic does not render cockpit utility classes; match its own controls.
        await page.evaluate(() => {
          for (const element of document.querySelectorAll("[id]")) element.className = element.id === "button" ? "mc-next-button" : "";
        });
        const classicOnly = await page.addStyleTag({ content: classicCss });
        const before = await snapshot(page);
        await classicOnly.evaluate((style) => style.remove());
        await page.addStyleTag({ content: cockpitCss });
        await page.addStyleTag({ content: classicCss });
        assert.deepEqual(await snapshot(page), before, "Retained cockpit styles changed the classic owner typography or colors.");
      } finally { await page.close(); }
    });
    it(`keeps classic controls unchanged while a reverse cockpit chunk loads (${theme})`, async () => {
      const page = await fixture(theme, "classic");
      try {
        await page.evaluate(() => {
          for (const element of document.querySelectorAll("[id]")) element.className = element.id === "button" ? "mc-next-button" : "";
        });
        await page.addStyleTag({ content: classicCss });
        const before = await snapshot(page);
        await page.addStyleTag({ content: cockpitCss });
        assert.deepEqual(await snapshot(page), before, "A pending or cancelled cockpit load changed the active classic controls.");
      } finally { await page.close(); }
    });
  }
});
