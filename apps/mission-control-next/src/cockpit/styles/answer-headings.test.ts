import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./cockpit.css", import.meta.url)), "utf8").replace(/\s+/g, " ");
const ANSWER = ".cockpit-chat-content .mc-assistant-markdown";

/** The declarations of the rule with exactly this selector, so formatting and declaration order don't matter. */
function declarations(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  return body
    .split(";")
    .map((declaration) => declaration.trim())
    .filter(Boolean);
}

describe("Chat answer headings", () => {
  it("size every heading level at or above the answer body", () => {
    expect(declarations(`${ANSWER} h1`)).toContain("font-size: var(--text-xl)");
    expect(declarations(`${ANSWER} h2`)).toContain("font-size: var(--text-lg)");
    expect(declarations(`${ANSWER} :is(h3, h4, h5, h6)`)).toContain("font-size: var(--text-md)");
  });

  it("give all headings the display face and a tight line height", () => {
    expect(declarations(`${ANSWER} :is(h1, h2, h3, h4, h5, h6)`)).toEqual(
      expect.arrayContaining(["font-family: var(--font-display)", "font-weight: 600", "line-height: 1.3"]),
    );
  });

  it("space a heading from the text above it", () => {
    expect(declarations(`${ANSWER} :is(h1, h2, h3, h4, h5, h6):not(:first-child)`)).toContain("margin-top: 1.25em");
  });
});
