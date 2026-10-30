import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { AssistantMessageRenderer } from "./AssistantMessageRenderer";
import { loadKatex, MATH_MAX_TEX_CHARS, renderMathToHtml } from "./assistant-math";

let renderer: ReactTestRenderer | null = null;

beforeAll(async () => {
  expect(await loadKatex()).not.toBeNull();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

function render(content: string, running = false) {
  act(() => {
    renderer = create(<AssistantMessageRenderer role="assistant" content={content} running={running} />);
  });
  return renderer!.root;
}

const formulas = (root: ReactTestInstance) =>
  root.findAll(
    (node) => typeof node.props.className === "string" && node.props.className.split(" ").includes("mc-assistant-math"),
  );
const markup = (node: ReactTestInstance) => String(node.props.dangerouslySetInnerHTML.__html);
const sources = (root: ReactTestInstance) => root.findAll((node) => node.props["data-math-source"] !== undefined);

describe("math in Chat replies", () => {
  it("typesets inline and display math with MathML for screen readers", () => {
    const root = render("The area is $\\pi r^2$.\n\n$$\n\\frac{a}{b}\n$$\n");
    const [inline, display] = formulas(root);
    expect(inline!.type).toBe("span");
    expect(markup(inline!)).toContain('class="katex"');
    expect(markup(inline!)).toContain("<math");
    expect(display!.type).toBe("div");
    expect(markup(display!)).toContain("katex-display");
  });

  it("reads \\( \\), \\[ \\] and a ```math fence", () => {
    const root = render("Inline \\(x^2\\).\n\n\\[\\sum_{i=1}^n i\\]\n\n```math\nE = mc^2\n```\n");
    expect(formulas(root)).toHaveLength(3);
  });

  it("leaves prices as text", () => {
    const root = render("Plans cost $5 and $10 a month.");
    expect(formulas(root)).toHaveLength(0);
    expect(sources(root)).toHaveLength(0);
  });

  it("shows the TeX source for a formula KaTeX cannot read", () => {
    const root = render("Broken: $$\\frac{a$$ here.");
    expect(formulas(root)).toHaveLength(0);
    expect(sources(root).map((node) => node.children.join(""))).toEqual(["\\frac{a"]);
  });

  it("shows a display formula still arriving as its source, then typesets it", () => {
    let root = render("Here:\n\n$$\n\\frac{a}{", true);
    expect(formulas(root)).toHaveLength(0);
    expect(sources(root)).toHaveLength(1);
    root = render("Here:\n\n$$\n\\frac{a}{b}\n$$\n\nDone.", true);
    expect(formulas(root)).toHaveLength(1);
  });
});

describe("renderMathToHtml", () => {
  it("never turns TeX into links, images or script", async () => {
    const katex = (await loadKatex())!;
    for (const tex of ["\\href{javascript:alert(1)}{x}", "\\url{https://example.com}", "\\includegraphics{x.png}"]) {
      const html = renderMathToHtml(katex, tex, false);
      expect(html ?? "").not.toMatch(/<a\b|href=|<img\b|<script\b/i);
    }
  });

  it("refuses empty and oversized formulas", async () => {
    const katex = (await loadKatex())!;
    expect(renderMathToHtml(katex, "  ", false)).toBeNull();
    expect(renderMathToHtml(katex, "x".repeat(MATH_MAX_TEX_CHARS + 1), false)).toBeNull();
  });
});
