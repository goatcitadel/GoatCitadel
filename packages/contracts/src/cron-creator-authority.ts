import { sha256Hex } from "./sha256.js";
import { canonicalJsonString } from "./canonical-json.js";
import type { CronJobRecord, CronJobCreatorAuthority, CronJobCreatorAuthorityInput } from "./monitoring.js";

type CronActionMaterial = Pick<CronJobRecord, "jobId" | "action" | "actionConfig">;

export function cronCreatorActionSha256(job: CronActionMaterial): string {
  return sha256Hex(
    canonicalJsonString({ jobId: job.jobId, action: job.action, actionConfig: job.actionConfig ?? null }),
  );
}

/** Called only by the canonical cron repository with server-derived actor input. */
export function buildCronCreatorAuthority(
  job: CronActionMaterial,
  input: CronJobCreatorAuthorityInput,
): CronJobCreatorAuthority {
  const actorId = input.actorId.trim();
  const creator = job.actionConfig?.agentTurn?.createdBy;
  if (
    !actorId ||
    actorId.length > 512 ||
    !["authenticated_operator", "admitted_chat"].includes(input.source) ||
    job.action !== "agent_turn" ||
    !creator ||
    !creator.permissionProfileId?.trim() ||
    (creator.operatorId !== actorId && creator.authActorId !== actorId) ||
    (creator.operatorId && creator.operatorId !== actorId) ||
    (creator.authActorId && creator.authActorId !== actorId)
  ) {
    throw new Error("Scheduled creator authority must match its canonical actor and selected profile.");
  }
  return {
    version: "cron.creator-authority.v1",
    jobId: job.jobId,
    actorId,
    source: input.source,
    actionSha256: cronCreatorActionSha256(job),
  };
}

export function hasCurrentCronCreatorAuthority(
  job: CronActionMaterial & { creatorAuthority?: CronJobCreatorAuthority },
): boolean {
  const receipt = job.creatorAuthority;
  if (!receipt || receipt.version !== "cron.creator-authority.v1") return false;
  try {
    return canonicalJsonString(buildCronCreatorAuthority(job, receipt)) === canonicalJsonString(receipt);
  } catch {
    return false;
  }
}
