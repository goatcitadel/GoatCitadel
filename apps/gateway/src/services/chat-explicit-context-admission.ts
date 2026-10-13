import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  ConflictError,
  CHAT_ROUTED_CONTEXT_ADMISSION_SNAPSHOT_VERSION,
  readDurableChatTurnExecutionPayloadAuthority,
  type ChatCompletionRequest,
  type ChatRoutedContextSnapshotRecord,
} from "@goatcitadel/contracts";
import { estimateTokensFromText } from "@goatcitadel/memory-core";
import { verifyChatRoutedContextSnapshot, type AsyncStorage } from "@goatcitadel/storage";
import type { LlmService } from "./llm-service.js";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import { bindChatExplicitContextValidator } from "./chat-explicit-context-authority.js";
import { fingerprintChatProviderFallbackRoute } from "./chat-provider-fallback-admission.js";
import { LlmDispatchGuardRejectedError } from "./llm-dispatch-guard.js";
import { buildChatRoutedContextSnapshot } from "./chat-routed-context-service.js";
import { projectMcpAdmissionContextBudgetTools } from "./mcp-admission-context-budget.js";
import type { ChatTurnPrepHost } from "./chat-turn-prep-service.js";
import type {
  ResolveChatRoutedContextSourcesInput,
  ResolvedChatRoutedContextSources,
} from "./chat-routed-context-service.js";

export interface ChatExplicitContextAdmissionHost {
  storage: Pick<AsyncStorage, "durableRuns" | "sessionMutationAdmissions" | "routedContextSnapshots">;
  llmService: Pick<LlmService, "getModelContextWindow" | "getProviderRouteConfigFingerprint">;
  revalidateChatRoutedContextSnapshot(snapshot: ChatRoutedContextSnapshotRecord): Promise<void>;
}

/** Shared provider/tool admission check. Source revocation must also stop reads
 * from the retained snapshot before an attached-context tool returns its bytes. */
export async function assertAdmittedExplicitContextCurrent(
  host: ChatExplicitContextAdmissionHost,
  input: Pick<
    ChatTurnAgentRunnerInput,
    | "featureAdmission"
    | "workspaceId"
    | "sessionId"
    | "turnId"
    | "policyRunId"
    | "canonicalDurableRunId"
    | "canonicalWriteFence"
  >,
): Promise<void> {
  const expected = input.featureAdmission;
  const context = expected?.references.explicitContext;
  if (!expected || !context) return;
  const fence = input.canonicalWriteFence;
  const runId = input.canonicalDurableRunId ?? input.policyRunId;
  if (!fence || !runId) reject("Explicit context requires current durable Chat authority.");
  await fence(async () => {
    const run = await host.storage.durableRuns.getRun(runId);
    const authority = readDurableChatTurnExecutionPayloadAuthority({
      workflowKey: run.workflowKey,
      durableRunId: runId,
      payload: run.payload,
    });
    if (
      !authority ||
      run.status !== "running" ||
      authority.capabilityProfileId ||
      authority.requestActor.actorKind !== "operator" ||
      authority.featureReferenceSha256 !== expected.referenceSha256 ||
      authority.sessionId !== input.sessionId ||
      authority.turnId !== input.turnId ||
      authority.workspaceId !== input.workspaceId ||
      authority.routedContextSnapshotId !== context.snapshotId ||
      authority.routedContextSnapshotHash !== context.snapshotHash
    ) {
      reject("Explicit context durable scope changed.");
    }
    const identity = {
      admissionId: authority.admissionId,
      sessionIncarnationId: authority.sessionIncarnationId,
      workspaceId: authority.workspaceId,
      sessionId: authority.sessionId,
      turnId: authority.turnId,
      aggregateRevision: authority.admissionAggregateRevision,
      controllerGeneration: authority.admissionControllerGeneration,
      materialSha256: authority.admissionMaterialSha256,
    };
    const [features, binding, snapshot] = await Promise.all([
      host.storage.sessionMutationAdmissions.findFeatureReferences(identity),
      host.storage.sessionMutationAdmissions.findDurableRunBinding(identity),
      host.storage.routedContextSnapshots.get(context.snapshotId),
    ]);
    verifyChatRoutedContextSnapshot(snapshot);
    const admitted = snapshot.admissionBinding;
    if (
      !features ||
      binding?.durableRunId !== runId ||
      features.referenceSha256 !== expected.referenceSha256 ||
      canonicalJsonString(features.references) !== canonicalJsonString(expected.references) ||
      createHash("sha256").update(canonicalJsonString(features.references)).digest("hex") !==
        expected.referenceSha256 ||
      snapshot.snapshotHash !== context.snapshotHash ||
      snapshot.sessionId !== input.sessionId ||
      snapshot.turnId !== input.turnId ||
      snapshot.workspaceId !== input.workspaceId ||
      !admitted ||
      admitted.admissionId !== identity.admissionId ||
      admitted.sessionIncarnationId !== identity.sessionIncarnationId ||
      admitted.materialSha256 !== identity.materialSha256 ||
      admitted.aggregateRevision !== identity.aggregateRevision ||
      admitted.controllerGeneration !== identity.controllerGeneration
    ) {
      reject("Explicit context does not match its persisted feature admission.");
    }
    await host.revalidateChatRoutedContextSnapshot(snapshot);
  });
}

/** Rehydrates immutable bytes under current canonical authority, then carries a
 * process-local validation callback through hooks to the network boundary. */
export async function prepareAdmittedExplicitContextRequest(
  host: ChatExplicitContextAdmissionHost,
  input: ChatTurnAgentRunnerInput,
  request: ChatCompletionRequest,
): Promise<ChatCompletionRequest> {
  const expected = input.featureAdmission;
  const context = expected?.references.explicitContext;
  if (!expected || !context) return request;
  const runId = input.canonicalDurableRunId ?? input.policyRunId;
  const fence = input.canonicalWriteFence;
  if (!fence || !runId || input.capabilityProfile) reject("Explicit context requires current durable Chat authority.");
  const snapshot = await host.storage.routedContextSnapshots.get(context.snapshotId);
  verifyChatRoutedContextSnapshot(snapshot);
  const check = async (effective: ChatCompletionRequest): Promise<void> => {
    await fence(async () => {
      if (effective.signal?.aborted || input.signal?.aborted) reject("Explicit context turn was cancelled.");
      const run = await host.storage.durableRuns.getRun(runId);
      const authority = readDurableChatTurnExecutionPayloadAuthority({
        workflowKey: run.workflowKey,
        durableRunId: runId,
        payload: run.payload,
      });
      if (
        !authority ||
        run.status !== "running" ||
        authority.capabilityProfileId ||
        authority.requestActor.actorKind !== "operator" ||
        authority.featureReferenceSha256 !== expected.referenceSha256 ||
        authority.routedContextSnapshotId !== snapshot.snapshotId ||
        authority.routedContextSnapshotHash !== snapshot.snapshotHash ||
        authority.sessionId !== input.sessionId ||
        authority.turnId !== input.turnId ||
        authority.workspaceId !== input.workspaceId ||
        authority.requestActor.operatorId !== input.operatorId ||
        authority.requestActor.authActorId !== input.authActorId ||
        authority.requestActor.authActorSource !== input.authActorSource
      )
        reject("Explicit context durable scope changed.");
      const identity = {
        admissionId: authority.admissionId,
        sessionIncarnationId: authority.sessionIncarnationId,
        workspaceId: authority.workspaceId,
        sessionId: authority.sessionId,
        turnId: authority.turnId,
        aggregateRevision: authority.admissionAggregateRevision,
        controllerGeneration: authority.admissionControllerGeneration,
        materialSha256: authority.admissionMaterialSha256,
      };
      const [features, binding] = await Promise.all([
        host.storage.sessionMutationAdmissions.findFeatureReferences(identity),
        host.storage.sessionMutationAdmissions.findDurableRunBinding(identity),
      ]);
      const admitted = snapshot.admissionBinding;
      if (
        !features ||
        binding?.durableRunId !== runId ||
        features.referenceSha256 !== expected.referenceSha256 ||
        canonicalJsonString(features.references) !== canonicalJsonString(expected.references) ||
        createHash("sha256").update(canonicalJsonString(features.references)).digest("hex") !==
          expected.referenceSha256 ||
        snapshot.snapshotHash !== context.snapshotHash ||
        snapshot.turnId !== input.turnId ||
        snapshot.sessionId !== input.sessionId ||
        snapshot.workspaceId !== input.workspaceId ||
        !admitted ||
        admitted.admissionId !== identity.admissionId ||
        admitted.sessionIncarnationId !== identity.sessionIncarnationId ||
        admitted.materialSha256 !== identity.materialSha256 ||
        admitted.aggregateRevision !== identity.aggregateRevision ||
        admitted.controllerGeneration !== identity.controllerGeneration ||
        effective.memory?.sessionId !== input.sessionId ||
        effective.memory?.turnId !== input.turnId ||
        effective.memory?.runId !== runId
      ) {
        reject("Explicit context does not match its persisted feature admission.");
      }
      await host.revalidateChatRoutedContextSnapshot(snapshot);
      const route = features.references.providerRoute;
      if (
        !route ||
        fingerprintChatProviderFallbackRoute(host.llmService, route.primary, route.fallback) !== route.fingerprint ||
        ![route.primary, route.fallback].some(
          (target) => target && target.providerId === effective.providerId && target.model === effective.model,
        )
      ) {
        reject("Explicit context provider route changed after admission.");
      }
      const blocks = effective.messages.filter(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.startsWith("Routed context snapshot (immutable)."),
      );
      if (snapshot.contextText && (blocks.length !== 1 || blocks[0]?.content !== snapshot.contextText)) {
        reject("Explicit context bytes changed during provider preparation.");
      }
      const window = host.llmService.getModelContextWindow(effective.providerId!, effective.model!);
      const output = effective.max_tokens;
      const prompt = estimateTokensFromText(
        canonicalJsonString({ messages: effective.messages, tools: effective.tools ?? [] }),
        { model: effective.model },
      );
      if (
        !window ||
        typeof output !== "number" ||
        !Number.isSafeInteger(output) ||
        output < 1 ||
        prompt + output + 512 > window
      ) {
        reject("The complete request does not fit the admitted context model. No context was truncated.");
      }
    });
  };
  const existing = request.messages.filter(
    (message) =>
      message.role === "system" &&
      typeof message.content === "string" &&
      message.content.startsWith("Routed context snapshot (immutable)."),
  );
  const prepared: ChatCompletionRequest = {
    ...request,
    max_tokens: request.max_tokens ?? snapshot.budget.outputReservedTokens,
    messages:
      snapshot.contextText && existing.length === 0
        ? [{ role: "system", content: snapshot.contextText }, ...request.messages]
        : request.messages,
  };
  await check(prepared);
  return bindChatExplicitContextValidator(prepared, check);
}

function reject(message: string): never {
  throw new LlmDispatchGuardRejectedError(new Error(message));
}

/** Rechecks current visibility and read policy without replacing frozen bytes. */
export async function revalidateChatRoutedContextSnapshotAccess(
  host: {
    storage: Pick<AsyncStorage, "chatSessionMeta" | "chatSessionPrefs">;
    isFeatureEnabled(flag: string): Promise<boolean>;
    resolveChatRoutedContextSources(
      input: ResolveChatRoutedContextSourcesInput,
    ): Promise<ResolvedChatRoutedContextSources>;
  },
  snapshot: ChatRoutedContextSnapshotRecord,
): Promise<void> {
  verifyChatRoutedContextSnapshot(snapshot);
  if (snapshot.schemaVersion !== CHAT_ROUTED_CONTEXT_ADMISSION_SNAPSHOT_VERSION) return;
  if (!(await host.isFeatureEnabled("chatExplicitContextV1Enabled"))) {
    throw new ConflictError({ message: "Explicit context was disabled. Start a fresh turn after review." });
  }
  const [session, prefs] = await Promise.all([
    host.storage.chatSessionMeta.get(snapshot.sessionId),
    host.storage.chatSessionPrefs.get(snapshot.sessionId),
  ]);
  if (!session || (session.workspaceId ?? "default") !== snapshot.workspaceId || !prefs) {
    throw new ConflictError({ message: "Explicit context session scope is no longer available." });
  }
  const entries = snapshot.entries.filter(
    (entry) => entry.disposition === "included" || entry.disposition === "truncated",
  );
  if (!entries.length) return;
  const live = await host.resolveChatRoutedContextSources({
    refs: entries.map(({ kind, ref }) => ({ kind, ref })),
    sessionId: snapshot.sessionId,
    workspaceId: snapshot.workspaceId,
    memoryMode: prefs.memoryMode,
    allowGlobalMemory: false,
  });
  for (const [index, entry] of entries.entries()) {
    const current = live.sources[index];
    if (
      !current ||
      current.kind !== entry.kind ||
      current.ref !== entry.ref ||
      current.sourceScope !== entry.sourceScope ||
      current.sourceWorkspaceId !== entry.sourceWorkspaceId ||
      (entry.externalProvenance &&
        canonicalJsonString(current.externalProvenance) !== canonicalJsonString(entry.externalProvenance))
    ) {
      throw new ConflictError({ message: "Explicit context source access or provenance changed after admission." });
    }
  }
}

/** Validate retained admission-bound context without replacing historical profile replay. */
export async function verifyDurableAdmittedExplicitContextSnapshot(
  host: {
    storage: Pick<AsyncStorage, "sessionMutationAdmissions" | "chatTurnTraces">;
    revalidateChatRoutedContextSnapshot?(snapshot: ChatRoutedContextSnapshotRecord): Promise<void>;
  },
  run: import("@goatcitadel/contracts").DurableRunRecord,
  payload: import("./chat-turn-types.js").DurableChatTurnExecutionPayload,
  snapshot: ChatRoutedContextSnapshotRecord,
): Promise<void> {
  const binding = snapshot.admissionBinding;
  const identity = {
    admissionId: payload.admissionId,
    sessionIncarnationId: payload.sessionIncarnationId,
    workspaceId: payload.workspaceId,
    sessionId: payload.sessionId,
    turnId: payload.turnId,
    aggregateRevision: payload.admissionAggregateRevision,
    controllerGeneration: payload.admissionControllerGeneration,
    materialSha256: payload.admissionMaterialSha256,
  };
  const features = await host.storage.sessionMutationAdmissions.findFeatureReferences(identity);
  const durableBinding = await host.storage.sessionMutationAdmissions.findDurableRunBinding(identity);
  const context = features?.references.explicitContext;
  const route = features?.references.providerRoute?.primary;
  const trace = await host.storage.chatTurnTraces.get(payload.turnId);
  const traceBinding = trace?.routing?.routedContext;
  if (
    payload.capabilityProfileId ||
    !binding ||
    !context ||
    !route ||
    features?.referenceSha256 !== payload.featureReferenceSha256 ||
    durableBinding?.durableRunId !== run.runId ||
    binding.admissionId !== identity.admissionId ||
    binding.sessionIncarnationId !== identity.sessionIncarnationId ||
    binding.materialSha256 !== identity.materialSha256 ||
    binding.aggregateRevision !== identity.aggregateRevision ||
    binding.controllerGeneration !== identity.controllerGeneration ||
    snapshot.snapshotId !== payload.routedContextSnapshotId ||
    snapshot.snapshotHash !== payload.routedContextSnapshotHash ||
    context.snapshotId !== snapshot.snapshotId ||
    context.snapshotHash !== snapshot.snapshotHash ||
    snapshot.sessionId !== payload.sessionId ||
    snapshot.turnId !== payload.turnId ||
    snapshot.workspaceId !== payload.workspaceId ||
    snapshot.budget.effectiveProviderId !== route.providerId ||
    snapshot.budget.effectiveModel !== route.model ||
    trace?.sessionId !== payload.sessionId ||
    trace.turnId !== payload.turnId ||
    trace.durable?.runId !== run.runId ||
    traceBinding?.snapshotId !== snapshot.snapshotId ||
    traceBinding.snapshotHash !== snapshot.snapshotHash ||
    traceBinding.contentHash !== snapshot.contentHash ||
    traceBinding.sourceRequestHash !== snapshot.sourceRequestHash
  ) {
    throw new Error(`Durable Chat run ${run.runId} has a mismatched admission-bound context snapshot.`);
  }
  if (!host.revalidateChatRoutedContextSnapshot)
    throw new Error("Explicit context access revalidation is unavailable.");
  await host.revalidateChatRoutedContextSnapshot(snapshot);
}

export interface ExplicitContextPreparationInput {
  capabilityProfile?: import("@goatcitadel/contracts").ChatTurnCapabilityProfileRecord;
  featureAdmission?: ChatTurnAgentRunnerInput["featureAdmission"];
  effectiveProviderRoute?: import("./chat-route-resolution.js").ResolvedChatRouteDescriptor;
  input: import("@goatcitadel/contracts").ChatSendMessageRequest;
  sessionId: string;
  workspaceId: string;
  turnId: string;
  content: string;
  effectiveProviderId?: string;
  effectiveModel?: string;
  userMessage: Pick<import("@goatcitadel/contracts").ChatMessageRecord, "messageId">;
  prefs: import("@goatcitadel/contracts").ChatSessionPrefsRecord;
  autonomy: { retrievalMode: ChatTurnAgentRunnerInput["retrievalMode"] };
  effectiveToolAutonomy: ChatTurnAgentRunnerInput["toolAutonomy"];
  history: ChatCompletionRequest["messages"];
  options?: { turnAdmission?: import("./chat-turn-types.js").ActiveTurnAdmission };
}
export interface ExplicitContextPreparationHost {
  llmService: Pick<LlmService, "getModelContextWindow">;
  resolveChatRoutedContextSources: import("./chat-turn-prep-service.js").ChatTurnPrepHost["resolveChatRoutedContextSources"];
  resolveExplicitContextToolDefinitions?: import("./chat-turn-prep-service.js").ChatTurnPrepHost["resolveExplicitContextToolDefinitions"];
  bindChatFeatureAdmission?: import("./chat-turn-prep-service.js").ChatTurnPrepHost["bindChatFeatureAdmission"];
}
export interface ExplicitContextPreparationPort {
  prepare(input: ExplicitContextPreparationInput): ReturnType<typeof prepareRoutedContextAdmission>;
}
/** Compatibility hosts may supply the original narrow callbacks; Gateway supplies its dedicated internal port. */
export function prepareChatRoutedContextAdmission(
  host: ChatTurnPrepHost,
  input: ExplicitContextPreparationInput,
) {
  if (host.explicitContextPreparation) return host.explicitContextPreparation.prepare(input);
  return prepareRoutedContextAdmission(host, input);
}
/** Immutable context composition and binding; persistence and transaction ownership are unchanged. */
export async function prepareRoutedContextAdmission(
  host: ExplicitContextPreparationHost,
  state: ExplicitContextPreparationInput,
) {
  let { featureAdmission, history } = state;
  const {
    capabilityProfile,
    effectiveProviderRoute,
    input,
    sessionId,
    workspaceId,
    turnId,
    content,
    effectiveProviderId,
    effectiveModel,
    userMessage,
    prefs,
    autonomy,
    effectiveToolAutonomy,
    options,
  } = state;
  let routedContextSnapshot: ChatRoutedContextSnapshotRecord;

  if ((!capabilityProfile && !featureAdmission?.references.providerRoute) || !effectiveProviderRoute) {
    throw new ConflictError({ message: "Routed context requires server-owned capability resolution." });
  }
  const frozenProfileJson = capabilityProfile ? canonicalJsonString(capabilityProfile) : undefined;
  const routeContextWindowTokens = requireRoutedContextWindow(
    host,
    effectiveProviderRoute.effectiveProviderId,
    effectiveProviderRoute.effectiveModel,
  );
  const resolvedSources = await host.resolveChatRoutedContextSources({
    refs: input.contextRefs,
    sessionId,
    workspaceId,
    memoryMode: capabilityProfile?.selection.memory.mode ?? prefs.memoryMode,
    // Global memory remains denied until a server-owned profile field
    // explicitly admits it. Client refs can never widen this boundary.
    allowGlobalMemory: false,
    ordinaryAttachmentIds: collectOrdinaryAttachmentIds(input),
  });
  const baseContextTools =
    !capabilityProfile && host.resolveExplicitContextToolDefinitions
      ? await host.resolveExplicitContextToolDefinitions({
          sessionId,
          turnId,
          userMessageId: userMessage.messageId,
          content,
          mode: "chat",
          workspaceId,
          providerId: effectiveProviderId,
          model: effectiveModel,
          webMode: prefs.webMode,
          memoryMode: prefs.memoryMode,
          thinkingLevel: prefs.thinkingLevel,
          speedMode: prefs.speedMode,
          subagentPolicy: "off",
          retrievalMode: autonomy.retrievalMode,
          toolAutonomy: effectiveToolAutonomy,
          historyMessages: history,
          routedContextRequested: true,
          operatorId: input.operatorId,
          authActorId: input.authActorId,
          authActorSource: input.authActorSource,
        })
      : undefined;
  if (
    !capabilityProfile &&
    (!baseContextTools || !host.bindChatFeatureAdmission || !options?.turnAdmission || !featureAdmission)
  ) {
    throw new ConflictError({ message: "Explicit context admission owners are unavailable." });
  }
  // Discovery has selected these server-owned receipts, but the snapshot has
  // not yet been bound. Count their bytes without restoring callable handles.
  const contextTools =
    baseContextTools && effectiveToolAutonomy !== "manual"
      ? projectMcpAdmissionContextBudgetTools(baseContextTools, featureAdmission?.references)
      : baseContextTools;
  routedContextSnapshot = buildChatRoutedContextSnapshot({
    resolved: resolvedSources,
    turnId,
    sessionId,
    workspaceId,
    capabilityProfile,
    ...(!capabilityProfile
      ? {
          admission: {
            binding: {
              admissionId: options!.turnAdmission!.identity.admissionId,
              sessionIncarnationId: options!.turnAdmission!.identity.sessionIncarnationId,
              materialSha256: options!.turnAdmission!.identity.materialSha256,
              aggregateRevision: options!.turnAdmission!.identity.aggregateRevision,
              controllerGeneration: options!.turnAdmission!.identity.controllerGeneration,
            },
            providerId: effectiveProviderId!,
            model: effectiveModel!,
            memoryMode: prefs.memoryMode,
            tools: contextTools!,
          },
        }
      : {}),
    routeContextWindowTokens,
    // Includes the exact final capability-profile instruction and excludes
    // any prior routed block, so budget receipts cover real prompt overhead.
    baseHistoryMessages: history,
  });
  if (capabilityProfile && canonicalJsonString(capabilityProfile) !== frozenProfileJson) {
    throw new ConflictError({ message: "Routed context attempted to mutate the frozen capability profile." });
  }
  if (!capabilityProfile) {
    featureAdmission = await host.bindChatFeatureAdmission!(options!.turnAdmission!, {
      ...featureAdmission!.references,
      explicitContext: {
        snapshotId: routedContextSnapshot.snapshotId,
        snapshotHash: routedContextSnapshot.snapshotHash,
      },
    });
  }
  history = upsertChatRoutedContextSystemInstruction(history, routedContextSnapshot.contextText);

  return { routedContextSnapshot, featureAdmission, history };
}

function requireRoutedContextWindow(
  host: ExplicitContextPreparationHost,
  providerId: string | undefined,
  model: string | undefined,
): number {
  if (!providerId || !model) {
    throw new ConflictError({ message: "Routed context requires a frozen effective provider and model." });
  }
  const contextWindow = host.llmService.getModelContextWindow(providerId, model);
  if (!Number.isSafeInteger(contextWindow) || (contextWindow ?? 0) <= 0) {
    throw new ConflictError({
      message: `The frozen route ${providerId}/${model} lacks trusted context-window metadata.`,
    });
  }
  return contextWindow as number;
}

function collectOrdinaryAttachmentIds(input: import("@goatcitadel/contracts").ChatSendMessageRequest): string[] {
  const ids = new Set((input.attachments ?? []).map((id) => id.trim()).filter(Boolean));
  for (const part of input.parts ?? []) {
    if (part.type !== "text" && part.attachmentId.trim()) {
      ids.add(part.attachmentId.trim());
    }
  }
  return [...ids];
}

export function upsertChatRoutedContextSystemInstruction(
  history: ChatCompletionRequest["messages"],
  contextText: string,
): ChatCompletionRequest["messages"] {
  const withoutPriorBinding = history.filter(
    (message) =>
      !(
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.startsWith(ROUTED_CONTEXT_SYSTEM_PREFIX)
      ),
  );
  if (!contextText) {
    return withoutPriorBinding;
  }
  const insertionIndex = withoutPriorBinding.findIndex((message) => message.role !== "system");
  const next = [...withoutPriorBinding];
  next.splice(insertionIndex < 0 ? next.length : insertionIndex, 0, { role: "system", content: contextText });
  return next;
}

const ROUTED_CONTEXT_SYSTEM_PREFIX = "Routed context snapshot (immutable).";
