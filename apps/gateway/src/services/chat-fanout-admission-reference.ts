import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  ConflictError,
  type ChatProjectRecord,
  type ChatTurnFeatureReferences,
  type ChatFanoutInvocationRecord,
} from "@goatcitadel/contracts";
import type { ActiveTurnAdmission } from "./chat-turn-types.js";
export const CHAT_DURABLE_FANOUT_WORKFLOW_TEMPLATE = "chat.durable.agent.fanout.v1";

/** Evidence of explicit automatic selection. Every invocation still needs live project/grant authority. */
export function buildFanoutAdmissionReference(
  admission: ActiveTurnAdmission,
  project: ChatProjectRecord,
): NonNullable<ChatTurnFeatureReferences["childWork"]> {
  if (
    admission.requestActor.actorKind !== "operator" ||
    admission.admittedRequest.parentDelegationStepId ||
    admission.systemHeartbeatOccurrence ||
    project.lifecycleStatus !== "active" ||
    (project.workspaceId ?? "default") !== admission.identity.workspaceId
  ) {
    throw new ConflictError({ message: "Automatic fanout requires an operator Chat turn in an active project." });
  }
  return {
    ownerId: admission.identity.admissionId,
    revision: "chat.automatic-fanout.v1",
    sha256: createHash("sha256")
      .update(
        canonicalJsonString({
          admission: admission.identity,
          actor: admission.requestActor,
          projectId: project.projectId,
          projectRevision: project.revision,
          selection: "auto_when_useful",
        }),
      )
      .digest("hex"),
  };
}

export function buildFanoutChildAdmissionReference(
  admission: ActiveTurnAdmission,
  invocation: ChatFanoutInvocationRecord,
  stepId: string,
): NonNullable<ChatTurnFeatureReferences["childWork"]> {
  if (
    !invocation.parentAdmission ||
    admission.admittedRequest.parentDelegationStepId !== stepId ||
    admission.requestActor.actorKind !== "operator"
  )
    throw new ConflictError({ message: "Automatic child requires its canonical parent binding." });
  return {
    ownerId: invocation.invocationId,
    revision: "chat.automatic-fanout-child.v1",
    sha256: createHash("sha256")
      .update(
        canonicalJsonString({ admission: admission.identity, parentAdmission: invocation.parentAdmission, stepId }),
      )
      .digest("hex"),
  };
}
