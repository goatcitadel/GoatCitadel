import { describe, expect, it, vi } from "vitest";
import type { DaemonStatus } from "./daemon-route-service.js";
import {
  GOVERNED_GATEWAY_SERVICE_MANUAL_REPAIR_REGISTRATION,
  GOVERNED_GATEWAY_SERVICE_MANUAL_REPAIR_RECIPE,
  GovernedRemediationOwnedGatewayServiceAdapter,
  governedGatewayServiceRecipeSha256,
  governedGatewayServiceScope,
} from "./governed-remediation-owned-gateway-service-adapter.js";

const baseStatus = (): DaemonStatus => ({
  running: true,
  pid: 4242,
  uptimeSeconds: 60,
  host: "secret-host.internal",
  state: "running",
  supported: false,
  controllable: false,
  controlMessage: "canary-control-message",
  controlHandoff: {
    owner: "canary-owner",
    serviceName: "canary-service",
    reason: "canary-reason",
    desktopControl: "canary-desktop-control",
    commands: [
      {
        label: "canary-label",
        command: "canary-command --token ghp_aaaaaaaaaaaaaaaaaaaaaaaa",
        description: "canary-description",
      },
    ],
  },
  diagnostics: [
    {
      id: "canary-diagnostic",
      title: "canary-title",
      severity: "critical",
      detail: "canary-detail ghp_bbbbbbbbbbbbbbbbbbbbbbbb",
      evidence: { env: "canary-env", token: "ghp_cccccccccccccccccccccccc" },
    },
  ],
  repairActions: [
    {
      id: "canary-action",
      label: "canary-action-label",
      severity: "critical",
      description: "canary-action-description",
      command: "canary-action-command",
      autoRunAllowed: false,
      requiresOwnerProof: true,
    },
  ],
});

describe("GovernedRemediationOwnedGatewayServiceAdapter", () => {
  it("registers owned-service lifecycle repair as installation-scoped and non-callable", () => {
    expect(GOVERNED_GATEWAY_SERVICE_MANUAL_REPAIR_RECIPE).toMatchObject({
      repairClass: "owned_service",
      executionMode: "manual_required",
      allowedScopeKinds: ["installation"],
      allowedDeploymentProfiles: expect.arrayContaining(["local_dev", "remote_hardened", "trusted_local"]),
      rollbackStrategy: "manual_required",
      maxApplyAttempts: 0,
    });
    expect(GOVERNED_GATEWAY_SERVICE_MANUAL_REPAIR_RECIPE.allowedDeploymentProfiles).toHaveLength(3);
    expect(GOVERNED_GATEWAY_SERVICE_MANUAL_REPAIR_REGISTRATION.owner).toBeNull();
    expect(governedGatewayServiceRecipeSha256()).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("drops daemon identity, commands, diagnostics, and secret-like canaries", async () => {
    const getDaemonStatus = vi.fn(async () => baseStatus());
    const adapter = new GovernedRemediationOwnedGatewayServiceAdapter({ getDaemonStatus });

    const assessment = await adapter.assess({
      deploymentProfile: "trusted_local",
      scope: governedGatewayServiceScope({ deploymentId: "deployment-a", installationId: "installation-a" }),
    });

    expect(assessment).toMatchObject({
      status: "manual_required",
      reason: "external_process_manager_required",
      ownerRevision: null,
      observation: {
        processObserved: true,
        lifecycleControl: "external_owner_required",
        authenticatedReadinessProbe: "not_owned",
      },
      automaticExecution: false,
    });
    expect(getDaemonStatus).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(assessment);
    for (const canary of [
      "4242",
      "secret-host.internal",
      "canary-control-message",
      "canary-owner",
      "canary-command",
      "canary-diagnostic",
      "canary-env",
      "ghp_",
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("reports an unobservable process without invoking lifecycle mutations", async () => {
    const getDaemonStatus = vi.fn(async () => ({ ...baseStatus(), running: false }));
    const daemonRestart = vi.fn();
    const daemon = { getDaemonStatus, daemonRestart };
    const adapter = new GovernedRemediationOwnedGatewayServiceAdapter(daemon);

    await expect(
      adapter.assess({
        deploymentProfile: "remote_hardened",
        scope: governedGatewayServiceScope({ deploymentId: "deployment-b", installationId: "installation-b" }),
      }),
    ).resolves.toMatchObject({
      status: "manual_required",
      reason: "gateway_process_not_observable",
      observation: { processObserved: false },
    });
    expect(daemonRestart).not.toHaveBeenCalled();
  });
});
