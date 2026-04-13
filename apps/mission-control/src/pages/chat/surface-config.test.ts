import { describe, expect, it } from "vitest";
import { defaultDockOpenForMode, getMissionControlSurfaceConfig } from "./surface-config";

describe("mission control surface config", () => {
  it("keeps chat dock collapsed by default and opens specialized docks by default", () => {
    expect(defaultDockOpenForMode("chat")).toBe(false);
    expect(defaultDockOpenForMode("cowork")).toBe(true);
    expect(defaultDockOpenForMode("code")).toBe(true);
  });

  it("returns distinct empty-state copy per mode", () => {
    const chat = getMissionControlSurfaceConfig("chat");
    const cowork = getMissionControlSurfaceConfig("cowork");
    const code = getMissionControlSurfaceConfig("code");

    expect(chat.emptyTitle).not.toBe(cowork.emptyTitle);
    expect(code.dockTitle).toBe("Code context");
    expect(cowork.layout.mainGridClassName).toBe("surface-grid-cowork");
    expect(chat.layout.dominantArtifact).toBe("conversation");
    expect(cowork.layout.threadPlacement).toBe("support");
    expect(cowork.layout.threadPanelRank).toBe("muted");
    expect(code.layout.workflowPlacement).toBe("primary");
    expect(code.layout.threadPanelRank).toBe("inset");
  });
});
