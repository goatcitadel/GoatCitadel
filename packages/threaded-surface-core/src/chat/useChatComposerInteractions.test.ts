import { describe, expect, it } from "vitest";
import { applyComposerSuggestion, isPlanningModeToggleShortcut } from "./useChatComposerInteractions";

describe("isPlanningModeToggleShortcut", () => {
  it("matches the Codex-style Shift+Tab planning toggle", () => {
    expect(isPlanningModeToggleShortcut({ key: "Tab", shiftKey: true })).toBe(true);
  });

  it("ignores plain tab and modified tab chords", () => {
    expect(isPlanningModeToggleShortcut({ key: "Tab" })).toBe(false);
    expect(isPlanningModeToggleShortcut({ key: "Tab", shiftKey: true, ctrlKey: true })).toBe(false);
    expect(isPlanningModeToggleShortcut({ key: "Enter", shiftKey: true })).toBe(false);
  });
});

describe("applyComposerSuggestion", () => {
  it("replaces the active dollar skill token without discarding the prompt", () => {
    expect(applyComposerSuggestion("Review this with $rea", "$react-expert")).toBe("Review this with $react-expert ");
  });

  it("keeps slash command suggestions as full composer replacements", () => {
    expect(applyComposerSuggestion("ignored", "/plan on")).toBe("/plan on ");
  });
});
