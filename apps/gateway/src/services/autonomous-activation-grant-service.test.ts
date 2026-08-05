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
    settings.mutate((stored) =>
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
});

function createSettings(): Pick<Storage["systemSettings"], "get" | "set"> & {
  mutate: (mutator: (value: unknown[]) => unknown[]) => void;
} {
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
    mutate: (mutator) => {
      const current = records.get("autonomous_activation_grants_v1");
      records.set("autonomous_activation_grants_v1", mutator(Array.isArray(current) ? current : []));
    },
  };
}
