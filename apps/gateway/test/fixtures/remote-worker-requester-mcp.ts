import assert from "node:assert/strict";
import {
  NotFoundError,
  mcpRequesterScopeHashMaterial,
  remoteWorkerInferenceCanonicalSha256 as digest,
  type CapabilityCatalogEntry,
  type ChatTurnCapabilityToolDefinition,
  type McpServerRecord,
  type ToolInvokeResult,
  type ToolPolicyActorContext,
} from "@goatcitadel/contracts";
import { ToolPolicyEngine } from "@goatcitadel/policy-engine";
import type { AsyncStorage } from "@goatcitadel/storage";
import {
  composeMcpRequesterScopedRuntime,
  GatewayService,
  type McpRequesterScopedCompositionHost,
} from "../../src/services/gateway-service.js";
import {
  collectNativeMcpChatCatalogCandidates,
  resolveNativeMcpChatToolSchemas,
} from "../../src/services/gateway/native-mcp-chat-catalog.js";
import { resolveNativeMcpChatToolBinding } from "../../src/services/gateway/native-mcp-chat-binding.js";
import { createMcpEphemeralResolvedConnectionCandidate } from "../../src/services/mcp-requester-resolution.js";
import { buildMcpRequesterScopedTurnContextFromCapabilityProfile } from "../../src/services/mcp-requester-resolution-service.js";
import {
  buildToolCallBeforeHookInterpositionBinding,
  buildToolRuntimeOwnerBinding,
} from "../../src/services/tool-runtime-interposition.js";
import {
  ToolInvocationCoordinatorService,
  type ToolInvocationCoordinatorHost,
} from "../../src/services/tool-invocation-coordinator-service.js";
import type { RemoteWorkerApprovedActionInput } from "../../src/services/remote-worker-effect-runtime.js";

const HOST = "worker-mcp.example.test";
const RESULT = "The retained file result is Orion 7.";

/** Real Gateway MCP owners with synthetic requester credentials and wire replies.
 * The native worker still uses its actual protected TLS listener and repositories. */
export async function createRequesterMcpWorkerFixture(storage: AsyncStorage, root: string, approvalRequired: boolean) {
  const now = new Date().toISOString();
  const server: McpServerRecord = {
    serverId: "worker-mcp",
    label: "Controlled worker MCP",
    transport: "http",
    connectionMode: "requester_scoped",
    configurationRevision: 1,
    requesterResolution: {
      resolverId: "fixture.worker",
      resolverVersion: "1.0.0",
      configGeneration: 1,
      transportPolicy: {
        allowedSchemes: ["https"],
        allowedHosts: [HOST],
        allowedPorts: [443],
        allowedHeaderNames: ["authorization"],
      },
    },
    authType: "none",
    enabled: true,
    status: "disconnected",
    category: "automation",
    trustTier: "restricted",
    costTier: "unknown",
    policy: { requireFirstToolApproval: false, redactionMode: "off", allowedToolPatterns: [], blockedToolPatterns: [] },
    createdAt: now,
    updatedAt: now,
  } as McpServerRecord;
  const methods: string[] = [];
  const argumentsSeen: unknown[] = [];
  let revoked = false;
  let revokedAuthReads = 0;
  const fetchMcp = async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(new URL(String(url)).hostname, HOST);
    const body = JSON.parse(String(init?.body)) as {
      id?: number;
      method: string;
      params?: { name?: string; arguments?: unknown };
    };
    methods.push(body.method);
    const respond = (result: object) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 0, result }), {
        headers: { "content-type": "application/json" },
      });
    if (body.method === "initialize") return respond({ protocolVersion: "2025-06-18" });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list")
      return respond({
        tools: [
          {
            name: "read",
            description: "Read the controlled note",
            inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        ],
      });
    assert.equal(body.method, "tools/call");
    assert.equal(body.params?.name, "read");
    assert.deepEqual(body.params?.arguments, { path: "note.txt" });
    argumentsSeen.push(body.params?.arguments);
    return respond({ content: [{ type: "text", text: RESULT }] });
  };
  const resolve = async () =>
    createMcpEphemeralResolvedConnectionCandidate({
      outcomeClass: "resolved",
      url: `https://${HOST}/mcp`,
      headers: [{ name: "authorization", value: "Bearer controlled-worker-mcp-secret" }],
      connectionGeneration: 1,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    });
  const host: McpRequesterScopedCompositionHost = {
    resolvers: {
      profileDiscovery: [
        {
          resolverId: "fixture.worker",
          resolverVersion: "1.0.0",
          configGeneration: 1,
          resolveForProfileDiscovery: resolve,
        },
      ],
      toolCall: [
        { resolverId: "fixture.worker", resolverVersion: "1.0.0", configGeneration: 1, resolveForToolCall: resolve },
      ],
    },
    listMcpServers: async () => [server],
    getChatTurnCapabilityProfile: async (id) => {
      try {
        return await storage.chatTurnCapabilityProfiles.get(id);
      } catch (error) {
        if (error instanceof NotFoundError) return undefined;
        throw error;
      }
    },
    assertMcpServerInScope: async (request) => {
      assert.equal(request.workspaceId, "default");
    },
    readAuthConnectionState: async (actor) => {
      if (revoked) revokedAuthReads++;
      return { revoked: revoked || actor.actorId !== "operator-a" || actor.actorSource !== "token" };
    },
    getNetworkAllowlist: () => [HOST],
    recordDevDiagnostic: () => undefined,
  };
  let requester = composeMcpRequesterScopedRuntime(host);
  const wrapper: CapabilityCatalogEntry = {
    capabilityId: "tool:mcp.invoke",
    kind: "tool",
    category: "built_in",
    title: "MCP",
    summary: "Governed MCP invocation",
    callable: true,
    toolName: "mcp.invoke",
  };
  const discovery = {
    profileId: "profile-connected-worker",
    turnId: "turn-connected-worker",
    sessionId: "session-connected-worker",
    workspaceId: "default",
    authActorId: "operator-a",
    authActorSource: "token" as const,
    catalogSnapshotId: "connected-worker-snapshot",
    callableCatalogSha256: digest([wrapper]),
    requesterScopeSha256: digest(
      mcpRequesterScopeHashMaterial({
        profileId: "profile-connected-worker",
        turnId: "turn-connected-worker",
        sessionId: "session-connected-worker",
        workspaceId: "default",
        authActorId: "operator-a",
        authActorSource: "token",
      }),
    ),
  };
  const previousFetch = global.fetch;
  let callableEntries: CapabilityCatalogEntry[];
  let tools: ChatTurnCapabilityToolDefinition[];
  try {
    global.fetch = fetchMcp;
    const candidates = collectNativeMcpChatCatalogCandidates(await requester.discoverMcpRequesterCatalogs(discovery), [
      wrapper,
    ]);
    assert.equal(candidates.length, 1);
    callableEntries = [wrapper, candidates[0]!.entry];
    const schemas = await resolveNativeMcpChatToolSchemas(
      candidates,
      { ...discovery, callableCatalogSha256: digest(callableEntries) },
      requester.resolveMcpRequesterCatalogBindings,
    );
    assert.equal(schemas.length, 1);
    const native = schemas[0]!;
    tools = [
      {
        canonicalName: native.canonicalName,
        modelName: native.modelName,
        providerDefinition: native.providerDefinition,
        definitionHash: digest(native.providerDefinition),
        runtimeOwner: buildToolRuntimeOwnerBinding("builtin"),
        effectPotential: native.candidate.entry.effectPotential,
        mcpRequesterResolution: native.requesterBinding,
      },
    ];
  } finally {
    global.fetch = previousFetch;
  }
  const policyEngine = new ToolPolicyEngine(
    {
      profiles: { danger: ["*"] },
      tools: { profile: "danger", approvalMode: approvalRequired ? "approve_all" : "bypass", allow: [], deny: [] },
      agents: {},
      sandbox: {
        writeJailRoots: [root],
        readOnlyRoots: [root],
        networkAllowlist: [],
        riskyShellPatterns: [],
        requireApprovalForRiskyShell: true,
      },
    },
    storage,
  );
  const policyContext: ToolPolicyActorContext = {
    permissionProfileId: "safe",
    authActorId: "operator-a",
    authActorSource: "token",
  };
  const coordinatorHost = {
    policyEngine,
    normalizeToolInvokeRequest: async (request) => request,
    resolveNativeMcpChatToolBinding: (request, context) => resolveNativeMcpChatToolBinding(storage, request, context),
    hooksService: { runInlineHooks: async () => ({ runs: [] }), enqueueAfterHooks: async () => undefined },
    isValidToolName: () => true,
    evaluateToolDeploymentGuard: () => undefined,
    resolveToolHookWorkspaceId: async () => "default",
    resolveToolCallBeforeHookInterposition: async () => buildToolCallBeforeHookInterpositionBinding([]),
    primeToolApprovalLifecycle: (approvalId, request) =>
      storage.approvals.mergeLinkage(approvalId, {
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        turnId: request.turnId,
        runId: request.runId,
        taskId: request.taskId,
        toolName: request.toolName,
        actionType: "tool.invoke",
      }),
    scheduleApprovalExplanationById: async () => undefined,
    publishRealtime: async () => undefined,
    requireMcpServer: async () => server,
    assertMcpServerInScope: async (request) => {
      assert.equal(request.workspaceId, "default");
    },
    requesterScopedMcpDispatch: requester.requesterScopedMcpDispatch,
    invokeMcpRuntimeTool: async () => {
      throw new Error("Native requester MCP cannot use static transport");
    },
    matchesWildcard: (value, pattern) => value === pattern,
    applyMcpRedaction: (output) => output,
  } as ToolInvocationCoordinatorHost;
  const coordinator = new ToolInvocationCoordinatorService(coordinatorHost);
  const gateway = Object.assign(Object.create(GatewayService.prototype), {
    storage,
    policyEngine,
    toolInvocationCoordinator: coordinator,
    enrichMcpInvokePolicyContext: async (input: unknown) => input,
  }) as { executeApprovedRemoteWorkerAction(input: RemoteWorkerApprovedActionInput): Promise<ToolInvokeResult> };
  return {
    profileOptions: { callableEntries, tools },
    canonicalName: tools[0]!.canonicalName,
    modelName: tools[0]!.modelName,
    fetchMcp,
    isMcpRequest: (url: string | URL | Request) => new URL(String(url)).hostname === HOST,
    listCallableCapabilities: async () => [wrapper],
    resolvePolicyContext: async () => policyContext,
    revalidateRequesterTool: (profile: Parameters<typeof requester.revalidateRequesterTool>[0], name: string) =>
      requester.revalidateRequesterTool(profile, name),
    createMcpRequesterTurnContext: buildMcpRequesterScopedTurnContextFromCapabilityProfile,
    coordinator,
    executeApprovedAction: (input: RemoteWorkerApprovedActionInput) => gateway.executeApprovedRemoteWorkerAction(input),
    restartRequester: () => {
      requester = composeMcpRequesterScopedRuntime(host);
      coordinatorHost.requesterScopedMcpDispatch = requester.requesterScopedMcpDispatch;
    },
    calls: () => argumentsSeen.length,
    revokeRequester: () => {
      revoked = true;
    },
    readEvidence: () => ({ methods: [...methods], arguments: [...argumentsSeen], revokedAuthReads }),
  };
}
