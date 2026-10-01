import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcRoot = fileURLToPath(new URL("../../", import.meta.url));

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? cssFiles(full) : name.endsWith(".css") ? [full] : [];
  });
}

describe("Tailwind isolation", () => {
  it("imports Tailwind only from the cockpit stylesheet", () => {
    const importers = cssFiles(srcRoot)
      .filter((file) => readFileSync(file, "utf8").includes('@import "tailwindcss"'))
      .map((file) => path.relative(srcRoot, file).replace(/\\/g, "/"));
    expect(importers).toEqual(["cockpit/styles/cockpit.css"]);
  });

  it("defines both themes and the density variant", () => {
    const css = readFileSync(fileURLToPath(new URL("./cockpit.css", import.meta.url)), "utf8");
    expect(css).toContain('@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));');
    expect(css).toContain('@custom-variant compact (&:where([data-density="compact"], [data-density="compact"] *));');
    expect(css).toMatch(/--breakpoint-md:\s*64rem;/);
    expect(css).toMatch(/--text-md:\s*1rem;/);
  });
});
