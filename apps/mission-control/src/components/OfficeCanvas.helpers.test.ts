import { describe, expect, it } from "vitest";
import {
  activityChipKind,
  activityLabel,
  attentionChipKind,
  attentionLabel,
  buildCircularLayout,
  buildZoneAnchors,
  getAgentShapeProfile,
  hashToken,
  hexToRgb,
  lerp,
  mixHexColor,
  motionScalarForMode,
  operatorPresetPalette,
  rgbToHex,
  statusBadge,
  statusHoloColor,
  truncate,
  zoneWorkloadColor,
  type OfficeDeskAgent,
} from "./OfficeCanvas";

function agent(roleId: string, zoneId?: string): OfficeDeskAgent {
  return {
    roleId,
    name: roleId,
    title: `${roleId} title`,
    status: "active",
    risk: "none",
    currentThought: "Thinking.",
    currentAction: "Working.",
    activityState: "working_seated",
    collabPeers: [],
    zoneId: zoneId as OfficeDeskAgent["zoneId"],
  };
}

describe("OfficeCanvas helper behavior", () => {
  it("builds deterministic layouts, zone anchors, and procedural profiles", () => {
    expect(buildCircularLayout([])).toEqual([]);

    const layout = buildCircularLayout([
      agent("architect", "command"),
      agent("coder", "build"),
      agent("researcher", "research"),
    ]);
    expect(layout.map((seat) => seat.zoneId)).toEqual(["command", "build", "research"]);
    expect(layout[0]?.zoneLabel).toBe("Command Deck");

    const anchors = buildZoneAnchors(layout);
    expect(anchors.get("command")?.[0]).toBeTypeOf("number");
    expect(anchors.get("security")?.[2]).toBeTypeOf("number");
    expect(hashToken("coder")).toBe(hashToken("coder"));
    expect(getAgentShapeProfile(layout[0]!)).toMatchObject({
      height: expect.any(Number),
      width: expect.any(Number),
      accentCount: expect.any(Number),
    });
  });

  it("maps status, activity, attention, operator, and motion labels", () => {
    expect(statusHoloColor("active", "blocked")).toBe("#ff7466");
    expect(statusHoloColor("ready", "approval")).toBe("#ff9a45");
    expect(statusHoloColor("active", "none")).toBe("#54ddff");
    expect(statusHoloColor("ready", "none")).toBe("#8fce5f");
    expect(statusHoloColor("idle", "none")).toBe("#4a5568");

    expect(statusBadge("active", "none", "alert_response")).toEqual({ label: "ALERT", kind: "blocked" });
    expect(statusBadge("active", "error", "working_seated")).toEqual({ label: "BLOCK", kind: "blocked" });
    expect(statusBadge("active", "approval", "working_seated")).toEqual({ label: "HOLD", kind: "approval" });
    expect(statusBadge("active", "none", "working_seated")).toEqual({ label: "RUN", kind: "active" });
    expect(statusBadge("ready", "none", "working_seated")).toEqual({ label: "READY", kind: "ready" });
    expect(statusBadge("idle", "none", "working_seated")).toEqual({ label: "IDLE", kind: "idle" });

    expect(activityLabel("idle_milling")).toBe("Patrol");
    expect(activityLabel("transitioning_to_desk")).toBe("Routing");
    expect(activityLabel("working_seated")).toBe("Execute");
    expect(activityLabel("collaborating")).toBe("Sync");
    expect(activityLabel("alert_response")).toBe("Alert");
    expect(attentionLabel("priority")).toBe("Priority");
    expect(attentionLabel("watch")).toBe("Watch");
    expect(attentionLabel(undefined)).toBe("Stable");
    expect(attentionChipKind("priority")).toBe("blocked");
    expect(attentionChipKind("watch")).toBe("approval");
    expect(attentionChipKind(undefined)).toBe("active");
    expect(activityChipKind("alert_response", "none")).toBe("blocked");
    expect(activityChipKind("working_seated", "approval")).toBe("approval");
    expect(activityChipKind("idle_milling", "none")).toBe("idle");
    expect(activityChipKind("working_seated", "none")).toBe("active");

    expect(operatorPresetPalette("nightwatch")).toMatchObject({ accent: "#4fb7d9" });
    expect(operatorPresetPalette("strategist")).toMatchObject({ accent: "#8fce5f" });
    expect(operatorPresetPalette("trailblazer")).toMatchObject({ accent: "#ffb36d" });
    expect(motionScalarForMode("cinematic")).toBe(1);
    expect(motionScalarForMode("balanced")).toBe(0.72);
    expect(motionScalarForMode("subtle")).toBe(0.45);
    expect(motionScalarForMode("reduced")).toBe(0.2);
  });

  it("mixes colors and text helpers defensively", () => {
    expect(zoneWorkloadColor(undefined, "command")).toMatch(/^#[0-9a-f]{6}$/);
    expect(
      zoneWorkloadColor({ zoneId: "command", workloadScore: 2, attentionLevel: "priority" } as any, "command"),
    ).toMatch(/^#[0-9a-f]{6}$/);
    expect(mixHexColor("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixHexColor("#000", "#fff", -1)).toBe("#000000");
    expect(hexToRgb("#0f8")).toEqual({ r: 0, g: 255, b: 136 });
    expect(rgbToHex(300, -20, 16)).toBe("#ff0010");
    expect(lerp(10, 20, 0.25)).toBe(12.5);
    expect(truncate("short", 20)).toBe("short");
    expect(truncate("very long label", 8)).toBe("very ...");
    expect(truncate("abc", 2)).toBe("...");
  });
});
