import { test } from "node:test";
import assert from "node:assert/strict";
import {
  relLuminance,
  contrastRatio,
  buildThemeTokens,
  collectContrastViolations,
} from "./check-mission-control-next-contrast.mjs";

test("relative luminance extremes", () => {
  assert.ok(Math.abs(relLuminance({ r: 255, g: 255, b: 255 }) - 1) < 1e-6);
  assert.ok(relLuminance({ r: 0, g: 0, b: 0 }) < 1e-6);
});

test("WCAG contrast of black on white is ~21:1", () => {
  const r = contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 });
  assert.ok(r > 20.9 && r < 21.1, `expected ~21, got ${r}`);
});

test("both theme token maps resolve and include surfaces", async () => {
  const themes = await buildThemeTokens();
  assert.ok(themes.dark.has("--bg-app") && themes.dark.has("--fg-primary"));
  assert.ok(themes.light.has("--bg-app") && themes.light.has("--fg-primary"));
});

// Regression guard: every semantically-required foreground/background pair must
// clear AA 4.5:1 in BOTH themes. Exercises the full var()/color-mix/oklch path
// (the per-area --primary is a color-mix of oklch area accents). If a token edit
// drops a pair below AA, this fails before the change can ship.
test("all required token pairs clear AA in both themes", async () => {
  const themes = await buildThemeTokens();
  const violations = collectContrastViolations(themes);
  assert.deepEqual(
    violations,
    [],
    "contrast violations:\n" + violations.map((v) => `  ${JSON.stringify(v)}`).join("\n"),
  );
});
