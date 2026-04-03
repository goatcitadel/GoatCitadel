import { describe, expect, it } from "vitest";
import { buildCompanionContract } from "./companion-contract.js";

describe("buildCompanionContract", () => {
  it("derives the Android bootstrap contract from declared platform targets", () => {
    const contract = buildCompanionContract([
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
    ], { androidRuntimeProven: true });

    expect(contract).toEqual({
      contractId: "companion.android.v1",
      label: "Android Companion Bootstrap Contract",
      pairedSurfaceContractId: "a2ui.v1",
      primaryTarget: "android",
      bootstrapStatus: "server_foundation",
      repoStrategy: "separate_repo",
      bootstrapRepo: "GoatCitadel-mobile",
      targetCatalogIds: [
        "platform.android-canvas-camera-screen",
        "platform.ios-canvas-camera-voice",
      ],
      deviceCapabilities: ["scene_view", "camera_input", "screen_input"],
      transportLanes: ["foreground_sse", "push_refresh", "manual_refresh"],
      authRequirements: [
        "device_identity",
        "short_lived_access_token",
        "rotating_refresh_token",
        "request_signing",
        "replay_protection",
      ],
      serverPrerequisites: [
        "device_pairing",
        "token_rotation",
        "request_signing",
        "sse_resume",
        "per_device_audit",
      ],
      bootstrapFeatures: [
        "dashboard",
        "chat",
        "approvals",
        "tasks",
        "settings",
        "event_feed",
      ],
      notes: [
        "Android is the first companion bootstrap target and should ship from the separate GoatCitadel-mobile repo, not this monorepo.",
        "Foreground SSE with resume is the primary realtime lane; push refresh and manual refresh cover background/mobile constraints.",
        "Live gateway proof now covers companion session exchange, refresh rotation, signed mutation verification, replay protection, and SSE resume, and Android runtime/UI proof is now on file for the separate mobile repo.",
      ],
    });
  });

  it("returns undefined when Android is not a declared target", () => {
    expect(buildCompanionContract([
      {
        catalogId: "platform.ios-canvas-camera-voice",
        label: "iOS Canvas/Camera/Voice",
        maturity: "planned",
        capabilities: ["canvas", "camera", "voice"],
      },
    ])).toBeUndefined();
  });
});
