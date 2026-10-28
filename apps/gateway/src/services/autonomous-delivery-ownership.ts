import { canonicalJsonString, hasCurrentCronCreatorAuthority, type CronAgentTurnConfig } from "@goatcitadel/contracts";
import { resolveCommitmentDeliveryChannel, type ChatAutonomousTurnDeps } from "./chat-autonomous-turn-service.js";
import type { CanonicalCronChatAdmissionIdentity } from "./chat-durable-runtime-authority.js";
import {
  buildScheduledOccurrenceReference,
  readCurrentScheduledOccurrence,
  type ScheduledChatAuthorityHost,
} from "./scheduled-chat-authority.js";

type DeliveryChannel = NonNullable<CronAgentTurnConfig["deliveryChannel"]>;

export interface AutonomousDeliveryOwnershipInput {
  sessionId: string;
  deliveryChannel: DeliveryChannel;
  systemActorId?: string;
  /** The turn's cron admission identity, from its server-written durable run metadata. */
  cronAdmission?: unknown;
}

/**
 * Whether an autonomous chat reply is GoatCitadel's own delivery (operator ruling P2-R19). It is own only when its
 * source is known not to be the AI, read on the server from the scheduled occurrence that produced the reply:
 * - an operator-made schedule: the job's creator receipt says an authenticated operator made it, and the receipt
 *   still matches the occurrence's frozen action (`schedule.manage` jobs carry an `admitted_chat` receipt); or
 * - a commitment follow-up whose target is the session's own bound channel.
 * Anything else, including a source that can't be resolved, is not own and stays subject to a switched-off group.
 */
export async function isOwnAutonomousDelivery(
  input: AutonomousDeliveryOwnershipInput,
  scheduledHost: Pick<ScheduledChatAuthorityHost, "storage">,
  autonomousDeps: Pick<ChatAutonomousTurnDeps, "storage" | "listConnectorRecords">,
): Promise<boolean> {
  const admission = readCronAdmission(input.cronAdmission);
  if (!admission || input.systemActorId !== `system:cron:${admission.jobId}`) {
    return false;
  }
  let occurrence: Awaited<ReturnType<typeof readCurrentScheduledOccurrence>>;
  try {
    occurrence = await readCurrentScheduledOccurrence(scheduledHost, buildScheduledOccurrenceReference(admission));
  } catch {
    // The occurrence is gone, settled or changed: its source can't be vouched for, so the reply is not own.
    return false;
  }
  const { job, run, config } = occurrence;
  if (!sameChannel(config.deliveryChannel, input.deliveryChannel)) {
    return false;
  }
  if (config.commitment) {
    let boundChannel: Awaited<ReturnType<typeof resolveCommitmentDeliveryChannel>>;
    try {
      boundChannel = await resolveCommitmentDeliveryChannel(autonomousDeps, input.sessionId);
    } catch {
      // The bound channel can't be read, so the reply isn't own. It is still enqueued; only a switched-off group stops it.
      return false;
    }
    return config.sessionId === input.sessionId && sameChannel(boundChannel, input.deliveryChannel);
  }
  return (
    job.creatorAuthority?.source === "authenticated_operator" &&
    hasCurrentCronCreatorAuthority({
      ...job,
      action: "agent_turn",
      actionConfig: run.actionSnapshot.actionConfig as typeof job.actionConfig,
    })
  );
}

function readCronAdmission(value: unknown): CanonicalCronChatAdmissionIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const admission = value as Partial<CanonicalCronChatAdmissionIdentity>;
  return typeof admission.cronRunId === "string" &&
    typeof admission.jobId === "string" &&
    Number.isSafeInteger(admission.executionGeneration)
    ? (admission as CanonicalCronChatAdmissionIdentity)
    : undefined;
}

function sameChannel(left: DeliveryChannel | undefined, right: DeliveryChannel): boolean {
  return (
    left !== undefined &&
    canonicalJsonString({ channelKey: left.channelKey.trim(), target: left.target?.trim() || null }) ===
      canonicalJsonString({ channelKey: right.channelKey.trim(), target: right.target?.trim() || null })
  );
}
