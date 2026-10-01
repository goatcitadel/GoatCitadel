import { canonicalJsonString, type AutonomousActivationGrantRecord } from "@goatcitadel/contracts";
import { fetchAutonomousActivationGrants } from "@goatcitadel/mission-control-shared/api/client";

export const AUTONOMOUS_GRANT_REVOKE_INPUT = { revokedBy: "operator", reason: "Revoked from Settings." };
export const AUTONOMOUS_GRANT_BOUNDARY =
  "Revocation stops this saved grant from admitting new activations. It does not prove already-running work stopped. The API has no atomic revision precondition; the exact current record is checked before dispatch.";
export const grantsEqual = (left: unknown, right: unknown) => canonicalJsonString(left) === canonicalJsonString(right);

export function assertAutonomousGrant(value: AutonomousActivationGrantRecord): void {
  if (
    !value ||
    !value.grantId ||
    !value.workspaceId ||
    !value.grantor ||
    !value.reason ||
    !["active", "expired", "revoked"].includes(value.status) ||
    !["safe", "caution", "danger", "nuclear"].includes(value.maxRiskLevel) ||
    !Array.isArray(value.surfaces) ||
    !value.surfaces.every((item) => ["chat", "tools", "mcp", "all", "cowork", "code"].includes(item)) ||
    !Array.isArray(value.activationKinds) ||
    !value.activationKinds.every((item) =>
      ["capability", "tool", "mcp_tool", "code_mode", "subagent_fanout"].includes(item),
    ) ||
    !Array.isArray(value.capabilityPatterns) ||
    !Array.isArray(value.toolPatterns) ||
    !Number.isFinite(value.usedActivations) ||
    value.usedActivations < 0 ||
    ![value.createdAt, value.updatedAt, value.expiresAt].every((item) => Number.isFinite(Date.parse(item)))
  ) {
    throw new Error("The Gateway grant record is missing or contradictory.");
  }
}

export async function readAutonomousGrants(signal?: AbortSignal): Promise<AutonomousActivationGrantRecord[]> {
  const result = await fetchAutonomousActivationGrants(true, signal);
  if (!Array.isArray(result.items)) throw new Error("The Gateway grant list is unavailable.");
  const ids = new Set<string>();
  for (const grant of result.items) {
    assertAutonomousGrant(grant);
    if (ids.has(grant.grantId)) throw new Error("The Gateway returned duplicate grant identities.");
    ids.add(grant.grantId);
  }
  return result.items;
}

export function grantCanBeRevoked(value: AutonomousActivationGrantRecord): boolean {
  return value.status === "active" && !value.revokedAt && Date.parse(value.expiresAt) > Date.now();
}

export function autonomousGrantReviewDescription(grant: AutonomousActivationGrantRecord): string {
  return `Revoke ${grant.grantId} in workspace ${grant.workspaceId}${grant.projectId ? `, project ${grant.projectId}` : ""}? Policy contexts: ${grant.surfaces.join(", ")}. Activation kinds: ${grant.activationKinds.join(", ")}. Risk ceiling: ${grant.maxRiskLevel}. Capability patterns: ${grant.capabilityPatterns.join(", ") || "none"}. Tool patterns: ${grant.toolPatterns.join(", ") || "none"}. Used ${grant.usedActivations} of ${grant.maxActivations ?? "unlimited"} activations; budget ${grant.budgetUsd === undefined ? "not specified" : `$${grant.budgetUsd}`}. Expires ${grant.expiresAt}. Granted by ${grant.grantor}: ${grant.reason}. ${AUTONOMOUS_GRANT_BOUNDARY}`;
}

/** Compare immutable grant policy; usage may advance between the non-CAS check and revoke. */
function grantPolicy(value: AutonomousActivationGrantRecord) {
  const {
    status: _status,
    updatedAt: _updatedAt,
    usedActivations: _usedActivations,
    usedBudgetUsd: _usedBudgetUsd,
    lastUsedAt: _lastUsedAt,
    reservationIds: _reservationIds,
    revokedAt: _revokedAt,
    revokedBy: _revokedBy,
    revocationReason: _revocationReason,
    ...policy
  } = value;
  return policy;
}

export function assertAutonomousGrantRevoked(
  before: AutonomousActivationGrantRecord,
  receipt: AutonomousActivationGrantRecord,
): void {
  assertAutonomousGrant(receipt);
  if (
    !grantsEqual(grantPolicy(before), grantPolicy(receipt)) ||
    receipt.status !== "revoked" ||
    !receipt.revokedAt ||
    !Number.isFinite(Date.parse(receipt.revokedAt)) ||
    receipt.updatedAt !== receipt.revokedAt ||
    receipt.revokedBy !== AUTONOMOUS_GRANT_REVOKE_INPUT.revokedBy ||
    receipt.revocationReason !== AUTONOMOUS_GRANT_REVOKE_INPUT.reason
  ) {
    throw new Error("The Gateway did not acknowledge this exact grant revocation.");
  }
}
