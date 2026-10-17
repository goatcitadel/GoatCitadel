import type { ChatSendMessageRequest } from "@goatcitadel/contracts";
import type { DurableChatTurnExecutionPayload } from "../chat-turn-types.js";
import type { PreparedAgentChatTurn } from "../chat-turn-prep-service.js";
import {
  computeEffectiveChatTurnRequestMaterialSha256,
  deriveChatTurnSurfaceDerivation,
  freezeChatTurnExecutionRequest,
} from "../session-control-service.js";

/**
 * Builds the frozen durable Chat turn execution payload from a prepared, admitted turn.
 * Pure: it reads only the prepared turn, the request and the durable run id, and fails
 * closed when the turn lacks its frozen admission or durable run identity.
 */
export function createDurableChatTurnPayload(
  prepared: PreparedAgentChatTurn,
  input: ChatSendMessageRequest,
  threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
  durableRunId: string,
): DurableChatTurnExecutionPayload {
  const admission = prepared.turnAdmission?.identity;
  if (!admission) {
    throw new Error(`Durable Chat turn ${prepared.turnId} has no frozen mutation admission.`);
  }
  if (!prepared.turnAdmission) {
    throw new Error(`Durable Chat turn ${prepared.turnId} has no admitted request snapshot.`);
  }
  const durableRequest = freezeChatTurnExecutionRequest(input);
  const normalizedDurableRunId = durableRunId.trim();
  if (!normalizedDurableRunId) {
    throw new Error(`Durable Chat turn ${prepared.turnId} has no durable run identity for policy derivation.`);
  }
  const surfaceDerivation = deriveChatTurnSurfaceDerivation(prepared.turnAdmission.admittedRequest, durableRequest);
  return {
    version: "chat.turn.execute.v2",
    admissionId: admission.admissionId,
    sessionIncarnationId: admission.sessionIncarnationId,
    admissionMaterialSha256: admission.materialSha256,
    workspaceId: admission.workspaceId,
    admissionAggregateRevision: admission.aggregateRevision,
    admissionControllerGeneration: admission.controllerGeneration,
    effectiveRequestMaterialSha256: computeEffectiveChatTurnRequestMaterialSha256(
      admission.materialSha256,
      durableRequest,
    ),
    ...(!durableRequest.policyRunId
      ? {
          policyRunIdDerivation: {
            version: 1 as const,
            kind: "durable_run_id" as const,
            runId: normalizedDurableRunId,
          },
        }
      : {}),
    ...(surfaceDerivation ? { surfaceDerivation } : {}),
    requestActor: prepared.turnAdmission.requestActor,
    sessionId: prepared.session.sessionId,
    turnId: prepared.turnId,
    userMessageId: prepared.userEventId,
    assistantMessageId: prepared.assistantMessageId,
    capabilityProfileId: prepared.capabilityProfile?.profileId,
    capabilityProfileHash: prepared.capabilityProfile?.hashes.profileHash,
    ...(prepared.featureAdmission ? { featureReferenceSha256: prepared.featureAdmission.referenceSha256 } : {}),
    branchKind: prepared.branchKind,
    parentTurnId: prepared.parentTurnId,
    sourceTurnId: prepared.sourceTurnId,
    threadEventType,
    request: {
      ...durableRequest,
    },
  };
}
