import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./accessible-controls.css", import.meta.url)), "utf8");

function unlayered(source: string): string {
  const start = source.indexOf("@layer base {");
  if (start < 0) return source;
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}" && --depth === 0) return unlayered(source.slice(0, start) + source.slice(index + 1));
  }
  return source;
}

describe("Cockpit accessible controls", () => {
  it("keeps control defaults below Tailwind utilities", () => {
    expect(css).toContain("@layer base {");
    const outside = unlayered(css).replace(/@media \(forced-colors: active\)[\s\S]*$/, "");
    expect(outside).not.toMatch(/height:\s*auto/);
    expect(outside).not.toMatch(/min-height:\s*2em/);
    expect(outside).not.toMatch(/border-color:\s*var\(/);
    expect(outside).not.toMatch(/box-shadow:/);
  });

  it("limits the selected underline to tabs and the phone tab bar without changing weight", () => {
    expect(css).not.toMatch(/font-weight/);
    expect(css).toContain('[role="tab"][aria-selected="true"], [data-cockpit-tabbar] [aria-current="page"]');
  });

  it("keeps focus, coarse-pointer, reduced-motion and forced-colors rules", () => {
    expect(css).toMatch(/:focus-visible \{\s*outline: 2px solid var\(--cockpit-accent\) !important;/);
    expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]*min-height: max\(44px, 2em\)/);
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("@media (forced-colors: active)");
  });
});
