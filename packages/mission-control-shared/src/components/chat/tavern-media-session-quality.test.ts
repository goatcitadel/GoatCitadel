import { describe, expect, it } from "vitest";
import {
  describeTavernMediaPreset,
  listTavernMediaQualityPresets,
  resolveTavernMediaQualityPreset,
} from "./tavern-media-session-quality";

describe("tavern media session quality helpers", () => {
  it("maps browser connection profiles to future live media presets", () => {
    expect(resolveTavernMediaQualityPreset({ profile: "high" })).toMatchObject({
      presetId: "high",
      maxVideo: { width: 1920, height: 1080, frameRate: 30 },
      audioFirst: false,
    });
    expect(resolveTavernMediaQualityPreset({ profile: "balanced" })).toMatchObject({
      presetId: "balanced",
      maxVideo: { width: 1280, height: 720, frameRate: 30 },
    });
    expect(resolveTavernMediaQualityPreset({ profile: "constrained" })).toMatchObject({
      presetId: "constrained",
      maxVideo: { width: 854, height: 480, frameRate: 24 },
    });
    expect(resolveTavernMediaQualityPreset({ profile: "data_saver" })).toMatchObject({
      presetId: "data_saver",
      audioFirst: true,
    });
    expect(resolveTavernMediaQualityPreset({ profile: "unknown" })).toMatchObject({
      presetId: "balanced",
    });
  });

  it("allows explicit operator preset selection without starting live media", () => {
    expect(resolveTavernMediaQualityPreset({ profile: "high", requestedPresetId: "poor" })).toMatchObject({
      presetId: "poor",
      audioFirst: true,
      maxVideo: { width: 640, height: 360, frameRate: 15 },
    });
    expect(describeTavernMediaPreset("poor")).toBe("Poor: 360p/15fps, audio-first.");
    expect(describeTavernMediaPreset("balanced")).toBe("Balanced: 720p/30fps.");
  });

  it("returns defensive copies of preset metadata", () => {
    const [first] = listTavernMediaQualityPresets();
    expect(first).toMatchObject({ presetId: "high" });
    if (first) {
      first.maxVideo.height = 1;
    }

    expect(listTavernMediaQualityPresets()[0]).toMatchObject({
      presetId: "high",
      maxVideo: { height: 1080 },
    });
  });
});
