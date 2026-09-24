import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Resolved from this file, not the process CWD, so the check runs the same
// from the repo root and from the package.
function readStyles(name: string): string {
  return readFileSync(new URL(`./styles/${name}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

const composerCss = readStyles("composer.css");
const mobileCss = readStyles("mobile.css");
const sidePanelsCss = readStyles("side-panels.css");

function declarationsFor(css: string, selector: string): string[] {
  const declarations: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]!.split(",").map((part) => part.trim());
    if (selectors.includes(selector)) declarations.push(match[2]!);
  }
  return declarations;
}

function lastValue(css: string, selector: string, property: string): string | undefined {
  const pattern = new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;]+);`, "g");
  let value: string | undefined;
  for (const block of declarationsFor(css, selector)) {
    for (const match of block.matchAll(pattern)) value = match[1]!.trim();
  }
  return value;
}

describe("Chat command palette styles", () => {
  it("keeps every line of the selected row on the AA-guarded accent text token", () => {
    // --primary-foreground on --primary is checked for every area and theme by
    // scripts/check-mission-control-next-contrast.mjs. The selected row must
    // use that pair for its description and metadata as well as its title.
    expect(lastValue(composerCss, ".mc-next-command-item.active", "color")).toBe("var(--primary-foreground)");
    expect(lastValue(composerCss, ".mc-next-command-item.active span", "color")).toBe("var(--primary-foreground)");
    expect(lastValue(composerCss, ".mc-next-command-item.active small", "color")).toBe("var(--primary-foreground)");
  });

  it("left-aligns row content in one full-width column instead of centering it", () => {
    expect(lastValue(composerCss, ".mc-next-command-item", "grid-template-columns")).toBe("minmax(0, 1fr)");
    expect(lastValue(composerCss, ".mc-next-command-item", "justify-content")).toBe("stretch");
  });

  it("paints the open palette dialog opaque so the conversation cannot bleed through its rows", () => {
    expect(lastValue(composerCss, ".mc-next-command-popover.palette-sheet", "background")).toBe("var(--card)");
  });

  it("keeps the narrow palette above the persistent status strip", () => {
    const paletteRules = declarationsFor(composerCss, ".mc-next-command-popover.palette-sheet");
    expect(paletteRules.some((rule) => rule.includes("position: fixed") && rule.includes("bottom: 3rem"))).toBe(true);
    expect(lastValue(composerCss, ".mc-next-command-popover.palette-sheet", "bottom")).toBe("3rem");
  });
});

describe("Chat details drawer tab styles", () => {
  it("stacks the icon over the label so four tabs never break a word mid-way", () => {
    const tab = ".mc-next-utility-panel-tabs .mc-next-utility-panel-tab";
    expect(lastValue(sidePanelsCss, tab, "flex-direction")).toBe("column");
    expect(lastValue(sidePanelsCss, tab, "overflow-wrap")).toBe("normal");
    expect(lastValue(sidePanelsCss, `${tab} span`, "overflow-wrap")).toBe("normal");
  });
});

describe("Chat send-block hint styles", () => {
  it("keeps the reason beside a blocked Send visible on phones", () => {
    // Other composer helper copy is hidden on narrow screens to save space; the
    // route-block hint is the only visible explanation for a disabled Send.
    expect(lastValue(mobileCss, ".mc-next-threaded-surface.unified .mc-next-composer-helper", "display")).toBe("none");
    expect(
      lastValue(
        mobileCss,
        ".mc-next-threaded-surface.unified .mc-next-composer-helper.mc-next-composer-send-block",
        "display",
      ),
    ).toBe("block");
  });
});
