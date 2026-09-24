import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Resolved from this file, not the process CWD, so the check runs the same
// from the repo root and from the package.
const calmCss = readFileSync(new URL("./calm-surfaces.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return calmCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

describe("calm surface card styles", () => {
  it("lays card status stats out as compact wrapping chips so a lone stat does not span the card", () => {
    const statsRule = rule(".mc-next-shell .mc-next-directory-card-head > .mc-next-directory-stats");
    expect(statsRule).toMatch(/display:\s*flex/);
    expect(statsRule).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(".mc-next-shell .mc-next-directory-card-head > .mc-next-directory-stats > div")).toMatch(
      /flex:\s*0 1 auto/,
    );
  });
});
