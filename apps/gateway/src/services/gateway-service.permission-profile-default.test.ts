import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import { GatewayService } from "./gateway-service.js";

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
  gateway.storage = { permissionProfiles: { resolveContext } };
  return { gateway, resolveContext };
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
});
