import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import { GatewayService } from "./gateway-service.js";
import {
  HEARTBEAT_PERMISSION_PROFILE_ID,
  SCHEDULED_TURN_PERMISSION_PROFILE_ID,
} from "./gateway/autonomous-turn-policy.js";

/**
 * resolveToolPolicyContext should pick the permission-profile fallback from the
 * operator's configured approval mode + deployment profile, so a local-first
 * operator who set `approvalMode: "bypass"` is not silently forced onto the
 * approve-all "safe" default (which gates every tool and degrades cowork). The
 * restrictive default must remain for remote/hardened and non-bypass configs.
 */
function createGatewayHarness(config: {
  deploymentProfile: "local_dev" | "trusted_local" | "remote_hardened";
  approvalMode: "approve_all" | "approve_risky" | "bypass";
}) {
  const gateway = Object.create(GatewayService.prototype) as GatewayService & Record<string, any>;
  gateway.config = {
    assistant: { deploymentProfile: config.deploymentProfile, auth: { mode: "none" } },
    toolPolicy: { tools: { approvalMode: config.approvalMode } },
  };
  gateway.syntheticPermissionProfiles = new Map();
  const resolveContext = vi.fn((query: { profileId?: string; defaultProfileId?: string }) => {
    const profileId = query.profileId ?? query.defaultProfileId ?? "safe";
    const approvalMode = profileId === "trusted_local_power" ? "bypass" : "approve_all";
    return { permissionProfile: { profileId, approvalMode }, localOperatorOverride: undefined };
  });
  const getProfile = vi.fn((profileId: string) => {
    if (profileId === "trusted_local_power") {
      return {
        profileId,
        builtin: true,
        status: "active",
        scope: "global",
        approvalMode: "bypass",
        createdBy: "system",
      };
    }
    if (profileId === SCHEDULED_TURN_PERMISSION_PROFILE_ID || profileId === HEARTBEAT_PERMISSION_PROFILE_ID) {
      return {
        profileId,
        builtin: true,
        status: "active",
        scope: "global",
        approvalMode: "approve_all",
        createdBy: "system",
      };
    }
    if (profileId === "safe") {
      return {
        profileId,
        builtin: true,
        status: "active",
        scope: "global",
        approvalMode: "approve_all",
        createdBy: "system",
      };
    }
    return {
      profileId,
      builtin: false,
      status: "active",
      scope: "operator",
      scopeRef: "operator-1",
      approvalMode: "approve_risky",
      createdBy: "operator-1",
    };
  });
  gateway.storage = { permissionProfiles: { getProfile, resolveContext } };
  return { gateway, getProfile, resolveContext };
}

describe("GatewayService resolveToolPolicyContext default permission profile", () => {
  it("defaults a local + bypass operator to trusted_local_power (honors approvalMode)", () => {
    const { gateway, resolveContext } = createGatewayHarness({
      deploymentProfile: "local_dev",
      approvalMode: "bypass",
    });

    const context = gateway.resolveToolPolicyContext({ surface: "cowork" });

    expect(resolveContext).toHaveBeenCalledTimes(1);
    expect(resolveContext.mock.calls[0][0].defaultProfileId).toBe("trusted_local_power");
    expect(context.permissionProfileId).toBe("trusted_local_power");
    expect(context.permissionProfile.approvalMode).toBe("bypass");
  });

  it("keeps the restrictive 'safe' default on remote_hardened even when approvalMode is bypass", () => {
    const { gateway, resolveContext } = createGatewayHarness({
      deploymentProfile: "remote_hardened",
      approvalMode: "bypass",
    });

    // Must not throw: the default stays "safe" (approve_all), so the existing
    // remote_hardened bypass guard is never tripped by our own default.
    const context = gateway.resolveToolPolicyContext({ surface: "cowork" });

    expect(resolveContext.mock.calls[0][0].defaultProfileId).toBe("safe");
    expect(context.permissionProfileId).toBe("safe");
  });

  it("keeps the 'safe' default for a local operator who did not opt into bypass", () => {
    const { gateway, resolveContext } = createGatewayHarness({
      deploymentProfile: "local_dev",
      approvalMode: "approve_risky",
    });

    gateway.resolveToolPolicyContext({ surface: "cowork" });

    expect(resolveContext.mock.calls[0][0].defaultProfileId).toBe("safe");
  });

  it("also defaults the trusted_local deployment profile to trusted_local_power under bypass", () => {
    const { gateway, resolveContext } = createGatewayHarness({
      deploymentProfile: "trusted_local",
      approvalMode: "bypass",
    });

    gateway.resolveToolPolicyContext({ surface: "cowork" });

    // The condition is "non-hardened + bypass", so trusted_local must behave like
    // local_dev here — guards against a future narrowing to only local_dev.
    expect(resolveContext.mock.calls[0][0].defaultProfileId).toBe("trusted_local_power");
  });

  it("keeps the 'safe' default for a local operator on approve_all", () => {
    const { gateway, resolveContext } = createGatewayHarness({
      deploymentProfile: "local_dev",
      approvalMode: "approve_all",
    });

    gateway.resolveToolPolicyContext({ surface: "cowork" });

    expect(resolveContext.mock.calls[0][0].defaultProfileId).toBe("safe");
  });

  it("rejects explicit request selection of the powerful global trusted profile", () => {
    const { gateway, resolveContext } = createGatewayHarness({
      deploymentProfile: "local_dev",
      approvalMode: "approve_all",
    });

    expect(() =>
      gateway.resolveToolPolicyContext({
        operatorId: "operator-1",
        workspaceId: "workspace-1",
        surface: "tools",
        permissionProfileId: "trusted_local_power",
      }),
    ).toThrow(/cannot be selected directly by request/i);
    expect(resolveContext).not.toHaveBeenCalled();
  });

  it("allows explicit scoped custom profiles only for their owner scope", () => {
    const { gateway, resolveContext } = createGatewayHarness({
      deploymentProfile: "local_dev",
      approvalMode: "approve_all",
    });

    gateway.resolveToolPolicyContext({
      operatorId: "operator-1",
      workspaceId: "workspace-1",
      surface: "tools",
      permissionProfileId: "operator-profile",
    });

    expect(resolveContext.mock.calls[0][0].profileId).toBe("operator-profile");
    expect(() =>
      gateway.resolveToolPolicyContext({
        operatorId: "operator-2",
        workspaceId: "workspace-1",
        surface: "tools",
        permissionProfileId: "operator-profile",
      }),
    ).toThrow(/not selectable/i);
  });

  it("allows system-owned restricted autonomous profiles without making them user-selectable", () => {
    const { gateway, resolveContext } = createGatewayHarness({
      deploymentProfile: "local_dev",
      approvalMode: "approve_all",
    });

    gateway.resolveToolPolicyContext({
      operatorId: "system-cron",
      authActorId: "system-cron",
      authActorSource: "none",
      workspaceId: "workspace-1",
      surface: "background",
      permissionProfileId: SCHEDULED_TURN_PERMISSION_PROFILE_ID,
    });

    expect(resolveContext.mock.calls[0][0].profileId).toBe(SCHEDULED_TURN_PERMISSION_PROFILE_ID);
    expect(() =>
      gateway.resolveToolPolicyContext({
        operatorId: "operator-1",
        authActorId: "operator-1",
        authActorSource: "token",
        workspaceId: "workspace-1",
        surface: "tools",
        permissionProfileId: HEARTBEAT_PERMISSION_PROFILE_ID,
      }),
    ).toThrow(/cannot be selected directly by request/i);
  });
});
