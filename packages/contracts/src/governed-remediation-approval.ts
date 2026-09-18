import type { GovernedRemediationScope } from "./governed-remediation.js";

export const GOVERNED_REMEDIATION_APPROVAL_SCHEMA_VERSION = "goatcitadel.remediation-approval.v1" as const;
export type GovernedRemediationApprovalPurpose = "pre_effect" | "activation";

/** One approval covers one immutable repair identity and one phase purpose.
 * Current operation/lease and policy checks remain mandatory at each boundary. */
export interface GovernedRemediationApprovalPayload {
  readonly schemaVersion: typeof GOVERNED_REMEDIATION_APPROVAL_SCHEMA_VERSION;
  readonly purpose: GovernedRemediationApprovalPurpose;
  readonly remediationId: string;
  readonly requesterActorId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly sourceTurnId: string;
  readonly durableRunId: string;
  readonly blockedCheckpointId: string;
  readonly expectedWaitingRunVersion: number;
  readonly recipeId: string;
  readonly recipeVersion: number;
  readonly recipeSha256: string;
  readonly ownerId: string;
  readonly requestedCapabilityId: string;
  readonly scope: GovernedRemediationScope;
  readonly expectedOwnerRevision: string | null;
  /** Activation is additionally bound to the already-applied effect. */
  readonly applicationReceiptId: string | null;
}

export function governedRemediationApprovalKind(purpose: GovernedRemediationApprovalPurpose): string {
  return `runtime.remediation.${purpose}`;
}
