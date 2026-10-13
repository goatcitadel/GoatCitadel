import { describe, expect, it, vi } from "vitest";
import type { ChatTurnFeatureReferences } from "@goatcitadel/contracts";
import {
  ChatTurnAgentRunner,
  type ChatTurnAgentRunnerDeps,
  type ChatTurnAgentRunnerInput,
} from "./chat-turn-agent-runner.js";
import { createMockStorage } from "./chat-turn-agent-runner-test-fixtures.js";
import { readMcpRequesterAdmissionTurnContext } from "./mcp-requester-admission-context.js";
import { readMeshAdmissionTurnContext } from "./gateway/mesh-chat-binding.js";

const scope = {
  admissionId: "admission",
  sessionIncarnationId: "incarnation",
  workspaceId: "workspace",
  sessionId: "session",
  turnId: "turn",
  aggregateRevision: 1,
  controllerGeneration: 1,
  materialSha256: "a".repeat(64),
  actorId: "actor",
  actorSource: "token" as const,
};

function fixture(kind: "static" | "requester" | "mesh", allowed = true) {
  // The canonical admission owner validates complete receipts before this runner
  // input. This fixture isolates the final invocation policy-probe handoff.
  const selected =
    kind === "mesh"
      ? { selectedMeshCapabilities: { scope } }
      : kind === "static"
        ? { selectedStaticMcp: [{ version: "mcp.static.admission.v1", scope }] }
        : { requesterConnections: [{ version: "mcp.requester.admission.v1", scope }] };
  const references = { version: "chat.turn.feature-references.v1", ...selected } as ChatTurnFeatureReferences;
  const toolName = kind === "mesh" ? "mesh:node:tool:read" : "mcp.server.read";
  const inspectToolAccess = vi.fn<NonNullable<ChatTurnAgentRunnerDeps["inspectToolAccess"]>>(
    async (_request, options) => {
      const context =
        kind === "mesh"
          ? readMeshAdmissionTurnContext(options?.meshTurnContext)
          : readMcpRequesterAdmissionTurnContext(options?.mcpRequesterTurnContext);
      if (!context) throw new Error("Missing canonical native admission context");
      expect(context.scope).toEqual(scope);
      expect(context.referenceSha256).toBe("b".repeat(64));
      return {
        allowed,
        requiresApproval: true,
        reasonCodes: allowed ? ["approval_required"] : ["policy_deny"],
        riskLevel: "danger",
        permissionProfileId: "safe",
      } as Awaited<ReturnType<NonNullable<ChatTurnAgentRunnerDeps["inspectToolAccess"]>>>;
    },
  );
  const runner = new ChatTurnAgentRunner({
    storage: createMockStorage() as never,
    listToolCatalog: () => [],
    invokeTool: vi.fn(),
    createChatCompletion: vi.fn(),
    inspectToolAccess,
  });
  const input: ChatTurnAgentRunnerInput = {
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    workspaceId: scope.workspaceId,
    authActorId: scope.actorId,
    authActorSource: scope.actorSource,
    userMessageId: "user",
    content: "Read the selected tool.",
    mode: "chat",
    providerId: "provider",
    model: "model",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    historyMessages: [],
    featureAdmission: { references, referenceSha256: "b".repeat(64) },
    canonicalWriteFence: async <T>(work: () => T | Promise<T>): Promise<Awaited<T>> => await work(),
  };
  const decision = () =>
    (
      runner as unknown as {
        resolveCapabilityProfileInvocationDecision(
          input: ChatTurnAgentRunnerInput,
          tool: { toolName: string; args: Record<string, unknown> },
        ): Promise<{ blockedReason?: string; reasonCodes: string[] }>;
      }
    ).resolveCapabilityProfileInvocationDecision(input, { toolName, args: {} });
  return { input, decision, inspectToolAccess };
}

describe("profile-free native invocation policy recheck", () => {
  it.each(["static", "requester", "mesh"] as const)(
    "passes the opaque %s admission context without bypassing approval",
    async (kind) => {
      const f = fixture(kind);
      expect(await f.decision()).toEqual({ reasonCodes: ["approval_required"] });
      expect(f.inspectToolAccess).toHaveBeenCalledOnce();
    },
  );
  it("preserves a live deny after carrying the selected static admission", async () => {
    expect(await fixture("static", false).decision()).toMatchObject({
      reasonCodes: ["policy_deny"],
      blockedReason: expect.any(String),
    });
  });
  it("fails closed before the policy probe when the turn actor changes", async () => {
    const f = fixture("static");
    f.input.authActorId = "different-actor";
    expect(await f.decision()).toMatchObject({
      reasonCodes: ["policy_evaluation_failed"],
      blockedReason: expect.any(String),
    });
    expect(f.inspectToolAccess).not.toHaveBeenCalled();
  });
});
