import {
  canonicalJsonString,
  readChatTurnFeatureReferences,
  readDurableChatTurnExecutionPayloadAuthority,
  remoteWorkerCapabilityBindingForTurn,
  remoteWorkerInferenceCanonicalSha256 as digest,
  sameRemoteWorkerCapabilityBinding,
  classifyToolEffectPotential,
  type ChatRemotePlacement,
  type ChatTurnCapabilityToolDefinition,
  type RemoteWorkerAdmissionReference,
  type ToolPolicyActorContext,
  type ChatTurnFeatureReferences,
  type CapabilityCatalogEntry,
  type ChatTurnCapabilityToolRuntimeOwnerBinding,
  type ToolEffectPotentialRecord,
  type ChatSessionPrefsRecord,
  type PermissionSurface,
  chatRemotePlacementSchema,
  DEFAULT_CITADEL_ID,
  type ToolAccessEvaluateRequest,
} from "@goatcitadel/contracts";
import type { ChatFeatureAdmissionHost } from "./chat-feature-admission-service.js";
import {
  buildBuiltinChatToolProviderDefinition,
  type ChatTurnAgentRunnerDeps,
  type ChatToolAccessProbeOptions,
  type ChatTurnAgentRunnerInput,
  type ResolvedChatTurnToolSchema,
} from "./chat-turn-agent-runner.js";
import type { MeshChatToolSchema } from "./gateway/mesh-chat-catalog.js";
import { requesterScopeFromActiveAdmission } from "./mcp-requester-admission-scope.js";
import { buildSelectedMeshAdmission } from "./chat-mesh-admission-service.js";
import type { ToolCallBeforeHookInterpositionBinding } from "./tool-runtime-interposition.js";
import { assertMcpRequesterAdmissionScopeCurrent } from "./mcp-requester-admission-scope.js";
import { assertChatFeatureBindingCurrent } from "./chat-feature-binding-current.js";
import {
  assertAdmittedExplicitContextCurrent,
  type ChatExplicitContextAdmissionHost,
} from "./chat-explicit-context-admission.js";
import { fingerprintChatProviderFallbackRoute } from "./chat-provider-fallback-admission.js";
import {
  createMcpRequesterAdmissionTurnContext,
  type McpRequesterAdmissionTurnContextHandle,
} from "./mcp-requester-admission-context.js";
import { createMeshAdmissionTurnContext, type MeshChatTurnContextHandle } from "./gateway/mesh-chat-binding.js";
import type { NativeMcpChatToolSchema } from "./gateway/native-mcp-chat-catalog.js";

export interface RemoteWorkerChatAdmissionSelectionHost {
  enabled(): boolean;
  storage: Pick<AsyncStorage, "workspaces">;
  assertTurnAdmissionWrite: ChatFeatureAdmissionHost["assertTurnAdmissionWrite"];
  getChatSessionPrefs(sessionId: string): Promise<ChatSessionPrefsRecord>;
  resolveToolPolicyContext(input: {
    operatorId?: string;
    authActorId?: string;
    authActorSource?: ToolPolicyActorContext["authActorSource"];
    workspaceId?: string;
    sessionId?: string;
    taskId?: string;
    runId?: string;
    surface?: PermissionSurface;
    permissionProfileId?: string;
    localOperatorOverrideId?: string;
  }): Promise<ToolPolicyActorContext>;
  resolveCapabilityToolSchema(input: ChatTurnAgentRunnerInput): Promise<ResolvedChatTurnToolSchema>;
  listCallable(workspaceId: string): Promise<CapabilityCatalogEntry[]>;
  resolveMeshToolSchemas(input: {
    workspaceId: string;
    entries: readonly CapabilityCatalogEntry[];
  }): Promise<MeshChatToolSchema[]>;
  getToolCallBeforeInterposition(workspaceId: string): Promise<ToolCallBeforeHookInterpositionBinding>;
  resolveRuntimeOwnerBinding(toolName: string): ChatTurnCapabilityToolRuntimeOwnerBinding;
}

export interface RemoteWorkerChatAdmissionCompositionHost extends ChatExplicitContextAdmissionHost {
  storage: Pick<
    AsyncStorage,
    "durableRuns" | "sessionMutationAdmissions" | "routedContextSnapshots" | "sessionControls" | "workspaces"
  >;
  enabled(): Promise<boolean>;
  resolveToolPolicyContext: RemoteWorkerChatAdmissionSelectionHost["resolveToolPolicyContext"];
  resolveAdmittedSkillInstructions(
    references: ChatTurnFeatureReferences,
    workspaceId: string,
  ): Promise<string | undefined>;
  restoreNativeAdmissionSchemas(handle: McpRequesterAdmissionTurnContextHandle): Promise<NativeMcpChatToolSchema[]>;
  restoreMeshAdmissionSchemas(handle: MeshChatTurnContextHandle): Promise<MeshChatToolSchema[]>;
  getToolCallBeforeInterposition: RemoteWorkerChatAdmissionSelectionHost["getToolCallBeforeInterposition"];
  listToolCatalog: ChatTurnAgentRunnerDeps["listToolCatalog"];
  listCallable: RemoteWorkerChatAdmissionSelectionHost["listCallable"];
  resolveRuntimeOwnerBinding: RemoteWorkerChatAdmissionSelectionHost["resolveRuntimeOwnerBinding"];
  inspectToolAccess(
    input: ToolAccessEvaluateRequest,
    options?: ChatToolAccessProbeOptions,
  ): ReturnType<NonNullable<ChatTurnAgentRunnerDeps["inspectToolAccess"]>>;
}
import { selectBoundedProviderSchemas, type ProviderSchemaCandidate } from "./chat-tool-schema-budget.js";
import type { AsyncStorage } from "@goatcitadel/storage";
import { remoteWorkerEvidenceFromProfile, type RemoteWorkerChatEvidence } from "./remote-worker-chat-authority.js";
import type { RemoteWorkerCapabilityBinding } from "@goatcitadel/contracts";

type SelectedConnection =
  | NonNullable<ChatTurnFeatureReferences["requesterConnections"]>[number]
  | NonNullable<ChatTurnFeatureReferences["selectedStaticMcp"]>[number];

/** Pure exposure decisions over already resolved evidence. This never grants authority. */
export function selectRemoteAdmissionSchemas(input: {
  content: string;
  schema: { tools: Record<string, unknown>[]; modelToCanonical: ReadonlyMap<string, string> };
  connections: readonly SelectedConnection[];
  mesh: readonly { canonicalName: string; modelName: string; providerDefinition: Record<string, unknown> }[];
}): ProviderSchemaCandidate[] | undefined {
  const candidates: ProviderSchemaCandidate[] = input.schema.tools.map((definition) => {
    const modelName = (definition.function as { name: string }).name;
    const canonicalName = input.schema.modelToCanonical.get(modelName);
    if (!canonicalName) throw new Error("Remote placement tool has no exact model mapping.");
    return {
      canonicalName,
      modelName,
      definition,
      ...(input.content.toLowerCase().includes(canonicalName.toLowerCase())
        ? { requiredReason: "explicit" as const }
        : {}),
    };
  });
  for (const connection of input.connections) {
    if (!("version" in connection))
      throw new Error("Remote placement requires selected requester receipt definitions.");
    for (const tool of connection.selectedTools)
      candidates.push({
        canonicalName: tool.canonicalToolName,
        modelName: tool.modelName,
        definition: {
          type: "function",
          function: {
            name: tool.modelName,
            ...(tool.description ? { description: tool.description } : {}),
            parameters: tool.inputSchema,
          },
        },
        requiredReason: "explicit",
      });
  }
  for (const tool of input.mesh)
    candidates.push({
      canonicalName: tool.canonicalName,
      modelName: tool.modelName,
      definition: tool.providerDefinition,
      requiredReason: "explicit",
    });
  const selected = selectBoundedProviderSchemas(candidates).selected;
  return selected.length > 16 ? undefined : selected;
}

/** Keep remote/plugin/interposed effects conservative using exact current owners. */
export function buildRemoteAdmissionToolEvidence(input: {
  selected: readonly ProviderSchemaCandidate[];
  catalog: readonly CapabilityCatalogEntry[];
  runtimeOwners: ReadonlyMap<string, ChatTurnCapabilityToolRuntimeOwnerBinding>;
  interpositionCount: number;
}): ChatRemotePlacement["selectedTools"] {
  return input.selected.map((tool) => {
    const runtimeOwner = input.runtimeOwners.get(tool.canonicalName);
    if (!runtimeOwner) throw new Error("Remote placement selected tool has no current runtime owner.");
    const entry = input.catalog.find((candidate) => candidate.callable && candidate.toolName === tool.canonicalName);
    const remote = tool.canonicalName.startsWith("mcp.") || tool.canonicalName.startsWith("mesh:");
    if (!entry && !remote) throw new Error("Remote placement selected tool is no longer callable.");
    return {
      canonicalName: tool.canonicalName,
      modelName: tool.modelName,
      providerDefinition: tool.definition,
      definitionHash: digest(tool.definition),
      runtimeOwner,
      effectPotential: classifyRemoteAdmissionToolEffect({
        toolName: tool.canonicalName,
        runtimeOwner,
        effectPotential: entry?.effectPotential,
        nativeMcp: tool.canonicalName.startsWith("mcp."),
        mesh: tool.canonicalName.startsWith("mesh:"),
        interpositionCount: input.interpositionCount,
      }),
    };
  });
}

/** Shared by initial selection and current worker revalidation; no authority handles. */
export function classifyRemoteAdmissionToolEffect(input: {
  toolName: string;
  runtimeOwner: ChatTurnCapabilityToolRuntimeOwnerBinding;
  effectPotential?: ToolEffectPotentialRecord;
  nativeMcp: boolean;
  mesh: boolean;
  interpositionCount: number;
}): ToolEffectPotentialRecord {
  return input.nativeMcp || input.mesh || input.interpositionCount > 0 || input.runtimeOwner.kind === "plugin"
    ? classifyToolEffectPotential({
        toolName: input.toolName,
        trustedBuiltin: false,
        sourceKind: input.nativeMcp ? "mcp" : input.runtimeOwner.kind === "plugin" ? "plugin" : "remote",
      })
    : (input.effectPotential ?? classifyToolEffectPotential({ toolName: input.toolName, trustedBuiltin: false }));
}

export interface RemoteWorkerChatAdmissionAuthorityHost {
  storage: Pick<AsyncStorage, "sessionMutationAdmissions" | "durableRuns">;
  enabled(): Promise<boolean>;
  resolvePolicy(input: {
    reference: RemoteWorkerAdmissionReference;
    placement: ChatRemotePlacement;
    durableRunId: string;
    taskId?: string;
  }): Promise<ToolPolicyActorContext>;
  assertFeaturesCurrent(input: {
    reference: RemoteWorkerAdmissionReference;
    features: ChatTurnFeatureReferences;
    durableRunId: string;
    assertCurrent(): Promise<void>;
  }): Promise<void>;
  readCurrentSelectedTools(input: {
    reference: RemoteWorkerAdmissionReference;
    features: ChatTurnFeatureReferences;
    placement: ChatRemotePlacement;
    policy: ToolPolicyActorContext;
    assertCurrent(): Promise<void>;
  }): Promise<readonly ChatTurnCapabilityToolDefinition[]>;
}

/** Read-only history/materialization projection. No current-dispatch handle is
 * returned; callers cannot use this as inference or effect authorization. */
export async function readRetainedRemoteWorkerChatEvidence(
  storage: Pick<AsyncStorage, "sessionMutationAdmissions" | "durableRuns" | "chatTurnCapabilityProfiles">,
  input: RemoteWorkerCapabilityBinding & { durableRunId: string; capabilityProfileId?: string },
): Promise<RemoteWorkerChatEvidence> {
  if (!input.admissionReference) {
    const profile = input.capabilityProfileId
      ? await storage.chatTurnCapabilityProfiles.get(input.capabilityProfileId)
      : await storage.chatTurnCapabilityProfiles.findByRun(input.durableRunId);
    if (
      !profile ||
      profile.identity.durableRunId !== input.durableRunId ||
      !sameRemoteWorkerCapabilityBinding(input, { capabilityProfileSha256: profile.hashes.profileHash })
    )
      throw new Error("Retained worker profile differs from its canonical assignment.");
    return remoteWorkerEvidenceFromProfile(profile);
  }
  const reference = input.admissionReference;
  const run = await storage.durableRuns.getRun(input.durableRunId);
  const payload = readDurableChatTurnExecutionPayloadAuthority({
    workflowKey: run.workflowKey,
    durableRunId: run.runId,
    payload: run.payload,
  });
  const retained = await storage.sessionMutationAdmissions.findFeatureReferences(reference.scope);
  if (
    !payload ||
    !sameRemoteWorkerCapabilityBinding(remoteWorkerCapabilityBindingForTurn(payload), input) ||
    !retained ||
    retained.referenceSha256 !== reference.featureReferenceSha256 ||
    digest(retained.references) !== reference.featureReferenceSha256
  )
    throw new Error("Retained worker feature evidence differs from its canonical assignment.");
  const features = readChatTurnFeatureReferences(retained.references),
    placement = features.remotePlacement;
  if (
    !placement ||
    !("version" in placement) ||
    placement.version !== "chat.remote-placement.admission.v1" ||
    canonicalJsonString(placement.scope) !== canonicalJsonString(reference.scope) ||
    !features.providerRoute ||
    digest(payload.request.content) !== placement.contentSha256
  )
    throw new Error("Retained worker selected evidence is unavailable.");
  return {
    binding: { admissionReference: reference },
    identity: {
      ...reference.scope,
      durableRunId: input.durableRunId,
      citadelId: placement.citadelId,
      operatorId: placement.operatorId,
      authActorId: reference.scope.actorId,
      authActorSource: reference.scope.actorSource,
    },
    tools: placement.selectedTools.map((tool) => {
      const mesh = features.selectedMeshCapabilities?.selected.find(
        (entry) => entry.capabilityId === tool.canonicalName,
      );
      return { ...tool, ...(mesh ? { meshPublication: mesh.publication } : {}) };
    }),
    permission: placement.permission,
    route: features.providerRoute.primary,
    contentHash: placement.contentSha256,
    memoryMode: placement.memoryMode,
    features,
    runtimeInterposition: placement.runtimeInterposition,
  };
}

/** Resolve selected evidence through current canonical owners. The mandatory
 * callback comes from the real protected assignment or durable dispatch claim;
 * a persisted admission row alone cannot create a live execution authority. */
export async function resolveRemoteWorkerAdmissionAuthority(
  host: RemoteWorkerChatAdmissionAuthorityHost,
  input: {
    reference: RemoteWorkerAdmissionReference;
    durableRunId: string;
    taskId?: string;
    assertCurrent(): Promise<void>;
  },
): Promise<{ evidence: RemoteWorkerChatEvidence; policy: ToolPolicyActorContext }> {
  await input.assertCurrent();
  if (!(await host.enabled())) throw new Error("Remote Chat admission-reference execution is disabled.");
  const { reference } = input;
  const run = await host.storage.durableRuns.getRun(input.durableRunId);
  const payload = readDurableChatTurnExecutionPayloadAuthority({
    workflowKey: run.workflowKey,
    durableRunId: run.runId,
    payload: run.payload,
  });
  if (
    !payload ||
    !sameRemoteWorkerCapabilityBinding(remoteWorkerCapabilityBindingForTurn(payload), { admissionReference: reference })
  )
    throw new Error("Remote Chat admission differs from its durable workload.");
  const retained = await host.storage.sessionMutationAdmissions.findFeatureReferences(reference.scope);
  if (
    !retained ||
    retained.referenceSha256 !== reference.featureReferenceSha256 ||
    digest(retained.references) !== reference.featureReferenceSha256
  )
    throw new Error("Remote Chat feature reference changed.");
  const features = readChatTurnFeatureReferences(retained.references);
  const placement = features.remotePlacement;
  if (
    !placement ||
    !("version" in placement) ||
    placement.version !== "chat.remote-placement.admission.v1" ||
    canonicalJsonString(placement.scope) !== canonicalJsonString(reference.scope) ||
    !features.providerRoute ||
    typeof payload.request.content !== "string" ||
    digest(payload.request.content) !== placement.contentSha256
  )
    throw new Error("Remote Chat selected evidence is incomplete or bound to another request.");
  await host.assertFeaturesCurrent({ ...input, features });
  const policy = await host.resolvePolicy({ ...input, placement });
  if (
    !policy.permissionProfile ||
    policy.permissionProfile.profileId !== policy.permissionProfileId ||
    policy.authActorId !== reference.scope.actorId ||
    policy.authActorSource !== reference.scope.actorSource ||
    policy.permissionProfileId !== placement.permission.profileId ||
    policy.localOperatorOverrideId !== placement.permission.localOperatorOverrideId ||
    digest(policy.permissionProfile) !== placement.permission.profileHash ||
    (policy.localOperatorOverride &&
      (!Number.isFinite(Date.parse(policy.localOperatorOverride.expiresAt)) ||
        Date.parse(policy.localOperatorOverride.expiresAt) <= Date.now()))
  )
    throw new Error("Remote Chat permission or actor authority changed.");
  const tools = await host.readCurrentSelectedTools({
    reference,
    features,
    placement,
    policy,
    assertCurrent: input.assertCurrent,
  });
  if (
    tools.length !== placement.selectedTools.length ||
    tools.some((tool, index) => {
      const selected = placement.selectedTools[index]!;
      return (
        tool.canonicalName !== selected.canonicalName ||
        tool.modelName !== selected.modelName ||
        tool.definitionHash !== selected.definitionHash ||
        digest(tool.providerDefinition) !== selected.definitionHash ||
        digest(tool.runtimeOwner) !== digest(selected.runtimeOwner) ||
        digest(tool.effectPotential) !== digest(selected.effectPotential)
      );
    })
  )
    throw new Error("Remote Chat selected tool definition or runtime owner changed.");
  await input.assertCurrent();
  return {
    policy,
    evidence: {
      binding: { admissionReference: reference },
      identity: {
        workspaceId: reference.scope.workspaceId,
        sessionId: reference.scope.sessionId,
        turnId: reference.scope.turnId,
        durableRunId: input.durableRunId,
        citadelId: placement.citadelId,
        operatorId: placement.operatorId,
        authActorId: reference.scope.actorId,
        authActorSource: reference.scope.actorSource,
      },
      tools,
      permission: placement.permission,
      route: features.providerRoute.primary,
      contentHash: placement.contentSha256,
      memoryMode: placement.memoryMode,
      features,
      runtimeInterposition: placement.runtimeInterposition,
      assertCurrent: input.assertCurrent,
    },
  };
}

/** Select evidence under the existing admission fence; this does not dispatch work. */
export async function selectRemoteWorkerChatAdmission(
  host: RemoteWorkerChatAdmissionSelectionHost,
  input: Parameters<NonNullable<ChatFeatureAdmissionHost["resolveRemotePlacement"]>>[0],
): Promise<ChatRemotePlacement | undefined> {
  const request = input.admission.admittedRequest;
  if (
    !host.enabled() ||
    input.references.childWork ||
    input.references.scheduledOccurrence ||
    input.references.heartbeatOccurrence ||
    request.parentDelegationStepId ||
    request.sideChatContext ||
    request.modelCouncil
  )
    return undefined;
  await host.assertTurnAdmissionWrite(input.admission);
  const scope = requesterScopeFromActiveAdmission(input.admission);
  const prefs = await host.getChatSessionPrefs(scope.sessionId);
  if ((request.subagentPolicy ?? prefs.subagentPolicy) !== "off") return undefined;
  const workspace = await host.storage.workspaces.find(scope.workspaceId);
  if (!workspace) throw new Error("Remote placement workspace is unavailable.");
  const policy = await host.resolveToolPolicyContext({
    workspaceId: scope.workspaceId,
    sessionId: scope.sessionId,
    operatorId: input.admission.requestActor.operatorId,
    authActorId: scope.actorId,
    authActorSource: scope.actorSource,
    surface: "chat",
    permissionProfileId: request.permissionProfileId,
    localOperatorOverrideId: request.localOperatorOverrideId,
    taskId: request.policyTaskId,
  });
  if (
    !policy.permissionProfile ||
    !policy.permissionProfileId ||
    policy.permissionProfile.profileId !== policy.permissionProfileId
  )
    throw new Error("Remote placement requires the exact current permission profile.");
  const schema = await host.resolveCapabilityToolSchema({
    sessionId: scope.sessionId,
    workspaceId: scope.workspaceId,
    turnId: scope.turnId,
    userMessageId: `remote-admission:${scope.turnId}`,
    content: input.content,
    mode: "chat",
    providerId: input.route.effectiveProviderId,
    model: input.route.effectiveModel,
    webMode: request.webMode ?? prefs.webMode,
    memoryMode: request.memoryMode ?? prefs.memoryMode,
    retrievalMode: prefs.retrievalMode ?? "standard",
    thinkingLevel: request.thinkingLevel ?? prefs.thinkingLevel,
    toolAutonomy: prefs.toolAutonomy,
    subagentPolicy: "off",
    historyMessages: [],
    operatorId: policy.operatorId,
    authActorId: scope.actorId,
    authActorSource: scope.actorSource,
    permissionProfileId: policy.permissionProfileId,
    localOperatorOverrideId: policy.localOperatorOverrideId,
    policyContext: policy,
    policyTaskId: request.policyTaskId,
  });
  const catalog = await host.listCallable(scope.workspaceId);
  const meshIds = new Set(input.references.selectedMeshCapabilities?.selected.map((entry) => entry.capabilityId));
  const mesh = await host.resolveMeshToolSchemas({
    workspaceId: scope.workspaceId,
    entries: catalog.filter((entry) => meshIds.has(entry.capabilityId)),
  });
  if (
    mesh.length !== meshIds.size ||
    (input.references.selectedMeshCapabilities &&
      canonicalJsonString(buildSelectedMeshAdmission(scope, mesh)) !==
        canonicalJsonString(input.references.selectedMeshCapabilities))
  )
    throw new Error("Remote placement mesh evidence changed during selection.");
  const selected = selectRemoteAdmissionSchemas({
    content: input.content,
    schema,
    connections: [...(input.references.requesterConnections ?? []), ...(input.references.selectedStaticMcp ?? [])],
    mesh,
  });
  if (!selected) return undefined;
  const hooks = await host.getToolCallBeforeInterposition(scope.workspaceId);
  const runtimeOwners = new Map(
    selected.map((tool) => [tool.canonicalName, host.resolveRuntimeOwnerBinding(tool.canonicalName)]),
  );
  const tools = buildRemoteAdmissionToolEvidence({ selected, catalog, runtimeOwners, interpositionCount: hooks.count });
  await host.assertTurnAdmissionWrite(input.admission);
  return chatRemotePlacementSchema.parse({
    version: "chat.remote-placement.admission.v1",
    scope,
    citadelId: workspace.citadelId ?? DEFAULT_CITADEL_ID,
    operatorId: policy.operatorId,
    contentSha256: digest(input.content),
    memoryMode: request.memoryMode ?? prefs.memoryMode,
    runtimeInterposition: hooks,
    permission: {
      profileId: policy.permissionProfileId,
      approvalMode: policy.permissionProfile.approvalMode,
      profileHash: digest(policy.permissionProfile),
      ...(policy.localOperatorOverrideId ? { localOperatorOverrideId: policy.localOperatorOverrideId } : {}),
      ...(policy.localOperatorOverride
        ? { localOperatorOverrideExpiresAt: policy.localOperatorOverride.expiresAt }
        : {}),
    },
    selectedTools: tools,
  });
}

/** Compose admission-reference checks from current canonical owners; no new execution authority. */
export function createRemoteWorkerChatAdmissionAuthorityHost(
  host: RemoteWorkerChatAdmissionCompositionHost,
): RemoteWorkerChatAdmissionAuthorityHost {
  return {
    storage: host.storage,
    enabled: () => host.enabled(),
    resolvePolicy: ({ reference, placement, durableRunId, taskId }) =>
      host.resolveToolPolicyContext({
        workspaceId: reference.scope.workspaceId,
        sessionId: reference.scope.sessionId,
        operatorId: placement.operatorId,
        authActorId: reference.scope.actorId,
        authActorSource: reference.scope.actorSource,
        surface: "chat",
        runId: durableRunId,
        taskId,
        permissionProfileId: placement.permission.profileId,
        localOperatorOverrideId: placement.permission.localOperatorOverrideId,
      }),
    assertFeaturesCurrent: async ({ reference, features, durableRunId, assertCurrent }) => {
      await assertCurrent();
      await assertMcpRequesterAdmissionScopeCurrent(host.storage, reference.scope);
      const workspace = await host.storage.workspaces.find(reference.scope.workspaceId);
      const placement = features.remotePlacement;
      if (
        !workspace ||
        !placement ||
        !("citadelId" in placement) ||
        placement.citadelId !== (workspace.citadelId ?? DEFAULT_CITADEL_ID)
      )
        throw new Error("Remote placement workspace Citadel changed.");
      const featureInput = {
        workspaceId: reference.scope.workspaceId,
        sessionId: reference.scope.sessionId,
        turnId: reference.scope.turnId,
        canonicalDurableRunId: durableRunId,
        featureAdmission: { references: features, referenceSha256: reference.featureReferenceSha256 },
        canonicalWriteFence: async <T>(work: () => T | Promise<T>): Promise<Awaited<T>> => {
          await assertCurrent();
          const result = await work();
          await assertCurrent();
          return result;
        },
      };
      await assertChatFeatureBindingCurrent(host.storage, featureInput);
      const route = features.providerRoute;
      if (
        !route ||
        fingerprintChatProviderFallbackRoute(host.llmService, route.primary, route.fallback) !== route.fingerprint
      )
        throw new Error("Remote worker admitted provider route configuration changed.");
      if (features.childWork || features.scheduledOccurrence || features.heartbeatOccurrence)
        throw new Error("Remote worker placement cannot assume a local orchestration owner.");
      await assertAdmittedExplicitContextCurrent(host, featureInput);
      if (features.selectedSkills) await host.resolveAdmittedSkillInstructions(features, reference.scope.workspaceId);
      if (features.requesterConnections?.length || features.selectedStaticMcp?.length)
        await host.restoreNativeAdmissionSchemas(
          createMcpRequesterAdmissionTurnContext(reference.scope, reference.featureReferenceSha256, assertCurrent),
        );
      if (features.selectedMeshCapabilities)
        await host.restoreMeshAdmissionSchemas(
          createMeshAdmissionTurnContext(reference.scope, reference.featureReferenceSha256, assertCurrent),
        );
    },
    readCurrentSelectedTools: async ({ reference, features, placement, policy, assertCurrent }) => {
      const scope = reference.scope;
      const hooks = await host.getToolCallBeforeInterposition(scope.workspaceId);
      if (canonicalJsonString(hooks) !== canonicalJsonString(placement.runtimeInterposition))
        throw new Error("Remote worker tool hook authority changed.");
      const nativeContext = createMcpRequesterAdmissionTurnContext(
        scope,
        reference.featureReferenceSha256,
        assertCurrent,
      );
      const meshContext = createMeshAdmissionTurnContext(scope, reference.featureReferenceSha256, assertCurrent);
      const native =
        features.requesterConnections?.length || features.selectedStaticMcp?.length
          ? await host.restoreNativeAdmissionSchemas(nativeContext)
          : [];
      const mesh = features.selectedMeshCapabilities ? await host.restoreMeshAdmissionSchemas(meshContext) : [];
      const registered = host.listToolCatalog();
      const catalog = await host.listCallable(scope.workspaceId);
      const output: import("@goatcitadel/contracts").ChatTurnCapabilityToolDefinition[] = [];
      for (const selected of placement.selectedTools) {
        await assertCurrent();
        const n = native.find((tool) => tool.canonicalName === selected.canonicalName);
        const m = mesh.find((tool) => tool.canonicalName === selected.canonicalName);
        const entry = catalog.find((entry) => entry.callable && entry.toolName === selected.canonicalName);
        const tool = registered.find((tool) => tool.toolName === selected.canonicalName);
        if (!n && !m && (!entry || !tool)) throw new Error("Remote worker selected tool is no longer callable.");
        const definition =
          n?.providerDefinition ??
          m?.providerDefinition ??
          buildBuiltinChatToolProviderDefinition(tool!, selected.modelName);
        const runtimeOwner = host.resolveRuntimeOwnerBinding(selected.canonicalName);
        const access = await host.inspectToolAccess(
          {
            toolName: selected.canonicalName,
            args: {},
            agentId: "assistant",
            workspaceId: scope.workspaceId,
            sessionId: scope.sessionId,
            surface: "chat",
            policyContext: policy,
            permissionProfileId: policy.permissionProfileId,
          },
          n ? { mcpRequesterTurnContext: nativeContext } : m ? { meshTurnContext: meshContext } : undefined,
        );
        if (!access.allowed) throw new Error("Remote worker selected tool is denied by current policy.");
        output.push({
          canonicalName: selected.canonicalName,
          modelName: n?.modelName ?? m?.modelName ?? selected.modelName,
          definitionHash: digest(definition),
          providerDefinition: definition,
          runtimeOwner,
          ...(m ? { meshPublication: m.publication } : {}),
          effectPotential: classifyRemoteAdmissionToolEffect({
            toolName: selected.canonicalName,
            runtimeOwner,
            effectPotential: entry?.effectPotential,
            nativeMcp: Boolean(n),
            mesh: Boolean(m),
            interpositionCount: hooks.count,
          }),
        });
      }
      return output;
    },
  };
}
