import { describe, expect, it } from "vitest";
import { defaultDockOpenForMode, DESKTOP_DOCK_BREAKPOINT, getMissionControlSurfaceConfig } from "./surface-config";

describe("surface-config", () => {
  it("returns mode-specific shell and layout defaults", () => {
    const chat = getMissionControlSurfaceConfig("chat");
    const cowork = getMissionControlSurfaceConfig("cowork");
    const code = getMissionControlSurfaceConfig("code");

    expect(chat).toMatchObject({
      mode: "chat",
      label: "Chat",
      shellEyebrow: "Chat",
      layout: {
        dominantArtifact: "conversation",
        workflowPlacement: "none",
        dockBehavior: "collapsible",
      },
    });
    expect(cowork).toMatchObject({
      mode: "cowork",
      label: "Cowork",
      layout: {
        dominantArtifact: "workflow",
        workflowPlacement: "primary",
        dockBehavior: "drawer",
      },
    });
    expect(code).toMatchObject({
      mode: "code",
      label: "Code",
      layout: {
        dominantArtifact: "workbench",
        defaultColumnWidths: "workbench | thread | dock",
      },
    });
    expect(code.emptyPrompts).toContain("Implement the smallest safe fix");
  });

  it("opens the dock only for desktop-width surface layouts", () => {
    expect(defaultDockOpenForMode("chat")).toBe(false);
    expect(defaultDockOpenForMode("chat", DESKTOP_DOCK_BREAKPOINT - 1)).toBe(false);
    expect(defaultDockOpenForMode("chat", DESKTOP_DOCK_BREAKPOINT)).toBe(true);
    expect(defaultDockOpenForMode("cowork", DESKTOP_DOCK_BREAKPOINT + 100)).toBe(true);
    expect(defaultDockOpenForMode("code", DESKTOP_DOCK_BREAKPOINT + 100)).toBe(true);
  });
});
