import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./cockpit.css", import.meta.url)), "utf8").replace(/\s+/g, " ");

describe("Chat answer headings", () => {
  it("size h1 and h2 above the answer body and space headings from the text above", () => {
    expect(css).toContain(".cockpit-chat-content .mc-assistant-markdown h1 { font-size: var(--text-xl); }");
    expect(css).toContain(".cockpit-chat-content .mc-assistant-markdown h2 { font-size: var(--text-lg); }");
    expect(css).toContain(
      ".cockpit-chat-content .mc-assistant-markdown :is(h1, h2, h3, h4, h5, h6):not(:first-child) { margin-top: 1.25em; }",
    );
  });
});
