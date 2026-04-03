import { describe, expect, it } from "vitest";
import { buildA2UIContract } from "./a2ui-contract.js";

describe("buildA2UIContract", () => {
  it("derives ui and platform scopes from the declared canvas targets", () => {
    const contract = buildA2UIContract(
      {
        catalogId: "automation.canvas-a2ui",
        label: "Canvas + A2UI",
        maturity: "beta",
        capabilities: ["scene-view", "selection", "inspect", "agent-apply"],
      },
      [
        {
          catalogId: "platform.android-canvas-camera-screen",
          label: "Android Canvas/Camera/Screen",
          maturity: "beta",
          capabilities: ["canvas", "camera", "screen"],
        },
        {
          catalogId: "platform.ios-canvas-camera-voice",
          label: "iOS Canvas/Camera/Voice",
          maturity: "planned",
          capabilities: ["canvas", "camera", "voice"],
        },
      ],
      { androidRuntimeProven: true },
    );

    expect(contract).toEqual({
      contractId: "a2ui.v1",
      label: "A2UI Operator Contract",
      scopes: ["ui_canvas", "platform_canvas"],
      transports: ["local_session", "companion_session"],
      operatorSurface: "mission_control",
      uiCapabilities: ["scene_view", "selection", "inspect", "agent_apply"],
      platformCapabilities: ["scene_view", "camera_input", "screen_input", "voice_input"],
      notes: [
        "Mission Control is the first operator surface for a2ui.v1 proof and review.",
        "Platform canvas targets inherit a2ui.v1 through companion_session, and Android proof is now on file for the current signed-session runtime.",
      ],
    });
  });

  it("returns undefined when no canvas automation or platform targets exist", () => {
    expect(buildA2UIContract(undefined, [])).toBeUndefined();
  });
});
