import { describe, expect, it } from "vitest";
import { defaultDockOpenForMode, getMissionControlSurfaceConfig } from "./surface-config";

describe("mission control surface config", () => {
  it("keeps specialized docks drawer-first by default", () => {
    expect(defaultDockOpenForMode("chat")).toBe(false);
    expect(defaultDockOpenForMode("cowork")).toBe(false);
    expect(defaultDockOpenForMode("code")).toBe(false);
  });

  it("returns distinct empty-state copy per mode", () => {
    const chat = getMissionControlSurfaceConfig("chat");
    const cowork = getMissionControlSurfaceConfig("cowork");
    const code = getMissionControlSurfaceConfig("code");

    expect(chat.emptyTitle).not.toBe(cowork.emptyTitle);
    expect(code.dockTitle).toBe("Code context");
    expect(cowork.layout.mainGridClassName).toBe("surface-grid-cowork");
    expect(chat.layout.dominantArtifact).toBe("conversation");
    expect(chat.layout.dockBehavior).toBe("collapsible");
    expect(cowork.layout.threadPlacement).toBe("support");
    expect(cowork.layout.threadPanelRank).toBe("muted");
    expect(cowork.layout.supportThreadBehavior).toBe("stacked");
    expect(code.layout.workflowPlacement).toBe("primary");
    expect(code.layout.threadPanelRank).toBe("inset");
    expect(code.layout.dockBehavior).toBe("drawer");
    expect(code.layout.desktopDensity).toBe("code");
  });
});
