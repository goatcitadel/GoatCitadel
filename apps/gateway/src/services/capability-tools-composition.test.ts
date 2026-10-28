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

  it("writes a failed rule check to the server log once, with secrets redacted", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { wired } = owners("trusted_local");
      const failing: CapabilityToolListOwners = {
        ...wired,
        tools: {
          ...wired.tools,
          inspectToolAccess: vi.fn(async () => {
            throw new Error("upstream rejected Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz0123456789");
          }),
        },
      };

      const response = await composeCapabilityTools(failing).list("default");

      const logged = stderr.mock.calls
        .map(([chunk]) => String(chunk))
        .filter((line) => line.includes("tool rule checks failed"));
      expect(logged).toHaveLength(1);
      expect(JSON.parse(logged[0] ?? "{}")).toMatchObject({ level: "error", failedProbes: 2 });
      expect(logged[0]).toContain("upstream rejected");
      expect(logged[0]).not.toContain("sk-live-abcdefghijklmnopqrstuvwxyz0123456789");
      // The operator-visible answer names none of it.
      expect(JSON.stringify(response)).not.toContain("upstream rejected");
    } finally {
      stderr.mockRestore();
    }
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
