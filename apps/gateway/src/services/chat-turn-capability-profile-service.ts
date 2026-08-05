import { createHash } from "node:crypto";
import {
  CHAT_TURN_CAPABILITY_PROFILE_VERSION,
  canonicalJsonString,
  classifyToolEffectPotential,
  mcpRequesterScopeHashMaterial,
  type CapabilityCatalogEntry,
  type CapabilityCatalogSnapshotRecord,
  type ChatCompletionRequest,
  type ChatMemoryMode,
  type ChatMode,
  type ChatNormalizationProfile,
  type ChatRetrievalMode,
  type ChatSpeedMode,
  type ChatSubagentPolicy,
  type ChatThinkingLevel,
  type ChatTurnCapabilityProfilePreview,
  type ChatTurnCapabilityProfileRecord,
  type ChatTurnCapabilityToolMeshPublicationBinding,
  type ChatTurnCapabilityToolRuntimeOwnerBinding,
  type ChatWebMode,
  type McpRequesterResolutionBinding,
  type McpRequesterScopeAuthActorSource,
  type ToolPolicyActorContext,
  type WorkPassportRecord,
} from "@goatcitadel/contracts";
import {
  sealChatTurnCapabilityProfile,
  verifyCapabilityCatalogEntryUniqueness,
  verifyChatTurnCapabilityProfile,
  type AsyncStorage as Storage,
} from "@goatcitadel/storage";
import type { ResolvedChatTurnToolSchema } from "./chat-turn-agent-runner.js";
import type { ChatTurnRoute } from "./chat-turn-prep-service.js";
import {
  buildToolRuntimeOwnerBinding,
  buildToolCallBeforeHookInterpositionBinding,
  TOOL_CALL_BEFORE_HOOK_BINDING_LIMIT,
  TOOL_EFFECT_INTERPOSITION_TRIGGERS,
} from "./tool-runtime-interposition.js";

type CapabilityProfileStorage = Pick<Storage, "toolGrants" | "skillLifecycle" | "workspaceHooks">;

export interface ChatTurnCapabilityRouteResolution {
  requestedProviderId?: string;
  requestedModel?: string;
  effectiveProviderId?: string;
  effectiveModel?: string;
  fallbackTarget?: { providerId: string; model: string };
  fallbackPolicy: "off" | "armed";
  runtimeClass: "local" | "cloud" | "unknown";
  blockedReason?: string;
}

export interface ChatTurnCapabilityProfileResolveInput {
  sessionId: string;
  turnId: string;
  workspaceId: string;
  citadelId: string;
  route: ChatTurnRoute;
  content: string;
  mode: ChatMode;
  webMode: ChatWebMode;
  memoryMode: ChatMemoryMode;
  retrievalMode: ChatRetrievalMode;
  thinkingLevel: ChatThinkingLevel;
  speedMode: ChatSpeedMode;
  subagentPolicy: ChatSubagentPolicy;
  normalizationProfile?: ChatNormalizationProfile;
  toolAutonomy: "safe_auto" | "manual";
  routedContextRequested?: boolean;
  historyMessages: ChatCompletionRequest["messages"];
  routeResolution: ChatTurnCapabilityRouteResolution;
  operatorId?: string;
  authActorId?: string;
  authActorSource?: ToolPolicyActorContext["authActorSource"];
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
  policyRunId?: string;
  policyTaskId?: string;
  fullWebAccess?: boolean;
  /** Server-owned policy context for autonomous/internal turns. */
  policyContext?: ToolPolicyActorContext;
  durableRunId?: string;
  createdAt?: string;
}

export interface ChatTurnCapabilityProfileResolveDeps {
  storage: CapabilityProfileStorage;
  listCapabilityCatalog(scope: "inspectable" | "callable"): Promise<CapabilityCatalogEntry[]>;
  resolveToolSchema(input: {
    sessionId: string;
    turnId: string;
    userMessageId: string;
    content: string;
    mode: ChatMode;
    providerId?: string;
    model?: string;
    webMode: ChatWebMode;
    memoryMode: ChatMemoryMode;
    retrievalMode: ChatRetrievalMode;
    thinkingLevel: ChatThinkingLevel;
    speedMode: ChatSpeedMode;
    subagentPolicy: ChatSubagentPolicy;
    normalizationProfile?: ChatNormalizationProfile;
    toolAutonomy: "safe_auto" | "manual";
    routedContextRequested?: boolean;
    operatorId?: string;
    authActorId?: string;
    authActorSource?: ToolPolicyActorContext["authActorSource"];
    permissionProfileId?: string;
    localOperatorOverrideId?: string;
    policyRunId?: string;
    policyTaskId?: string;
    fullWebAccess?: boolean;
    policyContext?: ToolPolicyActorContext;
    historyMessages: ChatCompletionRequest["messages"];
  }): Promise<ResolvedChatTurnToolSchema>;
  resolveToolPolicyContext(input: {
    operatorId?: string;
    authActorId?: string;
    authActorSource?: ToolPolicyActorContext["authActorSource"];
    workspaceId?: string;
    sessionId?: string;
    taskId?: string;
    runId?: string;
    surface?: ChatMode;
    permissionProfileId?: string;
    localOperatorOverrideId?: string;
  }): Promise<ToolPolicyActorContext>;
  getProviderReadiness(providerId: string | undefined):
    | {
        configured: boolean;
        local: boolean;
      }
    | undefined;
  /** Gateway-owned, operator-correctable task-boundary classification. */
  classifyWorkPassport?(workspaceId: string, content: string): Promise<WorkPassportRecord>;
  /** Gateway-owned governed runtime-skill activation and exact-byte receipt builder. */
  resolveActivatedSkills?(input: {
    content: string;
    trustedSkills: ChatTurnCapabilityProfileRecord["selection"]["trustedSkills"];
  }): Promise<ChatTurnCapabilityProfileRecord["selection"]["activatedSkills"]>;
  resolveToolRuntimeOwnerBinding?(toolName: string): ChatTurnCapabilityToolRuntimeOwnerBinding;
  /**
   * Gateway-owned profile-freeze seam. Implementations may return only the
   * secret-free immutable binding; connection resolution remains runtime-only.
   */
  resolveMcpRequesterResolutionBinding?(input: {
    profileId: string;
    turnId: string;
    sessionId: string;
    workspaceId: string;
    authActorId?: string;
    authActorSource?: ToolPolicyActorContext["authActorSource"];
    catalogSnapshotId: string;
    callableCatalogSha256: string;
    requesterScopeSha256?: string;
    canonicalToolName: string;
    modelToolName: string;
  }): McpRequesterResolutionBinding | undefined | Promise<McpRequesterResolutionBinding | undefined>;
  /**
   * HX-408 M2 profile-freeze drift gate for mesh-published callables. The
   * gateway composition re-verifies the exact activation through the
   * storage-owned revalidation query at freeze time and returns the
   * packet-mandated snapshot; `undefined` means the entry no longer
   * revalidates and the profile freeze MUST fail closed (any freeze-time
   * drift blocks the turn).
   */
  resolveMeshPublicationBinding?(input: {
    workspaceId: string;
    capabilityId: string;
    entrySha256: string;
    manifestSha256: string;
    publisherGeneration: number;
  }): Promise<ChatTurnCapabilityToolMeshPublicationBinding | undefined>;
}

export interface ChatTurnCapabilityProfileResolution {
  profile: ChatTurnCapabilityProfileRecord;
  catalogSnapshot: CapabilityCatalogSnapshotRecord;
  preview: ChatTurnCapabilityProfilePreview;
}

export async function resolveChatTurnCapabilityProfile(
  deps: ChatTurnCapabilityProfileResolveDeps,
  input: ChatTurnCapabilityProfileResolveInput,
): Promise<ChatTurnCapabilityProfileResolution> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const toolCallBeforeInterposition = buildToolCallBeforeHookInterpositionBinding(
    (
      await Promise.all(
        TOOL_EFFECT_INTERPOSITION_TRIGGERS.map((trigger) =>
          deps.storage.workspaceHooks.listByTrigger(input.workspaceId, trigger, TOOL_CALL_BEFORE_HOOK_BINDING_LIMIT),
        ),
      )
    ).flat(),
  );
  const [inspectableCatalog, callableCatalog] = await Promise.all([
    deps.listCapabilityCatalog("inspectable"),
    deps.listCapabilityCatalog("callable"),
  ]);
  const inspectableEntries = sortCatalogEntries(inspectableCatalog);
  const callableEntries = sortCatalogEntries(callableCatalog);
  assertCanonicalCatalogPair(inspectableEntries, callableEntries);
  const inspectableHash = digest(inspectableEntries);
  const callableHash = digest(callableEntries);
  const snapshotId = `chat-cap-snap-${inspectableHash.slice(0, 16)}-${callableHash.slice(0, 16)}`;
  const catalogSnapshot: CapabilityCatalogSnapshotRecord = {
    snapshotId,
    inspectableEntries,
    callableEntries,
    createdAt,
  };
  const capabilityProfileId = `chat-capability-profile-${input.turnId}`;

  const policyContext =
    input.policyContext ??
    (await deps.resolveToolPolicyContext({
      operatorId: input.operatorId,
      authActorId: input.authActorId,
      authActorSource: input.authActorSource,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      taskId: input.policyTaskId,
      runId: input.policyRunId,
      surface: input.mode,
      permissionProfileId: input.permissionProfileId,
      localOperatorOverrideId: input.localOperatorOverrideId,
    }));
  const resolvedPermissionProfileId = policyContext.permissionProfileId ?? input.permissionProfileId ?? "safe";
  const requesterScopeSha256 =
    policyContext.authActorId && isMcpRequesterScopeAuthActorSource(policyContext.authActorSource)
      ? digest(
          mcpRequesterScopeHashMaterial({
            profileId: capabilityProfileId,
            turnId: input.turnId,
            sessionId: input.sessionId,
            workspaceId: input.workspaceId,
            authActorId: policyContext.authActorId,
            authActorSource: policyContext.authActorSource,
          }),
        )
      : undefined;
  const toolSchema = await deps.resolveToolSchema({
    sessionId: input.sessionId,
    turnId: input.turnId,
    userMessageId: `capability-profile:${input.turnId}`,
    content: input.content,
    mode: input.mode,
    providerId: input.routeResolution.effectiveProviderId,
    model: input.routeResolution.effectiveModel,
    webMode: input.webMode,
    memoryMode: input.memoryMode,
    retrievalMode: input.retrievalMode,
    thinkingLevel: input.thinkingLevel,
    speedMode: input.speedMode,
    subagentPolicy: input.subagentPolicy,
    normalizationProfile: input.normalizationProfile,
    toolAutonomy: input.toolAutonomy,
    routedContextRequested: input.routedContextRequested,
    operatorId: input.operatorId,
    authActorId: input.authActorId,
    authActorSource: input.authActorSource,
    permissionProfileId: resolvedPermissionProfileId,
    localOperatorOverrideId: policyContext.localOperatorOverrideId ?? input.localOperatorOverrideId,
    policyRunId: input.policyRunId,
    policyTaskId: input.policyTaskId,
    fullWebAccess: input.fullWebAccess,
    policyContext,
    historyMessages: input.historyMessages,
  });
  const callableToolsByName = new Map(
    callableEntries
      .filter((entry) => entry.kind === "tool" && entry.callable && Boolean(entry.toolName))
      .map((entry) => [entry.toolName as string, entry]),
  );
  // HX-408 M2: mesh-published callables are addressed by their server-derived
  // capability ID and must carry a freeze-verified activation snapshot.
  const meshCallableByCapabilityId = new Map(
    callableEntries
      .filter(
        (entry) =>
          (entry.kind === "mesh_tool" || entry.kind === "mesh_mcp_server") &&
          entry.callable &&
          entry.mesh !== undefined,
      )
      .map((entry) => [entry.capabilityId, entry]),
  );
  const tools = await Promise.all(
    toolSchema.tools.map(async (providerDefinition) => {
      const modelName = readProviderToolName(providerDefinition);
      const canonicalName = toolSchema.modelToCanonical.get(modelName);
      if (!canonicalName) {
        throw new Error(`Resolved provider tool ${modelName} is outside the server-owned allow-map.`);
      }
      const meshCatalogEntry = callableToolsByName.has(canonicalName)
        ? undefined
        : meshCallableByCapabilityId.get(canonicalName);
      const catalogEntry = callableToolsByName.get(canonicalName) ?? meshCatalogEntry;
      if (!catalogEntry) {
        throw new Error(`Resolved provider tool ${canonicalName} is outside the canonical callable catalog.`);
      }
      const meshPublication = meshCatalogEntry
        ? await resolveFrozenMeshPublicationBinding(deps, input.workspaceId, canonicalName, meshCatalogEntry)
        : undefined;
      const runtimeOwner =
        deps.resolveToolRuntimeOwnerBinding?.(canonicalName) ?? buildToolRuntimeOwnerBinding("builtin");
      const resolvedMcpRequesterResolution = canonicalName.startsWith("mcp.")
        ? await deps.resolveMcpRequesterResolutionBinding?.({
            profileId: capabilityProfileId,
            turnId: input.turnId,
            sessionId: input.sessionId,
            workspaceId: input.workspaceId,
            authActorId: policyContext.authActorId,
            authActorSource: policyContext.authActorSource,
            catalogSnapshotId: snapshotId,
            callableCatalogSha256: callableHash,
            requesterScopeSha256,
            canonicalToolName: canonicalName,
            modelToolName: modelName,
          })
        : undefined;
      const mcpRequesterResolution = resolvedMcpRequesterResolution
        ? copyAndFreezeMcpRequesterResolutionBinding(resolvedMcpRequesterResolution)
        : undefined;
      return {
        canonicalName,
        modelName,
        definitionHash: digest(providerDefinition),
        providerDefinition,
        runtimeOwner,
        ...(mcpRequesterResolution ? { mcpRequesterResolution } : {}),
        ...(meshPublication ? { meshPublication } : {}),
        effectPotential: meshPublication
          ? // A mesh-published callable executes on a remote node: its recovery
            // upper bound is always the conservative remote classification.
            classifyToolEffectPotential({
              toolName: canonicalName,
              trustedBuiltin: false,
              sourceKind: "remote",
            })
          : toolCallBeforeInterposition.count > 0 || runtimeOwner.kind === "plugin"
            ? classifyToolEffectPotential({
                toolName: canonicalName,
                trustedBuiltin: false,
                sourceKind: runtimeOwner.kind === "plugin" ? "plugin" : "remote",
              })
            : (catalogEntry.effectPotential ??
              classifyToolEffectPotential({
                toolName: canonicalName,
                trustedBuiltin: false,
                readOnly: catalogEntry.wrapperVisibility?.readOnly,
              })),
      };
    }),
  );
  const modelNameAllowMap = tools.map(({ modelName, canonicalName }) => ({ modelName, canonicalName }));
  const trustedSkills = buildTrustedSkillSnapshot(callableEntries, await deps.storage.skillLifecycle.list());
  const activatedSkills = (await deps.resolveActivatedSkills?.({ content: input.content, trustedSkills })) ?? [];
  const activeGrants = (await collectActiveGrants(deps.storage, input)).map((grant) => ({
    grantId: grant.grantId,
    toolPattern: grant.toolPattern,
    decision: grant.decision,
    scope: grant.scope,
    scopeRef: grant.scopeRef,
    grantType: grant.grantType,
    ...(grant.constraints ? { constraints: grant.constraints } : {}),
    ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
    ...(grant.usesRemaining !== undefined ? { usesRemaining: grant.usesRemaining } : {}),
  }));
  const permissionProfile = policyContext.permissionProfile;
  const permissionProfileHash = digest(
    permissionProfile ?? {
      profileId: resolvedPermissionProfileId,
      approvalMode: "approve_all",
    },
  );
  const approvalMode = permissionProfile?.approvalMode ?? "approve_all";
  const localOperatorOverride = policyContext.localOperatorOverride;
  const toolsRequiringApproval = tools
    .filter((tool) =>
      toolSchema.policyDecisions.some(
        (decision) => decision.toolName === tool.canonicalName && decision.allowed && decision.requiresApproval,
      ),
    )
    .map((tool) => tool.canonicalName);
  const providerReadiness = buildProviderReadiness(deps, input);
  const source = buildChatTurnCapabilityProfileSourceScope(input.route);
  const contentHash = digest(input.content);
  const workPassport = await deps.classifyWorkPassport?.(input.workspaceId, input.content);
  const memory = {
    mode: input.memoryMode,
    retrievalMode: input.retrievalMode,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    contextManifestRef: `chat-memory-scope:${digest({
      mode: input.memoryMode,
      retrievalMode: input.retrievalMode,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
    })}`,
    writeApprovalRequired: approvalMode !== "bypass",
  };
  const selection = {
    contentHash,
    requestedProviderId: input.routeResolution.requestedProviderId,
    requestedModel: input.routeResolution.requestedModel,
    effectiveProviderId: input.routeResolution.effectiveProviderId,
    effectiveModel: input.routeResolution.effectiveModel,
    // Chat executes an explicit provider/model route. Cross-provider fallback
    // is therefore frozen off until the completion layer accepts and enforces
    // an exact server-owned fallback allowlist.
    allowedFallbacks: [],
    mode: input.mode,
    webMode: input.webMode,
    memory,
    thinkingLevel: input.thinkingLevel,
    speedMode: input.speedMode,
    subagentPolicy: input.subagentPolicy,
    toolAutonomy: input.toolAutonomy,
    tools,
    modelNameAllowMap,
    trustedSkills,
    ...(activatedSkills.length > 0 ? { activatedSkills } : {}),
    ...(workPassport ? { workPassport } : {}),
  } satisfies ChatTurnCapabilityProfileRecord["selection"];
  const governance = {
    activeGrants,
    permission: {
      profileId: resolvedPermissionProfileId,
      approvalMode,
      profileHash: permissionProfileHash,
      ...(localOperatorOverride?.overrideId ? { localOperatorOverrideId: localOperatorOverride.overrideId } : {}),
      ...(localOperatorOverride?.expiresAt ? { localOperatorOverrideExpiresAt: localOperatorOverride.expiresAt } : {}),
    },
    policyDecisions: toolSchema.policyDecisions.map((decision) => ({
      ...decision,
      reasonCodes: [...decision.reasonCodes],
    })),
    authReadiness: buildAuthReadiness(input, providerReadiness, tools, trustedSkills),
    approval: {
      mode: approvalMode,
      selectedToolCount: tools.length,
      toolsRequiringApproval,
      approvalGranted: false,
    },
  } satisfies ChatTurnCapabilityProfileRecord["governance"];
  const catalog = {
    snapshotId,
    inspectableHash,
    callableHash,
    inspectableCount: inspectableEntries.length,
    callableCount: callableEntries.length,
    runtimeInterpositionHash: toolCallBeforeInterposition.hash,
    toolCallBeforeHookCount: toolCallBeforeInterposition.count,
  };
  const preflightFingerprint = digest({
    schemaVersion: CHAT_TURN_CAPABILITY_PROFILE_VERSION,
    source,
    catalog,
    selection,
    governance,
  });
  const profile = sealChatTurnCapabilityProfile({
    profileId: capabilityProfileId,
    schemaVersion: CHAT_TURN_CAPABILITY_PROFILE_VERSION,
    identity: {
      turnId: input.turnId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      citadelId: input.citadelId,
      ...(input.durableRunId ? { durableRunId: input.durableRunId } : {}),
      ...(policyContext.operatorId ? { operatorId: policyContext.operatorId } : {}),
      ...(policyContext.authActorId ? { authActorId: policyContext.authActorId } : {}),
      ...(policyContext.authActorSource ? { authActorSource: policyContext.authActorSource } : {}),
    },
    source,
    catalog,
    selection,
    governance,
    preflightFingerprint,
    createdAt,
  });
  // Preflight and direct-send selection must fail at the same boundary as
  // persistence. Do not return a preview for a profile that would later be
  // rejected as malformed, ambiguous, oversized, or secret-bearing.
  verifyChatTurnCapabilityProfile(profile);
  const blockedReasons = [
    input.routeResolution.blockedReason,
    ...providerReadiness.reasonCodes.filter((reason) => providerReadiness.status !== "ready" && reason),
  ].filter((value): value is string => Boolean(value));
  const preview: ChatTurnCapabilityProfilePreview = {
    schemaVersion: CHAT_TURN_CAPABILITY_PROFILE_VERSION,
    fingerprint: preflightFingerprint,
    contentHash,
    providerId: selection.effectiveProviderId,
    model: selection.effectiveModel,
    fallbackCount: selection.allowedFallbacks.length,
    selectedTools: tools.map((tool) => ({
      canonicalName: tool.canonicalName,
      modelName: tool.modelName,
      requiresApproval: toolsRequiringApproval.includes(tool.canonicalName),
    })),
    trustedSkills: trustedSkills.map((skill) => ({
      skillId: skill.skillId,
      ...(skill.trustLabel ? { trustLabel: skill.trustLabel } : {}),
    })),
    memory,
    approval: governance.approval,
    authReadiness: governance.authReadiness,
    blockedReasons,
    ...(workPassport ? { workPassport } : {}),
  };
  return { profile, catalogSnapshot, preview };
}

function buildProviderReadiness(
  deps: ChatTurnCapabilityProfileResolveDeps,
  input: ChatTurnCapabilityProfileResolveInput,
): ChatTurnCapabilityProfileRecord["governance"]["authReadiness"][number] {
  const providerId = input.routeResolution.effectiveProviderId;
  if (!providerId) {
    return {
      kind: "provider",
      ref: "unresolved",
      status: "blocked",
      reasonCodes: [input.routeResolution.blockedReason ?? "provider_unresolved"],
    };
  }
  const readiness = deps.getProviderReadiness(providerId);
  if (!readiness) {
    return { kind: "provider", ref: providerId, status: "unknown", reasonCodes: ["provider_unknown"] };
  }
  if (readiness.local || readiness.configured) {
    return { kind: "provider", ref: providerId, status: "ready", reasonCodes: [] };
  }
  return { kind: "provider", ref: providerId, status: "missing", reasonCodes: ["provider_auth_missing"] };
}

function buildAuthReadiness(
  input: ChatTurnCapabilityProfileResolveInput,
  provider: ChatTurnCapabilityProfileRecord["governance"]["authReadiness"][number],
  tools: ChatTurnCapabilityProfileRecord["selection"]["tools"],
  trustedSkills: ChatTurnCapabilityProfileRecord["selection"]["trustedSkills"],
): ChatTurnCapabilityProfileRecord["governance"]["authReadiness"] {
  const channelBindingComplete = Boolean(input.route.channel.trim() && input.route.account.trim());
  const localChatChannel = input.route.channel.trim().toLowerCase() === "chat";
  const channel = {
    kind: "channel" as const,
    ref: `channel-binding:${digest({ channel: input.route.channel, account: input.route.account })}`,
    status: !channelBindingComplete
      ? ("blocked" as const)
      : localChatChannel
        ? ("ready" as const)
        : ("unknown" as const),
    reasonCodes: !channelBindingComplete
      ? ["channel_binding_incomplete"]
      : localChatChannel
        ? ["local_chat_channel"]
        : ["channel_runtime_auth_check_required"],
  };
  const toolReadiness = tools.map((tool) => ({
    kind: tool.canonicalName.startsWith("mcp.") ? ("mcp" as const) : ("tool" as const),
    ref: tool.canonicalName,
    status: "unknown" as const,
    reasonCodes: ["runtime_auth_check_required"],
  }));
  const skillReadiness = trustedSkills.map((skill) => ({
    kind: "skill" as const,
    ref: skill.skillId,
    status: skill.treeSha256 ? ("ready" as const) : ("unknown" as const),
    reasonCodes: skill.treeSha256 ? ["verified_content_integrity"] : ["skill_auth_not_declared"],
  }));
  return [provider, channel, ...toolReadiness, ...skillReadiness];
}

export function buildChatTurnCapabilityProfileSourceScope(
  route: ChatTurnRoute,
): ChatTurnCapabilityProfileRecord["source"] {
  const bindingTarget = {
    peer: route.peer,
    room: route.room,
    threadId: route.threadId,
  };
  return {
    channel: route.channel,
    account: route.account,
    ...(route.peer || route.room || route.threadId ? { bindingTargetHash: digest(bindingTarget) } : {}),
  };
}

function buildTrustedSkillSnapshot(
  callableEntries: CapabilityCatalogEntry[],
  lifecycleRows: Awaited<ReturnType<CapabilityProfileStorage["skillLifecycle"]["list"]>>,
): ChatTurnCapabilityProfileRecord["selection"]["trustedSkills"] {
  const lifecycleBySkill = new Map(lifecycleRows.map((row) => [row.skillId, row]));
  return callableEntries
    .filter((entry) => entry.kind === "skill" && Boolean(entry.skillId))
    .map((entry) => {
      const skillId = entry.skillId as string;
      const lifecycle = lifecycleBySkill.get(skillId);
      if (!lifecycle || (lifecycle.lifecycleState !== "approved" && lifecycle.lifecycleState !== "trusted")) {
        throw new Error(`Callable skill ${skillId} is missing an active trusted lifecycle binding.`);
      }
      const integrity = lifecycle?.provenance?.contentIntegrity;
      if (!integrity?.verified) {
        throw new Error(`Callable skill ${skillId} failed exact-byte integrity verification.`);
      }
      const provenanceSource = lifecycle.provenance?.source?.trim();
      if (!provenanceSource) {
        throw new Error(`Callable skill ${skillId} is missing server-owned provenance.`);
      }
      return {
        capabilityId: entry.capabilityId,
        skillId,
        category: lifecycle.category,
        lifecycleState: lifecycle.lifecycleState,
        trustLabel: lifecycle.trustLabel,
        source: provenanceSource,
        sourceRef: lifecycle.provenance?.sourceRef ?? entry.sourceRef,
        sourceProvider: lifecycle.provenance?.sourceProvider ?? entry.sourceProvider,
        commitSha: lifecycle.provenance?.commitSha,
        contentIntegrityManifestVersion: integrity.manifestVersion,
        treeSha256: integrity.treeSha256,
        contentFileCount: integrity.fileCount,
        contentBytes: integrity.totalBytes,
      };
    })
    .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
}

async function collectActiveGrants(storage: CapabilityProfileStorage, input: ChatTurnCapabilityProfileResolveInput) {
  const scopes: Array<[Parameters<CapabilityProfileStorage["toolGrants"]["listActive"]>[0], string]> = [
    ["global", "global"],
    ["agent", "assistant"],
    ["workspace", input.workspaceId],
    ["session", input.sessionId],
    ["citadel", input.citadelId],
  ];
  if (input.policyTaskId) {
    scopes.push(["task", input.policyTaskId]);
  }
  const byId = new Map(
    (await Promise.all(scopes.map(([scope, scopeRef]) => storage.toolGrants.listActive(scope, scopeRef))))
      .flat()
      .map((grant) => [grant.grantId, grant]),
  );
  return [...byId.values()].sort((left, right) => left.grantId.localeCompare(right.grantId));
}

function sortCatalogEntries(entries: CapabilityCatalogEntry[]): CapabilityCatalogEntry[] {
  return [...entries].sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
}

function assertCanonicalCatalogPair(
  inspectableEntries: CapabilityCatalogEntry[],
  callableEntries: CapabilityCatalogEntry[],
): void {
  verifyCapabilityCatalogEntryUniqueness(inspectableEntries, "inspectable capability catalog");
  verifyCapabilityCatalogEntryUniqueness(callableEntries, "callable capability catalog");
  const inspectableById = new Map(inspectableEntries.map((entry) => [entry.capabilityId, entry]));
  for (const entry of callableEntries) {
    const inspectable = inspectableById.get(entry.capabilityId);
    if (!entry.callable || !inspectable || canonicalJsonString(inspectable) !== canonicalJsonString(entry)) {
      throw new Error(`Callable capability ${entry.capabilityId} is not an exact canonical inspectable entry.`);
    }
  }
}

function readProviderToolName(definition: Record<string, unknown>): string {
  const fn = definition.function;
  if (!isRecord(fn) || typeof fn.name !== "string" || !fn.name.trim()) {
    throw new Error("Resolved provider tool definition is missing function.name.");
  }
  return fn.name;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value)).digest("hex");
}

function isMcpRequesterScopeAuthActorSource(
  value: ToolPolicyActorContext["authActorSource"],
): value is McpRequesterScopeAuthActorSource {
  return value === "token" || value === "basic" || value === "loopback" || value === "device" || value === "companion";
}

function copyAndFreezeMcpRequesterResolutionBinding(
  input: McpRequesterResolutionBinding,
): McpRequesterResolutionBinding {
  const copied = structuredClone(input);
  if (copied.meshActivation) Object.freeze(copied.meshActivation);
  return Object.freeze(copied);
}

/**
 * HX-408 M2 freeze gate: a mesh-published callable may enter the profile only
 * with a server-verified activation snapshot whose immutable identity matches
 * the exact catalog entry being selected. A missing seam, a failed
 * revalidation, or any identity divergence blocks the turn fail-closed with a
 * content-free reason.
 */
async function resolveFrozenMeshPublicationBinding(
  deps: ChatTurnCapabilityProfileResolveDeps,
  workspaceId: string,
  canonicalName: string,
  catalogEntry: CapabilityCatalogEntry,
): Promise<ChatTurnCapabilityToolMeshPublicationBinding> {
  const projection = catalogEntry.mesh;
  const blocked = () =>
    new Error(`Mesh-published tool ${canonicalName} is blocked because mesh_capability_freeze_drift.`);
  if (!projection || !deps.resolveMeshPublicationBinding) {
    throw blocked();
  }
  const binding = await deps.resolveMeshPublicationBinding({
    workspaceId,
    capabilityId: catalogEntry.capabilityId,
    entrySha256: projection.entrySha256,
    manifestSha256: projection.manifestSha256,
    publisherGeneration: projection.publisherGeneration,
  });
  if (
    !binding ||
    binding.nodeId !== projection.nodeId ||
    binding.publisherGeneration !== projection.publisherGeneration ||
    binding.manifestSha256 !== projection.manifestSha256 ||
    binding.entrySha256 !== projection.entrySha256 ||
    binding.effectPosture !== projection.effectPosture
  ) {
    throw blocked();
  }
  const copied = structuredClone(binding);
  return Object.freeze(copied);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
