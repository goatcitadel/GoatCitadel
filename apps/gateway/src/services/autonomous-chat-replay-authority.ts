import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  isDurableRunTerminal,
} from "@goatcitadel/contracts";
import type {
  ChatTurnTraceRecord,
  ChatSendMessageRequest,
  CronAgentTurnConfig,
  DurableRunRecord,
} from "@goatcitadel/contracts";
import {
  verifyChatTurnCapabilityCatalogBinding,
  verifyChatTurnCapabilityProfile,
} from "@goatcitadel/storage";
import type { AgentTurnCronRunOutcome } from "./gateway/cron-agent-turn-support.js";
import { type AutonomousTurnKind } from "./gateway/autonomous-turn-policy.js";
import {
  CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY,
  buildAutonomousChatAdmissionMetadataMaterial,
  hashChatTurnRuntimeAuthorityValue,
  readAutonomousChatAdmissionMetadataSeal,
  readChatTurnRuntimeAuthoritySeal,
  readExactAutonomousChatPostCommitPendingMarker,
  readExactAutonomousChatPostCommitSettlement,
  readExactChatTurnAdmissionHandoff,
  readExactGeneralChatPostCommitPendingMarker,
  readExactGeneralChatPostCommitSettlement,
  readExactLinkedFinalizationPendingMarker,
  readExactLinkedFinalizationSettlement,
  sealAutonomousChatAdmissionMetadata,
  verifyAutonomousChatAdmissionRunMetadata,
  verifyCheckpointAnchoredChatTurnRuntimeAuthority,
  type AutonomousChatChildIdentity,
  type ChatTurnRuntimeAuthoritySealV1,
} from "./chat-durable-runtime-authority.js";
import { DURABLE_RETRY_POLICY_DEFAULT, assertDurableRetryPolicyMatchesRun } from "./durable-retry-policy.js";
import { buildScheduledOccurrenceReference } from "./scheduled-chat-authority.js";
export { buildCronChatAdmissionIdentity } from "./scheduled-chat-authority.js";
import { buildHeartbeatOccurrenceReference } from "./heartbeat-chat-authority.js";
import {
  computeEffectiveChatTurnRequestMaterialSha256,
  computeFrozenChatTurnAdmissionMaterialSha256,
  freezeChatTurnExecutionRequest,
} from "./session-control-service.js";

import type { ChatAutonomousTurnDeps, CronChatAdmissionIdentity } from "./chat-autonomous-turn-service.js";
/** Exact durable replay validation preserves canonical admission, occurrence, profile and finalizer receipts. */
const AUTONOMOUS_CHAT_ADMISSION_METADATA_KEY = "autonomousAdmission" as const;
const AUTONOMOUS_CHAT_RUNTIME_MUTABLE_METADATA_KEYS = new Set([
  "retryPolicy",
  CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY,
  "waitForEvent",
  "outputText",
  "finalOutput",
  "outputSummary",
  "finalSummary",
  "outputMessageId",
  "outputTraceStatus",
  "linkedFinalizationPending",
  "linkedFinalization",
  "autonomousChatPostCommitPending",
  "autonomousChatPostCommit",
  "generalChatPostCommitPending",
  "generalChatPostCommit",
  "chatTurnAdmissionHandoff",
  "chatRetryExhaustionDeadLetterPending",
  "autonomyKillSwitch",
  "approvalMaterializedPostCommit",
]);
const AUTONOMOUS_CHAT_TERMINAL_OUTPUT_METADATA_KEYS = [
  "outputText",
  "finalOutput",
  "outputSummary",
  "finalSummary",
  "outputMessageId",
  "outputTraceStatus",
] as const;
const AUTONOMOUS_CHAT_TERMINAL_OUTPUT_CHECKPOINT_KEYS = ["assistantMessageId", "outputText", "outputSummary"] as const;

export function toCanonicalAutonomousChatChildIdentity(
  identity: AutonomousChatChildIdentity,
): AutonomousChatChildIdentity {
  return {
    userMessageId: identity.userMessageId,
    turnId: identity.turnId,
    assistantMessageId: identity.assistantMessageId,
    durableRunId: identity.durableRunId,
  };
}

export function assertOwnedCronChatDurableRun(
  run: DurableRunRecord,
  identity: CronChatAdmissionIdentity,
  expectedPayload: Record<string, unknown>,
): void {
  const metadata = run.metadata;
  if (
    run.runId !== identity.durableRunId ||
    run.workflowKey !== "chat.turn.execute" ||
    canonicalJsonString(run.payload) !== canonicalJsonString(expectedPayload) ||
    metadata?.cronRunId !== identity.cronRunId ||
    metadata?.cronJobId !== identity.jobId ||
    metadata?.cronExecutionGeneration !== identity.executionGeneration ||
    !cronChatAdmissionIdentityMatches(metadata?.cronAdmission, identity)
  ) {
    throw new Error(`Deterministic cron Chat child ${identity.durableRunId} is owned by a conflicting admission.`);
  }
}

function omitAutonomousChatRuntimeMutableMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !AUTONOMOUS_CHAT_RUNTIME_MUTABLE_METADATA_KEYS.has(key)),
  );
}

export async function assertOwnedAutonomousDurableReplay(
  deps: Pick<ChatAutonomousTurnDeps, "storage" | "getDurableRun">,
  input: {
    identity: AutonomousChatChildIdentity;
    trace: ChatTurnTraceRecord;
    request: ChatSendMessageRequest;
    sessionId: string;
    systemActorId: string;
    kind: AutonomousTurnKind;
    sourceRunId: string;
    prompt: string;
    reason: string;
    deliverMode: NonNullable<CronAgentTurnConfig["deliverMode"]>;
    deliveryChannel?: CronAgentTurnConfig["deliveryChannel"];
    profilePosture?: AgentTurnCronRunOutcome["profilePosture"];
    commitmentId?: string;
    admissionIdentity?: CronChatAdmissionIdentity;
  },
): Promise<{ terminal: boolean; requestProcessing: boolean; runStatus: DurableRunRecord["status"] }> {
  let run: DurableRunRecord;
  try {
    run = await deps.getDurableRun(input.identity.durableRunId);
  } catch (error) {
    throw new Error(
      `Deterministic autonomous Chat replay ${input.identity.durableRunId} has no durable owner: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  const payload = run.payload as Record<string, unknown>;
  const frozenRequest = freezeChatTurnExecutionRequest(input.request);
  const expectedAdmissionMaterialSha256 = computeFrozenChatTurnAdmissionMaterialSha256(frozenRequest);
  const expectedEffectiveMaterialSha256 = computeEffectiveChatTurnRequestMaterialSha256(
    expectedAdmissionMaterialSha256,
    frozenRequest,
  );
  const requestActor =
    payload.requestActor && typeof payload.requestActor === "object" && !Array.isArray(payload.requestActor)
      ? (payload.requestActor as Record<string, unknown>)
      : undefined;
  const admissionId = typeof payload.admissionId === "string" ? payload.admissionId : "";
  const admission = admissionId ? await deps.storage.sessionMutationAdmissions.require(admissionId) : undefined;
  const expectedAutonomousMetadata = {
    kind: input.kind,
    systemActorId: input.systemActorId,
    sourceRunId: input.sourceRunId,
    reason: input.reason,
    deliverMode: input.deliverMode,
    ...(input.deliveryChannel ? { deliveryChannel: input.deliveryChannel } : {}),
    ...(input.profilePosture ? { profilePosture: input.profilePosture } : {}),
    ...(input.commitmentId ? { commitmentId: input.commitmentId } : {}),
  };
  const expectedAutonomousAdmissionMaterial = buildAutonomousChatAdmissionMetadataMaterial({
    identity: toCanonicalAutonomousChatChildIdentity(input.identity),
    sessionId: input.sessionId,
    objective: frozenRequest.content,
    autonomous: expectedAutonomousMetadata,
    payload,
    capabilitySnapshotId: input.trace.capabilitySnapshotId,
    ...(input.admissionIdentity ? { cronAdmission: input.admissionIdentity } : {}),
  });
  const expectedImmutableMetadata = {
    surface: "chat",
    objective: frozenRequest.content,
    autonomous: expectedAutonomousMetadata,
    ...(typeof payload.capabilityProfileId === "string" && typeof payload.capabilityProfileHash === "string"
      ? {
          capabilityProfileId: payload.capabilityProfileId,
          capabilityProfileHash: payload.capabilityProfileHash,
        }
      : {}),
    [AUTONOMOUS_CHAT_ADMISSION_METADATA_KEY]: sealAutonomousChatAdmissionMetadata(expectedAutonomousAdmissionMaterial),
    ...(input.admissionIdentity
      ? {
          cronRunId: input.admissionIdentity.cronRunId,
          cronJobId: input.admissionIdentity.jobId,
          cronExecutionGeneration: input.admissionIdentity.executionGeneration,
          cronAdmission: input.admissionIdentity,
        }
      : {}),
  };
  const durableMetadata = run.metadata ?? {};
  const immutableDurableMetadata = omitAutonomousChatRuntimeMutableMetadata(durableMetadata);
  const conflicts = [
    run.runId !== input.identity.durableRunId ? "run" : undefined,
    run.workflowKey !== "chat.turn.execute" ? "workflow" : undefined,
    payload.version !== "chat.turn.execute.v2" ? "version" : undefined,
    payload.sessionId !== input.sessionId ? "session" : undefined,
    payload.turnId !== input.identity.turnId ? "turn" : undefined,
    payload.userMessageId !== input.identity.userMessageId ? "user_message" : undefined,
    payload.assistantMessageId !== input.identity.assistantMessageId ? "assistant_message" : undefined,
    canonicalJsonString(payload.request) !== canonicalJsonString(frozenRequest) ? "request" : undefined,
    payload.admissionMaterialSha256 !== expectedAdmissionMaterialSha256 ? "current_admission_material" : undefined,
    payload.effectiveRequestMaterialSha256 !== expectedEffectiveMaterialSha256 ? "effective_material" : undefined,
    canonicalJsonString(payload.policyRunIdDerivation) !==
    canonicalJsonString({ version: 1, kind: "durable_run_id", runId: run.runId })
      ? "policy_run_derivation"
      : undefined,
    canonicalJsonString(requestActor) !== canonicalJsonString({ actorKind: "system", actorId: input.systemActorId })
      ? "actor"
      : undefined,
    !admission ? "admission" : undefined,
    admission && admission.admissionKind !== "turn_write" ? "admission_kind" : undefined,
    admission && admission.actorKind !== "system" ? "admission_actor_kind" : undefined,
    admission && admission.actorId !== input.systemActorId ? "admission_actor" : undefined,
    admission && admission.sessionId !== input.sessionId ? "admission_session" : undefined,
    admission && admission.turnId !== input.identity.turnId ? "admission_turn" : undefined,
    admission && admission.sessionIncarnationId !== payload.sessionIncarnationId ? "incarnation" : undefined,
    admission && admission.workspaceId !== payload.workspaceId ? "workspace" : undefined,
    admission && admission.materialSha256 !== payload.admissionMaterialSha256 ? "material" : undefined,
    admission && admission.aggregateRevision !== payload.admissionAggregateRevision ? "aggregate_revision" : undefined,
    admission && admission.controllerGeneration !== payload.admissionControllerGeneration
      ? "controller_generation"
      : undefined,
    canonicalJsonString(immutableDurableMetadata) !== canonicalJsonString(expectedImmutableMetadata)
      ? "metadata"
      : undefined,
    input.admissionIdentity
      ? canonicalJsonString(payload.cronAdmission) !== canonicalJsonString(input.admissionIdentity)
        ? "cron_admission"
        : undefined
      : payload.cronAdmission !== undefined
        ? "unexpected_cron_admission"
        : undefined,
  ].filter((value): value is string => Boolean(value));
  if (conflicts.length > 0) {
    throw new Error(
      `Deterministic autonomous Chat replay ${run.runId} has conflicting v2 admission lineage (${conflicts.join(", ")}).`,
    );
  }
  if (!admission) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} has no mutation admission.`);
  }
  const expectedAdmissionSeal = sealAutonomousChatAdmissionMetadata(expectedAutonomousAdmissionMaterial);
  const actualAdmissionSeal = readAutonomousChatAdmissionMetadataSeal(
    durableMetadata[AUTONOMOUS_CHAT_ADMISSION_METADATA_KEY],
  );
  if (canonicalJsonString(actualAdmissionSeal) !== canonicalJsonString(expectedAdmissionSeal)) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} has a conflicting admission seal.`);
  }
  verifyAutonomousChatAdmissionRunMetadata(run, { admission, trace: input.trace });
  const capabilityProfileId = typeof payload.capabilityProfileId === "string" ? payload.capabilityProfileId : undefined;
  const capabilityProfileHash =
    typeof payload.capabilityProfileHash === "string" ? payload.capabilityProfileHash : undefined;
  const capabilityStoresPresent = Boolean(
    deps.storage.capabilityCatalogSnapshots && deps.storage.chatTurnCapabilityProfiles,
  );
  if (Boolean(deps.storage.capabilityCatalogSnapshots) !== Boolean(deps.storage.chatTurnCapabilityProfiles)) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} has incomplete capability stores.`);
  }
  if (Boolean(capabilityProfileId) !== Boolean(capabilityProfileHash)) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} has incomplete capability lineage.`);
  }
  const featureReferenceSha256 =
    typeof payload.featureReferenceSha256 === "string" ? payload.featureReferenceSha256 : undefined;
  let hasAutonomousFeatureBinding = false;
  if (featureReferenceSha256) {
    const features = await deps.storage.sessionMutationAdmissions.findFeatureReferences({
      admissionId: admission.admissionId,
      sessionIncarnationId: admission.sessionIncarnationId,
      workspaceId: admission.workspaceId,
      sessionId: admission.sessionId,
      turnId: input.identity.turnId,
    });
    if (
      !features ||
      features.referenceSha256 !== featureReferenceSha256 ||
      createHash("sha256").update(canonicalJsonString(features.references)).digest("hex") !== featureReferenceSha256
    ) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} has conflicting feature lineage.`);
    }
    if (input.admissionIdentity) {
      hasAutonomousFeatureBinding =
        canonicalJsonString(features.references.scheduledOccurrence) ===
        canonicalJsonString(buildScheduledOccurrenceReference(input.admissionIdentity));
    } else if (input.kind === "heartbeat" && features.references.heartbeatOccurrence) {
      const occurrence = await deps.storage.heartbeatOccurrences.find(features.references.heartbeatOccurrence.ownerId);
      hasAutonomousFeatureBinding = Boolean(
        occurrence &&
        occurrence.durableRunId === run.runId &&
        occurrence.admissionId === admission.admissionId &&
        occurrence.featureReferenceSha256 === featureReferenceSha256 &&
        canonicalJsonString(features.references.heartbeatOccurrence) ===
          canonicalJsonString(buildHeartbeatOccurrenceReference(occurrence)),
      );
    }
    if (!hasAutonomousFeatureBinding)
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} has no exact occurrence lineage.`);
  }
  if (capabilityStoresPresent && !hasAutonomousFeatureBinding && (!capabilityProfileId || !capabilityProfileHash)) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} is missing its v2 capability lineage.`);
  }
  if (capabilityProfileId && capabilityProfileHash) {
    const profile = await deps.storage.chatTurnCapabilityProfiles.findByTurn(input.identity.turnId);
    const snapshot = profile
      ? await deps.storage.capabilityCatalogSnapshots.find(profile.catalog.snapshotId)
      : undefined;
    const frozenRequestRecord = frozenRequest as typeof frozenRequest & { policyContext?: unknown };
    const frozenPolicyContext =
      frozenRequestRecord.policyContext &&
      typeof frozenRequestRecord.policyContext === "object" &&
      !Array.isArray(frozenRequestRecord.policyContext)
        ? (frozenRequestRecord.policyContext as Record<string, unknown>)
        : undefined;
    const frozenPermissionProfileId =
      typeof frozenPolicyContext?.permissionProfileId === "string"
        ? frozenPolicyContext.permissionProfileId
        : typeof frozenRequest.permissionProfileId === "string"
          ? frozenRequest.permissionProfileId
          : undefined;
    if (
      !profile ||
      profile.profileId !== capabilityProfileId ||
      profile.hashes.profileHash !== capabilityProfileHash ||
      profile.identity.durableRunId !== run.runId ||
      profile.identity.sessionId !== input.sessionId ||
      profile.identity.workspaceId !== payload.workspaceId ||
      profile.identity.turnId !== input.identity.turnId ||
      input.trace.capabilityProfileId !== capabilityProfileId ||
      input.trace.capabilityProfileHash !== capabilityProfileHash ||
      input.trace.capabilitySnapshotId !== profile.catalog.snapshotId ||
      !snapshot ||
      !frozenPermissionProfileId ||
      profile.governance.permission.profileId !== frozenPermissionProfileId
    ) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} has conflicting capability lineage.`);
    }
    verifyChatTurnCapabilityProfile(profile);
    verifyChatTurnCapabilityCatalogBinding(profile, snapshot);
    await deps.storage.sessionMutationAdmissions.requireCapabilityProfileBinding({
      admissionId: admission.admissionId,
      sessionIncarnationId: admission.sessionIncarnationId,
      workspaceId: admission.workspaceId,
      sessionId: admission.sessionId,
      turnId: input.identity.turnId,
      profileId: profile.profileId,
      profileHash: profile.hashes.profileHash,
      createdAt: profile.createdAt,
    });
  }
  await verifyAutonomousChatReplayRuntimeAuthority(deps, run, admission, input.trace);
  if (admission.status !== "active") {
    const expectedAdmissionStatus = run.status === "completed" ? "completed" : "cancelled";
    if (
      !isDurableRunTerminal(run.status) ||
      admission.status !== expectedAdmissionStatus ||
      admission.terminalAuthorityKind !== "durable_terminal" ||
      admission.terminalDurableRunId !== run.runId ||
      admission.terminalDurableRunStatus !== run.status ||
      input.trace.durable?.runId !== run.runId ||
      input.trace.durable.status !== run.status ||
      !isExactAutonomousTerminalTraceStatus(run.status, input.trace.status)
    ) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} has conflicting terminal authority.`);
    }
    return { terminal: true, requestProcessing: false, runStatus: run.status };
  }
  if (isDurableRunTerminal(run.status)) {
    if (
      run.leaseOwnerId !== undefined ||
      run.leaseExpiresAt !== undefined ||
      input.trace.durable?.runId !== run.runId ||
      input.trace.durable.status !== run.status ||
      !isExactAutonomousTerminalTraceStatus(run.status, input.trace.status)
    ) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} has conflicting pending terminal authority.`);
    }
  }
  if (!admission.runtimeOwnerId || !admission.runtimeLeaseRevision) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} has no request-owner binding evidence.`);
  }
  const binding = await deps.storage.sessionMutationAdmissions.bindDurableRun({
    admissionId: admission.admissionId,
    workspaceId: admission.workspaceId,
    sessionId: admission.sessionId,
    sessionIncarnationId: admission.sessionIncarnationId,
    turnId: input.identity.turnId,
    durableRunId: run.runId,
    requestRuntimeClaim: {
      runtimeOwnerId: admission.runtimeOwnerId,
      leaseRevision: admission.runtimeLeaseRevision,
    },
  });
  if (binding.disposition !== "replayed") {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} had no committed durable binding.`);
  }
  return {
    terminal: false,
    requestProcessing: run.status === "queued" || isDurableRunTerminal(run.status),
    runStatus: run.status,
  };
}

function isExactAutonomousTerminalTraceStatus(
  runStatus: DurableRunRecord["status"],
  traceStatus: ChatTurnTraceRecord["status"],
): boolean {
  if (runStatus === "completed") return traceStatus === "completed" || traceStatus === "partial";
  if (runStatus === "failed" || runStatus === "dead_lettered") return traceStatus === "failed";
  if (runStatus === "cancelled") return traceStatus === "cancelled";
  return false;
}

async function verifyAutonomousChatReplayRuntimeAuthority(
  deps: Pick<ChatAutonomousTurnDeps, "storage">,
  run: DurableRunRecord,
  admission: Awaited<ReturnType<ChatAutonomousTurnDeps["storage"]["sessionMutationAdmissions"]["require"]>>,
  trace: ChatTurnTraceRecord,
): Promise<void> {
  const metadata = run.metadata ?? {};
  const authorityValue = metadata[CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY];
  const authority = readChatTurnRuntimeAuthoritySeal(authorityValue);
  const runtimeEvidenceWithoutAuthority = [...AUTONOMOUS_CHAT_RUNTIME_MUTABLE_METADATA_KEYS].filter(
    (key) =>
      key !== "retryPolicy" &&
      key !== CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY &&
      !(key === "waitForEvent" && metadata[key] === null) &&
      metadata[key] !== undefined,
  );
  if (!authority) {
    if (run.status === "waiting" || isDurableRunTerminal(run.status) || runtimeEvidenceWithoutAuthority.length > 0) {
      throw new Error(
        `Deterministic autonomous Chat replay ${run.runId} has no checkpoint-anchored runtime authority.`,
      );
    }
    if (metadata.retryPolicy !== undefined) {
      assertDurableRetryPolicyMatchesRun(metadata.retryPolicy, run.maxAttempts, DURABLE_RETRY_POLICY_DEFAULT);
    }
    return;
  }
  if (run.status !== "waiting" && run.status !== "completed" && run.status !== "failed" && run.status !== "cancelled") {
    throw new Error(
      `Deterministic autonomous Chat replay ${run.runId} carries runtime authority for status ${run.status}.`,
    );
  }
  const payload = run.payload as { turnId?: unknown };
  const checkpointKind =
    run.status === "waiting"
      ? "run_waiting"
      : run.status === "completed"
        ? "run_completed"
        : run.status === "failed"
          ? "run_failed"
          : "run_cancelled";
  if (
    authority.material.runId !== run.runId ||
    authority.material.turnId !== payload.turnId ||
    authority.material.durableStatus !== run.status ||
    trace.status !== authority.material.traceStatus ||
    trace.durable?.runId !== run.runId ||
    trace.durable.status !== run.status ||
    trace.durable.checkpointKind !== checkpointKind ||
    run.leaseOwnerId !== undefined ||
    run.leaseExpiresAt !== undefined
  ) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} has conflicting runtime authority.`);
  }
  if (
    (run.status === "waiting" && authority.material.transitionKind !== "waiting") ||
    (run.status !== "waiting" &&
      authority.material.transitionKind !== "terminal" &&
      authority.material.transitionKind !== "linked_finalization")
  ) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} has an invalid runtime transition.`);
  }
  const checkpoint = await deps.storage.durableRuns.getLatestCheckpointByKind(run.runId, checkpointKind);
  if (!checkpoint) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} has no ${checkpointKind} authority checkpoint.`);
  }
  verifyCheckpointAnchoredChatTurnRuntimeAuthority(metadata, checkpoint.state);
  assertDurableRetryPolicyMatchesRun(metadata.retryPolicy, run.maxAttempts, DURABLE_RETRY_POLICY_DEFAULT);
  verifyAutonomousReplayTerminalOutput(run, checkpoint.state, authority);
  verifyAutonomousReplayAuxiliaryRuntimeReceipts(run, authority);
  verifyAutonomousReplayFinalizerEvidence(run, admission, authority);
}

function verifyAutonomousReplayTerminalOutput(
  run: DurableRunRecord,
  checkpointState: Record<string, unknown>,
  authority: ChatTurnRuntimeAuthoritySealV1,
): void {
  const metadata = run.metadata ?? {};
  const output = authority.material.terminalOutput;
  if (!output) {
    if (
      AUTONOMOUS_CHAT_TERMINAL_OUTPUT_METADATA_KEYS.some((key) => metadata[key] !== undefined) ||
      AUTONOMOUS_CHAT_TERMINAL_OUTPUT_CHECKPOINT_KEYS.some((key) => checkpointState[key] !== undefined)
    ) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} carries stale terminal output evidence.`);
    }
    return;
  }
  if (
    typeof metadata.outputText !== "string" ||
    typeof metadata.outputSummary !== "string" ||
    metadata.finalOutput !== metadata.outputText ||
    metadata.finalSummary !== metadata.outputSummary ||
    metadata.outputMessageId !== undefined ||
    metadata.outputTraceStatus !== undefined ||
    output.assistantMessageId !== checkpointState.assistantMessageId ||
    metadata.outputText !== checkpointState.outputText ||
    metadata.outputSummary !== checkpointState.outputSummary ||
    hashChatTurnRuntimeAuthorityValue(metadata.outputText) !== output.outputTextSha256 ||
    hashChatTurnRuntimeAuthorityValue(metadata.outputSummary) !== output.outputSummarySha256
  ) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} has terminal output authority drift.`);
  }
}

function verifyAutonomousReplayFinalizerEvidence(
  run: DurableRunRecord,
  admission: Awaited<ReturnType<ChatAutonomousTurnDeps["storage"]["sessionMutationAdmissions"]["require"]>>,
  authority: ChatTurnRuntimeAuthoritySealV1,
): void {
  const metadata = run.metadata ?? {};
  const linkedPending = readExactLinkedFinalizationPendingMarker(metadata.linkedFinalizationPending);
  const linkedSettlement = readExactLinkedFinalizationSettlement(metadata.linkedFinalization);
  const autonomousPending = readExactAutonomousChatPostCommitPendingMarker(metadata.autonomousChatPostCommitPending);
  const autonomousSettlement = readExactAutonomousChatPostCommitSettlement(metadata.autonomousChatPostCommit);
  const generalPending = readExactGeneralChatPostCommitPendingMarker(metadata.generalChatPostCommitPending);
  const generalSettlement = readExactGeneralChatPostCommitSettlement(metadata.generalChatPostCommit);
  const handoff = readExactChatTurnAdmissionHandoff(metadata.chatTurnAdmissionHandoff);
  const required = authority.material.requiredFinalizers;

  const linkedRequired = required.includes("linked");
  if (linkedRequired) {
    const linkedAuthority = authority.material.linkedFinalization;
    if (
      !linkedAuthority ||
      Boolean(linkedPending) === Boolean(linkedSettlement) ||
      (linkedPending &&
        (linkedPending.finalizationId !== linkedAuthority.finalizationId ||
          linkedPending.requestedAt !== linkedAuthority.requestedAt ||
          hashChatTurnRuntimeAuthorityValue(linkedPending.reason) !== linkedAuthority.reasonSha256)) ||
      (linkedSettlement &&
        (linkedSettlement.finalizationId !== linkedAuthority.finalizationId ||
          linkedSettlement.requestedAt !== linkedAuthority.requestedAt ||
          linkedSettlement.reasonSha256 !== linkedAuthority.reasonSha256))
    ) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} has conflicting linked finalization.`);
    }
  } else if (linkedPending || linkedSettlement) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} carries stray linked finalization evidence.`);
  }

  const autonomousRequired = required.includes("autonomous");
  if (autonomousRequired) {
    if (
      Boolean(autonomousPending) === Boolean(autonomousSettlement) ||
      (autonomousPending &&
        (autonomousPending.generationId !== authority.material.postCommitGenerationId ||
          autonomousPending.requestedAt !== authority.material.transitionAt)) ||
      (autonomousSettlement &&
        (autonomousSettlement.generationId !== authority.material.postCommitGenerationId ||
          autonomousSettlement.requestedAt !== authority.material.transitionAt))
    ) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} has conflicting autonomous finalization.`);
    }
  } else if (autonomousPending || autonomousSettlement) {
    throw new Error(
      `Deterministic autonomous Chat replay ${run.runId} carries stray autonomous finalization evidence.`,
    );
  }

  if (!generalPending && !generalSettlement) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} has no general finalization evidence.`);
  }
  for (const evidence of [generalPending, generalSettlement]) {
    if (
      evidence &&
      (evidence.generationId !== authority.material.postCommitGenerationId ||
        evidence.traceStatus !== authority.material.traceStatus ||
        evidence.requestedAt !== authority.material.transitionAt ||
        canonicalJsonString(evidence.postCommitEligibility) !==
          canonicalJsonString(authority.material.postCommitEligibility))
    ) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} has stale general finalization evidence.`);
    }
  }
  const priorFinalizerPending = Boolean(linkedPending || autonomousPending);
  if (priorFinalizerPending && generalSettlement) {
    throw new Error(
      `Deterministic autonomous Chat replay ${run.runId} settled general effects before its prior finalizer.`,
    );
  }
  if (generalPending && generalSettlement) {
    if (
      run.status === "waiting" ||
      (generalSettlement.settlementStatus !== "children_pending" &&
        generalSettlement.settlementStatus !== "waiting_for_parent_finalization") ||
      generalSettlement.completedAt !== undefined
    ) {
      throw new Error(
        `Deterministic autonomous Chat replay ${run.runId} has overlapping general finalization evidence.`,
      );
    }
  } else if (
    generalSettlement &&
    (generalSettlement.settlementStatus === "children_pending" ||
      generalSettlement.settlementStatus === "waiting_for_parent_finalization" ||
      typeof generalSettlement.completedAt !== "string")
  ) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} has incomplete general settlement evidence.`);
  }

  if (run.status === "waiting") {
    if (handoff) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} carries a terminal handoff while waiting.`);
    }
    if (canonicalJsonString(metadata.waitForEvent) !== canonicalJsonString(authority.material.waitForEvent)) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} has conflicting wait authority.`);
    }
    return;
  }
  if (metadata.waitForEvent !== undefined) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} carries stale wait authority.`);
  }
  if (generalSettlement) {
    if (!handoff) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} has no exact terminal handoff.`);
    }
    const durableEffectRunIds = generalSettlement.durableEffectRunIds as Record<string, string>;
    const childRunIds = [...new Set(Object.values(durableEffectRunIds))].sort((left, right) =>
      left.localeCompare(right),
    );
    if (
      handoff.admissionId !== admission.admissionId ||
      handoff.sessionIncarnationId !== admission.sessionIncarnationId ||
      handoff.turnId !== admission.turnId ||
      handoff.parentRunId !== run.runId ||
      handoff.postCommitGenerationId !== authority.material.postCommitGenerationId ||
      canonicalJsonString(handoff.childRunIds) !== canonicalJsonString(childRunIds) ||
      handoff.childRunIdsSha256 !== hashChatTurnRuntimeAuthorityValue(childRunIds)
    ) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} has a conflicting terminal handoff.`);
    }
  } else if (handoff) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} has an unowned terminal handoff.`);
  }
}

function verifyAutonomousReplayAuxiliaryRuntimeReceipts(
  run: DurableRunRecord,
  authority: ChatTurnRuntimeAuthoritySealV1,
): void {
  const metadata = run.metadata ?? {};
  if (metadata.approvalMaterializedPostCommit !== undefined) {
    const receipt = requireExactRuntimeRecord(
      metadata.approvalMaterializedPostCommit,
      ["version", "approvalId", "turnId", "traceStatus", "generationId", "requestedAt"],
      ["materializationKey"],
      "approval materialization receipt",
    );
    if (
      receipt.version !== 1 ||
      !isNonEmptyString(receipt.approvalId) ||
      receipt.turnId !== authority.material.turnId ||
      receipt.traceStatus !== authority.material.traceStatus ||
      receipt.generationId !== authority.material.postCommitGenerationId ||
      receipt.requestedAt !== authority.material.transitionAt ||
      (receipt.materializationKey !== undefined && !isNonEmptyString(receipt.materializationKey))
    ) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} has a stale approval receipt.`);
    }
  }
  if (metadata.autonomyKillSwitch !== undefined) {
    const receipt = requireExactRuntimeRecord(
      metadata.autonomyKillSwitch,
      ["reason", "blockedAt", "message"],
      [],
      "autonomy kill-switch receipt",
    );
    if (
      authority.material.transitionKind !== "waiting" ||
      authority.material.waitForEvent?.eventKey !== "autonomy.v1.enabled" ||
      authority.material.waitForEvent.correlationId !== run.runId ||
      receipt.reason !== "autonomyV1Disabled" ||
      receipt.blockedAt !== authority.material.transitionAt ||
      !isNonEmptyString(receipt.message)
    ) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} has a stale kill-switch receipt.`);
    }
  }
  if (metadata.chatRetryExhaustionDeadLetterPending !== undefined) {
    const receipt = requireExactRuntimeRecord(
      metadata.chatRetryExhaustionDeadLetterPending,
      ["version", "attemptNo", "maxAttempts", "actorId", "reason", "reasonSha256", "requestedAt"],
      [],
      "retry-exhaustion receipt",
    );
    if (
      receipt.version !== 1 ||
      !Number.isSafeInteger(receipt.attemptNo) ||
      !Number.isSafeInteger(receipt.maxAttempts) ||
      Number(receipt.attemptNo) <= Number(receipt.maxAttempts) ||
      receipt.maxAttempts !== run.maxAttempts ||
      !isNonEmptyString(receipt.actorId) ||
      !isNonEmptyString(receipt.reason) ||
      receipt.reasonSha256 !== hashChatTurnRuntimeAuthorityValue(receipt.reason) ||
      receipt.requestedAt !== authority.material.transitionAt ||
      authority.material.transitionKind !== "linked_finalization" ||
      authority.material.linkedFinalization?.reasonSha256 !== receipt.reasonSha256
    ) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} has an invalid retry-exhaustion receipt.`);
    }
  }
}

function requireExactRuntimeRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Autonomous Chat ${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (requiredKeys.some((key) => !(key in record)) || Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error(`Autonomous Chat ${label} has an invalid shape.`);
  }
  return record;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

export function cronChatAdmissionIdentityMatches(value: unknown, expected: CronChatAdmissionIdentity): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<CronChatAdmissionIdentity>;
  return (
    candidate.version === expected.version &&
    candidate.cronRunId === expected.cronRunId &&
    candidate.jobId === expected.jobId &&
    candidate.executionGeneration === expected.executionGeneration &&
    candidate.userMessageId === expected.userMessageId &&
    candidate.turnId === expected.turnId &&
    candidate.assistantMessageId === expected.assistantMessageId &&
    candidate.durableRunId === expected.durableRunId
  );
}
