import { describe, expect, it, vi } from "vitest";
import type { DeploymentProfile, ToolAccessEvaluateRequest, ToolPolicyActorContext } from "@goatcitadel/contracts";
import {
  composeCapabilityToolUsage,
  composeCapabilityTools,
  type CapabilityToolListOwners,
} from "./capability-tools-composition.js";

describe("composeCapabilityToolUsage", () => {
  it("reads the call counts from the chat tool run history", async () => {
    const countCallsByToolSince = vi.fn(async () => [
      { toolName: "fs.read", calls: 2, lastCalledAt: "2026-10-20T00:00:00.000Z" },
    ]);

    const response = await composeCapabilityToolUsage({ chatToolRuns: { countCallsByToolSince } }).read({
      refresh: false,
    });

    expect(countCallsByToolSince).toHaveBeenCalledTimes(1);
    expect(countCallsByToolSince).toHaveBeenCalledWith(response.since);
    expect(response.tools).toEqual([{ toolName: "fs.read", calls: 2, lastCalledAt: "2026-10-20T00:00:00.000Z" }]);
    expect(response.groups.find((group) => group.groupId === "files")?.calls).toBe(2);
  });
});

describe("composeCapabilityTools", () => {
  const POLICY_CONTEXT = { permissionProfileId: "safe" } as ToolPolicyActorContext;

  function owners(deploymentProfile: DeploymentProfile) {
    const inspectToolAccess = vi.fn(async (request: ToolAccessEvaluateRequest) => ({
      toolName: request.toolName,
      allowed: true,
      reasonCodes: ["allowed"],
      requiresApproval: false,
      riskLevel: "safe" as const,
    }));
    const resolveToolPolicyContext = vi.fn(async () => POLICY_CONTEXT);
    const wired: CapabilityToolListOwners = {
      tools: {
        listToolCatalog: () => [
          { toolName: "fs.write", description: "Write a file", riskLevel: "caution" },
          { toolName: "browser.cookies.get", description: "Read cookies", riskLevel: "caution" },
        ],
        inspectToolAccess,
        resolveToolPolicyContext,
      },
      settings: { getSettings: async () => ({ revision: 3, switchedOffToolGroups: ["git"] }) },
      deploymentProfile: () => deploymentProfile,
      safeWriteFallbackDir: () => "/work/goatcitadel_out",
    };
    return { wired, inspectToolAccess, resolveToolPolicyContext };
  }

  it("lists the groups from the install's own sources and probes with the safe write folder", async () => {
    const { wired, inspectToolAccess, resolveToolPolicyContext } = owners("trusted_local");

    const response = await composeCapabilityTools(wired).list("default", { operatorId: "operator-1" });

    expect(response.settingsRevision).toBe(3);
    expect(response.groups.find((group) => group.groupId === "git")?.state).toBe("off");
    expect(resolveToolPolicyContext).toHaveBeenCalledWith({
      workspaceId: "default",
      surface: "chat",
      operatorId: "operator-1",
    });
    const write = inspectToolAccess.mock.calls.map(([request]) => request).find((r) => r.toolName === "fs.write");
    expect(write?.args).toMatchObject({ path: "/work/goatcitadel_out/tool-access-probe.txt" });
    expect(write?.policyContext).toBe(POLICY_CONTEXT);
    // The install allows cookies and storage tools, so they are probed like any other.
    expect(inspectToolAccess.mock.calls.map(([request]) => request.toolName)).toContain("browser.cookies.get");
  });

  it("reports cookies and storage tools as blocked by the install on a hardened or dev profile", async () => {
    for (const profile of ["remote_hardened", "local_dev"] as const) {
      const { wired, inspectToolAccess } = owners(profile);

      const response = await composeCapabilityTools(wired).list("default");

      const cookies = response.groups
        .find((group) => group.groupId === "browser")
        ?.tools.find((tool) => tool.toolName === "browser.cookies.get");
      expect(cookies?.blockedBy).toBe("install_profile");
      expect(inspectToolAccess.mock.calls.map(([request]) => request.toolName)).not.toContain("browser.cookies.get");
    }
  });
});
