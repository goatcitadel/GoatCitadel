import { describe, expect, it } from "vitest";
import { DESIGN_BRAND_BLOCK_EXAMPLE, parseDesignBrandBlock } from "./design-brand.js";

const FULL_BLOCK = [
  "# Design",
  "",
  "Some prose.",
  "",
  "```brand",
  "name:  Acme Cooperative ",
  "colors: #0F172A, 0ea5e9, #fff, not-a-color, #12345",
  "fonts: Inter , Source Serif 4,,",
  "logo: assets/logo.svg",
  "tagline: ignored key",
  "```",
  "",
  "More prose.",
].join("\n");

describe("parseDesignBrandBlock", () => {
  it("parses the first brand block with normalized colors, fonts and a relative logo path", () => {
    expect(parseDesignBrandBlock(FULL_BLOCK)).toEqual({
      name: "Acme Cooperative",
      colors: ["#0f172a", "#0ea5e9", "#ffffff"],
      fonts: ["Inter", "Source Serif 4"],
      logoPath: "assets/logo.svg",
    });
  });

  it("keeps at most six colors and three fonts", () => {
    const parsed = parseDesignBrandBlock(
      "```brand\ncolors: #111, #222, #333, #444, #555, #666, #777\nfonts: A, B, C, D\n```",
    );

    expect(parsed?.colors).toEqual(["#111111", "#222222", "#333333", "#444444", "#555555", "#666666"]);
    expect(parsed?.fonts).toEqual(["A", "B", "C"]);
  });

  it.each(["../x.svg", "/abs.svg", "C:/x.svg", "https://example.test/x.svg", "a/../b.svg", "a\\b.svg"])(
    "drops the logo path %s",
    (logo) => {
      expect(parseDesignBrandBlock(`\`\`\`brand\nname: Acme\nlogo: ${logo}\n\`\`\``)).toEqual({ name: "Acme" });
    },
  );

  it("returns undefined without a brand block or when the block yields no fields", () => {
    expect(parseDesignBrandBlock("# Design\n\nNo block here.")).toBeUndefined();
    expect(parseDesignBrandBlock("```css\n:root { --x: #fff; }\n```")).toBeUndefined();
    expect(parseDesignBrandBlock("```brand\ntagline: only unknown keys\ncolors: nope\n```")).toBeUndefined();
    expect(parseDesignBrandBlock("")).toBeUndefined();
  });

  it("ignores a second brand block and trims the name to 80 characters", () => {
    const parsed = parseDesignBrandBlock(
      `\`\`\`BRAND\nname: ${"n".repeat(100)}\n\`\`\`\n\n\`\`\`brand\nname: Second\ncolors: #000\n\`\`\``,
    );

    expect(parsed).toEqual({ name: "n".repeat(80) });
  });

  it("ships an example that parses", () => {
    expect(parseDesignBrandBlock(DESIGN_BRAND_BLOCK_EXAMPLE)).toMatchObject({
      name: expect.any(String),
      colors: expect.arrayContaining([expect.stringMatching(/^#[0-9a-f]{6}$/u)]),
      fonts: expect.arrayContaining([expect.any(String)]),
    });
  });
});
