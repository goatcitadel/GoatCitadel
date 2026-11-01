import { describe, expect, it } from "vitest";
import { HEARTBEAT_PERMISSION_PROFILE_ID, SCHEDULED_TURN_PERMISSION_PROFILE_ID } from "@goatcitadel/contracts";
import {
  buildCodeModeRequestTurnShape,
  isCodeModeRequestTurnShapeEligible,
  isRestrictedAutonomousPermissionProfile,
} from "./code-mode-request-eligibility.js";

describe("buildCodeModeRequestTurnShape", () => {
  it("derives an operator Chat turn's shape", () => {
    expect(buildCodeModeRequestTurnShape({ mode: "chat", authActorSource: "token" })).toEqual({
      mode: "chat",
      parentDelegationStepId: undefined,
      serverOnlyPosture: false,
      restrictedAutonomousProfile: false,
      actorSource: "token",
    });
  });

  it("keeps the delegated child's parent step and the mode as given", () => {
    const shape = buildCodeModeRequestTurnShape({ mode: "code", parentDelegationStepId: "step-1" });
    expect(shape.mode).toBe("code");
    expect(shape.parentDelegationStepId).toBe("step-1");
    expect(isCodeModeRequestTurnShapeEligible(shape)).toBe(false);
  });

  it("marks any server-only posture", () => {
    expect(buildCodeModeRequestTurnShape({ mode: "chat", serverOnlyPosture: { kind: "system_heartbeat" } })).toEqual(
      expect.objectContaining({ serverOnlyPosture: true }),
    );
    expect(buildCodeModeRequestTurnShape({ mode: "chat", serverOnlyPosture: undefined }).serverOnlyPosture).toBe(false);
  });

  it("marks the scheduled and heartbeat permission profiles as restricted, and no other", () => {
    for (const permissionProfileId of [SCHEDULED_TURN_PERMISSION_PROFILE_ID, HEARTBEAT_PERMISSION_PROFILE_ID]) {
      expect(isRestrictedAutonomousPermissionProfile(permissionProfileId)).toBe(true);
      expect(buildCodeModeRequestTurnShape({ mode: "chat", permissionProfileId }).restrictedAutonomousProfile).toBe(
        true,
      );
    }
    for (const permissionProfileId of [undefined, "", "operator-default"]) {
      expect(isRestrictedAutonomousPermissionProfile(permissionProfileId)).toBe(false);
      expect(buildCodeModeRequestTurnShape({ mode: "chat", permissionProfileId }).restrictedAutonomousProfile).toBe(
        false,
      );
    }
  });

  it("reads the actor from the request first and falls back to the policy context", () => {
    expect(
      buildCodeModeRequestTurnShape({
        mode: "chat",
        authActorSource: "loopback",
        policyContext: { authActorSource: "companion" },
      }).actorSource,
    ).toBe("loopback");
    expect(
      buildCodeModeRequestTurnShape({ mode: "chat", policyContext: { authActorSource: "mesh_node" } }).actorSource,
    ).toBe("mesh_node");
    expect(buildCodeModeRequestTurnShape({ mode: "chat", policyContext: {} }).actorSource).toBeUndefined();
  });
});
