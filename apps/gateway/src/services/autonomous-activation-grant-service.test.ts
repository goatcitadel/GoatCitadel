import { describe, expect, it, vi } from "vitest";
import type { Storage } from "@goatcitadel/storage";
import { AutonomousActivationGrantService } from "./autonomous-activation-grant-service.js";

describe("AutonomousActivationGrantService", () => {
  it("refuses record-time grant use when activation count or expiry is exhausted", async () => {
    const settings = createSettings();
    const service = new AutonomousActivationGrantService(
      settings as never,
      vi.fn(async () => undefined),
    );
    const grant = await service.createGrant({
      workspaceId: "workspace-1",
      surfaces: ["mcp"],
      maxRiskLevel: "danger",
      capabilityPatterns: ["mcp:server-1"],
      toolPatterns: ["mcp.server-1.*"],
      activationKinds: ["mcp_tool"],
      maxActivations: 1,
      grantor: "operator",
      reason: "bounded runtime test",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect((await service.recordGrantUse(grant.grantId)).usedActivations).toBe(1);
    await expect(service.recordGrantUse(grant.grantId)).rejects.toThrow("activation count is exhausted");

    const expired = await service.createGrant({
      workspaceId: "workspace-1",
      surfaces: ["mcp"],
      maxRiskLevel: "danger",
      capabilityPatterns: ["mcp:server-2"],
      toolPatterns: ["mcp.server-2.*"],
      activationKinds: ["mcp_tool"],
      grantor: "operator",
      reason: "expiry test",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    settings.mutate("autonomous_activation_grants_v1", [], (stored) =>
      stored.map((item) =>
        item.grantId === expired.grantId ? { ...item, expiresAt: new Date(Date.now() - 1000).toISOString() } : item,
      ),
    );

    await expect(service.recordGrantUse(expired.grantId)).rejects.toThrow("is expired");
  });

  it("refuses record-time grant use when the remaining budget is exhausted", async () => {
    const service = new AutonomousActivationGrantService(
      createSettings() as never,
      vi.fn(async () => undefined),
    );
    const grant = await service.createGrant({
      workspaceId: "workspace-1",
      surfaces: ["code"],
      maxRiskLevel: "danger",
      capabilityPatterns: ["code-mode"],
      toolPatterns: ["code.mode.*"],
      activationKinds: ["code_mode"],
      budgetUsd: 0.1,
      grantor: "operator",
      reason: "budget test",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await expect(service.recordGrantUse(grant.grantId, 0.2)).rejects.toThrow("budget is exhausted");
  });

  it("never lets legacy or wildcard grants authorize automatic subagent fan-out", async () => {
    const service = new AutonomousActivationGrantService(
      createSettings() as never,
      vi.fn(async () => undefined),
    );
    await expect(
      service.createGrant({
        workspaceId: "workspace-1",
        surfaces: ["chat"],
        maxRiskLevel: "caution",
        capabilityPatterns: ["agent.fanout"],
        toolPatterns: ["agent.fanout"],
        activationKinds: ["subagent_fanout"],
        grantor: "operator",
        reason: "missing project",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).rejects.toThrow(/exact projectId/i);

    const legacy = await service.createGrant({
      workspaceId: "workspace-1",
      surfaces: ["chat"],
      maxRiskLevel: "caution",
      capabilityPatterns: ["agent.fanout"],
      toolPatterns: ["agent.fanout"],
      activationKinds: ["tool"],
      grantor: "operator",
      reason: "legacy grant",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const evaluation = await service.evaluateGrant({
      workspaceId: "workspace-1",
      projectId: "project-1",
      surface: "chat",
      riskLevel: "caution",
      activationKind: "subagent_fanout",
      capabilityId: "agent.fanout",
      toolName: "agent.fanout",
      estimatedCostUsd: 0.25,
    });
    expect(legacy.activationKinds).not.toContain("subagent_fanout");
    expect(evaluation.allowed).toBe(false);
  });

  it("requires a bounded Chat-only fan-out grant rather than broad or unbounded authority", async () => {
    const service = new AutonomousActivationGrantService(
      createSettings() as never,
      vi.fn(async () => undefined),
    );
    const base = {
      workspaceId: "workspace-1",
      projectId: "project-1",
      surfaces: ["chat"] as const,
      maxRiskLevel: "caution" as const,
      capabilityPatterns: ["agent.fanout"],
      toolPatterns: ["agent.fanout"],
      activationKinds: ["subagent_fanout"] as const,
      grantor: "operator",
      reason: "explicit fan-out authority",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await expect(service.createGrant(base)).rejects.toThrow(/maximum child activation/i);
    await expect(service.createGrant({ ...base, maxActivations: 1 })).rejects.toThrow(/budget ceiling/i);
    await expect(
      service.createGrant({ ...base, maxActivations: 1, budgetUsd: 0.25, surfaces: ["all"] }),
    ).rejects.toThrow(/scoped only to Chat/i);
    await expect(
      service.createGrant({
        ...base,
        maxActivations: 1,
        budgetUsd: 0.25,
        activationKinds: ["subagent_fanout", "tool"],
      }),
    ).rejects.toThrow(/cannot be combined/i);
  });

  it("requires an exact project and workspace match for subagent fan-out", async () => {
    const service = new AutonomousActivationGrantService(
      createSettings() as never,
      vi.fn(async () => undefined),
    );
    const grant = await createFanoutGrant(service, { workspaceId: "workspace-1", projectId: "project-1" });
    const base = {
      surface: "chat" as const,
      riskLevel: "caution" as const,
      activationKind: "subagent_fanout" as const,
      capabilityId: "agent.fanout",
      toolName: "agent.fanout",
      estimatedCostUsd: 0.25,
    };
    await expect(
      service.evaluateGrantById(grant.grantId, { ...base, workspaceId: "workspace-1", projectId: "project-1" }),
    ).resolves.toMatchObject({ allowed: true, matchedGrantId: grant.grantId });
    await expect(
      service.evaluateGrantById(grant.grantId, { ...base, workspaceId: "workspace-1", projectId: "project-2" }),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      service.evaluateGrantById(grant.grantId, { ...base, workspaceId: "workspace-2", projectId: "project-1" }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it("fails closed when a persisted fan-out-looking grant lacks the dedicated bounded shape", async () => {
    const settings = createSettings();
    const service = new AutonomousActivationGrantService(
      settings as never,
      vi.fn(async () => undefined),
    );
    const grant = await createFanoutGrant(service);
    await settings.mutate("autonomous_activation_grants_v1", [], (stored) =>
      stored.map((item) =>
        item.grantId === grant.grantId
          ? { ...item, surfaces: ["all"], maxRiskLevel: "danger", maxActivations: undefined }
          : item,
      ),
    );

    await expect(
      service.evaluateGrantById(grant.grantId, {
        workspaceId: "workspace-1",
        projectId: "project-1",
        surface: "chat",
        riskLevel: "caution",
        activationKind: "subagent_fanout",
        capabilityId: "agent.fanout",
        toolName: "agent.fanout",
        estimatedCostUsd: 0.25,
      }),
    ).resolves.toMatchObject({
      allowed: false,
      blockers: expect.arrayContaining([
        expect.stringMatching(/exclusively to Chat/i),
        expect.stringMatching(/required caution risk/i),
        expect.stringMatching(/child-activation limit/i),
      ]),
    });
  });

  it("reserves all fan-out child slots and cost atomically, with durable idempotence", async () => {
    const service = new AutonomousActivationGrantService(
      createSettings() as never,
      vi.fn(async () => undefined),
    );
    const grant = await createFanoutGrant(service, {
      maxActivations: 3,
      budgetUsd: 0.75,
    });
    const reservation = {
      grantId: grant.grantId,
      workspaceId: "workspace-1",
      projectId: "project-1",
      surface: "chat" as const,
      riskLevel: "caution" as const,
      activationKind: "subagent_fanout" as const,
      capabilityId: "agent.fanout",
      toolName: "agent.fanout",
      requiredActivations: 3,
      estimatedCostUsd: 0.75,
      reservationId: "fanout-parent-tool-1",
    };
    await expect(service.reserveGrantUse(reservation)).resolves.toMatchObject({
      usedActivations: 3,
      usedBudgetUsd: 0.75,
    });
    await expect(service.reserveGrantUse(reservation)).resolves.toMatchObject({
      usedActivations: 3,
      usedBudgetUsd: 0.75,
    });
    await expect(
      service.evaluateGrantAuthorityById(grant.grantId, {
        workspaceId: "workspace-1",
        projectId: "project-1",
        surface: "chat",
        riskLevel: "caution",
        activationKind: "subagent_fanout",
        capabilityId: "agent.fanout",
        toolName: "agent.fanout",
      }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(service.reserveGrantUse({ ...reservation, reservationId: "fanout-parent-tool-2" })).rejects.toThrow(
      /activation count is exhausted/i,
    );
  });

  it("rejects an aggregate reservation without partially consuming quota or budget", async () => {
    const service = new AutonomousActivationGrantService(
      createSettings() as never,
      vi.fn(async () => undefined),
    );
    const grant = await createFanoutGrant(service, { maxActivations: 2, budgetUsd: 0.5 });
    await expect(
      service.reserveGrantUse({
        grantId: grant.grantId,
        workspaceId: "workspace-1",
        projectId: "project-1",
        surface: "chat",
        riskLevel: "caution",
        activationKind: "subagent_fanout",
        capabilityId: "agent.fanout",
        toolName: "agent.fanout",
        requiredActivations: 3,
        estimatedCostUsd: 0.75,
        reservationId: "too-large",
      }),
    ).rejects.toThrow(/cannot reserve/i);
    await expect(service.listGrants({ includeExpired: true })).resolves.toMatchObject([
      { grantId: grant.grantId, usedActivations: 0, usedBudgetUsd: 0 },
    ]);
  });
});

async function createFanoutGrant(
  service: AutonomousActivationGrantService,
  overrides: Partial<{ workspaceId: string; projectId: string; maxActivations: number; budgetUsd: number }> = {},
) {
  return await service.createGrant({
    workspaceId: overrides.workspaceId ?? "workspace-1",
    projectId: overrides.projectId ?? "project-1",
    surfaces: ["chat"],
    maxRiskLevel: "caution",
    capabilityPatterns: ["agent.fanout"],
    toolPatterns: ["agent.fanout"],
    activationKinds: ["subagent_fanout"],
    maxActivations: overrides.maxActivations ?? 3,
    budgetUsd: overrides.budgetUsd ?? 0.75,
    grantor: "operator",
    reason: "explicit project fan-out",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
}

function createSettings(): Pick<Storage["systemSettings"], "get" | "set" | "mutate"> {
  const records = new Map<string, unknown>();
  return {
    get: (key) => {
      if (!records.has(key)) {
        return undefined;
      }
      return {
        key,
        value: records.get(key),
        updatedAt: new Date().toISOString(),
      };
    },
    set: (key, value) => {
      records.set(key, value);
      return {
        key,
        value,
        updatedAt: new Date().toISOString(),
      };
    },
    mutate: (key, initial, updater) => {
      const current = records.has(key) ? records.get(key) : initial;
      const value = updater(current as never);
      records.set(key, value);
      return {
        key,
        value,
        updatedAt: new Date().toISOString(),
      };
    },
  };
}
