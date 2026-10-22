import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { EmbeddedClassicPage } from "./EmbeddedClassicPage";

const css = readFileSync(fileURLToPath(new URL("../styles/embedded-classic.css", import.meta.url)), "utf8");

it("renders children inside the cockpit column with the containment class", () => {
  const html = renderToStaticMarkup(
    <EmbeddedClassicPage>
      <p>Classic body</p>
    </EmbeddedClassicPage>,
  );
  expect(html).toMatch(/^<div class="[^"]*\bmax-w-5xl\b[^"]*">/);
  expect(html).toMatch(/^<div class="[^"]*\bcockpit-embedded-classic\b/);
  expect(html).toContain("<p>Classic body</p>");
});

it("skips the column padding when the caller already owns the column", () => {
  const html = renderToStaticMarkup(
    <EmbeddedClassicPage inColumn>
      <p>Classic body</p>
    </EmbeddedClassicPage>,
  );
  expect(html).toMatch(/^<div class="[^"]*\bcockpit-embedded-classic\b/);
  expect(html).not.toContain("max-w-5xl");
});

it("scopes the containment rules", () => {
  expect(css).toContain(".cockpit-embedded-classic .mc-next-visually-hidden");
  expect(css).toMatch(/\.cockpit-embedded-classic \.mc-next-button[^{]*\{[^}]*display:\s*inline-flex/);
  expect(css).toContain(".cockpit-embedded-classic .mc-pp-kicker");
  expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  // Every rule is scoped, so nothing leaks into cockpit-native surfaces.
  for (const selector of css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("}")
    .map((block) => (block.split("{")[0] ?? "").trim())
    .filter(Boolean)) {
    for (const part of selector.split(",")) expect(part.trim()).toMatch(/^\.cockpit-embedded-classic\b/);
  }
});
