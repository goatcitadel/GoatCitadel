import { describe, expect, it } from "vitest";
import { defaultDockOpenForMode, getMissionControlSurfaceConfig } from "./surface-config";

describe("mission control surface config", () => {
  it("keeps chat dock collapsed by default and opens specialized docks by default", () => {
    expect(defaultDockOpenForMode("chat")).toBe(false);
    expect(defaultDockOpenForMode("cowork")).toBe(true);
    expect(defaultDockOpenForMode("code")).toBe(true);
  });

  it("returns distinct empty-state copy per mode", () => {
    expect(getMissionControlSurfaceConfig("chat").emptyTitle).not.toBe(getMissionControlSurfaceConfig("cowork").emptyTitle);
    expect(getMissionControlSurfaceConfig("code").dockTitle).toBe("Code context");
  });
});
