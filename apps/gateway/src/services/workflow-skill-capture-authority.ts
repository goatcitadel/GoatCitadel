import { createHash } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  canonicalJsonString,
  readDurableChatTurnExecutionPayloadAuthority,
  type ChatMessageRecord,
  type ChatTurnTraceRecord,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";

/** Read the original admitted author, never the display actor or current controller. */
export async function readWorkflowCaptureDurableAuthor(
  storage: Pick<AsyncStorage, "durableRuns" | "sessionMutationAdmissions">,
  workspaceId: string,
  trace: ChatTurnTraceRecord,
  user: ChatMessageRecord,
): Promise<{ actorId: string; bindingSha256: string }> {
  const unavailable = () => new ConflictError({
    message: "The workflow's authenticated author binding is unavailable or changed. Capture a new completed turn.",
  });
  if (!trace.durable?.runId) throw unavailable();
  let run;
  try {
    run = await storage.durableRuns.getRun(trace.durable.runId);
  } catch (error) {
    if (error instanceof NotFoundError) throw unavailable();
    throw error;
  }
  const payload = readDurableChatTurnExecutionPayloadAuthority({
    workflowKey: run.workflowKey, durableRunId: run.runId, payload: run.payload,
  });
  if (
    !payload || run.runId !== trace.durable.runId || run.status !== "completed" ||
    payload.workspaceId !== workspaceId || payload.sessionId !== trace.sessionId ||
    payload.turnId !== trace.turnId || payload.userMessageId !== trace.userMessageId ||
    payload.assistantMessageId !== trace.assistantMessageId ||
    payload.request.content !== user.content ||
    payload.capabilityProfileId !== trace.capabilityProfileId ||
    payload.capabilityProfileHash !== trace.capabilityProfileHash
  ) throw unavailable();
  const actor = payload.requestActor;
  if (
    actor.actorKind !== "operator" || !actor.authActorId?.trim() ||
    !["token", "basic", "loopback", "device"].includes(actor.authActorSource ?? "") ||
    actor.actorId !== actor.authActorId || (actor.operatorId !== undefined && actor.operatorId !== actor.actorId)
  ) throw unavailable();
  const admission = await storage.sessionMutationAdmissions.get(payload.admissionId);
  if (
    !admission || admission.admissionId !== payload.admissionId ||
    admission.admissionKind !== "turn_write" || admission.status !== "completed" ||
    admission.workspaceId !== workspaceId || admission.sessionId !== trace.sessionId ||
    admission.turnId !== trace.turnId || admission.sessionIncarnationId !== payload.sessionIncarnationId ||
    admission.materialSha256 !== payload.admissionMaterialSha256 ||
    admission.aggregateRevision !== payload.admissionAggregateRevision ||
    admission.controllerGeneration !== payload.admissionControllerGeneration ||
    admission.actorKind !== actor.actorKind || admission.actorId !== actor.actorId ||
    admission.terminalDurableRunId !== run.runId || admission.terminalDurableRunStatus !== "completed"
  ) throw unavailable();
  const binding = await storage.sessionMutationAdmissions.findDurableRunBinding({
    admissionId: admission.admissionId, sessionIncarnationId: admission.sessionIncarnationId,
    workspaceId, sessionId: trace.sessionId, turnId: trace.turnId,
  });
  if (!binding || binding.durableRunId !== run.runId) throw unavailable();
  return {
    actorId: actor.authActorId,
    bindingSha256: createHash("sha256").update(canonicalJsonString({
      runId: run.runId, admissionId: payload.admissionId,
      sessionIncarnationId: payload.sessionIncarnationId,
      workspaceId, sessionId: payload.sessionId, turnId: payload.turnId,
      userMessageId: payload.userMessageId, assistantMessageId: payload.assistantMessageId,
      admissionMaterialSha256: payload.admissionMaterialSha256,
      effectiveRequestMaterialSha256: payload.effectiveRequestMaterialSha256,
      requestActor: actor,
    })).digest("hex"),
  };
}
