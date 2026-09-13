import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { canonicalJsonString, MCP_REQUESTER_RESOLUTION_BINDING_VERSION, type ToolCatalogEntry } from "@goatcitadel/contracts";
import type { ChatTurnCapabilityProfileRecord, ToolInvokeRequest, ToolInvokeResult } from "@goatcitadel/contracts";
import { ChatTurnAgentRunner, type ChatTurnAgentRunnerDeps, type ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import { readMcpRequesterScopedTurnContext } from "./mcp-requester-resolution-service.js";
import { normalizeMcpRequesterDiscoveryOutput } from "./mcp-requester-resolution.js";
import { createMcpRequesterDiscoverySecretScanner } from "./mcp-resolution-secret-guard.js";
import { bindNativeMcpChatToolSchema, collectNativeMcpChatCatalogCandidates } from "./gateway/native-mcp-chat-catalog.js";
import { createMockStorage } from "./chat-turn-agent-runner-test-fixtures.js";

describe("native MCP schema selection in the Chat runner", () => {
  function fixture() {
    const parameters = { type: "object", properties: { query: { type: "string", minLength: 3 } }, required: ["query"], additionalProperties: false };
    const catalog = normalizeMcpRequesterDiscoveryOutput("tenant", { tools: [{ rawRemoteToolName: "search",
      canonicalToolName: "mcp.tenant.search", description: "Search records", inputSchema: parameters }] }, createMcpRequesterDiscoverySecretScanner());
    const candidate = collectNativeMcpChatCatalogCandidates([catalog], [])[0]!;
    const material = { schemaVersion: MCP_REQUESTER_RESOLUTION_BINDING_VERSION, mode: "requester_scoped" as const, serverId: "tenant", toolName: "mcp.tenant.search",
      resolverId: "gateway.tenant", resolverVersion: "1.0.0", resolverConfigGeneration: 1, requesterScopeSha256: "a".repeat(64),
      serverConfigRevision: 1, serverConfigSha256: "b".repeat(64), transportPolicySha256: "c".repeat(64),
      callableCatalogSnapshotId: "snapshot", callableCatalogSha256: "d".repeat(64) };
    const native = bindNativeMcpChatToolSchema(candidate, { ...material, bindingSha256: createHash("sha256").update(canonicalJsonString(material)).digest("hex") });
    const wrapper: ToolCatalogEntry = { toolName: "mcp.invoke", category: "ops", riskLevel: "danger", requiresApproval: true,
      description: "Invoke MCP", argSchema: { type: "object" }, examples: [], pack: "core" };
    const input = { sessionId: "session", turnId: "turn", userMessageId: "message", content: "Use mcp.tenant.search to find records.",
      mode: "chat", webMode: "off", memoryMode: "off", retrievalMode: "standard", thinkingLevel: "standard", speedMode: "standard",
      subagentPolicy: "off", toolAutonomy: "safe_auto", historyMessages: [] } as ChatTurnAgentRunnerInput;
    const probe = vi.fn<NonNullable<ChatTurnAgentRunnerDeps["inspectToolAccess"]>>(async () => ({ allowed: true, requiresApproval: true, reasonCodes: ["approval_required"] }));
    const deps = { storage: createMockStorage(), listToolCatalog: () => [wrapper], createChatCompletion: vi.fn(), invokeTool: vi.fn(), inspectToolAccess: probe } as ChatTurnAgentRunnerDeps;
    return { native, wrapper, input, probe, deps };
  }

  it("keeps the exact native schema and alias and probes its private policy binding", async () => {
    const f = fixture();
    const schema = await new ChatTurnAgentRunner(f.deps).resolveCapabilityToolSchema(f.input, [f.native]);
    expect(schema.tools).toContainEqual(f.native.providerDefinition);
    expect(schema.modelToCanonical.get(f.native.modelName)).toBe(f.native.canonicalName);
    expect(schema.policyDecisions).toContainEqual({ toolName: f.native.canonicalName, allowed: true, requiresApproval: true, reasonCodes: ["approval_required"] });
    const call = f.probe.mock.calls.find(([request]) => request.toolName === f.native.canonicalName)!;
    expect(call[1]?.mcpCatalogPolicyBinding).toBe(f.native.policyBinding);
    expect(call[1]?.mcpRequesterTurnContext).toBeUndefined();
    expect(f.probe.mock.calls.find(([request]) => request.toolName === "mcp.invoke")).toHaveLength(1);
  });

  it.each(["denied", "failed_probe", "missing_probe", "missing_wrapper"])("does not expose a native schema after %s", async (condition) => {
    const f = fixture();
    if (condition === "denied") f.probe.mockResolvedValue({ allowed: false, requiresApproval: false, reasonCodes: ["explicit_deny"] });
    if (condition === "failed_probe") f.probe.mockRejectedValue(new Error("Policy unavailable"));
    if (condition === "missing_probe") delete f.deps.inspectToolAccess;
    if (condition === "missing_wrapper") f.deps.listToolCatalog = () => [];
    const schema = await new ChatTurnAgentRunner(f.deps).resolveCapabilityToolSchema(f.input, [f.native]);
    expect(schema.modelToCanonical.has(f.native.modelName)).toBe(false);
  });

  it("rejects a cloned schema or registered-name collision before probing", async () => {
    const f = fixture();
    await expect(new ChatTurnAgentRunner(f.deps).resolveCapabilityToolSchema(f.input, [{ ...f.native }])).rejects.toThrow("not server-owned");
    f.deps.listToolCatalog = () => [f.wrapper, { ...f.wrapper, toolName: f.native.canonicalName }];
    await expect(new ChatTurnAgentRunner(f.deps).resolveCapabilityToolSchema(f.input, [f.native])).rejects.toThrow("collides");
    expect(f.probe).not.toHaveBeenCalled();
  });
});

describe.each(["mcp.invoke", "mcp.mcp-server.echo"])("ordinary Chat MCP requester context (%s)", (toolName) => {
  it("passes native requester context to the last current-policy probe", async () => {
    const inspectToolAccess = vi.fn(async () => ({ allowed: true, requiresApproval: false, reasonCodes: [] }));
    const runner = new ChatTurnAgentRunner({ inspectToolAccess } as unknown as ChatTurnAgentRunnerDeps) as unknown as {
      resolveCapabilityProfileInvocationDecision(input: ChatTurnAgentRunnerInput, tool: { toolName: string; args: Record<string, unknown> }): Promise<{ blockedReason?: string }>;
    };
    const input = { sessionId: "session", capabilityProfile: {
      profileId: "profile", identity: { turnId: "turn", sessionId: "session", workspaceId: "workspace",
        authActorId: "actor", authActorSource: "token" },
      catalog: { snapshotId: "catalog", callableHash: "a".repeat(64) }, hashes: { profileHash: "b".repeat(64) },
      governance: { policyDecisions: [{ toolName, allowed: true, requiresApproval: false }] },
      selection: { tools: [{ canonicalName: toolName }] },
    } } as unknown as ChatTurnAgentRunnerInput;
    expect(await runner.resolveCapabilityProfileInvocationDecision(input, { toolName, args: { value: "native" } }))
      .toEqual({ reasonCodes: [] });
    const call = inspectToolAccess.mock.calls[0] as unknown[];
    if (toolName === "mcp.invoke") expect(call).toHaveLength(1);
    else expect(readMcpRequesterScopedTurnContext((call[1] as { mcpRequesterTurnContext?: unknown }).mcpRequesterTurnContext))
      .toMatchObject({ profileId: "profile", actorId: "actor", turnId: "turn" });
  });
  it.each(["effect-aware", "legacy", "fenced"] as const)(
    "uses the frozen profile through the %s invocation port and ignores request authority",
    async (port) => {
      const invokeTool = vi.fn<ChatTurnAgentRunnerDeps["invokeTool"]>(async () => ({
        outcome: "executed", policyReason: "controlled transport", auditEventId: "audit",
      }));
      const invokeToolWithEffectTruth = vi.fn<NonNullable<ChatTurnAgentRunnerDeps["invokeToolWithEffectTruth"]>>(
        async () => ({ outcome: "executed", policyReason: "controlled transport", auditEventId: "audit" }),
      );
      const runner = new ChatTurnAgentRunner({
        invokeTool, ...(port === "effect-aware" ? { invokeToolWithEffectTruth } : {}),
      } as ChatTurnAgentRunnerDeps) as unknown as {
        invokeTurnTool(input: unknown, request: ToolInvokeRequest, options?: unknown): Promise<ToolInvokeResult>;
      };
      const profile = {
        profileId: "profile-chat",
        identity: { turnId: "turn-chat", sessionId: "session-chat", workspaceId: "workspace-chat",
          citadelId: "citadel-chat", authActorId: "actor-chat", authActorSource: "token" },
        catalog: { snapshotId: "catalog-chat", callableHash: "a".repeat(64) },
        hashes: { profileHash: "b".repeat(64) },
      } as ChatTurnCapabilityProfileRecord;
      const request: ToolInvokeRequest = {
        toolName, agentId: "assistant", sessionId: "session-chat",
        args: { serverId: "mcp-server", toolName: "echo", arguments: {},
          mcpRequesterTurnContext: { actorId: "forged-actor" } },
      };
      const effectOptions = {
        effectContext: {}, effectPotential: {}, onEffectPotentialEscalated: vi.fn(), onEffectReceipt: vi.fn(),
        onExecutorDispatch: vi.fn(), onAuxiliaryEffectDispatch: vi.fn(),
      };
      const canonicalWriteFence = vi.fn(async (work: () => unknown) => await work());
      await runner.invokeTurnTool({ capabilityProfile: profile,
        ...(port === "fenced" ? { canonicalWriteFence } : {}),
      }, request, port === "effect-aware" ? effectOptions : undefined);

      const options = port === "effect-aware" ? invokeToolWithEffectTruth.mock.calls[0]![1] : invokeTool.mock.calls[0]![1];
      expect(readMcpRequesterScopedTurnContext(options?.mcpRequesterTurnContext)).toMatchObject({
        profileId: profile.profileId, finalProfileSha256: profile.hashes.profileHash,
        actorId: "actor-chat", actorSource: "token", sessionId: "session-chat", turnId: "turn-chat",
        workspaceId: "workspace-chat", callableCatalogSnapshotId: "catalog-chat",
      });
      expect(() => JSON.stringify(options?.mcpRequesterTurnContext)).toThrow();
      expect(readMcpRequesterScopedTurnContext({ ...options?.mcpRequesterTurnContext })).toBeUndefined();
      if (port !== "legacy") {
        await options?.executionFence?.();
        expect(port === "fenced" ? canonicalWriteFence : effectOptions.onExecutorDispatch).toHaveBeenCalledOnce();
      }

      // Missing or unsupported identity does not fall back to the tool request.
      for (const capabilityProfile of [undefined, { ...profile, identity: { ...profile.identity, authActorSource: "mesh_node" } }]) {
        invokeTool.mockClear();
        invokeToolWithEffectTruth.mockClear();
        await runner.invokeTurnTool({ capabilityProfile }, request, port === "effect-aware" ? effectOptions : undefined);
        const missing = port === "effect-aware" ? invokeToolWithEffectTruth.mock.calls[0]![1] : invokeTool.mock.calls[0]![1];
        expect(missing?.mcpRequesterTurnContext).toBeUndefined();
      }
    },
  );
});
