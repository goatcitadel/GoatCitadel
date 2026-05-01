import { describe, expect, it } from "vitest";
import { isPlanningModeToggleShortcut } from "./useChatComposerInteractions";

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
