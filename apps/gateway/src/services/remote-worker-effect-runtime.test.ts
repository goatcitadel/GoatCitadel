import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mcpRequesterScopeHashMaterial,
  mcpStaticToolScopeHashMaterial,
  remoteWorkerInferenceCanonicalSha256 as digest,
  type CapabilityCatalogEntry,
  type ChatTurnCapabilityProfileDraft,
  type ToolInvokeResult,
  type ToolPolicyConfig,
} from "@goatcitadel/contracts";
import { ToolPolicyEngine } from "@goatcitadel/policy-engine";
import {
  Storage,
  createSqliteAsyncStorage,
  sealChatTurnCapabilityProfile,
  type RemoteWorkerInferenceRequestRecord,
} from "../../../../packages/storage/src/index.js";
import { seedRemoteWorkerInferenceAuthority } from "../../../../packages/storage/src/remote-worker-inference-fixture.js";
import {
  RemoteWorkerEffectRuntime,
  type RemoteWorkerEffectRuntimeDependencies,
  type RemoteWorkerApprovedActionInput,
} from "./remote-worker-effect-runtime.js";
import type { DispatchRemoteWorkerEffectInput } from "./remote-worker-effect-settlement-service.js";
import { modelToolIntentKey, readCanonicalWorkerModelToolResult } from "./remote-worker-chat-tool-result.js";
import { retainRemoteWorkerChatApprovalWait } from "./remote-worker-chat-approval-wait.js";
import { executeApprovedExternalRuntimeSideEffect } from "./approved-external-runtime-side-effect-service.js";
import { toToolInvokeRequest } from "./gateway/external-runtime-approval-adapter.js";
import { buildMcpRequesterScopedTurnContextFromCapabilityProfile, readMcpRequesterScopedTurnContext } from "./mcp-requester-resolution-service.js";
import { createMcpRequesterProviderAlias } from "./mcp-requester-resolution.js";
import { createMeshChatCatalogFixture } from "./gateway/mesh-chat-catalog-test-fixtures.js";
import { resolveMeshChatToolSchemas } from "./gateway/mesh-chat-catalog.js";
import { createMeshChatTurnContext, resolveMeshChatToolBinding } from "./gateway/mesh-chat-binding.js";
import { ToolInvocationCoordinatorService, type ToolInvocationCoordinatorHost } from "./tool-invocation-coordinator-service.js";
import { buildToolCallBeforeHookInterpositionBinding, buildToolRuntimeOwnerBinding } from "./tool-runtime-interposition.js";
import { GatewayService } from "./gateway-service.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(
  mode:
    | "complete"
    | "fail"
    | "blocked"
    | "drift"
    | "none"
    | "builtin_boundary"
    | "approval"
    | "foreign_approval"
    | "approval_after_hook"
    | "revoke_after" = "complete",
  toolName: "channel.send" | "mcp.invoke" | "mcp.controlled-mcp.echo" |
    "mesh:node-a:tool:project.status" | "mesh:node-a:mcp_server:project.status" = "channel.send",
  staticMcp = false,
) {
  const nativeMcp = toolName === "mcp.controlled-mcp.echo";
  const meshCatalog = toolName.startsWith("mesh:") ? createMeshChatCatalogFixture({ workspaceId: "default",
    kind: toolName.includes(":mcp_server:") ? "mcp_server" : "tool" }) : undefined;
  const meshSchema = meshCatalog ? (await resolveMeshChatToolSchemas(meshCatalog.deps, {
    workspaceId: "default", entries: [meshCatalog.entry],
  }))[0] : undefined;
  const root = await mkdtemp(join(tmpdir(), "goat-worker-effect-"));
  const storage = new Storage({
    dbPath: ":memory:",
    transcriptsDir: join(root, "transcripts"),
    auditDir: join(root, "audit"),
  });
  const asyncStorage = createSqliteAsyncStorage(storage);
  cleanups.push(async () => {
    await asyncStorage.close();
    await rm(root, { recursive: true, force: true });
  });
  const seeded = seedRemoteWorkerInferenceAuthority(storage.db, "effect");
  const entry: CapabilityCatalogEntry = meshCatalog?.entry ?? {
    capabilityId: `tool:${toolName}`,
    kind: "tool",
    category: "built_in",
    title: "Channel send",
    summary: "Governed delivery",
    callable: true,
    trustLabel: "Builtin",
    toolName,
    ...(nativeMcp ? { sourceRef: `mcp-tool-definition:${digest("controlled-echo-schema")}` } : {}),
  };
  const wrapper: CapabilityCatalogEntry = { ...entry, capabilityId: "tool:mcp.invoke", toolName: "mcp.invoke" };
  delete wrapper.sourceRef;
  const entries = nativeMcp ? [wrapper, entry] : [entry];
  const catalog = await asyncStorage.capabilityCatalogSnapshots.create({
    snapshotId: "effect-catalog",
    inspectableEntries: entries,
    callableEntries: entries,
    createdAt: seeded.now,
  });
  const identity: ChatTurnCapabilityProfileDraft["identity"] = {
    turnId: seeded.turnId, sessionId: seeded.sessionId, workspaceId: "default", citadelId: "default",
    durableRunId: seeded.durableRunId,
    ...(toolName !== "channel.send" ? { authActorId: "worker-operator", authActorSource: "token" as const } : {}),
  };
  const requesterMaterial = {
    schemaVersion: "goatcitadel.mcp-requester-resolution-binding.v1" as const, mode: "requester_scoped" as const,
    serverId: "controlled-mcp", toolName, resolverId: "controlled", resolverVersion: "1.0.0", resolverConfigGeneration: 1,
    requesterScopeSha256: digest(mcpRequesterScopeHashMaterial({ profileId: "effect-profile",
      turnId: identity.turnId, sessionId: identity.sessionId, workspaceId: identity.workspaceId,
      authActorId: "worker-operator", authActorSource: "token" })),
    serverConfigRevision: 1, serverConfigSha256: digest("server"), transportPolicySha256: digest("transport"),
    callableCatalogSnapshotId: catalog.snapshotId, callableCatalogSha256: digest(entries),
  };
  const requesterBinding = { ...requesterMaterial, bindingSha256: digest(requesterMaterial) };
  const modelToolName = meshSchema?.modelName ?? (nativeMcp ? createMcpRequesterProviderAlias({
    bindingSha256: requesterBinding.bindingSha256, canonicalToolName: toolName,
    normalizedToolDefinitionSha256: digest("controlled-echo-schema"), rawRemoteToolName: "echo", serverId: "controlled-mcp",
  }) : toolName.replaceAll(".", "_"));
  const definition = meshSchema?.providerDefinition ?? {
    type: "function",
    function: {
      name: modelToolName,
      description: "Send a message",
      parameters: { type: "object", properties: toolName === "mcp.invoke"
        ? { serverId: { type: "string" }, toolName: { type: "string" }, arguments: { type: "object" } }
        : { message: { type: "string" } } },
    },
  };
  const staticMaterial = { schemaVersion: "goatcitadel.mcp-static-tool-binding.v1" as const, mode: "static" as const,
    serverId: "controlled-mcp", nativeToolName: "echo", toolName, transport: "http" as const,
    configurationBindingId: "00000000-0000-4000-8000-000000000001", toolDefinitionSha256: digest(definition),
    profileScopeSha256: digest(mcpStaticToolScopeHashMaterial({ profileId: "effect-profile", turnId: identity.turnId,
      sessionId: identity.sessionId, workspaceId: identity.workspaceId, authActorId: "worker-operator", authActorSource: "token" })),
    callableCatalogSnapshotId: catalog.snapshotId, callableCatalogSha256: digest(entries) };
  const draft: ChatTurnCapabilityProfileDraft = {
    profileId: "effect-profile",
    schemaVersion: "chat.turn.capability-profile.v1",
    identity,
    source: { channel: "chat", account: "default" },
    catalog: {
      snapshotId: catalog.snapshotId,
      inspectableHash: digest(entries),
      callableHash: digest(entries),
      inspectableCount: entries.length,
      callableCount: entries.length,
    },
    selection: {
      contentHash: digest("fixture"),
      effectiveProviderId: "fixture",
      effectiveModel: "fixture",
      allowedFallbacks: [],
      mode: "chat",
      webMode: "off",
      memory: {
        mode: "off",
        retrievalMode: "standard",
        workspaceId: "default",
        sessionId: seeded.sessionId,
        contextManifestRef: `chat-memory-scope:${digest("memory")}`,
        writeApprovalRequired: true,
      },
      thinkingLevel: "standard",
      speedMode: "standard",
      subagentPolicy: "off",
      toolAutonomy: "manual",
      tools: [
        {
          canonicalName: toolName,
          modelName: modelToolName,
          runtimeOwner: meshSchema ? buildToolRuntimeOwnerBinding("builtin") : { kind: "builtin", bindingHash: digest("fixture-owner") },
          effectPotential: {
            version: "goatcitadel.tool-effect.v1",
            potential: "unknown",
            sourceKind: "remote",
            reason: "remote_runtime_may_cross_boundary",
          },
          definitionHash: digest(definition),
          providerDefinition: definition,
          ...(meshSchema ? { meshPublication: meshSchema.publication } : {}),
          ...(nativeMcp ? staticMcp ? { mcpStaticBinding: { ...staticMaterial, bindingSha256: digest(staticMaterial) } }
            : { mcpRequesterResolution: requesterBinding } : {}),
        },
      ],
      modelNameAllowMap: [{ modelName: modelToolName, canonicalName: toolName }],
      trustedSkills: [],
    },
    governance: {
      activeGrants: [],
      permission: {
        profileId: "safe",
        approvalMode: "approve_all",
        profileHash: digest({ profileId: "safe", approvalMode: "approve_all" }),
      },
      policyDecisions: [{ toolName, allowed: true, requiresApproval: true, reasonCodes: [] }],
      authReadiness: [
        { kind: "provider", ref: "fixture", status: "ready", reasonCodes: [] },
        { kind: "channel", ref: "chat", status: "ready", reasonCodes: [] },
        { kind: "tool", ref: toolName, status: "ready", reasonCodes: [] },
      ],
      approval: {
        mode: "approve_all",
        selectedToolCount: 1,
        toolsRequiringApproval: [toolName],
        approvalGranted: false,
      },
    },
    preflightFingerprint: digest("fixture"),
    createdAt: seeded.now,
  };
  const profile = sealChatTurnCapabilityProfile(draft);
  const assignment = storage.remoteWorkerAssignments.getAssignment("default", seeded.assignmentId);
  let current = true;
  let concreteCalls = 0;
  const resolveActiveChatApprovalResume = vi.fn<RemoteWorkerEffectRuntimeDependencies["storage"]["remoteWorkerAssignments"]["resolveActiveChatApprovalResume"]>(async () => undefined);
  const resolveActiveChatExecution = vi.fn(async () => {
    if (!current) throw new Error("fixture authority lost");
    return {
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
    };
  });
  const coordinator: RemoteWorkerEffectRuntimeDependencies["coordinator"] = {
    invokeTool: vi.fn(async (_request, options): Promise<ToolInvokeResult> => {
      if (mode === "approval" || mode === "foreign_approval" || mode === "approval_after_hook") {
        if (mode === "approval_after_hook") {
          await options!.auxiliaryEffectFence!();
          concreteCalls += 1;
        }
        const approval = await asyncStorage.approvals.create({
          kind: "tool.invoke",
          riskLevel: "caution",
          payload: {},
          preview: {},
          linkage: {
            workspaceId: mode === "foreign_approval" ? "foreign" : "default",
            sessionId: seeded.sessionId,
            turnId: seeded.turnId,
            runId: seeded.durableRunId,
            toolName,
            durableRunId: seeded.durableRunId,
          },
        });
        return {
          outcome: "approval_required",
          approvalId: approval.approvalId,
          policyReason: "approval required",
          auditEventId: "audit-approval",
        };
      }
      if (mode === "blocked")
        return { outcome: "blocked", policyReason: "fixture policy denied", auditEventId: "audit-blocked" };
      if (mode === "none") {
        options!.externalSideEffect!.markNotRequired();
        return { outcome: "executed", policyReason: "safe preflight", auditEventId: "audit-none" };
      }
      if (mode === "builtin_boundary") {
        await options!.beforeBuiltinExecute!();
        // The policy executor found no additional external boundary. It cannot
        // erase the canonical owner's already-recorded builtin invocation.
        options!.externalSideEffect!.markNotRequired();
        concreteCalls += 1;
        return { outcome: "executed", policyReason: "recorded builtin", auditEventId: "audit-builtin", result: { ok: true } };
      }
      if (mode === "drift") current = false;
      await options!.externalSideEffect!.markStarted();
      concreteCalls += 1;
      if (mode === "revoke_after") current = false;
      const rows = await asyncStorage.externalSideEffectRuns.listByWorkspace("default", 10);
      expect(rows[0]!.status).toBe("external_call_started");
      if (mode === "fail") throw new Error("fixture response lost");
      return {
        outcome: "executed",
        policyReason: "fixture dispatched",
        auditEventId: "audit-complete",
        result: { status: "sent" },
      };
    }),
  };
  const dependencies: RemoteWorkerEffectRuntimeDependencies = {
    storage: {
      remoteWorkerAssignments: {
        resolveActiveChatExecution,
        resolveActiveChatApprovalResume,
      } as unknown as RemoteWorkerEffectRuntimeDependencies["storage"]["remoteWorkerAssignments"],
      remoteWorkerEffects: asyncStorage.remoteWorkerEffects,
      chatToolRuns: asyncStorage.chatToolRuns,
      approvals: asyncStorage.approvals,
      pendingApprovalActions: asyncStorage.pendingApprovalActions,
      mutationIdempotency: asyncStorage.mutationIdempotency,
      externalSideEffectRuns: asyncStorage.externalSideEffectRuns,
      runImmediateTransaction: (work) => asyncStorage.runImmediateTransaction(work),
      chatTurnCapabilityProfiles: {
        get: async () => profile,
      } as unknown as RemoteWorkerEffectRuntimeDependencies["storage"]["chatTurnCapabilityProfiles"],
      capabilityCatalogSnapshots: asyncStorage.capabilityCatalogSnapshots,
      skillLifecycle: asyncStorage.skillLifecycle,
    },
    coordinator,
    // This suite isolates effect ownership; native tests exercise real model accounting.
    withToolModelBudget: async (_input, operation) => operation(),
    listCallableCapabilities: async () => nativeMcp ? [wrapper] : entries,
    resolvePolicyContext: async () => ({ permissionProfileId: "safe",
      ...(nativeMcp || meshSchema ? { authActorId: identity.authActorId, authActorSource: identity.authActorSource } : {}) }),
    ...(nativeMcp ? { revalidateRequesterTool: vi.fn(async () => undefined),
      createMcpRequesterTurnContext: buildMcpRequesterScopedTurnContextFromCapabilityProfile } : {}),
  };
  if (meshCatalog) {
    dependencies.revalidateMeshTool = vi.fn(async () => undefined);
    dependencies.createMeshTurnContext = vi.fn(createMeshChatTurnContext);
    dependencies.resolveMeshChatToolBinding = vi.fn((request, context) => resolveMeshChatToolBinding({
      storage: { ...dependencies.storage, meshCapabilityPublications: meshCatalog.deps.storage.meshCapabilityPublications },
      activations: meshCatalog.deps.activations,
    }, request, context));
  }
  const input: DispatchRemoteWorkerEffectInput = {
    fence: {
      registryWorkspaceId: "default",
      assignmentId: seeded.assignmentId,
      assignmentGeneration: 1,
      sessionControlGeneration: null,
      leaseTokenSha256: digest("fixture-lease"),
      protectedAuthority: { fixture: true } as unknown as NonNullable<
        DispatchRemoteWorkerEffectInput["fence"]["protectedAuthority"]
      >,
    },
    intentIndex: 0,
    effectSelector: toolName,
    canonicalArgs: meshSchema ? toolName.includes(":mcp_server:")
      ? { toolName: "project.status", arguments: { query: "Controlled fixture only" } }
      : { query: "Controlled fixture only" }
      : toolName === "mcp.invoke"
      ? { serverId: "controlled-mcp", toolName: "echo", arguments: { message: "Controlled fixture only" } }
      : { message: "Controlled fixture only" },
    workerIdempotencyKey: "worker-effect",
    intentIdempotencyKey: "intent-effect",
  };
  const call = { callId: "call-send", modelToolName, argumentsJson: JSON.stringify(input.canonicalArgs) };
  const modelRecord = {
    registryWorkspaceId: "default", executionWorkspaceId: "default", assignmentId: seeded.assignmentId,
    assignmentGeneration: 1, sessionId: seeded.sessionId, turnId: seeded.turnId,
    durableRunId: seeded.durableRunId,
    requestSha256: digest("controlled-model-request"),
  } as RemoteWorkerInferenceRequestRecord;
  input.workerIdempotencyKey = modelToolIntentKey(modelRecord, call);
  return {
    storage: asyncStorage,
    profile,
    rawStorage: storage,
    dependencies,
    meshCatalog,
    runtime: new RemoteWorkerEffectRuntime(dependencies),
    input,
    coordinator,
    resolveActiveChatApprovalResume,
    approveForResume: async (intentId: string) => {
      const tool = await asyncStorage.chatToolRuns.get(`remote-tool:${intentId}`);
      const approval = await asyncStorage.approvals.resolve(tool.approvalId!, { decision: "approve", resolvedBy: "operator" });
      if (!await asyncStorage.pendingApprovalActions.find(approval.approvalId))
        await asyncStorage.pendingApprovalActions.upsertPending({ approvalId: approval.approvalId, actionType: "tool.invoke",
        request: { toolName: tool.toolName, args: tool.args, agentId: "assistant", workspaceId: "default", citadelId: "default",
          sessionId: seeded.sessionId, turnId: seeded.turnId, toolRunId: tool.toolRunId, runId: seeded.durableRunId,
          ...(nativeMcp || meshSchema ? { policyContext: await dependencies.resolvePolicyContext(profile, undefined) } : {}) } });
      const pending = (await asyncStorage.pendingApprovalActions.find(approval.approvalId))!;
      const resume = { material: { approvalId: approval.approvalId, intentId, pendingActionSha256: digest(pending),
        approvalSha256: digest(approval) }, materialSha256: digest("controlled-native-resume") } as
        NonNullable<Awaited<ReturnType<typeof resolveActiveChatApprovalResume>>>;
      resolveActiveChatApprovalResume.mockResolvedValue(resume);
      return { tool, approval, pending, resume };
    },
    readModelResult: () => readCanonicalWorkerModelToolResult(asyncStorage, modelRecord, profile, call),
    concreteCalls: () => concreteCalls,
    revoke: () => {
      current = false;
    },
  };
}

function approvedExecutor(f: Awaited<ReturnType<typeof fixture>>, mode: "complete" | "lost" | "drift" | "alter-result" | "none" = "complete") {
  let calls = 0;
  const execute = vi.fn<NonNullable<RemoteWorkerEffectRuntimeDependencies["executeApprovedAction"]>>(async (input) => {
    expect(input.runtimeOwner).toEqual(f.profile.selection.tools[0]!.runtimeOwner);
    const result = await executeApprovedExternalRuntimeSideEffect({ storage: f.storage, approvalId: input.approvalId,
      request: toToolInvokeRequest(input.pending.request), signal: input.signal, execute: async (markStarted) => {
        await input.checkExecution();
        if (mode === "drift") f.revoke();
        await input.checkExecution();
        if (mode !== "none") {
          await markStarted();
          calls += 1;
        }
        if (mode === "lost") throw new Error("approved response lost after dispatch");
        return { outcome: "executed", policyReason: "approved dispatch", auditEventId: "approved-audit", result: { status: "sent" } };
      } });
    return mode === "alter-result" ? { ...result, result: { status: "invented" } } : result;
  });
  f.dependencies.executeApprovedAction = execute;
  return { execute, calls: () => calls };
}

describe("worker effects over canonical SQLite ledgers with controlled authority and transport", () => {
  it.each(["direct", "approved"] as const)("uses the real Gateway/coordinator mesh owners for a %s worker effect", async (mode) => {
    const f = await fixture("complete", "mesh:node-a:tool:project.status");
    const catalog = f.meshCatalog!;
    const config: ToolPolicyConfig = { profiles: { danger: ["mesh.invoke"] },
      tools: { profile: "danger", approvalMode: mode === "approved" ? "approve_all" : "bypass", allow: [], deny: [] }, agents: {},
      sandbox: { writeJailRoots: [], readOnlyRoots: [], networkAllowlist: [], riskyShellPatterns: [], requireApprovalForRiskyShell: true } };
    const storage = { ...f.dependencies.storage, approvalEvents: f.storage.approvalEvents,
      meshCapabilityPublications: catalog.deps.storage.meshCapabilityPublications };
    const policyEngine = new ToolPolicyEngine(config, f.storage);
    const dispatch = vi.fn<NonNullable<ToolInvocationCoordinatorHost["dispatchMeshCapabilityInvocation"]>>(async (input, options) => {
      await options?.executionFence?.();
      expect(input).toMatchObject({ capabilityId: catalog.capabilityId, binding: catalog.binding, args: f.input.canonicalArgs,
        workspaceId: f.profile.identity.workspaceId, sessionId: f.profile.identity.sessionId, turnId: f.profile.identity.turnId,
        executionProfileSha256: f.profile.hashes.profileHash });
      const effects = await f.storage.externalSideEffectRuns.listByWorkspace("default", 10);
      expect(effects.some((effect) => effect.status === "external_call_started")).toBe(true);
      return { invocationId: "controlled-mesh-invocation", disposition: "succeeded", settled: true,
        deliveryUncertain: false, manualReconciliationRequired: false, output: { status: "ok" }, receipt: {
          invocationId: "controlled-mesh-invocation", capabilityId: catalog.capabilityId, nodeId: catalog.binding.nodeId,
          activationId: catalog.binding.activationId, activationRevision: catalog.binding.activationRevision,
          publisherGeneration: catalog.binding.publisherGeneration, publicationLeaseFencingToken: catalog.binding.publicationLeaseFencingToken,
          inputSha256: digest(f.input.canonicalArgs), deadlineAt: "2099-01-01T00:00:00.000Z",
        } };
    });
    const host = {
      policyEngine, normalizeToolInvokeRequest: async (request) => request,
      resolveMeshChatToolBinding: f.dependencies.resolveMeshChatToolBinding, dispatchMeshCapabilityInvocation: dispatch,
      hooksService: { runInlineHooks: async () => ({ runs: [] }), enqueueAfterHooks: async () => undefined },
      isValidToolName: () => true, evaluateToolDeploymentGuard: () => undefined,
      resolveToolHookWorkspaceId: async () => "default",
      resolveToolCallBeforeHookInterposition: async () => buildToolCallBeforeHookInterpositionBinding([]),
      primeToolApprovalLifecycle: async (approvalId, request) => f.storage.approvals.mergeLinkage(approvalId, {
        workspaceId: request.workspaceId, sessionId: request.sessionId, turnId: request.turnId,
        runId: request.runId, taskId: request.taskId, toolName: request.toolName, actionType: "tool.invoke",
      }),
      scheduleApprovalExplanationById: async () => undefined, publishRealtime: async () => undefined,
    } as ToolInvocationCoordinatorHost;
    const coordinator = new ToolInvocationCoordinatorService(host);
    const gateway = Object.assign(Object.create(GatewayService.prototype), {
      storage, policyEngine, toolInvocationCoordinator: coordinator, meshCapabilityActivationService: catalog.deps.activations,
    }) as { executeApprovedRemoteWorkerAction(input: RemoteWorkerApprovedActionInput): Promise<ToolInvokeResult> };
    f.dependencies.coordinator = coordinator;
    f.dependencies.executeApprovedAction = (input) => gateway.executeApprovedRemoteWorkerAction(input);
    let result = await new RemoteWorkerEffectRuntime(f.dependencies).dispatchEffect(f.input);
    if (mode === "approved") {
      expect(result.receipt).toBeUndefined();
      expect(result.transitions.at(-1)?.transitionState).toBe("approval_wait");
      expect(dispatch).not.toHaveBeenCalled();
      const approved = await f.approveForResume(result.intentId);
      result = await new RemoteWorkerEffectRuntime(f.dependencies).dispatchEffect(f.input);
      expect(dispatch.mock.calls[0]?.[0].approvalId).toBe(approved.approval.approvalId);
    }
    expect(result.receipt?.receiptState).toBe("completed_with_effect");
    const modelResult = await f.readModelResult();
    expect(modelResult?.status).toBe("completed");
    expect(JSON.parse(modelResult!.resultJson!)).toMatchObject({ ok: true, output: { status: "ok" } });
    expect(await new RemoteWorkerEffectRuntime(f.dependencies).dispatchEffect(f.input)).toEqual(result);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it.each(["mesh:node-a:tool:project.status", "mesh:node-a:mcp_server:project.status"] as const)(
    "retains exact Gateway mesh context for %s through approved continuation", async (toolName) => {
      const f = await fixture("approval", toolName);
      const waiting = await f.runtime.dispatchEffect(f.input);
      const [request, options] = vi.mocked(f.coordinator.invokeTool).mock.calls[0]!;
      expect(f.dependencies.createMeshTurnContext).toHaveBeenCalledWith(f.profile);
      expect(f.dependencies.revalidateMeshTool).toHaveBeenCalledWith(f.profile, toolName);
      expect(request).toMatchObject({ toolName, args: f.input.canonicalArgs });
      expect(options?.mcpRequesterTurnContext).toBeUndefined();
      expect(() => JSON.stringify(options?.meshTurnContext)).toThrow();
      expect(await f.dependencies.resolveMeshChatToolBinding!(request, options?.meshTurnContext))
        .toMatchObject({ executionProfileSha256: f.profile.hashes.profileHash });
      await f.approveForResume(waiting.intentId);
      const approved = approvedExecutor(f);
      const resumed = await new RemoteWorkerEffectRuntime(f.dependencies).dispatchEffect(f.input);
      const continuation = approved.execute.mock.calls[0]![0];
      expect(continuation.mcpRequesterTurnContext).toBeUndefined();
      expect(await f.dependencies.resolveMeshChatToolBinding!(toToolInvokeRequest(continuation.pending.request), continuation.meshTurnContext))
        .toMatchObject({ executionProfileSha256: f.profile.hashes.profileHash });
      expect(resumed.receipt?.receiptState).toBe("completed_with_effect");
      expect(await new RemoteWorkerEffectRuntime(f.dependencies).dispatchEffect(f.input)).toEqual(resumed);
      expect(approved.execute).toHaveBeenCalledOnce();
      expect(f.coordinator.invokeTool).toHaveBeenCalledOnce();
      expect(JSON.stringify(await f.storage.chatToolRuns.listByTurn(f.profile.identity.turnId))).not.toContain("meshTurnContext");
    },
  );

  it.each(["missing authority", "missing context", "missing binding owner", "cloned context", "activation revoked", "policy actor"] as const)(
    "rejects mesh with %s before starting a Chat tool run", async (failure) => {
      const f = await fixture("complete", "mesh:node-a:tool:project.status");
      if (failure === "missing authority") delete f.dependencies.revalidateMeshTool;
      if (failure === "missing context") delete f.dependencies.createMeshTurnContext;
      if (failure === "missing binding owner") delete f.dependencies.resolveMeshChatToolBinding;
      if (failure === "cloned context") f.dependencies.createMeshTurnContext = (profile) => ({ ...createMeshChatTurnContext(profile) });
      if (failure === "activation revoked") f.meshCatalog!.deps.activations.resolveProfileBindings = async () => new Map();
      if (failure === "policy actor") f.dependencies.resolvePolicyContext = async () => ({ permissionProfileId: "safe",
        authActorId: "another-actor", authActorSource: "token" });
      await expect(f.runtime.dispatchEffect(f.input)).rejects.toThrow();
      expect(f.coordinator.invokeTool).not.toHaveBeenCalled();
      expect(await f.storage.chatToolRuns.listByTurn(f.profile.identity.turnId)).toEqual([]);
      expect(await f.storage.externalSideEffectRuns.listByWorkspace("default", 10)).toEqual([]);
    },
  );

  it.each(["complete", "fail"] as const)("retains a mesh %s outcome across owner restart without repeating dispatch", async (mode) => {
    const f = await fixture(mode, "mesh:node-a:tool:project.status");
    const result = await f.runtime.dispatchEffect(f.input);
    expect(result.receipt?.receiptState).toBe(mode === "complete" ? "completed_with_effect" : "manual_reconciliation");
    f.revoke();
    expect(await new RemoteWorkerEffectRuntime(f.dependencies).dispatchEffect(f.input)).toEqual(result);
    expect(f.concreteCalls()).toBe(1);
    expect(f.coordinator.invokeTool).toHaveBeenCalledOnce();
  });

  it("retains a static MCP tool through approved continuation and owner restart", async () => {
    const f = await fixture("approval", "mcp.controlled-mcp.echo", true);
    const waiting = await f.runtime.dispatchEffect(f.input);
    expect(f.dependencies.revalidateRequesterTool).toHaveBeenCalledWith(f.profile, f.input.effectSelector);
    expect(readMcpRequesterScopedTurnContext(vi.mocked(f.coordinator.invokeTool).mock.calls[0]![1]?.mcpRequesterTurnContext))
      .toMatchObject({ profileId: f.profile.profileId });
    await f.approveForResume(waiting.intentId);
    const approved = approvedExecutor(f);
    const resumed = await new RemoteWorkerEffectRuntime(f.dependencies).dispatchEffect(f.input);
    expect(approved.execute).toHaveBeenCalledOnce();
    expect(resumed.receipt?.receiptState).toBe("completed_with_effect");
    expect(await new RemoteWorkerEffectRuntime(f.dependencies).dispatchEffect(f.input)).toEqual(resumed);
    expect(approved.execute).toHaveBeenCalledOnce();
  });

  it.each(["mcp.invoke", "mcp.controlled-mcp.echo"] as const)("retains Gateway-created context for %s through execution and approved continuation", async (toolName) => {
    const f = await fixture("approval", toolName);
    const createContext = vi.fn(buildMcpRequesterScopedTurnContextFromCapabilityProfile);
    f.dependencies.createMcpRequesterTurnContext = createContext;
    const waiting = await f.runtime.dispatchEffect(f.input);
    expect(createContext).toHaveBeenCalledWith(f.profile);
    const direct = vi.mocked(f.coordinator.invokeTool).mock.calls[0]![1]?.mcpRequesterTurnContext;
    expect(readMcpRequesterScopedTurnContext(direct)).toMatchObject({
      actorId: "worker-operator", profileId: f.profile.profileId, finalProfileSha256: f.profile.hashes.profileHash,
    });
    await f.approveForResume(waiting.intentId);
    const approved = approvedExecutor(f);
    await new RemoteWorkerEffectRuntime(f.dependencies).dispatchEffect(f.input);
    expect(approved.execute).toHaveBeenCalledOnce();
    const resumed = approved.execute.mock.calls[0]![0].mcpRequesterTurnContext;
    expect(readMcpRequesterScopedTurnContext(resumed)).toEqual(readMcpRequesterScopedTurnContext(direct));
    expect(() => JSON.stringify(resumed)).toThrow();
    expect(JSON.stringify((await f.storage.chatToolRuns.listByTurn(f.profile.identity.turnId)))).not.toContain("mcpRequesterTurnContext");
  });

  it.each(["missing owner", "revoked requester", "missing context", "cloned context", "another turn", "policy actor"] as const)(
    "rejects native MCP with %s before starting a Chat tool run", async (failure) => {
      const f = await fixture("complete", "mcp.controlled-mcp.echo");
      if (failure === "missing owner") delete f.dependencies.revalidateRequesterTool;
      if (failure === "revoked requester") f.dependencies.revalidateRequesterTool = async () => { throw new Error("requester revoked"); };
      if (failure === "missing context") delete f.dependencies.createMcpRequesterTurnContext;
      if (failure === "cloned context") f.dependencies.createMcpRequesterTurnContext = (profile) => ({
        ...buildMcpRequesterScopedTurnContextFromCapabilityProfile(profile)!,
      });
      if (failure === "another turn") f.dependencies.createMcpRequesterTurnContext = (profile) =>
        buildMcpRequesterScopedTurnContextFromCapabilityProfile({ ...profile, identity: { ...profile.identity, turnId: "another-turn" } });
      if (failure === "policy actor") f.dependencies.resolvePolicyContext = async () => ({ permissionProfileId: "safe",
        authActorId: "another-actor", authActorSource: "token" });
      await expect(f.runtime.dispatchEffect(f.input)).rejects.toThrow();
      expect(f.coordinator.invokeTool).not.toHaveBeenCalled();
      expect(await f.storage.chatToolRuns.listByTurn(f.profile.identity.turnId)).toEqual([]);
      expect(await f.storage.externalSideEffectRuns.listByWorkspace("default", 10)).toEqual([]);
    },
  );

  it.each(["complete", "fail"] as const)("retains the native MCP %s outcome across owner restart without repeating dispatch", async (mode) => {
    const f = await fixture(mode, "mcp.controlled-mcp.echo");
    const result = await f.runtime.dispatchEffect(f.input);
    expect(result.receipt?.receiptState).toBe(mode === "complete" ? "completed_with_effect" : "manual_reconciliation");
    const [request] = vi.mocked(f.coordinator.invokeTool).mock.calls[0]!;
    expect(request).toMatchObject({ toolName: f.input.effectSelector, args: f.input.canonicalArgs });
    expect(f.dependencies.revalidateRequesterTool).toHaveBeenCalledWith(f.profile, f.input.effectSelector);
    f.revoke();
    expect(await new RemoteWorkerEffectRuntime(f.dependencies).dispatchEffect(f.input)).toEqual(result);
    expect(f.concreteCalls()).toBe(1);
    expect(f.coordinator.invokeTool).toHaveBeenCalledOnce();
  });

  it("rechecks requester revocation at the native MCP effect fence", async () => {
    const f = await fixture("complete", "mcp.controlled-mcp.echo");
    const invoke = f.coordinator.invokeTool;
    f.coordinator.invokeTool = vi.fn(async (request, options) => {
      f.dependencies.revalidateRequesterTool = async () => { throw new Error("requester revoked before send"); };
      return await invoke(request, options);
    });
    const result = await f.runtime.dispatchEffect(f.input);
    expect(result.receipt?.receiptState).toBe("failed_before_boundary");
    expect(f.concreteCalls()).toBe(0);
    expect((await f.storage.externalSideEffectRuns.listByWorkspace("default", 10))[0]).toMatchObject({
      status: "failed_before_boundary", externalCallStartedAt: undefined,
    });
  });

  it("preserves its builtin execution receipt when the executor reports no additional boundary", async () => {
    const f = await fixture("builtin_boundary");
    const result = await f.runtime.dispatchEffect(f.input);
    expect(result.receipt?.receiptState).toBe("completed_with_effect");
    expect(await new RemoteWorkerEffectRuntime(f.dependencies).dispatchEffect(f.input)).toEqual(result);
    expect(f.dependencies.coordinator.invokeTool).toHaveBeenCalledOnce();
  });

  it("executes an approved continuation through its canonical side-effect owner and replays without dispatch", async () => {
    const f = await fixture("approval");
    const waiting = await f.runtime.dispatchEffect(f.input);
    const { approval, tool } = await f.approveForResume(waiting.intentId);
    const approved = approvedExecutor(f);
    const result = await f.runtime.dispatchEffect(f.input);
    expect(result.receipt?.receiptState).toBe("completed_with_effect");
    expect(await f.storage.pendingApprovalActions.find(approval.approvalId)).toMatchObject({ resolutionStatus: "executed" });
    expect(await f.storage.chatToolRuns.get(tool.toolRunId)).toMatchObject({ status: "executed", result: { status: "sent" }, effectOutcomeKind: "concrete" });
    expect(await f.readModelResult()).toMatchObject({ status: "completed", toolRunId: tool.toolRunId });
    f.revoke();
    expect(await new RemoteWorkerEffectRuntime(f.dependencies).dispatchEffect(f.input)).toEqual(result);
    expect(approved.calls()).toBe(1);
    expect(approved.execute).toHaveBeenCalledOnce();
    expect(f.coordinator.invokeTool).toHaveBeenCalledOnce();
  });

  it("recovers a crash after approved execution committed but before worker tool projection", async () => {
    const f = await fixture("approval");
    const waiting = await f.runtime.dispatchEffect(f.input);
    const { approval, tool } = await f.approveForResume(waiting.intentId);
    const approved = approvedExecutor(f);
    const patch = vi.spyOn(f.rawStorage.chatToolRuns, "patch").mockImplementationOnce(() => { throw new Error("projection interrupted"); });
    await expect(f.runtime.dispatchEffect(f.input)).rejects.toThrow("projection interrupted");
    expect(await f.storage.pendingApprovalActions.find(approval.approvalId)).toMatchObject({ resolutionStatus: "executed" });
    expect(await f.storage.chatToolRuns.get(tool.toolRunId)).toMatchObject({ status: "approval_required" });
    patch.mockRestore();
    const result = await new RemoteWorkerEffectRuntime(f.dependencies).dispatchEffect(f.input);
    expect(result.receipt?.receiptState).toBe("completed_with_effect");
    expect(approved.calls()).toBe(1);
    expect(approved.execute).toHaveBeenCalledOnce();
  });

  it("retains an unknown approved outcome and never retries its external call", async () => {
    const f = await fixture("approval");
    const waiting = await f.runtime.dispatchEffect(f.input);
    await f.approveForResume(waiting.intentId);
    const approved = approvedExecutor(f, "lost");
    const result = await f.runtime.dispatchEffect(f.input);
    expect(result.receipt?.receiptState).toBe("manual_reconciliation");
    expect(await new RemoteWorkerEffectRuntime(f.dependencies).dispatchEffect(f.input)).toEqual(result);
    expect(approved.calls()).toBe(1);
    expect(approved.execute).toHaveBeenCalledOnce();
  });

  it("checks native execution authority again at the approved side-effect boundary", async () => {
    const f = await fixture("approval");
    const waiting = await f.runtime.dispatchEffect(f.input);
    const { approval } = await f.approveForResume(waiting.intentId);
    const approved = approvedExecutor(f, "drift");
    await expect(f.runtime.dispatchEffect(f.input)).rejects.toThrow("authority lost");
    expect(approved.calls()).toBe(0);
    expect(await f.storage.pendingApprovalActions.find(approval.approvalId)).toMatchObject({ resolutionStatus: "pending" });
    const owners = await f.storage.externalSideEffectRuns.listByWorkspace("default", 10);
    expect(owners.every(owner => !owner.externalCallStartedAt)).toBe(true);
  });

  it("keeps an unproven approved effect uncertain instead of certifying no side effect", async () => {
    const f = await fixture("approval");
    const waiting = await f.runtime.dispatchEffect(f.input);
    const { tool } = await f.approveForResume(waiting.intentId);
    const approved = approvedExecutor(f, "none");
    const result = await f.runtime.dispatchEffect(f.input);
    expect(result.receipt?.receiptState).toBe("manual_reconciliation");
    expect(await f.storage.chatToolRuns.get(tool.toolRunId)).toMatchObject({ effectOutcomeKind: "uncertain",
      effectEvidence: { reason: "completed_without_canonical_effect_receipt" } });
    expect(await new RemoteWorkerEffectRuntime(f.dependencies).dispatchEffect(f.input)).toEqual(result);
    expect(approved.calls()).toBe(0);
    expect(approved.execute).toHaveBeenCalledOnce();
  });

  it("refuses a returned result that disagrees with persisted approved execution truth", async () => {
    const f = await fixture("approval");
    const waiting = await f.runtime.dispatchEffect(f.input);
    const { tool } = await f.approveForResume(waiting.intentId);
    const approved = approvedExecutor(f, "alter-result");
    await expect(f.runtime.dispatchEffect(f.input)).rejects.toThrow("canonical terminal evidence");
    expect(await f.storage.chatToolRuns.get(tool.toolRunId)).toMatchObject({ status: "approval_required" });
    const result = await new RemoteWorkerEffectRuntime(f.dependencies).dispatchEffect(f.input);
    expect(result.receipt?.receiptState).toBe("completed_with_effect");
    expect(await f.storage.chatToolRuns.get(tool.toolRunId)).toMatchObject({ result: { status: "sent" } });
    expect(approved.calls()).toBe(1);
    expect(approved.execute).toHaveBeenCalledOnce();
  });

  it.each(["resume", "pending", "approval"])("refuses changed %s authority before approved dispatch", async (drift) => {
    const f = await fixture("approval");
    const waiting = await f.runtime.dispatchEffect(f.input);
    const { approval, resume } = await f.approveForResume(waiting.intentId);
    const approved = approvedExecutor(f);
    if (drift === "resume") {
      f.resolveActiveChatApprovalResume.mockResolvedValueOnce(resume).mockResolvedValue(undefined);
    } else if (drift === "pending") resume.material.pendingActionSha256 = digest("changed-pending");
    else await f.storage.approvals.mergeLinkage(approval.approvalId, { runId: "foreign" });
    await expect(f.runtime.dispatchEffect(f.input)).rejects.toThrow("canonical handoff");
    expect(approved.execute).not.toHaveBeenCalled();
  });

  it("commits exact Chat/owner evidence and replays a lost response without another dispatch", async () => {
    const f = await fixture();
    const [first, concurrent] = await Promise.all([
      f.runtime.dispatchEffect(f.input),
      f.runtime.dispatchEffect(f.input),
    ]);
    expect(concurrent).toEqual(first);
    expect(first.receipt.receiptState).toBe("completed_with_effect");
    const tool = await f.storage.chatToolRuns.get(`remote-tool:${first.intentId}`);
    expect(tool.effectOutcomeKind).toBe("concrete");
    expect(first.receipt.hx305OutcomeSha256).toBe(digest(tool));
    f.revoke();
    const restarted = new RemoteWorkerEffectRuntime(f.dependencies);
    expect(await restarted.dispatchEffect(f.input)).toEqual(first);
    expect(f.concreteCalls()).toBe(1);
  });

  it.each([
    ["fail", "manual_reconciliation", 1],
    ["blocked", "blocked_before_dispatch", 0],
    ["drift", "failed_before_boundary", 0],
    ["none", "manual_reconciliation", 0],
    ["revoke_after", "completed_with_effect", 1],
  ] as const)("retains %s without automatic replay", async (mode, state, calls) => {
    const f = await fixture(mode);
    const first = await f.runtime.dispatchEffect(f.input);
    expect(first.receipt.receiptState).toBe(state);
    expect(await new RemoteWorkerEffectRuntime(f.dependencies).dispatchEffect(f.input)).toEqual(first);
    expect(f.concreteCalls()).toBe(calls);
    expect(f.coordinator.invokeTool).toHaveBeenCalledOnce();
  });

  it.each(["reject", "edit"] as const)("settles %s after replaying a nonterminal approval wait without invoking the tool again", async (decision) => {
    const f = await fixture("approval");
    const first = await f.runtime.dispatchEffect(f.input);
    expect(first.receipt).toBeUndefined();
    expect(first.transitions.map((entry) => entry.transitionState)).toEqual(["recorded", "approval_wait"]);
    const tool = await f.storage.chatToolRuns.get(`remote-tool:${first.intentId}`);
    expect(tool.status).toBe("approval_required");
    expect(await f.readModelResult()).toMatchObject({ status: "waiting_approval", toolRunId: tool.toolRunId });
    expect(await f.storage.remoteWorkerEffects.findSettlement(
      f.input.fence.registryWorkspaceId, f.input.fence.assignmentId, f.input.fence.assignmentGeneration, first.intentId,
    )).toBeUndefined();
    expect(await new RemoteWorkerEffectRuntime(f.dependencies).dispatchEffect(f.input)).toEqual(first);
    expect(f.coordinator.invokeTool).toHaveBeenCalledOnce();
    expect(f.concreteCalls()).toBe(0);
    await f.storage.approvals.resolve(tool.approvalId!, { decision, resolvedBy: "operator" });
    expect(await f.readModelResult()).toMatchObject({ status: "waiting_approval" });
    const rejected = await new RemoteWorkerEffectRuntime(f.dependencies).dispatchEffect(f.input);
    expect(rejected.receipt?.receiptState).toBe("blocked_before_dispatch");
    const continuation = await f.readModelResult();
    expect(continuation).toMatchObject({ status: "completed", toolRunId: tool.toolRunId });
    expect(JSON.parse(continuation!.resultJson!)).toEqual({ status: "blocked", approvalDecision: decision,
      error: "The tool approval did not authorize execution." });
    expect(await f.readModelResult()).toEqual(continuation);
    expect(rejected.transitions.map((entry) => entry.transitionState)).toEqual(["recorded", "approval_wait", "blocked_before_dispatch"]);
    expect(f.coordinator.invokeTool).toHaveBeenCalledOnce();
    expect(f.concreteCalls()).toBe(0);
    await f.storage.approvals.mergeLinkage(tool.approvalId!, { turnId: "another-turn" });
    await expect(f.readModelResult()).rejects.toThrow("canonical decision receipt");
  });

  it("retains one scoped Chat approval projection without changing the parent durable run", async () => {
    const f = await fixture("approval");
    const effect = await f.runtime.dispatchEffect(f.input);
    const current = (await f.storage.remoteWorkerAssignments.findAssignmentAggregate("default", f.input.fence.assignmentId))!;
    const manifest = current.assignment.manifest;
    await f.storage.chatTurnTraces.patch(manifest.turnId, { durable: { runId: manifest.durableRunId, status: "running" } });
    const tool = await f.storage.chatToolRuns.get(`remote-tool:${effect.intentId}`);
    const retain = () => f.storage.runImmediateTransaction(() => retainRemoteWorkerChatApprovalWait(f.storage, current));
    const summary = await retain();
    expect(summary).toMatchObject({ approvalId: tool.approvalId, kind: "tool.invoke", toolName: tool.toolName });
    expect(summary).not.toHaveProperty("payload");
    expect(summary).not.toHaveProperty("args");
    const inline = await f.storage.chatInlineApprovals.get(tool.approvalId!);
    expect(inline).toMatchObject({ status: "pending", sessionId: manifest.sessionId, turnId: manifest.turnId });
    expect(await retain()).toEqual(summary);
    expect(await f.storage.chatInlineApprovals.get(tool.approvalId!)).toEqual(inline);
    expect(await f.storage.chatTurnTraces.get(manifest.turnId)).toMatchObject({ status: "waiting_for_approval" });
    expect(await f.storage.durableRuns.getRun(manifest.durableRunId)).toMatchObject({ status: "running" });
    expect(await f.storage.durableRuns.getLatestCheckpointByKind(manifest.durableRunId, "run_waiting")).toBeUndefined();
    expect(f.coordinator.invokeTool).toHaveBeenCalledOnce();
    expect(f.concreteCalls()).toBe(0);
  });

  it.each(["workspaceId", "sessionId", "turnId", "runId", "toolName"] as const)(
    "rejects a worker approval whose canonical %s linkage changed", async (field) => {
      const f = await fixture("approval");
      const effect = await f.runtime.dispatchEffect(f.input);
      const tool = await f.storage.chatToolRuns.get(`remote-tool:${effect.intentId}`);
      await f.storage.approvals.mergeLinkage(tool.approvalId!, { [field]: "foreign-owner" });
      const current = (await f.storage.remoteWorkerAssignments.findAssignmentAggregate("default", f.input.fence.assignmentId))!;
      await expect(f.storage.runImmediateTransaction(() => retainRemoteWorkerChatApprovalWait(f.storage, current)))
        .rejects.toThrow("exact parent Chat linkage");
      expect(await f.storage.chatInlineApprovals.get(tool.approvalId!)).toBeUndefined();
      expect(await f.storage.chatTurnTraces.get(current.assignment.manifest.turnId)).toMatchObject({ status: "running" });
    },
  );

  it.each(["approve", "reject", "edit"] as const)("retains a first Chat park when %s resolves before the worker wait is projected", async (decision) => {
    const f = await fixture("approval");
    const effect = await f.runtime.dispatchEffect(f.input);
    const tool = await f.storage.chatToolRuns.get(`remote-tool:${effect.intentId}`);
    const current = (await f.storage.remoteWorkerAssignments.findAssignmentAggregate("default", f.input.fence.assignmentId))!;
    const manifest = current.assignment.manifest;
    await f.storage.chatTurnTraces.patch(manifest.turnId, { durable: { runId: manifest.durableRunId, status: "running" } });
    const resolved = await f.storage.approvals.resolve(tool.approvalId!, { decision, resolvedBy: "operator" });
    const summary = await f.storage.runImmediateTransaction(() => retainRemoteWorkerChatApprovalWait(f.storage, current, {
      resumedApprovalId: "another-approval-cannot-suppress-this-wait",
    }));
    expect(summary?.approvalId).toBe(tool.approvalId);
    expect(await f.storage.chatInlineApprovals.get(tool.approvalId!)).toMatchObject({
      status: resolved.status === "rejected" ? "denied" : "approved", details: { decision },
    });
    expect(await f.storage.chatTurnTraces.get(manifest.turnId)).toMatchObject({ status: "waiting_for_approval" });
    expect(f.concreteCalls()).toBe(0);
    expect(f.coordinator.invokeTool).toHaveBeenCalledOnce();
  });

  it("rolls back the approval projection if its parent turn is already terminal", async () => {
    const f = await fixture("approval");
    const effect = await f.runtime.dispatchEffect(f.input);
    const current = (await f.storage.remoteWorkerAssignments.findAssignmentAggregate("default", f.input.fence.assignmentId))!;
    const manifest = current.assignment.manifest;
    await f.storage.chatTurnTraces.patch(manifest.turnId, {
      status: "completed", durable: { runId: manifest.durableRunId, status: "completed" },
    });
    await expect(f.storage.runImmediateTransaction(() => retainRemoteWorkerChatApprovalWait(f.storage, current)))
      .rejects.toThrow("lost its active Chat turn");
    const tool = await f.storage.chatToolRuns.get(`remote-tool:${effect.intentId}`);
    expect(await f.storage.chatInlineApprovals.get(tool.approvalId!)).toBeUndefined();
    expect(await f.storage.chatTurnTraces.get(manifest.turnId)).toMatchObject({ status: "completed" });
  });

  it("rejects authority loss and altered intent arguments before tool dispatch", async () => {
    const f = await fixture();
    f.revoke();
    await expect(f.runtime.dispatchEffect(f.input)).rejects.toThrow("authority lost");
    await expect(f.runtime.dispatchEffect({ ...f.input, canonicalArgs: { message: "changed" } })).rejects.toThrow();
    expect(f.coordinator.invokeTool).not.toHaveBeenCalled();
  });

  it("rejects an approval from a different workspace", async () => {
    const f = await fixture("foreign_approval");
    await expect(f.runtime.dispatchEffect(f.input)).rejects.toThrow("not linked");
    expect(f.concreteCalls()).toBe(0);
  });

  it("retains an approval raised after a hook effect without claiming no dispatch", async () => {
    const f = await fixture("approval_after_hook");
    const first = await f.runtime.dispatchEffect(f.input);
    expect(first.receipt.receiptState).toBe("manual_reconciliation");
    expect(await f.readModelResult()).toMatchObject({ status: "blocked" });
    const tool = await f.storage.chatToolRuns.get(`remote-tool:${first.intentId}`);
    expect(tool.status).toBe("approval_required");
    expect(tool.approvalId).toEqual(expect.any(String));
    expect(tool.effectOutcomeKind).toBe("uncertain");
    const wait = first.transitions.find((transition) => transition.transitionState === "approval_wait");
    expect(wait).toBeDefined();
    const approval = await f.storage.approvals.get(tool.approvalId!);
    expect(wait?.correlationSha256).toBe(
      digest({
        schemaVersion: "goatcitadel.remote-worker-effect-correlation.v1",
        transitionState: "approval_wait",
        externalSideEffectRunId: null,
        approvalRecordSha256: digest(approval),
        boundaryReceiptSha256: null,
        hx305OutcomeSha256: null,
        reconciliationRecordSha256: null,
        sanitizedError: null,
      }),
    );
    expect(await new RemoteWorkerEffectRuntime(f.dependencies).dispatchEffect(f.input)).toEqual(first);
    expect(f.concreteCalls()).toBe(1);
  });
});
