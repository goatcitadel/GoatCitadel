import { describe, expect, it, vi } from "vitest";
import { classifyToolEffectPotential, type ToolInvokeRequest, type ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { executeTool } from "./tool-executor.js";
import { createDefaultToolRegistry } from "./tool-registry.js";

const config = {
  profiles: {},
  tools: { profile: "minimal", allow: [], deny: [] },
  agents: {},
  sandbox: {
    writeJailRoots: [],
    readOnlyRoots: [],
    networkAllowlist: [],
    riskyShellPatterns: [],
    requireApprovalForRiskyShell: true,
  },
} as ToolPolicyConfig;
const request = (toolName: string, args: Record<string, unknown>): ToolInvokeRequest => ({
  toolName,
  args,
  sessionId: "session",
  agentId: "assistant",
});

describe("governed discovery/read tools", () => {
  it("registers trusted built-in read-only descriptors with no effect potential", () => {
    for (const name of ["capabilities.search", "skills.read"]) {
      const definition = createDefaultToolRegistry().get(name)!;
      expect(definition).toMatchObject({
        readOnly: true,
        deterministic: true,
        requiresApproval: false,
        riskLevel: "safe",
        codeModeAllowed: false,
      });
      expect(classifyToolEffectPotential({ ...definition, toolName: name, trustedBuiltin: true }).potential).toBe(
        "none",
      );
    }
  });

  it("fails closed without Gateway hooks and rejects model-supplied scope or excessive reads", async () => {
    const storage = {} as AsyncStorage;
    await expect(executeTool(request("capabilities.search", { query: "calendar" }), config, storage)).rejects.toThrow(
      /unavailable/,
    );
    await expect(executeTool(request("skills.read", { skillId: "bundled:test" }), config, storage)).rejects.toThrow(
      /unavailable/,
    );
    const searchCapabilities = vi.fn(async () => ({ discoveryOnly: true, capabilities: [] }));
    for (const args of [
      { query: "calendar", workspaceId: "other" },
      { query: "calendar", limit: 6 },
      { query: "x".repeat(513) },
    ]) {
      await expect(
        executeTool(request("capabilities.search", args), config, storage, { searchCapabilities }),
      ).rejects.toThrow(/bounded/);
    }
    expect(searchCapabilities).not.toHaveBeenCalled();
  });

  it("forwards the server-bound invoke request to read-only owner hooks", async () => {
    const req = request("skills.read", { skillId: "bundled:test", relativePath: "guide.md" });
    const readSkill = vi.fn(async () => ({ content: "Read these instructions", permissionsGranted: false }));
    expect(await executeTool(req, config, {} as AsyncStorage, { readSkill })).toMatchObject({
      permissionsGranted: false,
    });
    expect(readSkill).toHaveBeenCalledWith(req);
    await expect(
      executeTool({ ...req, args: { ...req.args, activate: true } }, config, {} as AsyncStorage, { readSkill }),
    ).rejects.toThrow(/bounded/);
    expect(readSkill).toHaveBeenCalledTimes(1);
  });
});
