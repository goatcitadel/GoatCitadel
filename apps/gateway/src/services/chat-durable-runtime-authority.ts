/* eslint-disable max-lines -- Canonical authority validators stay together so their exact-shape rules cannot drift. */
import { createHash } from "node:crypto";
import type { ChatTurnTraceRecord, DurableRunRecord, DurableRunStatus } from "@goatcitadel/contracts";
import { canonicalJsonString } from "@goatcitadel/contracts";
import type { PostCommitEligibility, SessionMutationAdmissionRecord } from "@goatcitadel/storage";

export const CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY = "chatTurnRuntimeAuthority" as const;
export const CHAT_TURN_RUNTIME_AUTHORITY_VERSION = "chat.turn.runtime-authority.v1" as const;
export const AUTONOMOUS_CHAT_ADMISSION_METADATA_VERSION = "chat.autonomous.admission.v1" as const;
export const CRON_CHAT_ADMISSION_IDENTITY_VERSION = "cron.chat.admission.v1" as const;
export const HEARTBEAT_DECISION_RECEIPT_METADATA_KEY = "heartbeatDecisionReceipt" as const;
export const HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY = "heartbeatDecisionRawOutput" as const;
export const HEARTBEAT_DECISION_MAX_MESSAGE_CODE_POINTS = 4_000 as const;

const GENERAL_POST_COMMIT_EFFECTS = [
  "capability_gap",
  "learned_memory_user",
  "learned_memory_assistant",
  "commitments",
  "background_review",
  "memory_maintenance",
  "memory_prewarm",
  "realtime",
  "agent_end",
] as const;
const GENERAL_POST_COMMIT_DURABLE_EFFECTS = ["commitments", "background_review", "memory_maintenance"] as const;
const TRACE_STATUSES = [
  "waiting_for_tool",
  "waiting_for_approval",
  "waiting_for_user_input",
  "completed",
  "partial",
  "failed",
  "cancelled",
] as const satisfies readonly ChatTurnTraceRecord["status"][];
const FINALIZER_ORDER = ["linked", "autonomous", "general"] as const;
const GENERAL_SETTLEMENT_RESOLUTION_KEYS = [
  "turnId",
  "status",
  "agentEnd",
  "learnedMemory",
  "capabilityGap",
  "realtime",
  "commitments",
  "memoryMaintenance",
  "memoryPrewarm",
  "backgroundReview",
] as const;

export function selectCanonicalGeneralChatPostCommitResolution(
  value: Record<string, unknown> | void,
): Record<string, unknown> {
  if (!value) return {};
  return Object.fromEntries(
    GENERAL_SETTLEMENT_RESOLUTION_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(value, key)).map((key) => [
      key,
      value[key],
    ]),
  );
}

export interface CanonicalChatRuntimeWaitForEvent {
  eventKey: string;
  correlationId?: string;
}

export type ChatTurnRuntimeAuthorityFinalizer = (typeof FINALIZER_ORDER)[number];

export interface ChatTurnRuntimeAuthorityTerminalOutputMaterial {
  assistantMessageId: string;
  outputTextSha256: string;
  outputSummarySha256: string;
}

export interface ChatTurnRuntimeAuthorityLinkedFinalizationMaterial {
  finalizationId: string;
  requestedAt: string;
  reasonSha256: string;
}

export interface HeartbeatDecisionReceipt {
  version: 1;
  occurrenceId: string;
  claimSha256: string;
  rawOutputSha256: string;
  notify: boolean;
  normalizedMessageSha256: string | null;
}

export type ExactHeartbeatDecision = { notify: false } | { notify: true; normalizedMessage: string };

export interface ChatTurnRuntimeAuthorityMaterialV1 {
  version: typeof CHAT_TURN_RUNTIME_AUTHORITY_VERSION;
  runId: string;
  turnId: string;
  transitionKind: "waiting" | "terminal" | "linked_finalization";
  durableStatus: Extract<DurableRunStatus, "waiting" | "completed" | "failed" | "cancelled">;
  traceStatus: ChatTurnTraceRecord["status"];
  transitionAt: string;
  postCommitGenerationId: string;
  postCommitEligibility: PostCommitEligibility;
  waitForEvent: CanonicalChatRuntimeWaitForEvent | null;
  terminalOutput: ChatTurnRuntimeAuthorityTerminalOutputMaterial | null;
  linkedFinalization: ChatTurnRuntimeAuthorityLinkedFinalizationMaterial | null;
  requiredFinalizers: ChatTurnRuntimeAuthorityFinalizer[];
  heartbeatDecisionReceipt?: HeartbeatDecisionReceipt;
}

export interface ChatTurnRuntimeAuthoritySealV1 {
  material: ChatTurnRuntimeAuthorityMaterialV1;
  materialSha256: string;
}

export interface BuildChatTurnRuntimeAuthoritySealInput {
  runId: string;
  turnId: string;
  transitionKind: ChatTurnRuntimeAuthorityMaterialV1["transitionKind"];
  durableStatus: ChatTurnRuntimeAuthorityMaterialV1["durableStatus"];
  traceStatus: ChatTurnTraceRecord["status"];
  transitionAt: string;
  postCommitGenerationId: string;
  postCommitEligibility: PostCommitEligibility;
  waitForEvent?: CanonicalChatRuntimeWaitForEvent;
  terminalOutput?: {
    assistantMessageId: string;
    outputText: string;
    outputSummary: string;
  };
  linkedFinalization?: {
    finalizationId: string;
    requestedAt: string;
    reason: string;
  };
  heartbeatDecisionReceipt?: HeartbeatDecisionReceipt;
  requiredFinalizers: readonly ChatTurnRuntimeAuthorityFinalizer[];
}

export interface ExactAutonomousChatPostCommitPendingMarker {
  version: 1;
  generationId?: string;
  requestedAt: string;
  claimId?: string;
  claimExpiresAt?: string;
}

export interface ExactGeneralChatPostCommitPendingMarker {
  version: 1;
  generationId: string;
  traceStatus: ChatTurnTraceRecord["status"];
  requestedAt: string;
  postCommitEligibility: PostCommitEligibility;
  completedEffects: string[];
  durableEffectRunIds: Record<string, string>;
}

/**
 * Pre-runtime-authority marker written by chat.turn.execute.v1. It is parsed
 * separately so startup can retire already-terminal legacy work without
 * synthesizing the frozen eligibility or v2 authority that did not exist when
 * the row was committed.
 */
export interface ExactLegacyGeneralChatPostCommitPendingMarker {
  version: 1;
  generationId: string;
  traceStatus: ChatTurnTraceRecord["status"];
  requestedAt: string;
  completedEffects: string[];
  durableEffectRunIds: Record<string, string>;
}

export interface ExactLinkedFinalizationPendingMarker {
  reason: string;
  requestedAt: string;
  finalizationId: string;
  claimId?: string;
  claimExpiresAt?: string;
}

export interface ExactLinkedFinalizationSettlement {
  version: 1;
  finalizationId: string;
  requestedAt: string;
  reasonSha256: string;
  completedAt: string;
}

export interface ExactChatTurnAdmissionHandoff {
  version: 1;
  admissionId: string;
  sessionIncarnationId: string;
  turnId: string;
  parentRunId: string;
  postCommitGenerationId: string;
  parentLocalEffectsStatus: "settled";
  childRunIds: string[];
  childRunIdsSha256: string;
  committedAt: string;
}

export interface AutonomousChatChildIdentity {
  userMessageId: string;
  turnId: string;
  assistantMessageId: string;
  durableRunId: string;
}

export interface CanonicalCronChatAdmissionIdentity {
  version: typeof CRON_CHAT_ADMISSION_IDENTITY_VERSION;
  cronRunId: string;
  jobId: string;
  executionGeneration: number;
  userMessageId: string;
  turnId: string;
  assistantMessageId: string;
  durableRunId: string;
}

export interface AutonomousChatAdmissionMetadataMaterialV1 {
  version: typeof AUTONOMOUS_CHAT_ADMISSION_METADATA_VERSION;
  identity: AutonomousChatChildIdentity;
  sessionId: string;
  objectiveSha256: string;
  autonomous: {
    kind: "scheduled" | "heartbeat";
    systemActorId: string;
    sourceRunId: string;
    reason: string;
    deliverMode: "always" | "on_notify";
    deliveryChannel?: { channelKey: string; target?: string };
    profilePosture?: string;
    commitmentId?: string;
  };
  admission: {
    admissionId: string;
    sessionIncarnationId: string;
    workspaceId: string;
    admissionMaterialSha256: string;
    effectiveRequestMaterialSha256: string;
  };
  capability: {
    profileId: string;
    profileHash: string;
    snapshotId: string;
  } | null;
  cronAdmission: CanonicalCronChatAdmissionIdentity | null;
}

export interface AutonomousChatAdmissionMetadataSealV1 {
  material: AutonomousChatAdmissionMetadataMaterialV1;
  materialSha256: string;
}

export interface VerifyAutonomousChatAdmissionRunOptions {
  admission?: SessionMutationAdmissionRecord;
  trace?: Pick<
    ChatTurnTraceRecord,
    | "turnId"
    | "sessionId"
    | "userMessageId"
    | "assistantMessageId"
    | "capabilityProfileId"
    | "capabilityProfileHash"
    | "capabilitySnapshotId"
  >;
}

export function hashChatTurnRuntimeAuthorityValue(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value)).digest("hex");
}

export function hashHeartbeatDecisionUtf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function parseExactHeartbeatDecisionRawOutput(rawOutput: string): ExactHeartbeatDecision | undefined {
  const fields = readExactHeartbeatDecisionObject(rawOutput);
  if (!fields || typeof fields.notify !== "boolean") return undefined;
  if (fields.notify === false) {
    return Object.keys(fields).length === 1 ? { notify: false } : undefined;
  }
  if (Object.keys(fields).length !== 2 || typeof fields.message !== "string") return undefined;
  const normalizedMessage = fields.message.trim();
  if (
    !normalizedMessage ||
    !containsOnlyUnicodeScalarValues(normalizedMessage) ||
    [...normalizedMessage].length > HEARTBEAT_DECISION_MAX_MESSAGE_CODE_POINTS
  ) {
    return undefined;
  }
  return { notify: true, normalizedMessage };
}

export function buildHeartbeatDecisionReceipt(input: {
  occurrenceId: string;
  claimSha256: string;
  rawOutput: string;
}): { decision: ExactHeartbeatDecision; receipt: HeartbeatDecisionReceipt } {
  const decision = parseExactHeartbeatDecisionRawOutput(input.rawOutput);
  if (!decision) {
    throw new Error("System heartbeat output is not an exact decision object.");
  }
  const receipt: HeartbeatDecisionReceipt = {
    version: 1,
    occurrenceId: requireIdentifier(input.occurrenceId, "heartbeat occurrenceId"),
    claimSha256: requireSha256(input.claimSha256, "heartbeat claimSha256"),
    rawOutputSha256: hashHeartbeatDecisionUtf8(input.rawOutput),
    notify: decision.notify,
    normalizedMessageSha256: decision.notify ? hashHeartbeatDecisionUtf8(decision.normalizedMessage) : null,
  };
  return { decision, receipt };
}

export function readHeartbeatDecisionReceipt(value: unknown): HeartbeatDecisionReceipt | undefined {
  if (value === undefined) return undefined;
  const receipt = requireRecord(value, "heartbeatDecisionReceipt");
  assertExactKeys(
    receipt,
    ["version", "occurrenceId", "claimSha256", "rawOutputSha256", "notify", "normalizedMessageSha256"],
    "heartbeatDecisionReceipt",
  );
  if (receipt.version !== 1 || typeof receipt.notify !== "boolean") {
    throw new Error("Heartbeat decision receipt is invalid.");
  }
  const normalizedMessageSha256 =
    receipt.normalizedMessageSha256 === null
      ? null
      : requireSha256(receipt.normalizedMessageSha256, "heartbeat normalizedMessageSha256");
  if ((receipt.notify && !normalizedMessageSha256) || (!receipt.notify && normalizedMessageSha256 !== null)) {
    throw new Error("Heartbeat decision receipt notification binding is invalid.");
  }
  return {
    version: 1,
    occurrenceId: requireIdentifier(receipt.occurrenceId, "heartbeat occurrenceId"),
    claimSha256: requireSha256(receipt.claimSha256, "heartbeat claimSha256"),
    rawOutputSha256: requireSha256(receipt.rawOutputSha256, "heartbeat rawOutputSha256"),
    notify: receipt.notify,
    normalizedMessageSha256,
  };
}

export function buildChatTurnRuntimeAuthoritySeal(
  input: BuildChatTurnRuntimeAuthoritySealInput,
): ChatTurnRuntimeAuthoritySealV1 {
  const requiredFinalizers = normalizeRequiredFinalizers(input.requiredFinalizers);
  const heartbeatDecisionReceipt = readHeartbeatDecisionReceipt(input.heartbeatDecisionReceipt);
  const material: ChatTurnRuntimeAuthorityMaterialV1 = {
    version: CHAT_TURN_RUNTIME_AUTHORITY_VERSION,
    runId: requireIdentifier(input.runId, "runId"),
    turnId: requireIdentifier(input.turnId, "turnId"),
    transitionKind: input.transitionKind,
    durableStatus: input.durableStatus,
    traceStatus: input.traceStatus,
    transitionAt: requireTimestamp(input.transitionAt, "transitionAt"),
    postCommitGenerationId: requireIdentifier(input.postCommitGenerationId, "postCommitGenerationId"),
    postCommitEligibility: requirePostCommitEligibility(input.postCommitEligibility),
    waitForEvent: input.waitForEvent ? requireWaitForEvent(input.waitForEvent) : null,
    terminalOutput: input.terminalOutput
      ? {
          assistantMessageId: requireIdentifier(input.terminalOutput.assistantMessageId, "assistantMessageId"),
          outputTextSha256: hashChatTurnRuntimeAuthorityValue(input.terminalOutput.outputText),
          outputSummarySha256: hashChatTurnRuntimeAuthorityValue(input.terminalOutput.outputSummary),
        }
      : null,
    linkedFinalization: input.linkedFinalization
      ? {
          finalizationId: requireIdentifier(input.linkedFinalization.finalizationId, "finalizationId"),
          requestedAt: requireTimestamp(input.linkedFinalization.requestedAt, "requestedAt"),
          reasonSha256: hashChatTurnRuntimeAuthorityValue(input.linkedFinalization.reason),
        }
      : null,
    requiredFinalizers,
    ...(heartbeatDecisionReceipt ? { heartbeatDecisionReceipt } : {}),
  };
  if (heartbeatDecisionReceipt?.notify) {
    if (
      !input.terminalOutput ||
      input.terminalOutput.outputText !== input.terminalOutput.outputSummary ||
      hashHeartbeatDecisionUtf8(input.terminalOutput.outputText) !== heartbeatDecisionReceipt.normalizedMessageSha256
    ) {
      throw new Error("Notifying heartbeat authority is not bound to its exact normalized message.");
    }
  } else if (heartbeatDecisionReceipt && input.terminalOutput) {
    throw new Error("Silent heartbeat authority cannot contain terminal output.");
  }
  assertRuntimeAuthorityTransitionShape(material);
  return {
    material,
    materialSha256: hashChatTurnRuntimeAuthorityValue(material),
  };
}

export function readChatTurnRuntimeAuthoritySeal(value: unknown): ChatTurnRuntimeAuthoritySealV1 | undefined {
  if (value === undefined) return undefined;
  const seal = requireRecord(value, "Chat turn runtime authority seal");
  assertExactKeys(seal, ["material", "materialSha256"], "Chat turn runtime authority seal");
  const material = readChatTurnRuntimeAuthorityMaterial(seal.material);
  const materialSha256 = requireSha256(seal.materialSha256, "materialSha256");
  if (materialSha256 !== hashChatTurnRuntimeAuthorityValue(material)) {
    throw new Error("Chat turn runtime authority seal hash does not match its material.");
  }
  return { material, materialSha256 };
}

export function verifyChatTurnRuntimeAuthoritySeal(
  value: unknown,
  expected?: ChatTurnRuntimeAuthoritySealV1,
): ChatTurnRuntimeAuthoritySealV1 {
  const seal = readChatTurnRuntimeAuthoritySeal(value);
  if (!seal) {
    throw new Error("Chat turn runtime authority seal is missing.");
  }
  if (expected && canonicalJsonString(seal) !== canonicalJsonString(expected)) {
    throw new Error("Chat turn runtime authority seal does not match the expected transition.");
  }
  return seal;
}

export function withChatTurnRuntimeAuthority(
  metadata: Record<string, unknown> | undefined,
  seal: ChatTurnRuntimeAuthoritySealV1,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    [CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY]: verifyChatTurnRuntimeAuthoritySeal(seal),
  };
}

export function withChatTurnRuntimeAuthorityCheckpoint(
  state: Record<string, unknown>,
  seal: ChatTurnRuntimeAuthoritySealV1,
): Record<string, unknown> {
  return {
    ...state,
    [CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY]: verifyChatTurnRuntimeAuthoritySeal(seal),
  };
}

export function verifyCheckpointAnchoredChatTurnRuntimeAuthority(
  metadata: Record<string, unknown> | undefined,
  checkpointState: Record<string, unknown>,
): ChatTurnRuntimeAuthoritySealV1 {
  const metadataSeal = verifyChatTurnRuntimeAuthoritySeal(metadata?.[CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY]);
  verifyChatTurnRuntimeAuthoritySeal(checkpointState[CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY], metadataSeal);
  return metadataSeal;
}

export function buildAutonomousChatAdmissionMetadataMaterial(input: {
  identity: AutonomousChatChildIdentity;
  sessionId: string;
  objective: string;
  autonomous: AutonomousChatAdmissionMetadataMaterialV1["autonomous"];
  payload: Record<string, unknown>;
  capabilitySnapshotId?: string;
  cronAdmission?: CanonicalCronChatAdmissionIdentity;
}): AutonomousChatAdmissionMetadataMaterialV1 {
  const profileId = input.payload.capabilityProfileId;
  const profileHash = input.payload.capabilityProfileHash;
  const hasAnyCapability =
    profileId !== undefined || profileHash !== undefined || input.capabilitySnapshotId !== undefined;
  if (
    hasAnyCapability &&
    (typeof profileId !== "string" || typeof profileHash !== "string" || !input.capabilitySnapshotId)
  ) {
    throw new Error("Autonomous Chat admission has incomplete capability lineage.");
  }
  return readAutonomousChatAdmissionMetadataMaterial({
    version: AUTONOMOUS_CHAT_ADMISSION_METADATA_VERSION,
    identity: input.identity,
    sessionId: input.sessionId,
    objectiveSha256: hashChatTurnRuntimeAuthorityValue(input.objective),
    autonomous: JSON.parse(canonicalJsonString(input.autonomous)) as Record<string, unknown>,
    admission: {
      admissionId: input.payload.admissionId,
      sessionIncarnationId: input.payload.sessionIncarnationId,
      workspaceId: input.payload.workspaceId,
      admissionMaterialSha256: input.payload.admissionMaterialSha256,
      effectiveRequestMaterialSha256: input.payload.effectiveRequestMaterialSha256,
    },
    capability: hasAnyCapability ? { profileId, profileHash, snapshotId: input.capabilitySnapshotId } : null,
    cronAdmission: input.cronAdmission ?? null,
  });
}

export function sealAutonomousChatAdmissionMetadata(
  material: AutonomousChatAdmissionMetadataMaterialV1,
): AutonomousChatAdmissionMetadataSealV1 {
  const canonicalMaterial = readAutonomousChatAdmissionMetadataMaterial(material);
  return {
    material: canonicalMaterial,
    materialSha256: hashChatTurnRuntimeAuthorityValue(canonicalMaterial),
  };
}

export function readAutonomousChatAdmissionMetadataSeal(value: unknown): AutonomousChatAdmissionMetadataSealV1 {
  const envelope = requireRecord(value, "Autonomous Chat admission seal");
  assertExactKeys(envelope, ["material", "materialSha256"], "Autonomous Chat admission seal");
  const material = readAutonomousChatAdmissionMetadataMaterial(envelope.material);
  const materialSha256 = requireSha256(envelope.materialSha256, "autonomous admission materialSha256");
  if (materialSha256 !== hashChatTurnRuntimeAuthorityValue(material)) {
    throw new Error("Autonomous Chat admission seal hash does not match its material.");
  }
  return { material, materialSha256 };
}

/**
 * Verifies the one canonical autonomous-admission seal and every immutable
 * binding that is available at durable-runtime replay/finalization time.
 */
export function verifyAutonomousChatAdmissionRunMetadata(
  run: DurableRunRecord,
  options: VerifyAutonomousChatAdmissionRunOptions = {},
): AutonomousChatAdmissionMetadataSealV1 {
  const payload = requireRecord(run.payload, "Autonomous Chat durable payload");
  const metadata = run.metadata ?? {};
  const seal = readAutonomousChatAdmissionMetadataSeal(metadata.autonomousAdmission);
  const material = seal.material;
  const request = requireRecord(payload.request, "Autonomous Chat frozen request");
  const requestActor = requireRecord(payload.requestActor, "Autonomous Chat request actor");
  const objective = requireIdentifier(metadata.objective, "autonomous objective");
  if (
    run.workflowKey !== "chat.turn.execute" ||
    payload.version !== "chat.turn.execute.v2" ||
    material.identity.durableRunId !== run.runId ||
    material.identity.turnId !== payload.turnId ||
    material.identity.userMessageId !== payload.userMessageId ||
    material.identity.assistantMessageId !== payload.assistantMessageId ||
    material.sessionId !== payload.sessionId ||
    objective !== request.content ||
    material.objectiveSha256 !== hashChatTurnRuntimeAuthorityValue(objective) ||
    canonicalJsonString(material.autonomous) !== canonicalJsonString(metadata.autonomous) ||
    requestActor.actorKind !== "system" ||
    requestActor.actorId !== material.autonomous.systemActorId ||
    material.admission.admissionId !== payload.admissionId ||
    material.admission.sessionIncarnationId !== payload.sessionIncarnationId ||
    material.admission.workspaceId !== payload.workspaceId ||
    material.admission.admissionMaterialSha256 !== payload.admissionMaterialSha256 ||
    material.admission.effectiveRequestMaterialSha256 !== payload.effectiveRequestMaterialSha256
  ) {
    throw new Error(`Autonomous Chat run ${run.runId} has conflicting immutable admission lineage.`);
  }

  const payloadProfileId = payload.capabilityProfileId;
  const payloadProfileHash = payload.capabilityProfileHash;
  if (material.capability === null) {
    if (
      payloadProfileId !== undefined ||
      payloadProfileHash !== undefined ||
      metadata.capabilityProfileId !== undefined ||
      metadata.capabilityProfileHash !== undefined
    ) {
      throw new Error(`Autonomous Chat run ${run.runId} has an incomplete null capability binding.`);
    }
  } else if (
    material.capability.profileId !== payloadProfileId ||
    material.capability.profileHash !== payloadProfileHash ||
    material.capability.profileId !== metadata.capabilityProfileId ||
    material.capability.profileHash !== metadata.capabilityProfileHash
  ) {
    throw new Error(`Autonomous Chat run ${run.runId} has conflicting capability lineage.`);
  }

  const cron = material.cronAdmission;
  if (cron === null) {
    if (
      payload.cronAdmission !== undefined ||
      metadata.cronAdmission !== undefined ||
      metadata.cronRunId !== undefined ||
      metadata.cronJobId !== undefined ||
      metadata.cronExecutionGeneration !== undefined
    ) {
      throw new Error(`Autonomous Chat run ${run.runId} has unexpected cron admission lineage.`);
    }
  } else if (
    canonicalJsonString(payload.cronAdmission) !== canonicalJsonString(cron) ||
    canonicalJsonString(metadata.cronAdmission) !== canonicalJsonString(cron) ||
    metadata.cronRunId !== cron.cronRunId ||
    metadata.cronJobId !== cron.jobId ||
    metadata.cronExecutionGeneration !== cron.executionGeneration ||
    cron.durableRunId !== run.runId ||
    cron.turnId !== material.identity.turnId ||
    cron.userMessageId !== material.identity.userMessageId ||
    cron.assistantMessageId !== material.identity.assistantMessageId
  ) {
    throw new Error(`Autonomous Chat run ${run.runId} has conflicting cron admission lineage.`);
  }

  const admission = options.admission;
  if (
    admission &&
    (admission.admissionId !== material.admission.admissionId ||
      admission.admissionKind !== "turn_write" ||
      admission.sessionIncarnationId !== material.admission.sessionIncarnationId ||
      admission.workspaceId !== material.admission.workspaceId ||
      admission.sessionId !== material.sessionId ||
      admission.turnId !== material.identity.turnId ||
      admission.actorKind !== "system" ||
      admission.actorId !== material.autonomous.systemActorId ||
      admission.materialSha256 !== material.admission.admissionMaterialSha256)
  ) {
    throw new Error(`Autonomous Chat run ${run.runId} does not match its mutation admission.`);
  }
  const trace = options.trace;
  if (
    trace &&
    (trace.turnId !== material.identity.turnId ||
      trace.sessionId !== material.sessionId ||
      trace.userMessageId !== material.identity.userMessageId ||
      trace.assistantMessageId !== material.identity.assistantMessageId ||
      trace.capabilityProfileId !== material.capability?.profileId ||
      trace.capabilityProfileHash !== material.capability?.profileHash ||
      trace.capabilitySnapshotId !== material.capability?.snapshotId)
  ) {
    throw new Error(`Autonomous Chat run ${run.runId} does not match its canonical trace binding.`);
  }
  return seal;
}

function readAutonomousChatAdmissionMetadataMaterial(value: unknown): AutonomousChatAdmissionMetadataMaterialV1 {
  const material = requireRecord(value, "Autonomous Chat admission material");
  assertExactKeys(
    material,
    ["version", "identity", "sessionId", "objectiveSha256", "autonomous", "admission", "capability", "cronAdmission"],
    "Autonomous Chat admission material",
  );
  if (material.version !== AUTONOMOUS_CHAT_ADMISSION_METADATA_VERSION) {
    throw new Error("Autonomous Chat admission material version is invalid.");
  }
  const identity = requireRecord(material.identity, "Autonomous Chat child identity");
  assertExactKeys(
    identity,
    ["userMessageId", "turnId", "assistantMessageId", "durableRunId"],
    "Autonomous Chat child identity",
  );
  const autonomous = requireRecord(material.autonomous, "Autonomous Chat autonomous context");
  assertExactOptionalKeys(
    autonomous,
    ["kind", "systemActorId", "sourceRunId", "reason", "deliverMode"],
    ["deliveryChannel", "profilePosture", "commitmentId"],
    "Autonomous Chat autonomous context",
  );
  if (autonomous.kind !== "scheduled" && autonomous.kind !== "heartbeat") {
    throw new Error("Autonomous Chat admission kind is invalid.");
  }
  if (autonomous.deliverMode !== "always" && autonomous.deliverMode !== "on_notify") {
    throw new Error("Autonomous Chat admission delivery mode is invalid.");
  }
  let deliveryChannel: { channelKey: string; target?: string } | undefined;
  if (autonomous.deliveryChannel !== undefined) {
    const channel = requireRecord(autonomous.deliveryChannel, "Autonomous Chat delivery channel");
    assertExactOptionalKeys(channel, ["channelKey"], ["target"], "Autonomous Chat delivery channel");
    deliveryChannel = {
      channelKey: requireBoundedIdentifier(channel.channelKey, "delivery channelKey", 256),
      ...(channel.target === undefined
        ? {}
        : { target: requireBoundedIdentifier(channel.target, "delivery target", 1_024) }),
    };
  }
  const admission = requireRecord(material.admission, "Autonomous Chat admission identity");
  assertExactKeys(
    admission,
    ["admissionId", "sessionIncarnationId", "workspaceId", "admissionMaterialSha256", "effectiveRequestMaterialSha256"],
    "Autonomous Chat admission identity",
  );
  const capability = material.capability === null ? null : readAutonomousChatCapability(material.capability);
  const cronAdmission = material.cronAdmission === null ? null : readCanonicalCronChatAdmission(material.cronAdmission);
  return {
    version: AUTONOMOUS_CHAT_ADMISSION_METADATA_VERSION,
    identity: {
      userMessageId: requireBoundedIdentifier(identity.userMessageId, "autonomous userMessageId"),
      turnId: requireBoundedIdentifier(identity.turnId, "autonomous turnId"),
      assistantMessageId: requireBoundedIdentifier(identity.assistantMessageId, "autonomous assistantMessageId"),
      durableRunId: requireBoundedIdentifier(identity.durableRunId, "autonomous durableRunId"),
    },
    sessionId: requireBoundedIdentifier(material.sessionId, "autonomous sessionId"),
    objectiveSha256: requireSha256(material.objectiveSha256, "objectiveSha256"),
    autonomous: {
      kind: autonomous.kind,
      systemActorId: requireBoundedIdentifier(autonomous.systemActorId, "autonomous systemActorId"),
      sourceRunId: requireBoundedIdentifier(autonomous.sourceRunId, "autonomous sourceRunId"),
      reason: requireBoundedIdentifier(autonomous.reason, "autonomous reason", 4_096),
      deliverMode: autonomous.deliverMode,
      ...(deliveryChannel ? { deliveryChannel } : {}),
      ...(autonomous.profilePosture === undefined
        ? {}
        : { profilePosture: requireBoundedIdentifier(autonomous.profilePosture, "profilePosture", 256) }),
      ...(autonomous.commitmentId === undefined
        ? {}
        : { commitmentId: requireBoundedIdentifier(autonomous.commitmentId, "commitmentId") }),
    },
    admission: {
      admissionId: requireBoundedIdentifier(admission.admissionId, "autonomous admissionId"),
      sessionIncarnationId: requireBoundedIdentifier(admission.sessionIncarnationId, "autonomous sessionIncarnationId"),
      workspaceId: requireBoundedIdentifier(admission.workspaceId, "autonomous workspaceId"),
      admissionMaterialSha256: requireSha256(admission.admissionMaterialSha256, "admissionMaterialSha256"),
      effectiveRequestMaterialSha256: requireSha256(
        admission.effectiveRequestMaterialSha256,
        "effectiveRequestMaterialSha256",
      ),
    },
    capability,
    cronAdmission,
  };
}

function readAutonomousChatCapability(
  value: unknown,
): NonNullable<AutonomousChatAdmissionMetadataMaterialV1["capability"]> {
  const capability = requireRecord(value, "Autonomous Chat capability binding");
  assertExactKeys(capability, ["profileId", "profileHash", "snapshotId"], "Autonomous Chat capability binding");
  return {
    profileId: requireBoundedIdentifier(capability.profileId, "capability profileId"),
    profileHash: requireSha256(capability.profileHash, "capability profileHash"),
    snapshotId: requireBoundedIdentifier(capability.snapshotId, "capability snapshotId"),
  };
}

function readCanonicalCronChatAdmission(value: unknown): CanonicalCronChatAdmissionIdentity {
  const cron = requireRecord(value, "Cron Chat admission identity");
  assertExactKeys(
    cron,
    [
      "version",
      "cronRunId",
      "jobId",
      "executionGeneration",
      "userMessageId",
      "turnId",
      "assistantMessageId",
      "durableRunId",
    ],
    "Cron Chat admission identity",
  );
  if (
    cron.version !== CRON_CHAT_ADMISSION_IDENTITY_VERSION ||
    !Number.isSafeInteger(cron.executionGeneration) ||
    Number(cron.executionGeneration) < 1
  ) {
    throw new Error("Cron Chat admission version or execution generation is invalid.");
  }
  return {
    version: CRON_CHAT_ADMISSION_IDENTITY_VERSION,
    cronRunId: requireBoundedIdentifier(cron.cronRunId, "cronRunId"),
    jobId: requireBoundedIdentifier(cron.jobId, "cron jobId"),
    executionGeneration: Number(cron.executionGeneration),
    userMessageId: requireBoundedIdentifier(cron.userMessageId, "cron userMessageId"),
    turnId: requireBoundedIdentifier(cron.turnId, "cron turnId"),
    assistantMessageId: requireBoundedIdentifier(cron.assistantMessageId, "cron assistantMessageId"),
    durableRunId: requireBoundedIdentifier(cron.durableRunId, "cron durableRunId"),
  };
}

export function readExactAutonomousChatPostCommitPendingMarker(
  value: unknown,
): ExactAutonomousChatPostCommitPendingMarker | undefined {
  if (value === undefined) return undefined;
  const marker = requireRecord(value, "Autonomous Chat post-commit pending marker");
  assertExactOptionalKeys(
    marker,
    ["version", "requestedAt"],
    ["generationId", "claimId", "claimExpiresAt"],
    "Autonomous Chat post-commit pending marker",
  );
  if (marker.version !== 1) throw new Error("Autonomous Chat post-commit pending marker version is invalid.");
  const generationId =
    marker.generationId === undefined ? undefined : requireIdentifier(marker.generationId, "generationId");
  const claimId = marker.claimId === undefined ? undefined : requireIdentifier(marker.claimId, "claimId");
  const claimExpiresAt =
    marker.claimExpiresAt === undefined ? undefined : requireTimestamp(marker.claimExpiresAt, "claimExpiresAt");
  return {
    version: 1,
    ...(generationId ? { generationId } : {}),
    requestedAt: requireTimestamp(marker.requestedAt, "requestedAt"),
    ...(claimId ? { claimId } : {}),
    ...(claimExpiresAt ? { claimExpiresAt } : {}),
  };
}

export function readExactGeneralChatPostCommitPendingMarker(
  value: unknown,
): ExactGeneralChatPostCommitPendingMarker | undefined {
  if (value === undefined) return undefined;
  const marker = requireRecord(value, "General Chat post-commit pending marker");
  assertExactKeys(
    marker,
    [
      "version",
      "generationId",
      "traceStatus",
      "requestedAt",
      "postCommitEligibility",
      "completedEffects",
      "durableEffectRunIds",
    ],
    "General Chat post-commit pending marker",
  );
  const common = readExactGeneralChatPostCommitPendingMarkerFields(marker);
  return {
    ...common,
    postCommitEligibility: requirePostCommitEligibility(marker.postCommitEligibility),
  };
}

export function readExactLegacyGeneralChatPostCommitPendingMarker(
  value: unknown,
): ExactLegacyGeneralChatPostCommitPendingMarker | undefined {
  if (value === undefined) return undefined;
  const marker = requireRecord(value, "Legacy General Chat post-commit pending marker");
  if (Object.prototype.hasOwnProperty.call(marker, "postCommitEligibility")) return undefined;
  assertExactKeys(
    marker,
    ["version", "generationId", "traceStatus", "requestedAt", "completedEffects", "durableEffectRunIds"],
    "Legacy General Chat post-commit pending marker",
  );
  return readExactGeneralChatPostCommitPendingMarkerFields(marker);
}

function readExactGeneralChatPostCommitPendingMarkerFields(
  marker: Record<string, unknown>,
): ExactLegacyGeneralChatPostCommitPendingMarker {
  if (marker.version !== 1) throw new Error("General Chat post-commit pending marker version is invalid.");
  const completedEffects = requireStringArray(marker.completedEffects, "completedEffects");
  if (
    completedEffects.some((effect) => !(GENERAL_POST_COMMIT_EFFECTS as readonly string[]).includes(effect)) ||
    new Set(completedEffects).size !== completedEffects.length
  ) {
    throw new Error("General Chat post-commit pending marker effects are invalid.");
  }
  const durableEffectRunIdsRecord = requireRecord(marker.durableEffectRunIds, "durableEffectRunIds");
  if (
    Object.keys(durableEffectRunIdsRecord).some(
      (effect) => !(GENERAL_POST_COMMIT_DURABLE_EFFECTS as readonly string[]).includes(effect),
    )
  ) {
    throw new Error("General Chat post-commit durable effect receipts contain an unknown key.");
  }
  const durableEffectRunIds = Object.fromEntries(
    Object.entries(durableEffectRunIdsRecord).map(([effect, runId]) => [
      effect,
      requireIdentifier(runId, `${effect} runId`),
    ]),
  );
  return {
    version: 1,
    generationId: requireIdentifier(marker.generationId, "generationId"),
    traceStatus: requireTraceStatus(marker.traceStatus),
    requestedAt: requireTimestamp(marker.requestedAt, "requestedAt"),
    completedEffects,
    durableEffectRunIds,
  };
}

export function readExactAutonomousChatPostCommitSettlement(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const settlement = requireRecord(value, "Autonomous Chat post-commit settlement");
  assertExactKeys(
    settlement,
    ["delivery", "heartbeatCleanup", "generationId", "requestedAt", "completedAt"],
    "Autonomous Chat post-commit settlement",
  );
  requireAutonomousDelivery(settlement.delivery);
  requireHeartbeatCleanup(settlement.heartbeatCleanup);
  requireIdentifier(settlement.generationId, "generationId");
  requireTimestamp(settlement.requestedAt, "requestedAt");
  requireTimestamp(settlement.completedAt, "completedAt");
  return settlement;
}

export function readExactGeneralChatPostCommitSettlement(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const settlement = requireRecord(value, "General Chat post-commit settlement");
  const authoritySuperseded = settlement.settlementStatus === "authority_superseded";
  const requiredKeys = authoritySuperseded
    ? [
        "generationId",
        "traceStatus",
        "requestedAt",
        "postCommitEligibility",
        "settlementStatus",
        "completedEffects",
        "blockedEffects",
        "durableEffectRunIds",
        "childOutcomeAuthority",
        "terminalControlEventId",
        "settledAt",
      ]
    : [
        "generationId",
        "traceStatus",
        "requestedAt",
        "postCommitEligibility",
        "parentLocalEffectsStatus",
        "parentLocalEffectsSettledAt",
        "completedEffects",
        "durableEffectRunIds",
        "durableEffectOutcomes",
        "childOutcomeAuthority",
        "settlementStatus",
      ];
  const optionalKeys = authoritySuperseded ? [] : ["completedAt", ...GENERAL_SETTLEMENT_RESOLUTION_KEYS];
  assertExactOptionalKeys(settlement, requiredKeys, optionalKeys, "General Chat post-commit settlement");
  requireIdentifier(settlement.generationId, "generationId");
  requireTraceStatus(settlement.traceStatus);
  requireTimestamp(settlement.requestedAt, "requestedAt");
  requirePostCommitEligibility(settlement.postCommitEligibility);
  const completedEffects = requireGeneralPostCommitEffects(settlement.completedEffects, "completedEffects");
  const durableEffectRunIds = requireDurableEffectRunIds(settlement.durableEffectRunIds);
  if (authoritySuperseded) {
    const blockedEffects = requireGeneralPostCommitEffects(settlement.blockedEffects, "blockedEffects");
    if (blockedEffects.some((effect) => completedEffects.includes(effect))) {
      throw new Error("General Chat post-commit completed and blocked effects overlap.");
    }
    requireIdentifier(settlement.terminalControlEventId, "terminalControlEventId");
    requireTimestamp(settlement.settledAt, "settledAt");
  } else {
    if (settlement.parentLocalEffectsStatus !== "settled") {
      throw new Error("General Chat post-commit parent effects are not settled.");
    }
    requireTimestamp(settlement.parentLocalEffectsSettledAt, "parentLocalEffectsSettledAt");
    requireDurableEffectOutcomes(settlement.durableEffectOutcomes, durableEffectRunIds);
    if (settlement.completedAt !== undefined) requireTimestamp(settlement.completedAt, "completedAt");
    if (
      !["waiting_for_parent_finalization", "children_pending", "settled_with_failures", "completed"].includes(
        String(settlement.settlementStatus),
      )
    ) {
      throw new Error("General Chat post-commit settlement status is invalid.");
    }
  }
  if (settlement.childOutcomeAuthority !== "child_durable_runs") {
    throw new Error("General Chat post-commit child outcome authority is invalid.");
  }
  return settlement;
}

export function readExactLinkedFinalizationPendingMarker(
  value: unknown,
): ExactLinkedFinalizationPendingMarker | undefined {
  if (value === undefined) return undefined;
  const marker = requireRecord(value, "Linked finalization pending marker");
  assertExactOptionalKeys(
    marker,
    ["reason", "requestedAt", "finalizationId"],
    ["claimId", "claimExpiresAt"],
    "Linked finalization pending marker",
  );
  const claimId = marker.claimId === undefined ? undefined : requireIdentifier(marker.claimId, "claimId");
  const claimExpiresAt =
    marker.claimExpiresAt === undefined ? undefined : requireTimestamp(marker.claimExpiresAt, "claimExpiresAt");
  return {
    reason: requireIdentifier(marker.reason, "reason"),
    requestedAt: requireTimestamp(marker.requestedAt, "requestedAt"),
    finalizationId: requireIdentifier(marker.finalizationId, "finalizationId"),
    ...(claimId ? { claimId } : {}),
    ...(claimExpiresAt ? { claimExpiresAt } : {}),
  };
}

export function readExactLinkedFinalizationSettlement(value: unknown): ExactLinkedFinalizationSettlement | undefined {
  if (value === undefined) return undefined;
  const receipt = requireRecord(value, "Linked finalization settlement");
  assertExactKeys(
    receipt,
    ["version", "finalizationId", "requestedAt", "reasonSha256", "completedAt"],
    "Linked finalization settlement",
  );
  if (receipt.version !== 1) throw new Error("Linked finalization settlement version is invalid.");
  return {
    version: 1,
    finalizationId: requireIdentifier(receipt.finalizationId, "finalizationId"),
    requestedAt: requireTimestamp(receipt.requestedAt, "requestedAt"),
    reasonSha256: requireSha256(receipt.reasonSha256, "reasonSha256"),
    completedAt: requireTimestamp(receipt.completedAt, "completedAt"),
  };
}

export function readExactChatTurnAdmissionHandoff(value: unknown): ExactChatTurnAdmissionHandoff | undefined {
  if (value === undefined) return undefined;
  const marker = requireRecord(value, "Chat turn admission handoff");
  assertExactKeys(
    marker,
    [
      "version",
      "admissionId",
      "sessionIncarnationId",
      "turnId",
      "parentRunId",
      "postCommitGenerationId",
      "parentLocalEffectsStatus",
      "childRunIds",
      "childRunIdsSha256",
      "committedAt",
    ],
    "Chat turn admission handoff",
  );
  if (marker.version !== 1 || marker.parentLocalEffectsStatus !== "settled") {
    throw new Error("Chat turn admission handoff version or local effects status is invalid.");
  }
  const childRunIds = requireStringArray(marker.childRunIds, "childRunIds");
  const normalizedChildRunIds = [...new Set(childRunIds)].sort((left, right) => left.localeCompare(right));
  if (
    canonicalJsonString(childRunIds) !== canonicalJsonString(normalizedChildRunIds) ||
    marker.childRunIdsSha256 !== hashChatTurnRuntimeAuthorityValue(childRunIds)
  ) {
    throw new Error("Chat turn admission handoff child-run receipt is invalid.");
  }
  return {
    version: 1,
    admissionId: requireIdentifier(marker.admissionId, "admissionId"),
    sessionIncarnationId: requireIdentifier(marker.sessionIncarnationId, "sessionIncarnationId"),
    turnId: requireIdentifier(marker.turnId, "turnId"),
    parentRunId: requireIdentifier(marker.parentRunId, "parentRunId"),
    postCommitGenerationId: requireIdentifier(marker.postCommitGenerationId, "postCommitGenerationId"),
    parentLocalEffectsStatus: "settled",
    childRunIds,
    childRunIdsSha256: requireSha256(marker.childRunIdsSha256, "childRunIdsSha256"),
    committedAt: requireTimestamp(marker.committedAt, "committedAt"),
  };
}

function readChatTurnRuntimeAuthorityMaterial(value: unknown): ChatTurnRuntimeAuthorityMaterialV1 {
  const material = requireRecord(value, "Chat turn runtime authority material");
  const hasHeartbeatDecisionReceipt = Object.prototype.hasOwnProperty.call(material, "heartbeatDecisionReceipt");
  assertExactKeys(
    material,
    [
      "version",
      "runId",
      "turnId",
      "transitionKind",
      "durableStatus",
      "traceStatus",
      "transitionAt",
      "postCommitGenerationId",
      "postCommitEligibility",
      "waitForEvent",
      "terminalOutput",
      "linkedFinalization",
      "requiredFinalizers",
      ...(hasHeartbeatDecisionReceipt ? ["heartbeatDecisionReceipt"] : []),
    ],
    "Chat turn runtime authority material",
  );
  if (material.version !== CHAT_TURN_RUNTIME_AUTHORITY_VERSION) {
    throw new Error("Chat turn runtime authority material version is invalid.");
  }
  if (!(["waiting", "terminal", "linked_finalization"] as const).includes(material.transitionKind as never)) {
    throw new Error("Chat turn runtime authority transition kind is invalid.");
  }
  if (!(["waiting", "completed", "failed", "cancelled"] as const).includes(material.durableStatus as never)) {
    throw new Error("Chat turn runtime authority durable status is invalid.");
  }
  const waitForEvent = material.waitForEvent === null ? null : requireWaitForEvent(material.waitForEvent);
  const terminalOutput =
    material.terminalOutput === null ? null : requireTerminalOutputMaterial(material.terminalOutput);
  const linkedFinalization =
    material.linkedFinalization === null ? null : requireLinkedFinalizationMaterial(material.linkedFinalization);
  const heartbeatDecisionReceipt = hasHeartbeatDecisionReceipt
    ? readHeartbeatDecisionReceipt(material.heartbeatDecisionReceipt)
    : undefined;
  const parsed: ChatTurnRuntimeAuthorityMaterialV1 = {
    version: CHAT_TURN_RUNTIME_AUTHORITY_VERSION,
    runId: requireIdentifier(material.runId, "runId"),
    turnId: requireIdentifier(material.turnId, "turnId"),
    transitionKind: material.transitionKind as ChatTurnRuntimeAuthorityMaterialV1["transitionKind"],
    durableStatus: material.durableStatus as ChatTurnRuntimeAuthorityMaterialV1["durableStatus"],
    traceStatus: requireTraceStatus(material.traceStatus),
    transitionAt: requireTimestamp(material.transitionAt, "transitionAt"),
    postCommitGenerationId: requireIdentifier(material.postCommitGenerationId, "postCommitGenerationId"),
    postCommitEligibility: requirePostCommitEligibility(material.postCommitEligibility),
    waitForEvent,
    terminalOutput,
    linkedFinalization,
    requiredFinalizers: normalizeRequiredFinalizers(
      requireStringArray(material.requiredFinalizers, "requiredFinalizers"),
    ),
    ...(heartbeatDecisionReceipt ? { heartbeatDecisionReceipt } : {}),
  };
  assertRuntimeAuthorityTransitionShape(parsed);
  return parsed;
}

function assertRuntimeAuthorityTransitionShape(material: ChatTurnRuntimeAuthorityMaterialV1): void {
  const heartbeatDecisionReceipt = material.heartbeatDecisionReceipt;
  if (material.transitionKind === "waiting") {
    if (
      material.durableStatus !== "waiting" ||
      !(["waiting_for_tool", "waiting_for_approval", "waiting_for_user_input"] as const).includes(
        material.traceStatus as never,
      ) ||
      !material.waitForEvent ||
      material.terminalOutput ||
      material.linkedFinalization ||
      heartbeatDecisionReceipt
    ) {
      throw new Error("Waiting Chat turn runtime authority material is internally inconsistent.");
    }
  } else if (material.transitionKind === "linked_finalization") {
    if (
      material.durableStatus !== "failed" ||
      material.traceStatus !== "failed" ||
      material.waitForEvent ||
      material.terminalOutput ||
      !material.linkedFinalization ||
      heartbeatDecisionReceipt
    ) {
      throw new Error("Linked-finalization Chat turn runtime authority material is internally inconsistent.");
    }
  } else {
    const exactCompletedOutput =
      heartbeatDecisionReceipt?.notify === false ? !material.terminalOutput : Boolean(material.terminalOutput);
    const exactTerminalPair =
      (material.durableStatus === "completed" &&
        (material.traceStatus === "completed" || material.traceStatus === "partial") &&
        exactCompletedOutput) ||
      (material.durableStatus === "failed" && material.traceStatus === "failed" && !material.terminalOutput) ||
      (material.durableStatus === "cancelled" && material.traceStatus === "cancelled" && !material.terminalOutput);
    if (
      !exactTerminalPair ||
      material.waitForEvent ||
      material.linkedFinalization ||
      (heartbeatDecisionReceipt && (material.durableStatus !== "completed" || material.traceStatus !== "completed"))
    ) {
      throw new Error("Terminal Chat turn runtime authority material is internally inconsistent.");
    }
  }
  if (
    heartbeatDecisionReceipt &&
    (material.postCommitEligibility.version !== 1 ||
      material.postCommitEligibility.autonomyEnabledAtParentSettlement !== false ||
      material.postCommitEligibility.evalIntegrityTurn !== false ||
      material.postCommitEligibility.humanSession !== false)
  ) {
    throw new Error("Heartbeat runtime authority must disable every post-commit eligibility bit.");
  }
  const exactFinalizers = canonicalJsonString(material.requiredFinalizers);
  const validFinalizers =
    material.transitionKind === "linked_finalization"
      ? [canonicalJsonString(["linked", "general"])]
      : material.durableStatus === "completed"
        ? [canonicalJsonString(["general"]), canonicalJsonString(["autonomous", "general"])]
        : [canonicalJsonString(["general"])];
  if (!validFinalizers.includes(exactFinalizers)) {
    throw new Error("Chat turn runtime authority finalizers do not match the exact transition contract.");
  }
}

function normalizeRequiredFinalizers(value: readonly string[]): ChatTurnRuntimeAuthorityFinalizer[] {
  if (value.some((item) => !(FINALIZER_ORDER as readonly string[]).includes(item))) {
    throw new Error("Chat turn runtime authority contains an unknown finalizer.");
  }
  if (new Set(value).size !== value.length) {
    throw new Error("Chat turn runtime authority contains duplicate finalizers.");
  }
  const normalized = FINALIZER_ORDER.filter((item) => value.includes(item));
  if (canonicalJsonString(value) !== canonicalJsonString(normalized)) {
    throw new Error("Chat turn runtime authority finalizers are not in canonical order.");
  }
  return [...normalized];
}

function requireWaitForEvent(value: unknown): CanonicalChatRuntimeWaitForEvent {
  const wait = requireRecord(value, "waitForEvent");
  assertExactOptionalKeys(wait, ["eventKey"], ["correlationId"], "waitForEvent");
  const correlationId =
    wait.correlationId === undefined ? undefined : requireIdentifier(wait.correlationId, "correlationId");
  return {
    eventKey: requireIdentifier(wait.eventKey, "eventKey"),
    ...(correlationId ? { correlationId } : {}),
  };
}

function requireTerminalOutputMaterial(value: unknown): ChatTurnRuntimeAuthorityTerminalOutputMaterial {
  const output = requireRecord(value, "terminalOutput");
  assertExactKeys(output, ["assistantMessageId", "outputTextSha256", "outputSummarySha256"], "terminalOutput");
  return {
    assistantMessageId: requireIdentifier(output.assistantMessageId, "assistantMessageId"),
    outputTextSha256: requireSha256(output.outputTextSha256, "outputTextSha256"),
    outputSummarySha256: requireSha256(output.outputSummarySha256, "outputSummarySha256"),
  };
}

function requireLinkedFinalizationMaterial(value: unknown): ChatTurnRuntimeAuthorityLinkedFinalizationMaterial {
  const linked = requireRecord(value, "linkedFinalization");
  assertExactKeys(linked, ["finalizationId", "requestedAt", "reasonSha256"], "linkedFinalization");
  return {
    finalizationId: requireIdentifier(linked.finalizationId, "finalizationId"),
    requestedAt: requireTimestamp(linked.requestedAt, "requestedAt"),
    reasonSha256: requireSha256(linked.reasonSha256, "reasonSha256"),
  };
}

function requireAutonomousDelivery(value: unknown): void {
  const delivery = requireRecord(value, "delivery");
  if (delivery.status === "enqueued") {
    assertExactKeys(delivery, ["status", "runId"], "delivery");
    requireIdentifier(delivery.runId, "delivery runId");
    return;
  }
  if (delivery.status === "skipped") {
    assertExactKeys(delivery, ["status", "reason"], "delivery");
    requireIdentifier(delivery.reason, "delivery reason");
    return;
  }
  throw new Error("Autonomous Chat delivery settlement is invalid.");
}

function requireHeartbeatCleanup(value: unknown): void {
  const cleanup = requireRecord(value, "heartbeatCleanup");
  if (["completed", "already_completed", "not_required"].includes(String(cleanup.status))) {
    assertExactKeys(cleanup, ["status"], "heartbeatCleanup");
    return;
  }
  if (["manual_reconciliation", "retryable_failure"].includes(String(cleanup.status))) {
    assertExactKeys(cleanup, ["status", "reason"], "heartbeatCleanup");
    requireIdentifier(cleanup.reason, "heartbeat cleanup reason");
    return;
  }
  throw new Error("Autonomous Chat heartbeat cleanup settlement is invalid.");
}

function requireGeneralPostCommitEffects(value: unknown, label: string): string[] {
  const effects = requireStringArray(value, label);
  if (
    effects.some((effect) => !(GENERAL_POST_COMMIT_EFFECTS as readonly string[]).includes(effect)) ||
    new Set(effects).size !== effects.length
  ) {
    throw new Error(`${label} contains an unknown or duplicate Chat post-commit effect.`);
  }
  return effects;
}

function requireDurableEffectRunIds(value: unknown): Record<string, string> {
  const record = requireRecord(value, "durableEffectRunIds");
  if (
    Object.keys(record).some((effect) => !(GENERAL_POST_COMMIT_DURABLE_EFFECTS as readonly string[]).includes(effect))
  ) {
    throw new Error("General Chat post-commit durable effect receipts contain an unknown key.");
  }
  return Object.fromEntries(
    Object.entries(record).map(([effect, runId]) => [effect, requireIdentifier(runId, `${effect} runId`)]),
  );
}

function requireDurableEffectOutcomes(value: unknown, durableEffectRunIds: Record<string, string>): void {
  const outcomes = requireRecord(value, "durableEffectOutcomes");
  const outcomeKeys = Object.keys(outcomes);
  if (
    outcomeKeys.some((effect) => !(GENERAL_POST_COMMIT_DURABLE_EFFECTS as readonly string[]).includes(effect)) ||
    outcomeKeys.some((effect) => !(effect in durableEffectRunIds)) ||
    Object.keys(durableEffectRunIds).some((effect) => !(effect in outcomes))
  ) {
    throw new Error("General Chat post-commit durable effect outcomes do not exactly match their run receipts.");
  }
  for (const [effect, outcomeValue] of Object.entries(outcomes)) {
    const outcome = requireRecord(outcomeValue, `${effect} outcome`);
    if (outcome.runId !== durableEffectRunIds[effect]) {
      throw new Error(`General Chat post-commit ${effect} outcome run id is invalid.`);
    }
    if (["queued", "running", "waiting", "paused"].includes(String(outcome.status))) {
      assertExactKeys(outcome, ["runId", "status", "observedAt"], `${effect} outcome`);
      requireTimestamp(outcome.observedAt, `${effect} observedAt`);
      continue;
    }
    if (["completed", "failed", "cancelled", "dead_lettered"].includes(String(outcome.status))) {
      assertExactOptionalKeys(outcome, ["runId", "status", "settledAt"], ["error"], `${effect} outcome`);
      requireTimestamp(outcome.settledAt, `${effect} settledAt`);
      if (outcome.error !== undefined) requireIdentifier(outcome.error, `${effect} error`);
      continue;
    }
    throw new Error(`General Chat post-commit ${effect} outcome status is invalid.`);
  }
}

function requirePostCommitEligibility(value: unknown): PostCommitEligibility {
  const eligibility = requireRecord(value, "postCommitEligibility");
  assertExactKeys(
    eligibility,
    ["version", "autonomyEnabledAtParentSettlement", "evalIntegrityTurn", "humanSession"],
    "postCommitEligibility",
  );
  if (
    eligibility.version !== 1 ||
    typeof eligibility.autonomyEnabledAtParentSettlement !== "boolean" ||
    typeof eligibility.evalIntegrityTurn !== "boolean" ||
    typeof eligibility.humanSession !== "boolean"
  ) {
    throw new Error("Post-commit eligibility is invalid.");
  }
  return eligibility as unknown as PostCommitEligibility;
}

function requireTraceStatus(value: unknown): ChatTurnTraceRecord["status"] {
  if (typeof value !== "string" || !(TRACE_STATUSES as readonly string[]).includes(value)) {
    throw new Error("Chat turn trace status is invalid.");
  }
  return value as ChatTurnTraceRecord["status"];
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireBoundedIdentifier(value: unknown, label: string, maxLength = 1_024): string {
  const identifier = requireIdentifier(value, label);
  if (identifier !== identifier.trim() || identifier.length > maxLength) {
    throw new Error(`${label} must be a canonical bounded string.`);
  }
  return identifier;
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireIdentifier(value, label);
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new Error(`${label} must be a canonical UTC millisecond timestamp.`);
  }
  return timestamp;
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  return [...value];
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(record).sort().join(",") !== [...keys].sort().join(",")) {
    throw new Error(`${label} contains missing or unknown keys.`);
  }
}

function assertExactOptionalKeys(
  record: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record);
  if (
    requiredKeys.some((key) => !(key in record)) ||
    actual.some((key) => !requiredKeys.includes(key) && !optionalKeys.includes(key))
  ) {
    throw new Error(`${label} contains missing or unknown keys.`);
  }
}

function readExactHeartbeatDecisionObject(rawOutput: string): Record<string, boolean | string> | undefined {
  let cursor = skipJsonWhitespace(rawOutput, 0);
  if (rawOutput[cursor] !== "{") return undefined;
  cursor = skipJsonWhitespace(rawOutput, cursor + 1);
  const fields: Record<string, boolean | string> = {};
  if (rawOutput[cursor] === "}") return undefined;
  while (cursor < rawOutput.length) {
    const keyToken = readJsonStringToken(rawOutput, cursor);
    if (!keyToken || (keyToken.value !== "notify" && keyToken.value !== "message")) return undefined;
    if (Object.prototype.hasOwnProperty.call(fields, keyToken.value)) return undefined;
    cursor = skipJsonWhitespace(rawOutput, keyToken.end);
    if (rawOutput[cursor] !== ":") return undefined;
    cursor = skipJsonWhitespace(rawOutput, cursor + 1);
    if (keyToken.value === "notify") {
      if (rawOutput.startsWith("true", cursor)) {
        fields.notify = true;
        cursor += 4;
      } else if (rawOutput.startsWith("false", cursor)) {
        fields.notify = false;
        cursor += 5;
      } else {
        return undefined;
      }
    } else {
      const valueToken = readJsonStringToken(rawOutput, cursor);
      if (!valueToken) return undefined;
      fields.message = valueToken.value;
      cursor = valueToken.end;
    }
    cursor = skipJsonWhitespace(rawOutput, cursor);
    if (rawOutput[cursor] === "}") {
      cursor = skipJsonWhitespace(rawOutput, cursor + 1);
      return cursor === rawOutput.length ? fields : undefined;
    }
    if (rawOutput[cursor] !== ",") return undefined;
    cursor = skipJsonWhitespace(rawOutput, cursor + 1);
  }
  return undefined;
}

function readJsonStringToken(value: string, start: number): { value: string; end: number } | undefined {
  if (value[start] !== '"') return undefined;
  for (let cursor = start + 1; cursor < value.length; cursor += 1) {
    const codeUnit = value.charCodeAt(cursor);
    if (codeUnit <= 0x1f) return undefined;
    if (value[cursor] === "\\") {
      cursor += 1;
      const escaped = value[cursor];
      if (!escaped || !'"\\/bfnrtu'.includes(escaped)) return undefined;
      if (escaped === "u") {
        const hex = value.slice(cursor + 1, cursor + 5);
        if (!/^[0-9a-fA-F]{4}$/u.test(hex)) return undefined;
        cursor += 4;
      }
      continue;
    }
    if (value[cursor] === '"') {
      const token = value.slice(start, cursor + 1);
      try {
        const parsed = JSON.parse(token) as unknown;
        return typeof parsed === "string" ? { value: parsed, end: cursor + 1 } : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function skipJsonWhitespace(value: string, start: number): number {
  let cursor = start;
  while (
    cursor < value.length &&
    (value[cursor] === " " || value[cursor] === "\t" || value[cursor] === "\r" || value[cursor] === "\n")
  ) {
    cursor += 1;
  }
  return cursor;
}

function containsOnlyUnicodeScalarValues(value: string): boolean {
  for (let cursor = 0; cursor < value.length; cursor += 1) {
    const codeUnit = value.charCodeAt(cursor);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(cursor + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      cursor += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
