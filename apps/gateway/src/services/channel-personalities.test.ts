import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPersonalityOverlay,
  getPersonalityPreset,
  listPersonalityPresets,
  normalizePersonalityId,
} from "./channel-personalities.js";

describe("channel personalities", () => {
  it("exposes all requested builtin presets with categories and soul files", () => {
    const ids = listPersonalityPresets().map((preset) => preset.id);
    const expected = [
      "helpful",
      "concise",
      "technical",
      "teacher",
      "creative",
      "operator",
      "researcher",
      "architect",
      "coach",
      "philosopher",
      "critic",
      "skeptic",
      "auditor",
      "red_team",
      "contrarian",
      "tinkerer",
      "pragmatist",
      "optimizer",
      "maintainer",
      "shipper",
      "manager",
      "executive",
      "coworker",
      "intern",
      "therapist",
      "systems_thinker",
      "first_principles",
      "futurist",
      "historian",
      "risk_analyst",
      "debugger",
      "noir",
      "hype",
      "playful",
      "wizard",
      "pirate",
      "alien",
      "time_traveler",
      "drunk_friend",
      "stoned_friend",
      "leprechaun",
      "chaotic_uncle",
      "burnt_out_dev",
      "overengineer",
      "minimalist",
      "glitch",
    ];

    for (const id of expected) {
      expect(ids).toContain(id);
    }
    for (const preset of listPersonalityPresets()) {
      expect(preset.category).toMatch(/^(core|critical|execution|social|thinking|flavor|chaos)$/);
      expect(preset.soulFile).toBe(`docs/personalities/${preset.category}/${preset.id}.md`);
      expect(fs.existsSync(path.resolve(process.cwd(), "..", "..", preset.soulFile))).toBe(true);
    }
  });

  it("normalizes default aliases and preserves policy boundaries in overlays", () => {
    expect(normalizePersonalityId("none")).toBe("default");
    expect(getPersonalityPreset("unknown").id).toBe("default");
    expect(buildPersonalityOverlay("default")).toBeUndefined();
    expect(buildPersonalityOverlay("operator")).toContain("cannot override GoatCitadel safety");
  });
});
