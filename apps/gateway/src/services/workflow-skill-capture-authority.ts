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

interface WorkflowCaptureAdmissionIdentity {
  runId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
}

export class WorkflowCaptureAdmissionPendingError extends ConflictError {
  public constructor(public readonly identity: WorkflowCaptureAdmissionIdentity) {
    super({ message: "This turn's authenticated author binding is still settling. Try skill capture again shortly." });
  }
}

/** Read the original admitted author, never the display actor or current controller. */
export async function readWorkflowCaptureDurableAuthor(
  storage: Pick<AsyncStorage, "durableRuns" | "sessionMutationAdmissions">,
  workspaceId: string,
  trace: ChatTurnTraceRecord,
  user: ChatMessageRecord,
): Promise<{ actorId: string; bindingSha256: string }> {
  const unavailable = () =>
    new ConflictError({
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
    workflowKey: run.workflowKey,
    durableRunId: run.runId,
    payload: run.payload,
  });
  if (
    !payload ||
    run.runId !== trace.durable.runId ||
    payload.workspaceId !== workspaceId ||
    payload.sessionId !== trace.sessionId ||
    payload.turnId !== trace.turnId ||
    payload.userMessageId !== trace.userMessageId ||
    payload.assistantMessageId !== trace.assistantMessageId ||
    payload.request.content !== user.content ||
    payload.capabilityProfileId !== trace.capabilityProfileId ||
    payload.capabilityProfileHash !== trace.capabilityProfileHash
  )
    throw unavailable();
  const actor = payload.requestActor;
  if (
    actor.actorKind !== "operator" ||
    !actor.authActorId?.trim() ||
    !["token", "basic", "loopback", "device"].includes(actor.authActorSource ?? "") ||
    actor.actorId !== actor.authActorId ||
    (actor.operatorId !== undefined && actor.operatorId !== actor.actorId)
  )
    throw unavailable();
  const admission = await storage.sessionMutationAdmissions.get(payload.admissionId);
  if (
    !admission ||
    admission.admissionId !== payload.admissionId ||
    admission.admissionKind !== "turn_write" ||
    admission.workspaceId !== workspaceId ||
    admission.sessionId !== trace.sessionId ||
    admission.turnId !== trace.turnId ||
    admission.sessionIncarnationId !== payload.sessionIncarnationId ||
    admission.materialSha256 !== payload.admissionMaterialSha256 ||
    admission.aggregateRevision !== payload.admissionAggregateRevision ||
    admission.controllerGeneration !== payload.admissionControllerGeneration ||
    admission.actorKind !== actor.actorKind ||
    admission.actorId !== actor.actorId
  )
    throw unavailable();
  const binding = await storage.sessionMutationAdmissions.findDurableRunBinding({
    admissionId: admission.admissionId,
    sessionIncarnationId: admission.sessionIncarnationId,
    workspaceId,
    sessionId: trace.sessionId,
    turnId: trace.turnId,
  });
  if (!binding || binding.durableRunId !== run.runId) throw unavailable();
  const admissionCompleted =
    admission.status === "completed" &&
    admission.terminalDurableRunId === run.runId &&
    admission.terminalDurableRunStatus === "completed";
  if (run.status !== "completed" || !admissionCompleted) {
    // The answer can be committed before its exact durable run and admission finish. Independent reads can also straddle that transition.
    if (
      (run.status === "running" || run.status === "completed") &&
      (admission.status === "active" || admissionCompleted)
    ) {
      throw new WorkflowCaptureAdmissionPendingError({
        runId: run.runId,
        workspaceId,
        sessionId: trace.sessionId,
        turnId: trace.turnId,
      });
    }
    throw unavailable();
  }
  return {
    actorId: actor.authActorId,
    bindingSha256: createHash("sha256")
      .update(
        canonicalJsonString({
          runId: run.runId,
          admissionId: payload.admissionId,
          sessionIncarnationId: payload.sessionIncarnationId,
          workspaceId,
          sessionId: payload.sessionId,
          turnId: payload.turnId,
          userMessageId: payload.userMessageId,
          assistantMessageId: payload.assistantMessageId,
          admissionMaterialSha256: payload.admissionMaterialSha256,
          effectiveRequestMaterialSha256: payload.effectiveRequestMaterialSha256,
          requestActor: actor,
        }),
      )
      .digest("hex"),
  };
}
