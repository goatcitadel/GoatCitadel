import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  ConflictError,
  isDurableRunTerminal,
  readDurableChatTurnExecutionPayloadAuthority,
  type ChatTurnFeatureReferences,
} from "@goatcitadel/contracts";
import type { AsyncStorage, HeartbeatOccurrenceRecord } from "@goatcitadel/storage";
import type { ActiveTurnAdmission } from "./chat-turn-types.js";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import { buildHeartbeatOccurrencePlan } from "./heartbeat-occurrence-service.js";
import {
  computeFrozenChatTurnAdmissionMaterialSha256,
  freezeChatTurnExecutionRequest,
} from "./session-control-service.js";

export type HeartbeatOccurrenceReference = NonNullable<ChatTurnFeatureReferences["heartbeatOccurrence"]>;
export interface HeartbeatChatAuthorityHost {
  storage: Pick<AsyncStorage, "heartbeatOccurrences" | "sessionMutationAdmissions" | "durableRuns">;
  isFeatureEnabled(flag: string): Promise<boolean>;
}

export function buildHeartbeatOccurrenceReference(occurrence: HeartbeatOccurrenceRecord): HeartbeatOccurrenceReference {
  return {
    ownerId: occurrence.occurrenceId,
    revision: String(occurrence.aggregateRevision),
    sha256: occurrence.claimSha256,
  };
}

/** The content-free reference only names existing, storage-claimed authority. */
export async function assertHeartbeatOccurrenceCurrent(
  host: HeartbeatChatAuthorityHost,
  input: {
    reference: HeartbeatOccurrenceReference;
    admission: Pick<
      ActiveTurnAdmission,
      "identity" | "requestActor" | "admittedRequest" | "durableClaim" | "systemHeartbeatOccurrence"
    >;
  },
): Promise<HeartbeatOccurrenceRecord> {
  if (
    !(await host.isFeatureEnabled("proactiveHeartbeatTurnsV1Enabled")) ||
    (await host.isFeatureEnabled("autonomyV1Disabled"))
  )
    fail("Heartbeat Chat execution is disabled.");
  const occurrence = await host.storage.heartbeatOccurrences.find(input.reference.ownerId);
  if (
    !occurrence ||
    !["admitted", "durable_bound"].includes(occurrence.state) ||
    canonicalJsonString(buildHeartbeatOccurrenceReference(occurrence)) !== canonicalJsonString(input.reference)
  )
    fail("Heartbeat occurrence reference is no longer current.");
  const { admission } = input;
  const posture = admission.systemHeartbeatOccurrence;
  const plan = buildHeartbeatOccurrencePlan({
    workspaceId: occurrence.workspaceId,
    sessionId: occurrence.sessionId,
    expectedPriorCadence: occurrence.priorCadence,
    idleFloorSeconds: occurrence.idleFloorSeconds,
  });
  if (
    !posture ||
    posture.kind !== "system_heartbeat_occurrence" ||
    posture.operation !== "chat_system_heartbeat" ||
    posture.occurrenceId !== occurrence.occurrenceId ||
    posture.claimSha256 !== occurrence.claimSha256 ||
    posture.durableRunId !== occurrence.durableRunId ||
    posture.correlationId !== occurrence.admissionCorrelationId ||
    admission.requestActor.actorKind !== "system" ||
    admission.requestActor.actorId !== "system-heartbeat" ||
    admission.identity.admissionId !== occurrence.admissionId ||
    admission.identity.workspaceId !== occurrence.workspaceId ||
    admission.identity.sessionId !== occurrence.sessionId ||
    admission.identity.sessionIncarnationId !== occurrence.sessionIncarnationId ||
    admission.identity.turnId !== occurrence.turnId ||
    admission.identity.aggregateRevision !== occurrence.aggregateRevision ||
    admission.identity.controllerGeneration !== occurrence.controllerGeneration ||
    admission.identity.materialSha256 !== occurrence.frozenRequestSha256 ||
    (admission.durableClaim && admission.durableClaim.durableRunId !== occurrence.durableRunId) ||
    occurrence.systemActorId !== "system-heartbeat" ||
    occurrence.admissionMaterialSha256 !== plan.frozenRequestSha256 ||
    occurrence.frozenRequestSha256 !== plan.frozenRequestSha256 ||
    occurrence.frozenObjectiveSha256 !== plan.frozenObjectiveSha256 ||
    occurrence.evaluatedPolicySha256 !== plan.evaluatedPolicySha256 ||
    computeFrozenChatTurnAdmissionMaterialSha256(freezeChatTurnExecutionRequest(admission.admittedRequest)) !==
      plan.frozenRequestSha256
  )
    fail("Heartbeat admission no longer matches its exact occurrence, actor and frozen policy.");
  return occurrence;
}

/** Revalidate under the canonical fence immediately before provider or tool dispatch. */
export async function assertHeartbeatChatDispatchCurrent(
  host: HeartbeatChatAuthorityHost,
  input: Pick<
    ChatTurnAgentRunnerInput,
    "featureAdmission" | "policyRunId" | "canonicalWriteFence" | "sessionId" | "turnId" | "workspaceId"
  >,
): Promise<void> {
  const expected = input.featureAdmission;
  if (!expected?.references.heartbeatOccurrence) return;
  const runId = input.policyRunId;
  if (!runId || !input.canonicalWriteFence) fail("Heartbeat dispatch requires its durable write fence.");
  await input.canonicalWriteFence(async () => {
    const run = await host.storage.durableRuns.getRun(runId);
    const payload = readDurableChatTurnExecutionPayloadAuthority({
      workflowKey: run.workflowKey,
      durableRunId: runId,
      payload: run.payload,
    });
    if (
      !payload ||
      isDurableRunTerminal(run.status) ||
      payload.sessionId !== input.sessionId ||
      payload.turnId !== input.turnId ||
      payload.workspaceId !== input.workspaceId ||
      payload.featureReferenceSha256 !== expected.referenceSha256
    )
      fail("Heartbeat durable payload no longer owns this dispatch.");
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
    const [binding, admitted, features] = await Promise.all([
      host.storage.sessionMutationAdmissions.findDurableRunBinding(identity),
      host.storage.sessionMutationAdmissions.get(identity.admissionId),
      host.storage.sessionMutationAdmissions.findFeatureReferences(identity),
    ]);
    if (
      binding?.durableRunId !== runId ||
      !admitted ||
      admitted.status !== "active" ||
      admitted.operation !== "chat_system_heartbeat" ||
      admitted.actorKind !== "system" ||
      admitted.actorId !== "system-heartbeat" ||
      !features ||
      features.referenceSha256 !== expected.referenceSha256 ||
      canonicalJsonString(features.references) !== canonicalJsonString(expected.references) ||
      createHash("sha256").update(canonicalJsonString(features.references)).digest("hex") !== expected.referenceSha256
    )
      fail("Heartbeat dispatch feature binding is stale.");
    const occurrence = await host.storage.heartbeatOccurrences.find(expected.references.heartbeatOccurrence!.ownerId);
    if (!occurrence) fail("Heartbeat dispatch occurrence is missing.");
    await assertHeartbeatOccurrenceCurrent(host, {
      reference: expected.references.heartbeatOccurrence!,
      admission: {
        identity,
        admittedRequest: payload.request as ActiveTurnAdmission["admittedRequest"],
        requestActor: payload.requestActor as ActiveTurnAdmission["requestActor"],
        systemHeartbeatOccurrence: {
          kind: "system_heartbeat_occurrence",
          operation: "chat_system_heartbeat",
          occurrenceId: occurrence.occurrenceId,
          claimSha256: occurrence.claimSha256,
          durableRunId: occurrence.durableRunId,
          correlationId: admitted.correlationId,
        },
      },
    });
    if (
      occurrence.state !== "durable_bound" ||
      occurrence.boundDurableRunId !== runId ||
      occurrence.durableRunId !== runId ||
      occurrence.featureReferenceSha256 !== expected.referenceSha256 ||
      payload.heartbeatOccurrenceId !== occurrence.occurrenceId ||
      payload.heartbeatClaimSha256 !== occurrence.claimSha256 ||
      payload.heartbeatEvaluatedPolicySha256 !== occurrence.evaluatedPolicySha256 ||
      payload.heartbeatFrozenObjectiveSha256 !== occurrence.frozenObjectiveSha256
    )
      fail("Heartbeat dispatch has conflicting canonical occurrence authority.");
  });
}

function fail(message: string): never {
  throw new ConflictError({ message });
}
