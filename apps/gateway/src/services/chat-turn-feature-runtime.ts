import {
  canonicalJsonString,
  CHAT_ROUTED_CONTEXT_TOOL_NAMES,
  type ChatCompletionRequest,
} from "@goatcitadel/contracts";
import type {
  ChatTurnAgentRunnerInput,
  ChatTurnAgentRunnerDeps,
  ResolvedChatTurnToolSchema,
} from "./chat-turn-agent-runner.js";
import { assertChatTurnToolUseOpen } from "./chat-turn-control.js";
import { bindChatFeatureDispatchCheck } from "./chat-feature-dispatch-authority.js";
import {
  createMcpRequesterAdmissionTurnContext,
  type McpChatTurnContextHandle,
  type McpRequesterAdmissionTurnContextHandle,
} from "./mcp-requester-admission-context.js";
import { buildMcpRequesterScopedTurnContextFromCapabilityProfile } from "./mcp-requester-resolution-service.js";
import {
  createMeshChatTurnContext,
  createMeshAdmissionTurnContext,
  type MeshChatTurnContextHandle,
} from "./gateway/mesh-chat-binding.js";
import type { NativeMcpChatToolSchema } from "./gateway/native-mcp-chat-catalog.js";
import type { MeshChatToolSchema } from "./gateway/mesh-chat-catalog.js";
import { extractProviderToolName } from "./chat-turn-agent-runner/provider-message-helpers.js";
export type ChatTurnFeatureRuntimeHost = Pick<
  ChatTurnAgentRunnerDeps,
  | "storage"
  | "attachedContextToolsV1Enabled"
  | "prepareExplicitContextRequest"
  | "assertFeatureReferencesCurrent"
  | "restoreRequesterAdmissionSchemas"
  | "restoreMeshAdmissionSchemas"
  | "resumeRequesterAdmissionApprovals"
  | "resumeMeshAdmissionApprovals"
  | "resumeFanoutApprovals"
>;
/** Feature guards and schema restoration share the existing canonical write and dispatch fences. */
export async function filterFeatureContextToolSchema(
  host: ChatTurnFeatureRuntimeHost,

  input: ChatTurnAgentRunnerInput,
  schema: ResolvedChatTurnToolSchema,
): Promise<ResolvedChatTurnToolSchema> {
  const contextToolNames = new Set<string>(CHAT_ROUTED_CONTEXT_TOOL_NAMES);
  const binding = input.serverContextUsageAttribution;
  let available = (await host.attachedContextToolsV1Enabled?.()) === true && Boolean(binding);
  if (available && binding) {
    const snapshot = await host.storage.routedContextSnapshots.findByTurn(input.turnId);
    const workspaceId = (await host.storage.chatSessionMeta.get(input.sessionId))?.workspaceId;
    available = Boolean(
      snapshot &&
      workspaceId &&
      snapshot.snapshotId === binding.contextSnapshotId &&
      snapshot.snapshotHash === binding.contextResolutionHash &&
      snapshot.turnId === input.turnId &&
      snapshot.sessionId === input.sessionId &&
      snapshot.workspaceId === workspaceId &&
      snapshot.entries.some(
        (entry) =>
          (entry.disposition === "included" || entry.disposition === "truncated") &&
          entry.admittedBytes > 0 &&
          entry.admittedText.length > 0,
      ),
    );
  }
  if (available) return schema;
  const canonicalToModel = new Map(
    [...schema.canonicalToModel].filter(([canonicalName]) => !contextToolNames.has(canonicalName)),
  );
  const modelToCanonical = new Map(
    [...schema.modelToCanonical].filter(([, canonicalName]) => !contextToolNames.has(canonicalName)),
  );
  return {
    tools: schema.tools.filter((tool) => {
      const modelName = extractProviderToolName(tool);
      return Boolean(modelName && modelToCanonical.has(modelName));
    }),
    modelToCanonical,
    canonicalToModel,
    policyDecisions: schema.policyDecisions.filter((decision) => !contextToolNames.has(decision.toolName)),
  };
}

export async function bindFeatureContextRequest(
  host: ChatTurnFeatureRuntimeHost,
  input: ChatTurnAgentRunnerInput,
  request: ChatCompletionRequest,
): Promise<ChatCompletionRequest> {
  let prepared = request;
  if (input.featureAdmission?.references.explicitContext) {
    if (!host.prepareExplicitContextRequest) throw new Error("Explicit context request validation is unavailable.");
    prepared = await host.prepareExplicitContextRequest(input, prepared);
  }
  if (!input.featureAdmission) return prepared;
  const providerRoute = input.featureAdmission.references.providerRoute;
  return bindChatFeatureDispatchCheck(prepared, {
    sessionId: input.sessionId,
    turnId: input.turnId,
    ...(providerRoute
      ? { allowedRoutes: [providerRoute.primary, ...(providerRoute.fallback ? [providerRoute.fallback] : [])] }
      : {}),
    runId: input.canonicalDurableRunId ?? input.policyRunId ?? "",
    check: () => assertFeatureTurnExternalDispatch(host, input),
  });
}

export async function assertFeatureTurnExternalDispatch(
  host: ChatTurnFeatureRuntimeHost,

  input: Pick<
    ChatTurnAgentRunnerInput,
    | "canonicalWriteFence"
    | "sessionId"
    | "turnId"
    | "workspaceId"
    | "featureAdmission"
    | "policyRunId"
    | "canonicalDurableRunId"
    | "parentDelegationStepId"
  >,
): Promise<void> {
  await assertChatTurnToolUseOpen(host.storage, input.sessionId, input.turnId);
  await runFeatureCanonicalWrite(input, () => undefined);
  if (input.featureAdmission) {
    if (!host.assertFeatureReferencesCurrent) throw new Error("Admitted feature revalidation is unavailable.");
    await host.assertFeatureReferencesCurrent(input);
  }
}

export function buildFeatureMcpTurnContext(
  host: ChatTurnFeatureRuntimeHost,

  turnInput: Pick<
    ChatTurnAgentRunnerInput,
    | "capabilityProfile"
    | "featureAdmission"
    | "sessionId"
    | "turnId"
    | "workspaceId"
    | "authActorId"
    | "authActorSource"
    | "canonicalWriteFence"
  >,
): McpChatTurnContextHandle | undefined {
  const profile = turnInput.capabilityProfile;
  if (profile) return buildMcpRequesterScopedTurnContextFromCapabilityProfile(profile);
  const receipts = [
    ...(turnInput.featureAdmission?.references.requesterConnections ?? []),
    ...(turnInput.featureAdmission?.references.selectedStaticMcp ?? []),
  ];
  if (!receipts?.length) return undefined;
  const first = receipts[0];
  if (
    !first ||
    !("version" in first) ||
    !["mcp.requester.admission.v1", "mcp.static.admission.v1"].includes(first.version) ||
    first.scope.sessionId !== turnInput.sessionId ||
    first.scope.turnId !== turnInput.turnId ||
    first.scope.workspaceId !== turnInput.workspaceId ||
    first.scope.actorId !== turnInput.authActorId ||
    first.scope.actorSource !== turnInput.authActorSource ||
    receipts.some(
      (receipt) => !("scope" in receipt) || canonicalJsonString(receipt.scope) !== canonicalJsonString(first.scope),
    )
  ) {
    throw new Error("Requester MCP feature references do not match this Chat turn.");
  }
  const fence = turnInput.canonicalWriteFence;
  if (!fence) throw new Error("Requester MCP admission requires its live execution claim.");
  return createMcpRequesterAdmissionTurnContext(first.scope, turnInput.featureAdmission!.referenceSha256, async () => {
    await fence(() => assertChatTurnToolUseOpen(host.storage, turnInput.sessionId, turnInput.turnId));
  });
}

export function buildFeatureMeshTurnContext(
  host: ChatTurnFeatureRuntimeHost,
  input: ChatTurnAgentRunnerInput,
): MeshChatTurnContextHandle | undefined {
  if (input.capabilityProfile) return createMeshChatTurnContext(input.capabilityProfile);
  const selected = input.featureAdmission?.references.selectedMeshCapabilities;
  if (!selected) return undefined;
  const { scope } = selected;
  const fence = input.canonicalWriteFence;
  if (
    !fence ||
    scope.sessionId !== input.sessionId ||
    scope.turnId !== input.turnId ||
    scope.workspaceId !== input.workspaceId ||
    scope.actorId !== input.authActorId ||
    scope.actorSource !== input.authActorSource
  )
    throw new Error("Mesh admission does not match the live Chat turn.");
  return createMeshAdmissionTurnContext(scope, input.featureAdmission!.referenceSha256, async () => {
    await fence(() => assertChatTurnToolUseOpen(host.storage, input.sessionId, input.turnId));
  });
}

async function runFeatureCanonicalWrite<T>(
  input: Pick<ChatTurnAgentRunnerInput, "canonicalWriteFence">,
  work: () => T | Promise<T>,
): Promise<Awaited<T>> {
  return input.canonicalWriteFence ? await input.canonicalWriteFence(work) : await work();
}
export async function restoreFeatureTurnToolSchemas(
  host: ChatTurnFeatureRuntimeHost,
  input: ChatTurnAgentRunnerInput,
  nativeTools: readonly NativeMcpChatToolSchema[],
  meshTools: readonly MeshChatToolSchema[],
) {
  let admittedNativeTools = nativeTools;
  if (
    !input.capabilityProfile &&
    nativeTools.length === 0 &&
    (input.featureAdmission?.references.requesterConnections?.length ||
      input.featureAdmission?.references.selectedStaticMcp?.length)
  ) {
    const context = buildFeatureMcpTurnContext(host, input);
    if (!context || !host.restoreRequesterAdmissionSchemas)
      throw new Error("Requester MCP admission restoration is unavailable.");
    admittedNativeTools = await host.restoreRequesterAdmissionSchemas(
      context as McpRequesterAdmissionTurnContextHandle,
    );
  }
  let admittedMeshTools = meshTools;
  if (
    !input.capabilityProfile &&
    meshTools.length === 0 &&
    input.featureAdmission?.references.selectedMeshCapabilities
  ) {
    const context = buildFeatureMeshTurnContext(host, input);
    if (!context || !host.restoreMeshAdmissionSchemas) throw new Error("Mesh admission restoration is unavailable.");
    admittedMeshTools = await host.restoreMeshAdmissionSchemas(context);
  }
  return { admittedNativeTools, admittedMeshTools };
}
export async function resumeFeatureTurnApprovals(
  host: ChatTurnFeatureRuntimeHost,
  input: ChatTurnAgentRunnerInput,
): Promise<void> {
  if (
    !input.capabilityProfile &&
    (input.featureAdmission?.references.requesterConnections?.length ||
      input.featureAdmission?.references.selectedStaticMcp?.length)
  ) {
    const handle = buildFeatureMcpTurnContext(host, input) as McpRequesterAdmissionTurnContextHandle;
    if (!host.resumeRequesterAdmissionApprovals) throw new Error("Requester MCP approval continuation is unavailable.");
    await host.resumeRequesterAdmissionApprovals(input, handle);
  }
  if (!input.capabilityProfile && input.featureAdmission?.references.selectedMeshCapabilities) {
    const handle = buildFeatureMeshTurnContext(host, input)!;
    if (!host.resumeMeshAdmissionApprovals) throw new Error("Mesh approval continuation is unavailable.");
    await host.resumeMeshAdmissionApprovals(input, handle);
  }
  if (input.subagentPolicy === "auto_when_useful" && !input.parentDelegationStepId) {
    await host.resumeFanoutApprovals?.(input);
  }
}

/** Remains lazy: artifact preflight alone decides whether the frozen workspace brand is needed. */
export function createChatWorkspaceDesignBrandResolver(
  host: Pick<ChatTurnAgentRunnerDeps, "resolveWorkspaceDesignBrand">,
  input: ChatTurnAgentRunnerInput,
) {
  return () =>
    host.resolveWorkspaceDesignBrand?.({
      workspaceId: input.workspaceId,
      capabilityProfile: input.capabilityProfile,
    });
}
