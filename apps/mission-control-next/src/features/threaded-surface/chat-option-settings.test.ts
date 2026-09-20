import { describe, expect, it } from "vitest";
import { buildActiveChatOptionSettings } from "./chat-option-settings";

describe("buildActiveChatOptionSettings", () => {
  it("names nothing when every setting is at its default", () => {
    expect(
      buildActiveChatOptionSettings({
        planningMode: "off",
        webMode: "off",
        reviewDepth: "off",
        modelCouncilEnabled: false,
      }),
    ).toEqual([]);
  });

  it("names each armed setting instead of a bare 'active' flag", () => {
    const settings = buildActiveChatOptionSettings({
      planningMode: "advisory",
      webMode: "deep",
      reviewDepth: "standard",
      modelCouncilEnabled: true,
    });
    expect(settings.map((setting) => setting.label)).toEqual(["Plan mode", "Deep research", "Review", "Model council"]);
    // Every chip explains what it does; a label alone is what we are replacing.
    expect(settings.every((setting) => setting.description.length > 0)).toBe(true);
  });

  it("distinguishes quick web lookups from deep research", () => {
    expect(buildActiveChatOptionSettings({ webMode: "quick", modelCouncilEnabled: false }).map((s) => s.label)).toEqual(
      ["Web research"],
    );
    expect(buildActiveChatOptionSettings({ webMode: "deep", modelCouncilEnabled: false }).map((s) => s.label)).toEqual([
      "Deep research",
    ]);
  });

  it("surfaces a non-standard review depth rather than flattening it", () => {
    expect(
      buildActiveChatOptionSettings({ reviewDepth: "thorough", modelCouncilEnabled: false }).map((s) => s.label),
    ).toEqual(["Review: thorough"]);
  });
});
