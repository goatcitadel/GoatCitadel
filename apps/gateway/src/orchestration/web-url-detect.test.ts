import { describe, expect, it } from "vitest";
import { extractExplicitWebUrl } from "./web-url-detect.js";

describe("explicit website addresses", () => {
  it.each([
    ["Help increase traffic to my website, www.irolled20.com.", "https://www.irolled20.com"],
    ["Help increase traffic to my website, irolled20.com.", "https://irolled20.com"],
    ["Review www.example.org/about?lang=en#intro.", "https://www.example.org/about?lang=en#intro"],
    ["My website is example.co.uk.", "https://example.co.uk"],
    ["Review (https://example.com/about).", "https://example.com/about"],
    ["Read [the page](https://example.com/about).", "https://example.com/about"],
    ["Read http://127.0.0.1:8787/health.", "http://127.0.0.1:8787/health"],
    ["Read http://[::1]:8787/health.", "http://[::1]:8787/health"],
    ["Read http://[::1].", "http://[::1]"],
  ])("extracts and normalizes %s", (content, expected) => {
    expect(extractExplicitWebUrl(content)).toBe(expected);
  });

  it.each([
    "Tell me about Peaky Blinders.",
    "Explain package.json and browser.navigate.",
    "Review src/www.example.com/config.ts.",
    "Review C:\\sites\\www.example.com\\index.html.",
    "My email is hello@www.example.com.",
    "My website contact is hello@example.com.",
    "My website: README.md",
    "My website: javascript:alert(1)",
  ])("does not invent a website from %s", (content) => {
    expect(extractExplicitWebUrl(content)).toBeUndefined();
  });
});
