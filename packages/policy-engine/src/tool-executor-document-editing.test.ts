import { describe, expect, it, vi } from "vitest";
import type { AsyncStorage, Storage } from "@goatcitadel/storage";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import { executeTool } from "./tool-executor.js";

describe("document.propose_patch tool execution", () => {
  it("delegates document content while preserving the server-authored invocation binding", async () => {
    const proposeDocumentPatch = vi.fn(async () => ({ proposalId: "proposal-1", state: "pending" }));
    const request: ToolInvokeRequest = {
      toolName: "document.propose_patch",
      sessionId: "session-1",
      turnId: "turn-1",
      workspaceId: "workspace-1",
      agentId: "assistant",
      args: {
        targetKind: "personal_note",
        targetId: "note-1",
        baseRevision: 2,
        proposedContent: "replacement",
        workspaceId: "forged-workspace",
        turnId: "forged-turn",
      },
    };
    const result = await executeTool(request, config(), storage(), { proposeDocumentPatch });
    expect(proposeDocumentPatch).toHaveBeenCalledWith(request, {
      targetKind: "personal_note",
      targetId: "note-1",
      baseRevision: 2,
      proposedContent: "replacement",
    });
    expect(result).toMatchObject({ proposalId: "proposal-1", state: "pending" });
  });

  it("fails closed without the Gateway document owner", async () => {
    await expect(
      executeTool(
        {
          toolName: "document.propose_patch",
          sessionId: "session-1",
          turnId: "turn-1",
          agentId: "assistant",
          args: { targetKind: "personal_note", targetId: "note-1", baseRevision: 1, proposedContent: "text" },
        },
        config(),
        storage(),
      ),
    ).rejects.toThrow(/unavailable/i);
  });
});

function config(): ToolPolicyConfig {
  return {
    profiles: { standard: ["*"] },
    tools: { profile: "standard", allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: [],
      readOnlyRoots: [],
      networkAllowlist: [],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
}

function storage(): Storage & AsyncStorage {
  return { toolGrants: { listActiveBySession: vi.fn(() => []) } } as unknown as Storage & AsyncStorage;
}
