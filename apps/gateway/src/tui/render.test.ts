import { describe, expect, it } from "vitest";
import { defaultOperatorSectionVisibility, renderBox, renderOperatorSection } from "./render.js";

const ANSI_ESCAPE_SEQUENCE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function visibleWidth(line: string): number {
  return [...line.replace(ANSI_ESCAPE_SEQUENCE_PATTERN, "")].length;
}

describe("renderBox", () => {
  it("keeps every line aligned for a title-only box", () => {
    const lines = renderBox("Title", [], "info").split("\n");
    const widths = lines.map(visibleWidth);
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBe(40);
  });

  it("keeps every line aligned for multi-line content", () => {
    const lines = renderBox("Current state", ["Provider: glm", "Model: glm-5", "Mode: balanced"], "success").split(
      "\n",
    );
    const widths = lines.map(visibleWidth);
    expect(new Set(widths).size).toBe(1);
  });

  it("clamps to the minimum width without shifting the right border", () => {
    const lines = renderBox("Hi", ["ok"], "warning").split("\n");
    const widths = lines.map(visibleWidth);
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBe(40);
  });

  it("wraps oversized content without breaking the box border width", () => {
    const lines = renderBox(
      "Long",
      [
        "This is a deliberately oversized line that should wrap instead of pushing the right border out of alignment in the terminal renderer.",
      ],
      "info",
    ).split("\n");
    const widths = lines.map(visibleWidth);
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBeLessThanOrEqual(108);
  });
});

describe("operator sections", () => {
  it("defaults noisy activity and diagnostics sections to collapsed", () => {
    expect(defaultOperatorSectionVisibility("activity", true)).toBe(false);
    expect(defaultOperatorSectionVisibility("diagnostics", true)).toBe(false);
    expect(
      renderOperatorSection({
        id: "activity",
        title: "Activity",
        lines: ["polling integrations"],
      }),
    ).toContain("Activity (collapsed)");
  });

  it("keeps content-bearing thinking, tools, and voice/meeting sections expanded", () => {
    for (const id of ["thinking", "tools", "voice_meeting"] as const) {
      const rendered = renderOperatorSection({
        id,
        title: id,
        lines: ["content"],
      });
      expect(rendered).toContain(`${id} (expanded)`);
      expect(rendered).toContain("content");
    }
  });
});
