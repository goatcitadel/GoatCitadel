import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  readChatTurnFeatureReferences,
  readDurableChatTurnExecutionPayloadAuthority,
  type ChatCompletionRequest,
  type ChatProviderFallbackPreference,
} from "@goatcitadel/contracts";
import { estimateTokensFromText } from "@goatcitadel/memory-core";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { LlmService } from "./llm-service.js";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import { LlmDispatchGuardRejectedError } from "./llm-dispatch-guard.js";
import {
  isLocalChatProviderUrl,
  issueChatProviderFallbackAuthorization,
  type ChatProviderFallbackAuthorization,
} from "./chat-provider-fallback-authority.js";

type Route = { providerId: string; model: string };
type RouteLlm = Pick<LlmService, "getProviderRouteConfigFingerprint">;
export interface ChatProviderFallbackAdmissionHost {
  storage: Pick<AsyncStorage, "durableRuns" | "sessionMutationAdmissions" | "chatSessionPrefs" | "chatToolRuns">;
  llmService: RouteLlm &
    Pick<
      LlmService,
      "getRuntimeConfig" | "getModelContextWindow" | "getCachedModelAvailability" | "resolveExecutionApiStyle"
    >;
  isFeatureEnabled(feature: "chatProviderFallbackV1Enabled"): boolean | Promise<boolean>;
}

/** Exact route configuration, context capacity and operator boundary consent. */
export function fingerprintChatProviderFallbackRoute(
  llm: RouteLlm,
  primary: Route,
  fallback?: ChatProviderFallbackPreference,
): string | undefined {
  const primaryConfig = llm.getProviderRouteConfigFingerprint(primary.providerId, primary.model);
  const fallbackConfig = fallback && llm.getProviderRouteConfigFingerprint(fallback.providerId, fallback.model);
  if (!primaryConfig || (fallback && !fallbackConfig)) return undefined;
  return createHash("sha256")
    .update(
      canonicalJsonString({
        version: "chat.provider-route.v1",
        primary,
        primaryConfig,
        fallback: fallback ?? null,
        fallbackConfig: fallbackConfig ?? null,
      }),
    )
    .digest("hex");
}

/** Reissues an opaque handle only from the persisted admission, never caller
 * feature fields alone. Every read is fenced by the current durable claim. */
export async function authorizeAdmittedChatProviderFallback(
  host: ChatProviderFallbackAdmissionHost,
  input: ChatTurnAgentRunnerInput,
  request: ChatCompletionRequest,
): Promise<ChatProviderFallbackAuthorization | undefined> {
  if (
    !input.featureAdmission?.references.providerRoute?.fallback ||
    !(input.canonicalDurableRunId ?? input.policyRunId) ||
    !input.canonicalWriteFence ||
    input.capabilityProfile ||
    input.parentDelegationStepId ||
    request.requiredRuntimeTarget ||
    !(await host.isFeatureEnabled("chatProviderFallbackV1Enabled"))
  )
    return undefined;
  const runId = (input.canonicalDurableRunId ?? input.policyRunId)!;
  const fence = input.canonicalWriteFence;
  const expected = input.featureAdmission;
  const expectedRoute = expected.references.providerRoute!;
  if (typeof request.timeoutMs !== "number" || !Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
    reject("Chat fallback requires the original bounded completion deadline.");
  }
  const deadlineAt = Date.now() + request.timeoutMs;
  const admittedOutputCap = request.max_tokens;
  if (typeof admittedOutputCap !== "number" || !Number.isSafeInteger(admittedOutputCap) || admittedOutputCap < 1) {
    reject("Chat fallback requires the original bounded output budget.");
  }
  const assertCurrent = async (effective: ChatCompletionRequest, checkFallbackCapacity = true): Promise<void> => {
    await fence(async () => {
      if (input.signal?.aborted || effective.signal?.aborted) reject("Chat fallback was cancelled.");
      if (Date.now() >= deadlineAt) reject("Chat fallback exhausted the original completion deadline.");
      if (!(await host.isFeatureEnabled("chatProviderFallbackV1Enabled"))) reject("Chat fallback was disabled.");
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
        authority.sessionId !== input.sessionId ||
        authority.turnId !== input.turnId ||
        authority.workspaceId !== input.workspaceId ||
        authority.requestActor.actorKind !== "operator" ||
        authority.requestActor.operatorId !== input.operatorId ||
        authority.requestActor.authActorId !== input.authActorId ||
        authority.requestActor.authActorSource !== input.authActorSource ||
        authority.request.parentDelegationStepId ||
        authority.featureReferenceSha256 !== expected.referenceSha256
      )
        reject("Chat fallback has no matching durable admission.");
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
      const binding = await host.storage.sessionMutationAdmissions.findDurableRunBinding(identity);
      const admission = await host.storage.sessionMutationAdmissions.get(identity.admissionId);
      const features = await host.storage.sessionMutationAdmissions.findFeatureReferences(identity);
      if (
        binding?.durableRunId !== runId ||
        !admission ||
        admission.status === "cancelled" ||
        admission.operation !== "chat_turn" ||
        admission.actorKind !== authority.requestActor.actorKind ||
        admission.actorId !== authority.requestActor.actorId ||
        !features ||
        features.referenceSha256 !== expected.referenceSha256
      ) {
        reject("Chat fallback admission binding is stale.");
      }
      const references = readChatTurnFeatureReferences(features.references);
      if (
        canonicalJsonString(references) !== canonicalJsonString(expected.references) ||
        createHash("sha256").update(canonicalJsonString(references)).digest("hex") !== expected.referenceSha256
      ) {
        reject("Chat fallback feature evidence changed.");
      }
      const prefs = await host.storage.chatSessionPrefs.get(input.sessionId);
      if (
        !prefs?.providerFallback ||
        canonicalJsonString(prefs.providerFallback) !== canonicalJsonString(expectedRoute.fallback)
      ) {
        reject("Chat fallback preference changed after admission.");
      }
      if ((await host.storage.chatToolRuns.listByTurn(input.turnId)).length !== 0) {
        reject("Initial Chat fallback cannot run after tool execution.");
      }
      if (
        expectedRoute.primary.providerId !== input.providerId ||
        expectedRoute.primary.model !== input.model ||
        fingerprintChatProviderFallbackRoute(host.llmService, expectedRoute.primary, expectedRoute.fallback) !==
          expectedRoute.fingerprint
      ) {
        reject("Chat fallback provider configuration changed.");
      }
      const target = expectedRoute.fallback!;
      const runtime = host.llmService.getRuntimeConfig({ useCache: false });
      const primary = runtime.providers.find((p) => p.providerId === expectedRoute.primary.providerId);
      const fallback = runtime.providers.find((p) => p.providerId === target.providerId);
      if (
        !primary ||
        !fallback ||
        (!fallback.hasApiKey && !isLocalChatProviderUrl(fallback.baseUrl)) ||
        (isLocalChatProviderUrl(primary.baseUrl) &&
          !isLocalChatProviderUrl(fallback.baseUrl) &&
          !target.allowLocalToCloud)
      ) {
        reject("Chat fallback provider or data-boundary consent is unavailable.");
      }
      // Backup capacity must not prevent a healthy primary from answering. It
      // becomes mandatory immediately before the backup's first dispatch.
      if (!checkFallbackCapacity) return;
      const availability = host.llmService.getCachedModelAvailability(target.providerId, target.model);
      if (availability === "unavailable" || availability === "stale_unavailable")
        reject("The selected fallback model is unavailable.");
      const window = host.llmService.getModelContextWindow(target.providerId, target.model);
      const promptTokens = estimateTokensFromText(
        canonicalJsonString({ messages: effective.messages, tools: effective.tools ?? [] }),
      );
      const outputTokens = effective.max_tokens ?? admittedOutputCap;
      if (
        !window ||
        typeof outputTokens !== "number" ||
        !Number.isSafeInteger(outputTokens) ||
        outputTokens < 1 ||
        (admittedOutputCap !== undefined && outputTokens > admittedOutputCap) ||
        promptTokens + outputTokens + 512 > window
      ) {
        reject("The admitted request does not fit the fallback model context budget.");
      }
    });
  };
  await assertCurrent(request, false);
  let effectiveRequest = request;
  return issueChatProviderFallbackAuthorization({
    sessionId: input.sessionId,
    turnId: input.turnId,
    runId,
    primary: expectedRoute.primary,
    fallback: expectedRoute.fallback!,
    allowLocalToCloud: expectedRoute.fallback!.allowLocalToCloud,
    revalidateBeforeFallback: async (effective) => {
      await assertCurrent(effective);
      effectiveRequest = effective;
    },
    dispatchGuard: async (dispatch) => {
      await assertCurrent(effectiveRequest);
      if (
        dispatch.attribution.sessionId !== input.sessionId ||
        dispatch.attribution.turnId !== input.turnId ||
        dispatch.attribution.durableRunId !== runId ||
        dispatch.route.apiStyle !==
          host.llmService.resolveExecutionApiStyle(expectedRoute.fallback!.providerId, expectedRoute.fallback!.model)
      ) {
        reject("Chat fallback network dispatch does not match its admission.");
      }
      if (
        typeof dispatch.effectiveOutputTokenCap !== "number" ||
        !Number.isSafeInteger(dispatch.effectiveOutputTokenCap) ||
        dispatch.effectiveOutputTokenCap < 1 ||
        admittedOutputCap === undefined ||
        dispatch.effectiveOutputTokenCap > admittedOutputCap
      ) {
        reject("Chat fallback network dispatch exceeds its admitted output budget.");
      }
    },
  });
}

function reject(message: string): never {
  throw new LlmDispatchGuardRejectedError(new Error(message));
}
