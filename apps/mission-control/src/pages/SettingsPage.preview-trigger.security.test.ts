import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression coverage for CODEX_FINDING #30: the Mission Control Settings
// page previously contained a debounced useEffect that auto-POSTed
// `/api/v1/llm/models/preview` on every base-URL field change. Even with
// the service-side host-mismatch credential guard, that turned the field
// into a side-effect surface — an attacker who could influence the field
// (XSS, social-engineered paste) triggered the request without an
// explicit operator gesture. The fix removes the auto-invoke; the
// operator must click the "Load models" button.
//
// This test pins source-level invariants. Constructing the full
// component + dependency graph in a unit test is heavy; the static check
// is the cheapest reliable guard against the regression.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const settingsPagePath = path.resolve(__dirname, "SettingsPage.tsx");

describe("SettingsPage model-preview trigger (codex #30)", () => {
  const source = readFileSync(settingsPagePath, "utf8");

  it("does not contain a setTimeout-based onLoadModels auto-invoke", () => {
    // The previous bug: `modelPreviewTimerRef.current = setTimeout(() => { … onLoadModels(...) }, 600);`
    // No call to onLoadModels should be wrapped in setTimeout anymore.
    const setTimeoutLoad = source.match(/setTimeout\([\s\S]{0,400}?onLoadModels/);
    expect(setTimeoutLoad, "Auto-invoke setTimeout block re-introduced — see codex #30").toBeNull();
  });

  it("does not include providerBaseUrl in any useEffect dependency array that calls onLoadModels", () => {
    // Catch a softer regression: dropping the setTimeout but keeping
    // `providerBaseUrl` in a useEffect that calls onLoadModels would
    // still auto-fire on every keystroke.
    const effectBlocks = source.matchAll(/useEffect\(\(\)\s*=>\s*\{([\s\S]*?)\},\s*\[([\s\S]*?)\]\s*\)/g);
    for (const match of effectBlocks) {
      const body = match[1] ?? "";
      const deps = match[2] ?? "";
      if (body.includes("onLoadModels") && deps.includes("providerBaseUrl")) {
        throw new Error(
          "Found a useEffect that calls onLoadModels with providerBaseUrl in its dependency array; this re-introduces the codex #30 auto-invoke.",
        );
      }
    }
  });

  it("wires onLoadModels to an explicit user-click handler", () => {
    // The explicit button-driven trigger must remain available so
    // operators can fetch models when they choose to.
    expect(source).toMatch(/onLoadModels=\{\(\)\s*=>\s*\{[\s\S]{0,120}?onLoadModels\(/);
  });
});
