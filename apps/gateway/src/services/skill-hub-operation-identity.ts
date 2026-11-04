import { createHash } from "node:crypto";
import type { SkillHubOperationIntentTemplate } from "@goatcitadel/contracts";

export function skillHubOperationFingerprint(
  input: Omit<SkillHubOperationIntentTemplate, "operationId" | "idempotencyKey" | "createdAt">,
  pluginInstallPlanId?: string,
): string {
  const parts = [
    input.workspaceId,
    input.operationKind,
    input.snapshotId,
    input.contentTreeSha256,
    input.skillId,
    input.targetCandidateId,
    input.targetVersionId,
    input.supersedesVersionId,
    input.expectedCandidateRevision,
    input.expectedRuntimeRevision,
    input.expectedCandidateAbsent,
    input.expectedRuntimeAbsent,
    input.actorId,
    input.sessionId,
    input.turnId,
  ];
  if (pluginInstallPlanId !== undefined) parts.push("plugin-install-plan", pluginInstallPlanId);
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Validate the existing operator identity, including its optional install generation. */
export function readSkillHubOperationFingerprint(
  intent: SkillHubOperationIntentTemplate,
  pluginInstallPlanId: unknown,
): string | undefined {
  if (
    pluginInstallPlanId !== undefined &&
    (typeof pluginInstallPlanId !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/u.test(pluginInstallPlanId))
  ) {
    return undefined;
  }
  const match = /^skill-hub:lifecycle:([a-f0-9]{64}):([1-9][0-9]*)$/u.exec(intent.idempotencyKey);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return undefined;
  const fingerprint = skillHubOperationFingerprint(intent, pluginInstallPlanId);
  return match[1] === fingerprint && intent.operationId === `skill-hub-op-${fingerprint.slice(0, 32)}-${match[2]}`
    ? fingerprint
    : undefined;
}
