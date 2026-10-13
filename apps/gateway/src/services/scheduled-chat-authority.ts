import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  ConflictError,
  isCronRunTerminalStatus,
  isDurableRunTerminal,
  readDurableChatTurnExecutionPayloadAuthority,
  hasCurrentCronCreatorAuthority,
  type ChatTurnFeatureReferences,
  type CronAgentTurnConfig,
  type CronRunExecutionToken,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { ActiveTurnAdmission } from "./chat-turn-types.js";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import {
  CRON_CHAT_ADMISSION_IDENTITY_VERSION,
  type CanonicalCronChatAdmissionIdentity,
} from "./chat-durable-runtime-authority.js";
import { normalizeAgentTurnCronActionConfig } from "./gateway/cron-agent-turn-support.js";
import { buildAutonomousTurnContext, SCHEDULED_TURN_PERMISSION_PROFILE_ID } from "./gateway/autonomous-turn-policy.js";
import {
  buildScheduledCreatorIntersectionProfile,
  permissionProfileAppliesToCreator,
} from "./gateway/scheduled-profile-intersection.js";

export type ScheduledOccurrenceReference = NonNullable<ChatTurnFeatureReferences["scheduledOccurrence"]>;
export interface ScheduledChatAuthorityHost {
  storage: Pick<AsyncStorage, "cronJobs" | "cronRuns" | "permissionProfiles"> &
    Partial<Pick<AsyncStorage, "agentCommitments">>;
  listToolNames(): string[];
  isFeatureEnabled(flag: string): Promise<boolean>;
}

export function buildCronChatAdmissionIdentity(token: CronRunExecutionToken): CanonicalCronChatAdmissionIdentity {
  const cronRunId = token.runId.trim(),
    jobId = token.jobId.trim(),
    executionGeneration = token.executionGeneration;
  if (!cronRunId || !jobId || !Number.isSafeInteger(executionGeneration) || executionGeneration < 1) {
    throw new Error(
      "Deterministic cron Chat admission requires a canonical cron run, job and positive execution generation.",
    );
  }
  const digest = createHash("sha256")
    .update(`${CRON_CHAT_ADMISSION_IDENTITY_VERSION}\0${cronRunId}`)
    .digest("hex")
    .slice(0, 40);
  return {
    version: CRON_CHAT_ADMISSION_IDENTITY_VERSION,
    cronRunId,
    jobId,
    executionGeneration,
    userMessageId: `msg_cron_user_${digest}`,
    turnId: `turn_cron_${digest}`,
    assistantMessageId: `msg_cron_assistant_${digest}`,
    durableRunId: `run_cron_chat_${digest}`,
  };
}

export function buildScheduledOccurrenceReference(
  identity: CanonicalCronChatAdmissionIdentity,
): ScheduledOccurrenceReference {
  return {
    ownerId: identity.cronRunId,
    revision: String(identity.executionGeneration),
    sha256: createHash("sha256").update(canonicalJsonString(identity)).digest("hex"),
  };
}

/** Current owner and immutable snapshot checks; this reference itself grants no authority. */
export async function readCurrentScheduledOccurrence(
  host: Pick<ScheduledChatAuthorityHost, "storage">,
  reference: ScheduledOccurrenceReference,
) {
  const run = await host.storage.cronRuns.get(reference.ownerId);
  if (!run || run.action !== "agent_turn" || isCronRunTerminalStatus(run.status))
    fail("Scheduled occurrence is no longer active.");
  const identity = buildCronChatAdmissionIdentity(run);
  if (canonicalJsonString(buildScheduledOccurrenceReference(identity)) !== canonicalJsonString(reference))
    fail("Scheduled occurrence reference differs from its canonical owner.");
  const job = await host.storage.cronJobs.get(run.jobId);
  if (!job || job.activeRunId !== run.runId || job.executionGeneration !== run.executionGeneration)
    fail("Scheduled occurrence lost its current execution generation.");
  if (run.actionSnapshot.action !== "agent_turn") fail("Scheduled occurrence has no immutable agent action.");
  const config = normalizeAgentTurnCronActionConfig(
    run.actionSnapshot.actionConfig as Record<string, unknown>,
  )?.agentTurn;
  if (!config || config.inertInboxFallback) fail("Scheduled occurrence is an inert reminder.");
  return { run, identity, config, job };
}

/** Revalidate at admission, durable prep, resume and each provider/tool dispatch. */
export async function assertScheduledOccurrenceCurrent(
  host: ScheduledChatAuthorityHost,
  input: {
    reference: ScheduledOccurrenceReference;
    admission: Pick<ActiveTurnAdmission, "identity" | "requestActor" | "admittedRequest" | "durableClaim">;
  },
) {
  if (
    !(await host.isFeatureEnabled("scheduledChatTurnsV1Enabled")) ||
    (await host.isFeatureEnabled("autonomyV1Disabled"))
  )
    fail("Scheduled Chat execution is disabled.");
  const { run, identity, config, job } = await readCurrentScheduledOccurrence(host, input.reference);
  if (
    !config.createdBy ||
    (!config.commitment &&
      !hasCurrentCronCreatorAuthority({
        ...job,
        action: "agent_turn",
        actionConfig: run.actionSnapshot.actionConfig as typeof job.actionConfig,
      }))
  ) {
    fail("Scheduled creator authority is missing or differs from the immutable occurrence.");
  }
  if (config.commitment) {
    if (!(await host.isFeatureEnabled("commitmentScheduledTurnsV1Enabled")) || !host.storage.agentCommitments)
      fail("Commitment Chat execution is disabled.");
    await host.storage.agentCommitments.assertScheduledOccurrence(run.runId, config);
  }
  const { admission } = input;
  const systemActorId = `system:cron:${run.jobId}`;
  if (
    admission.requestActor.actorKind !== "system" ||
    admission.requestActor.actorId !== systemActorId ||
    admission.identity.turnId !== identity.turnId ||
    (admission.durableClaim && admission.durableClaim.durableRunId !== identity.durableRunId) ||
    (run.childSessionId && run.childSessionId !== admission.identity.sessionId) ||
    (run.childTurnId && run.childTurnId !== identity.turnId) ||
    (run.childDurableRunId && run.childDurableRunId !== identity.durableRunId) ||
    admission.admittedRequest.content !== config.prompt ||
    admission.admittedRequest.permissionProfileId !== SCHEDULED_TURN_PERMISSION_PROFILE_ID ||
    (config.sessionId && config.sessionId !== admission.identity.sessionId)
  )
    fail("Scheduled Chat admission does not match the exact occurrence and actor.");
  const expectedPolicy = buildAutonomousTurnContext({
    kind: "scheduled",
    systemActorId,
    runId: run.runId,
    sessionId: admission.identity.sessionId,
  }).policyContext;
  {
    const creatorId = config.createdBy.permissionProfileId?.trim();
    if (!creatorId) fail("Scheduled creator has no permission profile provenance.");
    const creator = await host.storage.permissionProfiles.getProfile(creatorId);
    if (
      creator.status !== "active" ||
      !permissionProfileAppliesToCreator({
        profile: creator,
        creatorActorId: config.createdBy.operatorId?.trim() || config.createdBy.authActorId?.trim(),
        workspaceId: admission.identity.workspaceId,
      })
    )
      fail("Scheduled creator permission scope is no longer active.");
    const intersection = buildScheduledCreatorIntersectionProfile({
      creatorProfile: creator,
      runId: run.runId,
      knownToolNames: host.listToolNames(),
      now: run.createdAt,
    });
    expectedPolicy.permissionProfile = intersection;
    expectedPolicy.permissionProfileId = intersection.profileId;
    expectedPolicy.workspaceId = admission.identity.workspaceId;
  }
  const request = admission.admittedRequest as typeof admission.admittedRequest & { policyContext?: unknown };
  if (canonicalJsonString(request.policyContext) !== canonicalJsonString(expectedPolicy))
    fail("Scheduled creator or restricted policy changed after admission.");
  return { run, identity, config };
}

export function assertScheduledConfigMatches(config: CronAgentTurnConfig, admitted: CronAgentTurnConfig): void {
  const normalized = normalizeAgentTurnCronActionConfig({ agentTurn: config })?.agentTurn;
  if (canonicalJsonString(normalized) !== canonicalJsonString(admitted))
    fail("Scheduled invocation differs from its immutable action snapshot.");
}

/** Only the durable owner can supply the actor/request checked at dispatch. */
export async function assertScheduledChatDispatchCurrent(
  host: ScheduledChatAuthorityHost & {
    storage: ScheduledChatAuthorityHost["storage"] & Pick<AsyncStorage, "durableRuns" | "sessionMutationAdmissions">;
  },
  input: Pick<
    ChatTurnAgentRunnerInput,
    "featureAdmission" | "policyRunId" | "canonicalWriteFence" | "sessionId" | "turnId" | "workspaceId"
  >,
): Promise<void> {
  const expected = input.featureAdmission;
  if (!expected?.references.scheduledOccurrence) return;
  const runId = input.policyRunId;
  if (!runId || !input.canonicalWriteFence) fail("Scheduled dispatch requires a durable write fence.");
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
      fail("Scheduled durable payload no longer owns this dispatch.");
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
      admitted.status === "cancelled" ||
      admitted.actorKind !== "system" ||
      admitted.actorId !== payload.requestActor.actorId ||
      !features ||
      features.referenceSha256 !== expected.referenceSha256 ||
      canonicalJsonString(features.references) !== canonicalJsonString(expected.references) ||
      createHash("sha256").update(canonicalJsonString(features.references)).digest("hex") !== expected.referenceSha256
    )
      fail("Scheduled dispatch feature binding is stale.");
    const current = await assertScheduledOccurrenceCurrent(host, {
      reference: expected.references.scheduledOccurrence!,
      admission: {
        identity,
        admittedRequest: payload.request as ActiveTurnAdmission["admittedRequest"],
        requestActor: payload.requestActor as ActiveTurnAdmission["requestActor"],
      },
    });
    if (
      current.identity.durableRunId !== runId ||
      canonicalJsonString(payload.cronAdmission) !== canonicalJsonString(current.identity)
    ) {
      fail("Scheduled dispatch has conflicting cron authority.");
    }
  });
}

function fail(message: string): never {
  throw new ConflictError({ message });
}
