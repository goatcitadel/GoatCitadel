import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The strip is shared: the cockpit styles it with Tailwind utilities, but the Classic composer (the rollback shell)
// loads no Tailwind and styles it through these composer.css classes. Both must stay on the elements.
const CLASSIC_CLASSES = [
  "mc-next-composer-external-strip",
  "mc-next-composer-external-head",
  "mc-next-composer-inline-button",
  "mc-next-source-picker-backdrop",
  "mc-next-source-picker-dialog",
  "mc-next-source-picker-header",
  "mc-next-composer-external-error",
  "mc-next-composer-external-hint",
  "mc-next-composer-external-list",
  "mc-next-composer-external-chip",
  "mc-next-composer-external-chip-body",
  "mc-next-composer-external-select",
  "mc-next-composer-external-meta",
  "mc-next-composer-external-chip-actions",
  "mc-next-source-picker-attach",
  "mc-next-composer-external-attach-form",
  "mc-next-source-picker-footer",
] as const;

const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

describe("external source strip Classic styling", () => {
  const strip = read("./ThreadedExternalSourceStrip.tsx");
  const css = read("./styles/composer.css");

  it.each(CLASSIC_CLASSES)("emits %s and Classic's composer.css styles it", (name) => {
    expect(strip).toMatch(new RegExp(`className="[^"]*\\b${name}\\b`));
    expect(css).toMatch(new RegExp(`\\.${name}\\b`));
  });

  it("keeps a Classic class on every class-bearing element", () => {
    const classNames = [...strip.matchAll(/className="([^"]*)"/g)].map((match) => match[1]!);
    expect(classNames.length).toBeGreaterThan(0);
    for (const value of classNames) expect(value, value).toMatch(/\bmc-next-/);
  });
});
