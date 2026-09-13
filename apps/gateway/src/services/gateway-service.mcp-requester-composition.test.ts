import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalJsonString,
  type CapabilityCatalogEntry,
  type ChatTurnCapabilityProfileRecord,
  type McpServerRecord,
  type ToolInvokeRequest,
  type ToolInvokeResult,
  type ToolPolicyConfig,
} from "@goatcitadel/contracts";
import { ToolPolicyEngine } from "@goatcitadel/policy-engine";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import {
  ToolInvocationCoordinatorService,
  type ToolInvocationCoordinatorHost,
} from "./tool-invocation-coordinator-service.js";
import { resolveNativeMcpChatToolBinding } from "./gateway/native-mcp-chat-binding.js";
import { ChatTurnAgentRunner } from "./chat-turn-agent-runner.js";
import { assertChatCapabilityBindingsCurrent } from "./chat-capability-current-binding.js";
import {
  createMcpEphemeralResolvedConnectionCandidate,
  type McpEphemeralResolvedConnectionInput,
  type McpRequesterResolverRegistryInput,
} from "./mcp-requester-resolution.js";
import {
  buildMcpRequesterScopedTurnContextFromCapabilityProfile,
  type McpRequesterScopedProfileFreezeHookInput,
  type McpRequesterScopedTurnContextHandle,
} from "./mcp-requester-resolution-service.js";
import type { ChatTurnCapabilityProfileResolveDeps } from "./chat-turn-capability-profile-service.js";
import * as mcpDiagnosticsService from "./mcp-diagnostics-service.js";
import {
  composeMcpRequesterScopedRuntime,
  GatewayService,
  type McpRequesterScopedComposedRuntime,
  type McpRequesterScopedCompositionHost,
} from "./gateway-service.js";
import { loadGatewayConfig } from "../config.js";
import { seedRemoteWorkerInferenceAuthority } from "../../../../packages/storage/src/remote-worker-inference-fixture.js";
import {
  RemoteWorkerEffectRuntime,
  type RemoteWorkerApprovedActionInput,
  type RemoteWorkerEffectRuntimeDependencies,
} from "./remote-worker-effect-runtime.js";
import type { DispatchRemoteWorkerEffectInput } from "./remote-worker-effect-settlement-service.js";
import { buildToolCallBeforeHookInterpositionBinding } from "./tool-runtime-interposition.js";

const profileServiceCapture = vi.hoisted(() => ({ deps: [] as unknown[] }));

vi.mock("./chat-turn-capability-profile-service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./chat-turn-capability-profile-service.js")>();
  return {
    ...original,
    resolveChatTurnCapabilityProfile: vi.fn(async (deps: unknown) => {
      profileServiceCapture.deps.push(deps);
      throw new Error("capability-profile deps captured (test stop)");
    }),
  };
});

const START = Date.parse("2026-07-22T12:00:00.000Z");
const NETWORK_ALLOWLIST = ["a.example.test", "b.example.test"];

function digest(input: unknown): string {
  return createHash("sha256").update(canonicalJsonString(input)).digest("hex");
}

function requesterScopedServerRecord(): McpServerRecord {
  return {
    serverId: "tenant-mcp",
    label: "Tenant MCP",
    transport: "http",
    connectionMode: "requester_scoped",
    configurationRevision: 7,
    requesterResolution: {
      resolverId: "gateway.tenant",
      resolverVersion: "1.2.3",
      configGeneration: 4,
      transportPolicy: {
        allowedSchemes: ["https"],
        allowedHosts: ["a.example.test", "b.example.test"],
        allowedPorts: [443],
        allowedHeaderNames: ["authorization", "x-tenant"],
      },
    },
    authType: "none",
    enabled: true,
    status: "disconnected",
    category: "automation",
    trustTier: "restricted",
    costTier: "unknown",
    policy: {
      requireFirstToolApproval: false,
      redactionMode: "off",
      allowedToolPatterns: [],
      blockedToolPatterns: [],
    },
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  } as McpServerRecord;
}

function staticServerRecord(): McpServerRecord {
  return {
    serverId: "static-mcp",
    label: "Static MCP",
    transport: "http",
    url: "https://static.example.test/mcp",
    authType: "none",
    enabled: true,
    status: "connected",
    category: "automation",
    trustTier: "restricted",
    costTier: "unknown",
    policy: {
      requireFirstToolApproval: false,
      redactionMode: "off",
      allowedToolPatterns: [],
      blockedToolPatterns: [],
    },
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  } as McpServerRecord;
}

function profileRecordFor(actorId: string): ChatTurnCapabilityProfileRecord {
  const callableHash = digest({ tools: ["mcp.tenant-mcp.search"], actorId });
  return {
    profileId: `chat-capability-profile-turn-${actorId}`,
    identity: {
      turnId: `turn-${actorId}`,
      sessionId: `session-${actorId}`,
      workspaceId: "workspace-1",
      citadelId: "citadel-1",
      authActorId: actorId,
      authActorSource: "token",
    },
    catalog: {
      snapshotId: `chat-cap-snap-${actorId}`,
      inspectableHash: callableHash,
      callableHash,
      inspectableCount: 1,
      callableCount: 1,
    },
    hashes: {
      identityHash: digest({ identity: actorId }),
      sourceHash: digest({ source: actorId }),
      catalogHash: digest({ catalog: actorId }),
      selectionHash: digest({ selection: actorId }),
      governanceHash: digest({ governance: actorId }),
      profileHash: digest({ profile: actorId }),
    },
  } as unknown as ChatTurnCapabilityProfileRecord;
}

function freezeHookFor(profile: ChatTurnCapabilityProfileRecord): McpRequesterScopedProfileFreezeHookInput {
  return {
    profileId: profile.profileId,
    turnId: profile.identity.turnId,
    sessionId: profile.identity.sessionId,
    workspaceId: profile.identity.workspaceId,
    authActorId: profile.identity.authActorId as string,
    authActorSource: profile.identity.authActorSource as "token",
    catalogSnapshotId: profile.catalog.snapshotId,
    callableCatalogSha256: profile.catalog.callableHash,
    canonicalToolName: "mcp.tenant-mcp.search",
    modelToolName: "mcp__scoped_search",
  };
}

function resolvedFor(stage: "profile_discovery" | "tool_call", actorId: string): McpEphemeralResolvedConnectionInput {
  const host = stage === "profile_discovery" ? "a.example.test" : "b.example.test";
  return {
    outcomeClass: "resolved",
    url: `https://${host}/tools?requester=${actorId}&stage=${stage}`,
    headers: [
      { name: "Authorization", value: `Bearer secret-${actorId}-${stage}` },
      { name: "X-Tenant", value: actorId },
    ],
    connectionGeneration: 11,
    expiresAt: "2026-07-22T12:04:00.000Z",
  };
}

const originalFetch = global.fetch;

interface Captured {
  url: string;
  method: string;
  authorization?: string;
  dispatcher?: unknown;
}

let captured: Captured[];

const DISCOVERED_TOOLS = [
  {
    name: "search",
    description: "Search safely",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  },
];

function stubFetch(options: { toolDescription?: string } = {}): void {
  global.fetch = vi.fn(async (url: string, init?: RequestInit & { dispatcher?: unknown }) => {
    const body = JSON.parse(String((init as RequestInit).body)) as { id?: number; method?: string };
    const headers = (init?.headers ?? {}) as Record<string, string>;
    captured.push({
      url,
      method: body.method ?? "unknown",
      authorization: headers.Authorization ?? headers.authorization,
      dispatcher: init?.dispatcher,
    });
    const respond = (result: Record<string, unknown>) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 0, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (body.method === "initialize") {
      return respond({ protocolVersion: "2025-06-18" });
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (body.method === "tools/list") {
      return respond({
        tools: options.toolDescription
          ? [{ ...DISCOVERED_TOOLS[0], description: options.toolDescription }]
          : DISCOVERED_TOOLS,
      });
    }
    if (body.method === "tools/call") {
      return respond({ content: [{ type: "text", text: "done" }] });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof global.fetch;
}

interface Harness {
  runtime: McpRequesterScopedComposedRuntime;
  restart(): McpRequesterScopedComposedRuntime;
  servers: McpServerRecord[];
  profiles: Map<string, ChatTurnCapabilityProfileRecord>;
  revokedActors: Set<string>;
  diagnostics: Array<{ event: string; reasonCode: unknown }>;
  discoveryResolver: ReturnType<typeof vi.fn>;
  toolCallResolver: ReturnType<typeof vi.fn>;
  contextFor(profile: ChatTurnCapabilityProfileRecord): McpRequesterScopedTurnContextHandle;
}

function buildHarness(
  options: { resolvers?: boolean; onAuthRead?: () => void; scopePort?: boolean; scopeAllowed?: boolean } = {},
): Harness {
  const servers: McpServerRecord[] = [requesterScopedServerRecord(), staticServerRecord()];
  const profiles = new Map<string, ChatTurnCapabilityProfileRecord>();
  const revokedActors = new Set<string>();
  const diagnostics: Array<{ event: string; reasonCode: unknown }> = [];
  const discoveryResolver = vi.fn(async ({ requester }: { requester: { actorId: string } }) =>
    createMcpEphemeralResolvedConnectionCandidate(resolvedFor("profile_discovery", requester.actorId)),
  );
  const toolCallResolver = vi.fn(async ({ requester }: { requester: { actorId: string } }) =>
    createMcpEphemeralResolvedConnectionCandidate(resolvedFor("tool_call", requester.actorId)),
  );
  const resolvers: McpRequesterResolverRegistryInput = {
    profileDiscovery: [
      {
        resolverId: "gateway.tenant",
        resolverVersion: "1.2.3",
        configGeneration: 4,
        resolveForProfileDiscovery: discoveryResolver as never,
      },
    ],
    toolCall: [
      {
        resolverId: "gateway.tenant",
        resolverVersion: "1.2.3",
        configGeneration: 4,
        resolveForToolCall: toolCallResolver as never,
      },
    ],
  };
  const host: McpRequesterScopedCompositionHost = {
    ...(options.resolvers === false ? {} : { resolvers }),
    ...(options.scopePort === false
      ? {}
      : {
          assertMcpServerInScope: async () => {
            if (options.scopeAllowed === false) throw new Error("MCP server is outside this workspace");
          },
        }),
    listMcpServers: async () => servers.map((server) => ({ ...server })),
    getChatTurnCapabilityProfile: async (profileId) => profiles.get(profileId),
    readAuthConnectionState: async (actor) => {
      options.onAuthRead?.();
      return { revoked: revokedActors.has(actor.actorId) };
    },
    getNetworkAllowlist: () => NETWORK_ALLOWLIST,
    recordDevDiagnostic: (input) => {
      diagnostics.push({
        event: input.event,
        reasonCode: (input.context as Record<string, unknown> | undefined)?.reasonCode,
      });
    },
    now: () => START,
  };
  return {
    runtime: composeMcpRequesterScopedRuntime(host),
    restart: () => composeMcpRequesterScopedRuntime(host),
    servers,
    profiles,
    revokedActors,
    diagnostics,
    discoveryResolver,
    toolCallResolver,
    contextFor: (profile) => {
      const handle = buildMcpRequesterScopedTurnContextFromCapabilityProfile(profile);
      if (!handle) throw new Error("test fixture profile must produce a turn context");
      return handle;
    },
  };
}

beforeEach(() => {
  captured = [];
  stubFetch();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("composeMcpRequesterScopedRuntime (HX-415 slice 7d composed E2E)", () => {
  it.each(["chat", "worker", "approved worker"] as const)(
    "discovers, freezes, persists and dispatches native MCP through %s and the composed requester runtime",
    async (executionKind) => {
      const harness = buildHarness();
      const profile = profileRecordFor("operator-a");
      harness.profiles.set(profile.profileId, profile);
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-composed-native-mcp-"));
      const storage = new Storage({
        dbPath: ":memory:",
        transcriptsDir: path.join(root, "transcripts"),
        auditDir: path.join(root, "audit"),
      });
      const workerSeed =
        executionKind === "chat" ? undefined : seedRemoteWorkerInferenceAuthority(storage.db, "composed-mcp");
      const executionWorkspaceId = workerSeed ? "default" : "workspace-1";
      if (workerSeed)
        Object.assign(profile.identity, {
          workspaceId: executionWorkspaceId,
          sessionId: workerSeed.sessionId,
          turnId: workerSeed.turnId,
          durableRunId: workerSeed.durableRunId,
        });
      try {
        const config: ToolPolicyConfig = {
          profiles: { danger: ["*"] },
          tools: { profile: "danger", approvalMode: "bypass", allow: [], deny: [] },
          agents: {},
          sandbox: {
            writeJailRoots: [root],
            readOnlyRoots: [root],
            networkAllowlist: [],
            riskyShellPatterns: [],
            requireApprovalForRiskyShell: true,
          },
        };
        const policyEngine = new ToolPolicyEngine(config, createSqliteAsyncStorage(storage));
        const asyncStorage = createSqliteAsyncStorage(storage);
        const wrapper: CapabilityCatalogEntry = {
          capabilityId: "tool:mcp.invoke",
          kind: "tool",
          category: "built_in",
          title: "MCP",
          summary: "Governed MCP invocation",
          callable: true,
          toolName: "mcp.invoke",
        };
        const schemaRunner = new ChatTurnAgentRunner({
          storage: asyncStorage,
          listToolCatalog: () => policyEngine.listCatalog().filter((tool) => tool.toolName === "mcp.invoke"),
          createChatCompletion: vi.fn(),
          invokeTool: vi.fn(),
          inspectToolAccess: (request, options) =>
            policyEngine.inspectAccess(
              request,
              options?.mcpCatalogPolicyBinding ? { mcpToolBinding: options.mcpCatalogPolicyBinding } : undefined,
            ),
        });
        const actualProfileService = await vi.importActual<typeof import("./chat-turn-capability-profile-service.js")>(
          "./chat-turn-capability-profile-service.js",
        );
        const frozen = await actualProfileService.resolveChatTurnCapabilityProfile(
          {
            storage: asyncStorage,
            listCapabilityCatalog: async () => [wrapper],
            resolveToolSchema: (input, native) => schemaRunner.resolveCapabilityToolSchema(input, native),
            resolveToolPolicyContext: async () => ({
              authActorId: "operator-a",
              authActorSource: "token",
              workspaceId: executionWorkspaceId,
              sessionId: profile.identity.sessionId,
            }),
            getProviderReadiness: () => ({ configured: true, local: false }),
            discoverMcpRequesterCatalogs: harness.runtime.discoverMcpRequesterCatalogs,
            resolveMcpRequesterCatalogBindings: harness.runtime.resolveMcpRequesterCatalogBindings,
          },
          {
            sessionId: profile.identity.sessionId,
            turnId: profile.identity.turnId,
            workspaceId: executionWorkspaceId,
            ...(workerSeed ? { durableRunId: workerSeed.durableRunId } : {}),
            citadelId: "citadel-1",
            route: { channel: "chat", account: "default" },
            content: "Use mcp.tenant-mcp.search to find records.",
            mode: "chat",
            webMode: "off",
            memoryMode: "off",
            retrievalMode: "standard",
            thinkingLevel: "standard",
            speedMode: "standard",
            subagentPolicy: "off",
            toolAutonomy: "safe_auto",
            historyMessages: [],
            routeResolution: {
              effectiveProviderId: "controlled",
              effectiveModel: "controlled-model",
              fallbackPolicy: "off",
              runtimeClass: "cloud",
            },
            authActorId: "operator-a",
            authActorSource: "token",
          },
        );
        Object.assign(profile, frozen.profile);
        harness.profiles.set(profile.profileId, profile);
        const native = profile.selection.tools.find((tool) => tool.canonicalName === "mcp.tenant-mcp.search")!;
        expect(native).toBeDefined();
        expect(native.modelName).toMatch(/^mcp__[A-Za-z0-9_-]{43}$/);
        expect((native.providerDefinition.function as Record<string, unknown>).parameters).toEqual(
          DISCOVERED_TOOLS[0]!.inputSchema,
        );
        expect(harness.discoveryResolver).toHaveBeenCalledTimes(2);
        expect(captured.filter((call) => call.method === "tools/list")).toHaveLength(2);
        const { workspaceId, sessionId, turnId } = profile.identity;
        if (!workerSeed)
          storage.chatSessionLifecycles.initialize({
            workspaceId,
            sessionId,
            actorId: "operator-a",
            idempotencyKey: "native:init",
            correlationId: "native:init",
          });
        const admitted = storage.sessionMutationAdmissions.admit({
          workspaceId,
          sessionId,
          turnId,
          runtimeOwnerId: "native-runtime",
          admissionKind: "turn_write",
          aggregateRevision: 1,
          controllerGeneration: 1,
          actorKind: "system",
          actorId: "system:test",
          operation: "chat.turn.execute",
          materialSha256: digest({ turnId }),
          idempotencyKey: "native:admit",
          correlationId: "native:admit",
        }).admission;
        storage.db.transaction("immediate", () => {
          storage.capabilityCatalogSnapshots.create(frozen.catalogSnapshot);
          storage.sessionMutationAdmissions.bindCapabilityProfile({
            admissionId: admitted.admissionId,
            workspaceId,
            sessionId,
            sessionIncarnationId: admitted.sessionIncarnationId,
            turnId,
            profileId: profile.profileId,
            profileHash: profile.hashes.profileHash,
            createdAt: profile.createdAt,
            requestRuntimeClaim: {
              runtimeOwnerId: admitted.runtimeOwnerId!,
              leaseRevision: admitted.runtimeLeaseRevision!,
            },
          });
          storage.chatTurnCapabilityProfiles.create(profile);
        });
        expect(storage.chatTurnCapabilityProfiles.get(profile.profileId)).toEqual(profile);
        await expect(
          assertChatCapabilityBindingsCurrent(
            profile,
            asyncStorage,
            [wrapper],
            harness.runtime.revalidateRequesterTool,
          ),
        ).resolves.toBeUndefined();
        await expect(assertChatCapabilityBindingsCurrent(profile, asyncStorage, [wrapper])).rejects.toThrow(
          "cannot verify its native MCP catalog",
        );
        await expect(
          assertChatCapabilityBindingsCurrent(profile, asyncStorage, [], harness.runtime.revalidateRequesterTool),
        ).rejects.toThrow("shared MCP capability");
        const restarted = harness.restart();
        const staticTransport = vi.fn();
        const host = {
          policyEngine,
          normalizeToolInvokeRequest: async (request: ToolInvokeRequest) => request,
          resolveNativeMcpChatToolBinding: (request, context) =>
            resolveNativeMcpChatToolBinding(asyncStorage, request, context),
          hooksService: { runInlineHooks: async () => ({ runs: [] }), enqueueAfterHooks: async () => undefined },
          isValidToolName: () => true,
          evaluateToolDeploymentGuard: () => undefined,
          resolveToolHookWorkspaceId: async () => executionWorkspaceId,
          resolveToolCallBeforeHookInterposition: async () => buildToolCallBeforeHookInterpositionBinding([]),
          primeToolApprovalLifecycle: async (approvalId, request) =>
            asyncStorage.approvals.mergeLinkage(approvalId, {
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
          requireMcpServer: async () => harness.servers[0]!,
          assertMcpServerInScope: async (request) => {
            expect(request.workspaceId).toBe(executionWorkspaceId);
          },
          requesterScopedMcpDispatch: restarted.requesterScopedMcpDispatch,
          invokeMcpRuntimeTool: staticTransport,
          matchesWildcard: (value, pattern) => value === pattern,
          applyMcpRedaction: (output) => output,
        } as ToolInvocationCoordinatorHost;
        const coordinator = new ToolInvocationCoordinatorService(host);
        const invoke = vi.spyOn(coordinator, "invokeTool");
        const request: ToolInvokeRequest = {
          toolName: "mcp.tenant-mcp.search",
          args: { query: "native invocation" },
          agentId: "assistant",
          sessionId: profile.identity.sessionId,
          turnId: profile.identity.turnId,
          toolRunId: "native-tool-run",
          workspaceId: profile.identity.workspaceId,
          citadelId: profile.identity.citadelId,
          policyContext: { authActorId: "operator-a", authActorSource: "token" },
        };
        const executionFence = vi.fn();
        const markStarted = vi.fn();
        const options = {
          mcpRequesterTurnContext: harness.contextFor(profile),
          executionFence,
          externalSideEffect: { markStarted, markNotRequired: vi.fn() },
        };
        captured = [];
        if (!workerSeed) {
          const result = await coordinator.invokeTool(request, options);
          expect(result).toMatchObject({ outcome: "executed", result: { toolName: request.toolName, ok: true } });
          expect(JSON.stringify(result)).not.toMatch(/secret-operator-a|example\.test/u);
        } else {
          const assignment = storage.remoteWorkerAssignments.getAssignment("default", workerSeed.assignmentId);
          const resolveResume = vi.fn<
            RemoteWorkerEffectRuntimeDependencies["storage"]["remoteWorkerAssignments"]["resolveActiveChatApprovalResume"]
          >(async () => undefined);
          // Protected admission and approval handoff are controlled fixtures;
          // tool, policy, pending-action, requester and effect owners are real.
          const workerStorage = {
            remoteWorkerEffects: asyncStorage.remoteWorkerEffects,
            chatToolRuns: asyncStorage.chatToolRuns,
            approvals: asyncStorage.approvals,
            pendingApprovalActions: asyncStorage.pendingApprovalActions,
            mutationIdempotency: asyncStorage.mutationIdempotency,
            externalSideEffectRuns: asyncStorage.externalSideEffectRuns,
            runImmediateTransaction: (work) => asyncStorage.runImmediateTransaction(work),
            chatTurnCapabilityProfiles: asyncStorage.chatTurnCapabilityProfiles,
            capabilityCatalogSnapshots: asyncStorage.capabilityCatalogSnapshots,
            skillLifecycle: asyncStorage.skillLifecycle,
            remoteWorkerAssignments: {
              resolveActiveChatExecution: async () => ({
                authority: {
                  assignment: {
                    ...assignment,
                    manifest: {
                      ...assignment.manifest,
                      capabilityProfileSha256: profile.hashes.profileHash,
                      requiredCapabilityClasses: ["durable_compute", "governed_tool"],
                    },
                  },
                },
                workload: { capabilityProfileId: profile.profileId },
              }),
              resolveActiveChatApprovalResume: resolveResume,
            } as unknown as RemoteWorkerEffectRuntimeDependencies["storage"]["remoteWorkerAssignments"],
          } satisfies RemoteWorkerEffectRuntimeDependencies["storage"];
          const gateway = Object.assign(Object.create(GatewayService.prototype), {
            storage: asyncStorage,
            policyEngine,
            toolInvocationCoordinator: coordinator,
            enrichMcpInvokePolicyContext: async (input: unknown) => input,
          }) as {
            executeApprovedRemoteWorkerAction(input: RemoteWorkerApprovedActionInput): Promise<ToolInvokeResult>;
          };
          const workerDependencies: RemoteWorkerEffectRuntimeDependencies = {
            storage: workerStorage,
            coordinator,
            listCallableCapabilities: async () => [wrapper],
            revalidateRequesterTool: restarted.revalidateRequesterTool,
            resolvePolicyContext: async () => ({
              permissionProfileId: profile.governance.permission.profileId,
              authActorId: "operator-a",
              authActorSource: "token",
            }),
            createMcpRequesterTurnContext: buildMcpRequesterScopedTurnContextFromCapabilityProfile,
            withToolModelBudget: async (_input, operation) => operation(),
            executeApprovedAction: (input) => gateway.executeApprovedRemoteWorkerAction(input),
          };
          const workerInput: DispatchRemoteWorkerEffectInput = {
            fence: {
              registryWorkspaceId: "default",
              assignmentId: workerSeed.assignmentId,
              assignmentGeneration: 1,
              sessionControlGeneration: null,
              leaseTokenSha256: digest("controlled-lease"),
              protectedAuthority: { controlled: true } as NonNullable<
                DispatchRemoteWorkerEffectInput["fence"]["protectedAuthority"]
              >,
            },
            intentIndex: 0,
            effectSelector: request.toolName,
            canonicalArgs: request.args,
            workerIdempotencyKey: "composed-native-call",
            intentIdempotencyKey: "composed-native-intent",
          };
          if (executionKind === "approved worker") config.tools.approvalMode = "approve_all";
          const initial = await new RemoteWorkerEffectRuntime(workerDependencies).dispatchEffect(workerInput);
          expect(initial.receipt?.receiptState, JSON.stringify(await invoke.mock.results[0]!.value)).not.toBe(
            "blocked_before_dispatch",
          );
          if (executionKind === "approved worker") {
            expect(initial.receipt).toBeUndefined();
            expect(captured).toEqual([]);
            const waitingTool = await asyncStorage.chatToolRuns.get(`remote-tool:${initial.intentId}`);
            expect(waitingTool).toMatchObject({
              status: "approval_required",
              toolName: request.toolName,
              args: request.args,
            });
            const approval = await asyncStorage.approvals.resolve(waitingTool.approvalId!, {
              decision: "approve",
              resolvedBy: "operator-a",
            });
            const pending = (await asyncStorage.pendingApprovalActions.find(approval.approvalId))!;
            expect(pending.request).toMatchObject({ toolName: request.toolName, args: request.args });
            resolveResume.mockResolvedValue({
              material: {
                approvalId: approval.approvalId,
                intentId: initial.intentId,
                approvalSha256: digest(approval),
                pendingActionSha256: digest(pending),
              },
              materialSha256: digest("controlled-resume"),
            } as NonNullable<Awaited<ReturnType<typeof resolveResume>>>);
            host.requesterScopedMcpDispatch = harness.restart().requesterScopedMcpDispatch;
          }
          const completed = await new RemoteWorkerEffectRuntime(workerDependencies).dispatchEffect(workerInput);
          expect(completed.receipt?.receiptState).toBe("completed_with_effect");
          const tool = await asyncStorage.chatToolRuns.get(`remote-tool:${completed.intentId}`);
          expect(tool).toMatchObject({
            status: "executed",
            toolName: request.toolName,
            args: request.args,
            effectOutcomeKind: "concrete",
            result: { toolName: request.toolName, ok: true },
          });
          const effects = await asyncStorage.externalSideEffectRuns.listByWorkspace(executionWorkspaceId, 10);
          expect(effects.filter((effect) => effect.externalCallStartedAt)).toHaveLength(1);
          expect(JSON.stringify({ completed, tool, effects })).not.toMatch(
            /secret-operator-a|example\.test|mcpRequesterTurnContext/u,
          );
          const wireCount = captured.length;
          expect(await new RemoteWorkerEffectRuntime(workerDependencies).dispatchEffect(workerInput)).toEqual(
            completed,
          );
          expect(captured).toHaveLength(wireCount);
          config.tools.approvalMode = "bypass";
        }
        expect(captured.map((call) => call.method)).toEqual([
          "initialize",
          "notifications/initialized",
          "tools/list",
          "initialize",
          "notifications/initialized",
          "tools/list",
          "tools/call",
        ]);
        const callBody = JSON.parse(String(vi.mocked(global.fetch).mock.calls.at(-1)?.[1]?.body));
        expect(callBody.params).toMatchObject({ name: "search", arguments: request.args });
        expect(executionFence).toHaveBeenCalledTimes(workerSeed ? 0 : 1);
        expect(markStarted).toHaveBeenCalledTimes(workerSeed ? 0 : 1);
        expect(harness.discoveryResolver).toHaveBeenCalledTimes(3);
        expect(staticTransport).not.toHaveBeenCalled();
        expect(storage.toolAccessDecisions.countToolCallsInLastHour("mcp.invoke", "assistant", request.sessionId)).toBe(
          1,
        );
        expect(
          storage.toolAccessDecisions.countToolCallsInLastHour(request.toolName, "assistant", request.sessionId),
        ).toBe(1);

        // A second fresh runtime must check pinned server state BEFORE resolving
        // credentials. It can never adopt a changed endpoint/configuration.
        const serverBefore = { ...harness.servers[0]! };
        harness.servers[0]!.configurationRevision! += 1;
        captured = [];
        const beforeResolvers = harness.discoveryResolver.mock.calls.length;
        const blockedFence = vi.fn();
        const retry = {
          server: harness.servers[0]!,
          toolName: "search",
          arguments: request.args,
          mcpRequesterTurnContext: options.mcpRequesterTurnContext,
        };
        const changedServer = await harness
          .restart()
          .requesterScopedMcpDispatch.invoke(retry, { effectDispatch: blockedFence });
        expect(changedServer).toMatchObject({ ok: false, failurePhase: "pre_dispatch" });
        expect(harness.discoveryResolver).toHaveBeenCalledTimes(beforeResolvers);
        expect(captured).toEqual([]);
        harness.servers[0] = serverBefore;

        // Fresh schema discovery cannot replace the retained provider alias.
        stubFetch({ toolDescription: "Changed after the profile was frozen" });
        const schemaDrift = await harness
          .restart()
          .requesterScopedMcpDispatch.invoke({ ...retry, server: serverBefore }, { effectDispatch: blockedFence });
        expect(schemaDrift.ok).toBe(false);
        expect(captured.filter((call) => call.method === "tools/call")).toEqual([]);
        expect(blockedFence).not.toHaveBeenCalled();
        expect(JSON.stringify(schemaDrift)).toContain("schema_revalidation_drift");
        stubFetch();

        // The retained profile hash is re-read before recovery can use credentials.
        harness.profiles.set(profile.profileId, {
          ...profile,
          hashes: { ...profile.hashes, profileHash: "f".repeat(64) },
        });
        captured = [];
        expect(
          (
            await harness
              .restart()
              .requesterScopedMcpDispatch.invoke({ ...retry, server: serverBefore }, { effectDispatch: blockedFence })
          ).ok,
        ).toBe(false);
        expect(captured).toEqual([]);
        expect(blockedFence).not.toHaveBeenCalled();
        harness.profiles.set(profile.profileId, profile);

        // The saved handle and mapping never outrank current requester revocation.
        harness.revokedActors.add("operator-a");
        await expect(
          assertChatCapabilityBindingsCurrent(
            profile,
            asyncStorage,
            [wrapper],
            harness.runtime.revalidateRequesterTool,
          ),
        ).rejects.toThrow("no longer current");
        captured = [];
        expect((await coordinator.invokeTool(request, options)).outcome).toBe("blocked");
        expect(captured).toEqual([]);
        expect(executionFence).toHaveBeenCalledTimes(workerSeed ? 0 : 1);
        expect(markStarted).toHaveBeenCalledTimes(workerSeed ? 0 : 1);
      } finally {
        storage.close();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["missing_scope", "denied_scope", "missing_resolver"])(
    "omits discovery without authority: %s",
    async (caseName) => {
      const harness = buildHarness({
        scopePort: caseName !== "missing_scope",
        scopeAllowed: caseName !== "denied_scope",
        resolvers: caseName !== "missing_resolver",
      });
      const hook = freezeHookFor(profileRecordFor("operator-a"));
      expect(await harness.runtime.discoverMcpRequesterCatalogs(hook)).toEqual([]);
      expect(harness.discoveryResolver).not.toHaveBeenCalled();
      expect(captured).toEqual([]);
    },
  );

  it("runs profile freeze -> discovery outcome -> revalidated tools/call end to end with one effect dispatch", async () => {
    const harness = buildHarness();
    const profile = profileRecordFor("operator-a");
    harness.profiles.set(profile.profileId, profile);

    const binding = await harness.runtime.resolveMcpRequesterResolutionBinding(freezeHookFor(profile));
    expect(binding).toMatchObject({
      mode: "requester_scoped",
      serverId: "tenant-mcp",
      toolName: "mcp.tenant-mcp.search",
      resolverId: "gateway.tenant",
      callableCatalogSha256: profile.catalog.callableHash,
      callableCatalogSnapshotId: profile.catalog.snapshotId,
    });
    expect(captured.map((call) => call.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(captured[0]?.url).toContain("a.example.test");
    captured = [];

    const effectDispatch = vi.fn();
    const result = await harness.runtime.requesterScopedMcpDispatch.invoke(
      {
        server: harness.servers[0] as McpServerRecord,
        toolName: "search",
        arguments: { query: "hello" },
        mcpRequesterTurnContext: harness.contextFor(profile),
      },
      { effectDispatch },
    );

    expect(result.ok).toBe(true);
    expect(effectDispatch).toHaveBeenCalledTimes(1);
    expect(captured.map((call) => call.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    expect(captured.every((call) => call.url.includes("b.example.test"))).toBe(true);
    expect(captured[0]?.authorization).toBe("Bearer secret-operator-a-tool_call");
    // No secret/endpoint material in any serialized output or diagnostic.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret-operator-a");
    expect(serialized).not.toContain("b.example.test");
    expect(serialized).not.toContain("a.example.test");
    expect(JSON.stringify(harness.diagnostics)).not.toMatch(/secret-operator-a|example\.test/u);
    expect(harness.diagnostics).toEqual([]);
  });

  it("keeps two requesters on independent resolutions, credentials, and dispatchers", async () => {
    const harness = buildHarness();
    const alpha = profileRecordFor("operator-a");
    const beta = profileRecordFor("operator-b");
    harness.profiles.set(alpha.profileId, alpha);
    harness.profiles.set(beta.profileId, beta);
    expect(await harness.runtime.resolveMcpRequesterResolutionBinding(freezeHookFor(alpha))).toBeDefined();
    expect(await harness.runtime.resolveMcpRequesterResolutionBinding(freezeHookFor(beta))).toBeDefined();
    captured = [];

    const [alphaResult, betaResult] = await Promise.all([
      harness.runtime.requesterScopedMcpDispatch.invoke(
        {
          server: harness.servers[0] as McpServerRecord,
          toolName: "search",
          arguments: { query: "alpha" },
          mcpRequesterTurnContext: harness.contextFor(alpha),
        },
        { effectDispatch: vi.fn() },
      ),
      harness.runtime.requesterScopedMcpDispatch.invoke(
        {
          server: harness.servers[0] as McpServerRecord,
          toolName: "search",
          arguments: { query: "beta" },
          mcpRequesterTurnContext: harness.contextFor(beta),
        },
        { effectDispatch: vi.fn() },
      ),
    ]);

    expect(alphaResult.ok).toBe(true);
    expect(betaResult.ok).toBe(true);
    expect(harness.discoveryResolver).toHaveBeenCalledTimes(2);
    expect(harness.toolCallResolver).toHaveBeenCalledTimes(2);
    const alphaCalls = captured.filter((call) => call.authorization?.includes("operator-a"));
    const betaCalls = captured.filter((call) => call.authorization?.includes("operator-b"));
    expect(alphaCalls).toHaveLength(4);
    expect(betaCalls).toHaveLength(4);
    expect(alphaCalls.every((call) => call.url.includes("requester=operator-a"))).toBe(true);
    expect(betaCalls.every((call) => call.url.includes("requester=operator-b"))).toBe(true);
    const alphaDispatchers = new Set(alphaCalls.map((call) => call.dispatcher));
    const betaDispatchers = new Set(betaCalls.map((call) => call.dispatcher));
    expect(alphaDispatchers.size).toBe(1);
    expect(betaDispatchers.size).toBe(1);
    expect([...alphaDispatchers][0]).not.toBe([...betaDispatchers][0]);
  });

  it("default composition (no injected resolvers) fails closed at freeze and at invoke", async () => {
    const harness = buildHarness({ resolvers: false });
    const profile = profileRecordFor("operator-a");
    harness.profiles.set(profile.profileId, profile);

    await expect(harness.runtime.resolveMcpRequesterResolutionBinding(freezeHookFor(profile))).resolves.toBeUndefined();
    expect(harness.diagnostics).toContainEqual({
      event: "mcp.requester_resolution.freeze_failed",
      reasonCode: "resolver_missing",
    });

    const effectDispatch = vi.fn();
    const result = await harness.runtime.requesterScopedMcpDispatch.invoke(
      {
        server: harness.servers[0] as McpServerRecord,
        toolName: "search",
        mcpRequesterTurnContext: harness.contextFor(profile),
      },
      { effectDispatch },
    );
    expect(result.ok).toBe(false);
    expect(result.failurePhase).toBe("pre_dispatch");
    expect(result.output).toMatchObject({ requesterScoped: true, reasonCode: "requester_context_missing" });
    expect(effectDispatch).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
  });

  it("fails closed on a missing context and on a forged plain-object context (brand check)", async () => {
    const harness = buildHarness();
    const profile = profileRecordFor("operator-a");
    harness.profiles.set(profile.profileId, profile);
    expect(await harness.runtime.resolveMcpRequesterResolutionBinding(freezeHookFor(profile))).toBeDefined();
    captured = [];
    const effectDispatch = vi.fn();

    // Approval replay / direct-route posture: no context at all.
    const missing = await harness.runtime.requesterScopedMcpDispatch.invoke(
      { server: harness.servers[0] as McpServerRecord, toolName: "search" },
      { effectDispatch },
    );
    expect(missing.ok).toBe(false);
    expect(missing.failurePhase).toBe("pre_dispatch");
    expect(missing.output).toMatchObject({ requesterScoped: true, reasonCode: "requester_context_missing" });

    // A forged plain object with byte-identical fields carries no brand.
    const forged = {
      profileId: profile.profileId,
      finalProfileSha256: profile.hashes.profileHash,
      turnId: profile.identity.turnId,
      sessionId: profile.identity.sessionId,
      workspaceId: profile.identity.workspaceId,
      actorId: "operator-a",
      actorSource: "token",
      baseCallableCatalogSha256: profile.catalog.callableHash,
      finalCallableCatalogSha256: profile.catalog.callableHash,
      callableCatalogSnapshotId: profile.catalog.snapshotId,
      globalNetworkPolicyGeneration: 1,
      authConnectionGeneration: 1,
      turnGeneration: 1,
      preparationGeneration: 1,
      toJSON: () => undefined as never,
    };
    const forgedResult = await harness.runtime.requesterScopedMcpDispatch.invoke(
      {
        server: harness.servers[0] as McpServerRecord,
        toolName: "search",
        mcpRequesterTurnContext: forged as unknown as McpRequesterScopedTurnContextHandle,
      },
      { effectDispatch },
    );
    expect(forgedResult.ok).toBe(false);
    expect(forgedResult.output).toMatchObject({ requesterScoped: true, reasonCode: "requester_context_missing" });

    expect(effectDispatch).not.toHaveBeenCalled();
    expect(harness.toolCallResolver).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
    expect(harness.diagnostics.filter((entry) => entry.reasonCode === "requester_context_missing")).toHaveLength(2);
  });

  it("fails closed when the actor's auth owner reports revocation between freeze and dispatch", async () => {
    const harness = buildHarness();
    const profile = profileRecordFor("operator-a");
    harness.profiles.set(profile.profileId, profile);
    expect(await harness.runtime.resolveMcpRequesterResolutionBinding(freezeHookFor(profile))).toBeDefined();
    harness.revokedActors.add("operator-a");
    captured = [];
    const effectDispatch = vi.fn();

    const result = await harness.runtime.requesterScopedMcpDispatch.invoke(
      {
        server: harness.servers[0] as McpServerRecord,
        toolName: "search",
        mcpRequesterTurnContext: harness.contextFor(profile),
      },
      { effectDispatch },
    );

    expect(result.ok).toBe(false);
    expect(result.failurePhase).toBe("pre_dispatch");
    expect(result.output).toMatchObject({ requesterScoped: true, reasonCode: "connection_generation_revoked" });
    expect(effectDispatch).not.toHaveBeenCalled();
    expect(captured.map((call) => call.method)).not.toContain("tools/call");
  });

  it("fails closed with the effect un-fired when revocation lands mid-transport", async () => {
    const harness = buildHarness();
    const profile = profileRecordFor("operator-a");
    harness.profiles.set(profile.profileId, profile);
    expect(await harness.runtime.resolveMcpRequesterResolutionBinding(freezeHookFor(profile))).toBeDefined();
    captured = [];
    // Revoke after the tool-call transport has already begun (first writes done).
    const baseFetch = global.fetch;
    global.fetch = (async (url: never, init: never) => {
      const response = await (baseFetch as (url: never, init: never) => Promise<Response>)(url, init);
      if (captured.length >= 2) {
        harness.revokedActors.add("operator-a");
      }
      return response;
    }) as typeof global.fetch;
    const effectDispatch = vi.fn();

    const result = await harness.runtime.requesterScopedMcpDispatch.invoke(
      {
        server: harness.servers[0] as McpServerRecord,
        toolName: "search",
        mcpRequesterTurnContext: harness.contextFor(profile),
      },
      { effectDispatch },
    );

    expect(result.ok).toBe(false);
    expect(effectDispatch).not.toHaveBeenCalled();
    expect(captured.map((call) => call.method)).not.toContain("tools/call");
  });

  it("fails closed when the server flips to disabled or static mid-flight", async () => {
    const harness = buildHarness();
    const profile = profileRecordFor("operator-a");
    harness.profiles.set(profile.profileId, profile);
    expect(await harness.runtime.resolveMcpRequesterResolutionBinding(freezeHookFor(profile))).toBeDefined();
    captured = [];

    const requesterServer = harness.servers[0] as McpServerRecord;
    (harness.servers[0] as { enabled: boolean }).enabled = false;
    const disabled = await harness.runtime.requesterScopedMcpDispatch.invoke(
      { server: requesterServer, toolName: "search", mcpRequesterTurnContext: harness.contextFor(profile) },
      { effectDispatch: vi.fn() },
    );
    expect(disabled.ok).toBe(false);
    expect(disabled.output).toMatchObject({ requesterScoped: true, reasonCode: "server_not_callable" });

    (harness.servers[0] as { enabled: boolean }).enabled = true;
    (harness.servers[0] as { connectionMode?: string }).connectionMode = "static";
    const flippedStatic = await harness.runtime.requesterScopedMcpDispatch.invoke(
      { server: requesterServer, toolName: "search", mcpRequesterTurnContext: harness.contextFor(profile) },
      { effectDispatch: vi.fn() },
    );
    expect(flippedStatic.ok).toBe(false);
    expect(flippedStatic.output).toMatchObject({ requesterScoped: true, reasonCode: "server_not_callable" });
    expect(captured).toHaveLength(0);
  });

  it("fails closed when the durable profile record disappears or its actor drifts", async () => {
    const harness = buildHarness();
    const profile = profileRecordFor("operator-a");
    harness.profiles.set(profile.profileId, profile);
    expect(await harness.runtime.resolveMcpRequesterResolutionBinding(freezeHookFor(profile))).toBeDefined();
    const context = harness.contextFor(profile);
    captured = [];

    harness.profiles.delete(profile.profileId);
    const missingProfile = await harness.runtime.requesterScopedMcpDispatch.invoke(
      { server: harness.servers[0] as McpServerRecord, toolName: "search", mcpRequesterTurnContext: context },
      { effectDispatch: vi.fn() },
    );
    expect(missingProfile.ok).toBe(false);
    expect(missingProfile.output).toMatchObject({ requesterScoped: true, reasonCode: "server_not_callable" });

    // A replaced record with a different actor is requester-scope drift.
    const swapped = profileRecordFor("operator-b");
    harness.profiles.set(profile.profileId, {
      ...profile,
      identity: { ...profile.identity, authActorId: swapped.identity.authActorId },
    } as ChatTurnCapabilityProfileRecord);
    const drifted = await harness.runtime.requesterScopedMcpDispatch.invoke(
      { server: harness.servers[0] as McpServerRecord, toolName: "search", mcpRequesterTurnContext: context },
      { effectDispatch: vi.fn() },
    );
    expect(drifted.ok).toBe(false);
    expect(drifted.output).toMatchObject({ requesterScoped: true, reasonCode: "requester_scope_mismatch" });
    expect(captured).toHaveLength(0);
  });

  it("freeze hook yields undefined silently for static canonical names and fails closed on ambiguous server ids", async () => {
    const harness = buildHarness();
    const profile = profileRecordFor("operator-a");

    // Static server canonical name: static behavior wins with NO diagnostic.
    await expect(
      harness.runtime.resolveMcpRequesterResolutionBinding({
        ...freezeHookFor(profile),
        canonicalToolName: "mcp.static-mcp.search",
      }),
    ).resolves.toBeUndefined();
    // Non-MCP canonical name: same silent undefined.
    await expect(
      harness.runtime.resolveMcpRequesterResolutionBinding({
        ...freezeHookFor(profile),
        canonicalToolName: "browser.search",
      }),
    ).resolves.toBeUndefined();
    expect(harness.diagnostics).toEqual([]);
    expect(harness.discoveryResolver).not.toHaveBeenCalled();

    // Two requester-scoped servers whose ids make the canonical name ambiguous.
    const nested = requesterScopedServerRecord();
    (nested as { serverId: string }).serverId = "tenant-mcp.search";
    harness.servers.push(nested);
    await expect(
      harness.runtime.resolveMcpRequesterResolutionBinding({
        ...freezeHookFor(profile),
        canonicalToolName: "mcp.tenant-mcp.search.lookup",
      }),
    ).resolves.toBeUndefined();
    expect(harness.diagnostics).toContainEqual({
      event: "mcp.requester_resolution.freeze_failed",
      reasonCode: "requester_context_ambiguous",
    });
    expect(harness.discoveryResolver).not.toHaveBeenCalled();
  });

  it("never emits endpoint or credential material through diagnostics on failures", async () => {
    const harness = buildHarness();
    const profile = profileRecordFor("operator-a");
    harness.profiles.set(profile.profileId, profile);
    harness.discoveryResolver.mockImplementationOnce(async () => {
      throw new Error("resolver exploded with https://leak.example.test/?token=canary-secret");
    });

    await expect(harness.runtime.resolveMcpRequesterResolutionBinding(freezeHookFor(profile))).resolves.toBeUndefined();
    expect(harness.diagnostics).toContainEqual({
      event: "mcp.requester_resolution.freeze_failed",
      reasonCode: "resolver_failed",
    });
    const serializedDiagnostics = JSON.stringify(harness.diagnostics);
    expect(serializedDiagnostics).not.toContain("canary-secret");
    expect(serializedDiagnostics).not.toContain("leak.example.test");
  });

  it("records secret-free last outcomes through the composed runtime for freeze and dispatch", async () => {
    const harness = buildHarness();
    const profile = profileRecordFor("operator-a");
    harness.profiles.set(profile.profileId, profile);

    // Before any attempt: no recorded outcome, registration posture readable.
    expect(harness.runtime.requesterScopeDiagnostics.loadLastOutcome("tenant-mcp")).toBeUndefined();
    expect(
      harness.runtime.requesterScopeDiagnostics.resolveRegistrationPosture({
        resolverId: "gateway.tenant",
        resolverVersion: "1.2.3",
        configGeneration: 4,
      }),
    ).toBe("registered");
    expect(
      harness.runtime.requesterScopeDiagnostics.resolveRegistrationPosture({
        resolverId: "gateway.tenant",
        resolverVersion: "9.9.9",
        configGeneration: 4,
      }),
    ).toBe("resolver_binding_drift");
    expect(
      harness.runtime.requesterScopeDiagnostics.resolveRegistrationPosture({
        resolverId: "gateway.other",
        resolverVersion: "1.2.3",
        configGeneration: 4,
      }),
    ).toBe("resolver_missing");

    // Freeze failure records the exact taxonomy class for the exact server.
    harness.discoveryResolver.mockImplementationOnce(async () => {
      throw new Error("resolver exploded with https://leak.example.test/?token=canary-secret");
    });
    await expect(harness.runtime.resolveMcpRequesterResolutionBinding(freezeHookFor(profile))).resolves.toBeUndefined();
    expect(harness.runtime.requesterScopeDiagnostics.loadLastOutcome("tenant-mcp")).toEqual({
      serverId: "tenant-mcp",
      outcomeClass: "resolver_failed",
      atMs: START,
      connectionGenerationClass: "absent",
      expiryClass: "absent",
      networkPolicyDecision: "not_evaluated",
      profileDrift: false,
    });

    // Successful freeze + dispatch replaces it with resolved_ok.
    expect(await harness.runtime.resolveMcpRequesterResolutionBinding(freezeHookFor(profile))).toBeDefined();
    expect(harness.runtime.requesterScopeDiagnostics.loadLastOutcome("tenant-mcp")).toMatchObject({
      outcomeClass: "resolved_ok",
      connectionGenerationClass: "present",
      expiryClass: "within_bounds",
      networkPolicyDecision: "allowed",
      profileDrift: false,
    });
    const result = await harness.runtime.requesterScopedMcpDispatch.invoke(
      {
        server: harness.servers[0] as McpServerRecord,
        toolName: "search",
        arguments: { query: "hello" },
        mcpRequesterTurnContext: harness.contextFor(profile),
      },
      { effectDispatch: vi.fn() },
    );
    expect(result.ok).toBe(true);
    expect(harness.runtime.requesterScopeDiagnostics.loadLastOutcome("tenant-mcp")).toMatchObject({
      outcomeClass: "resolved_ok",
    });

    // A dispatch without a server-built context records the fail-closed class.
    const missing = await harness.runtime.requesterScopedMcpDispatch.invoke(
      { server: harness.servers[0] as McpServerRecord, toolName: "search" },
      { effectDispatch: vi.fn() },
    );
    expect(missing.ok).toBe(false);
    expect(harness.runtime.requesterScopeDiagnostics.loadLastOutcome("tenant-mcp")).toMatchObject({
      outcomeClass: "requester_context_missing",
      connectionGenerationClass: "absent",
    });
  });

  it("projects a secret-free posture even while the recorder holds a canary-failure outcome", async () => {
    const harness = buildHarness();
    const profile = profileRecordFor("operator-a");
    harness.profiles.set(profile.profileId, profile);
    harness.discoveryResolver.mockImplementationOnce(async () => {
      throw new Error("resolver exploded with https://leak.example.test/?token=canary-secret");
    });
    await expect(harness.runtime.resolveMcpRequesterResolutionBinding(freezeHookFor(profile))).resolves.toBeUndefined();

    const postures = mcpDiagnosticsService.listMcpRequesterScopePostures({
      listMcpServers: () => harness.servers.map((server) => ({ ...server })),
      requesterScopeDiagnostics: harness.runtime.requesterScopeDiagnostics,
    });
    expect(postures).toHaveLength(1);
    expect(postures[0]).toEqual({
      serverId: "tenant-mcp",
      connectionMode: "requester_scoped",
      requesterContextRequired: true,
      enabled: true,
      resolverId: "gateway.tenant",
      resolverVersion: "1.2.3",
      resolverConfigGeneration: 4,
      resolverRegistration: "registered",
      lastOutcome: {
        outcomeClass: "resolver_failed",
        atMs: START,
        connectionGenerationClass: "absent",
        expiryClass: "absent",
        networkPolicyDecision: "not_evaluated",
        profileDrift: false,
      },
    });
    const serialized = JSON.stringify(postures);
    expect(serialized).not.toContain("canary-secret");
    expect(serialized).not.toContain("leak.example.test");
    expect(serialized).not.toContain("a.example.test");
    expect(serialized).not.toMatch(/url|command|header|authorization|token|secret/iu);

    // Stock deployment (no injected resolvers): resolver_missing posture.
    const stock = buildHarness({ resolvers: false });
    const stockPostures = mcpDiagnosticsService.listMcpRequesterScopePostures({
      listMcpServers: () => stock.servers.map((server) => ({ ...server })),
      requesterScopeDiagnostics: stock.runtime.requesterScopeDiagnostics,
    });
    expect(stockPostures[0]?.resolverRegistration).toBe("resolver_missing");
  });
});

describe("GatewayService HX-415 constructor wiring", () => {
  it("wires the composed runtime into the coordinator host and the capability-profile deps", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gc-hx415-wiring-"));
    let gateway: GatewayService | undefined;
    const previousDriver = process.env.GOATCITADEL_DATABASE_DRIVER;
    try {
      process.env.GOATCITADEL_DATABASE_DRIVER = "sqlite";
      // Seed the temp root with the repository config fixtures (same pattern
      // as app.test.ts) so loadGatewayConfig materializes real defaults.
      const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
      await fs.cp(path.join(repoRoot, "config"), path.join(tempRoot, "config"), { recursive: true });
      const config = await loadGatewayConfig(tempRoot);
      gateway = new GatewayService(config);

      // 1. The composed runtime exists and its dispatch port is the EXACT
      //    object handed to the tool-invocation coordinator host.
      expect(gateway.mcpRequesterScopedRuntime).toBeDefined();
      const coordinatorHost = (
        gateway as unknown as {
          toolInvocationCoordinator: { host: { requesterScopedMcpDispatch?: unknown } };
        }
      ).toolInvocationCoordinator.host;
      expect(coordinatorHost.requesterScopedMcpDispatch).toBe(
        gateway.mcpRequesterScopedRuntime.requesterScopedMcpDispatch,
      );

      // 2. The capability-profile deps receive a freeze hook that delegates to
      //    the SAME composed runtime (behavioral identity via spy).
      const hookSpy = vi
        .spyOn(gateway.mcpRequesterScopedRuntime, "resolveMcpRequesterResolutionBinding")
        .mockResolvedValue(undefined);
      await expect(
        gateway.resolveChatTurnCapabilityProfile({
          sessionId: "session-1",
          turnId: "turn-1",
          workspaceId: "workspace-1",
          citadelId: "citadel-1",
          route: { channel: "chat", account: "default" },
          content: "hello",
          effectiveMode: "chat",
          effectiveToolAutonomy: "safe_auto",
          historyMessages: [],
          request: {},
          normalized: {},
          prefs: {
            webMode: "auto",
            memoryMode: "auto",
            thinkingLevel: "standard",
            speedMode: "standard",
            subagentPolicy: "off",
          },
          autonomy: { retrievalMode: "standard" },
          routeResolution: {
            requestedProviderId: "provider-a",
            requestedModel: "model-a",
            effectiveProviderId: "provider-a",
            effectiveModel: "model-a",
            fallbackPolicy: "off",
            runtimeClass: "local",
          },
        } as never),
      ).rejects.toThrow(/capability-profile deps captured/u);
      const deps = profileServiceCapture.deps.at(-1) as ChatTurnCapabilityProfileResolveDeps;
      expect(deps.resolveMcpRequesterResolutionBinding).toBeTypeOf("function");
      const hookInput = {
        profileId: "chat-capability-profile-turn-1",
        turnId: "turn-1",
        sessionId: "session-1",
        workspaceId: "workspace-1",
        authActorId: "operator-1",
        authActorSource: "token" as const,
        catalogSnapshotId: "chat-cap-snap-1",
        callableCatalogSha256: "a".repeat(64),
        canonicalToolName: "mcp.tenant-mcp.search",
        modelToolName: "mcp__scoped_search",
      };
      await deps.resolveMcpRequesterResolutionBinding?.(hookInput);
      expect(hookSpy).toHaveBeenCalledWith(hookInput);
    } finally {
      if (previousDriver === undefined) {
        delete process.env.GOATCITADEL_DATABASE_DRIVER;
      } else {
        process.env.GOATCITADEL_DATABASE_DRIVER = previousDriver;
      }
      await gateway?.close().catch(() => undefined);
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 120_000);
});
