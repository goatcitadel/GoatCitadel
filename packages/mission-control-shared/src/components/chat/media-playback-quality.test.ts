import { describe, expect, it } from "vitest";
import {
  classifyTavernMediaConnection,
  shouldDeferTavernInlineMedia,
  tavernMediaPreloadForProfile,
} from "./media-playback-quality";

describe("tavern media playback quality", () => {
  it("classifies data saver and slow connections conservatively", () => {
    expect(classifyTavernMediaConnection({ saveData: true, effectiveType: "4g", downlinkMbps: 40 })).toBe("data_saver");
    expect(classifyTavernMediaConnection({ effectiveType: "2g" })).toBe("data_saver");
    expect(classifyTavernMediaConnection({ effectiveType: "3g", downlinkMbps: 2 })).toBe("constrained");
    expect(classifyTavernMediaConnection({ downlinkMbps: 0.8 })).toBe("constrained");
    expect(classifyTavernMediaConnection({ rttMs: 600 })).toBe("constrained");
  });

  it("classifies strong and unknown connections without overclaiming", () => {
    expect(classifyTavernMediaConnection({ effectiveType: "4g", downlinkMbps: 15 })).toBe("high");
    expect(classifyTavernMediaConnection({ effectiveType: "4g", downlinkMbps: 2 })).toBe("balanced");
    expect(classifyTavernMediaConnection({})).toBe("unknown");
  });

  it("defers large video on constrained and data-saver profiles", () => {
    expect(shouldDeferTavernInlineMedia({ kind: "video", sizeBytes: 9 * 1024 * 1024, profile: "constrained" })).toBe(
      true,
    );
    expect(shouldDeferTavernInlineMedia({ kind: "video", sizeBytes: 3 * 1024 * 1024, profile: "constrained" })).toBe(
      false,
    );
    expect(shouldDeferTavernInlineMedia({ kind: "video", sizeBytes: 1024, profile: "data_saver" })).toBe(true);
    expect(shouldDeferTavernInlineMedia({ kind: "audio", sizeBytes: 1024, profile: "data_saver" })).toBe(false);
  });

  it("uses metadata preload except for constrained video", () => {
    expect(tavernMediaPreloadForProfile({ kind: "video", profile: "constrained" })).toBe("none");
    expect(tavernMediaPreloadForProfile({ kind: "video", profile: "data_saver" })).toBe("none");
    expect(tavernMediaPreloadForProfile({ kind: "video", profile: "balanced" })).toBe("metadata");
    expect(tavernMediaPreloadForProfile({ kind: "audio", profile: "data_saver" })).toBe("metadata");
  });
});
