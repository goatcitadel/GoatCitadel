import type { TrustPolicySkillDeclaredMetadata } from "@goatcitadel/mission-control-shared/api/trust";

export type TrustPolicyDashboardStatus =
  | "ready"
  | "not_callable"
  | "blocked"
  | "quarantined"
  | "approval_required"
  | "medium_trust"
  | "experimental"
  | "unknown";
export type TrustPolicyEntryKind = "capability" | "tool" | "source";
export type TrustPolicyCallableState = "callable" | "inspectable" | "not_callable" | "approval_required" | "blocked";
export type TrustPolicyStatusFilter = TrustPolicyDashboardStatus | "all" | "needs_review";
export type TrustPolicyKindFilter = TrustPolicyEntryKind | "all";

export interface TrustPolicyMatrixRow {
  id: string;
  kind: TrustPolicyEntryKind;
  label: string;
  source?: string;
  status: TrustPolicyDashboardStatus;
  trustState?: string;
  owner?: string;
  callableState?: TrustPolicyCallableState;
  callable?: boolean;
  grants?: string[];
  blockers?: string[];
  declaredMetadata?: TrustPolicySkillDeclaredMetadata;
  bundleWarnings?: string[];
  missingRequiredEnv?: string[];
  actionNeeded?: string;
  lastUse?: {
    at?: string;
    label?: string;
    runId?: string;
    approvalId?: string;
    evidenceRef?: string;
  } | null;
}

export interface TrustPolicyDeclaredGovernanceView {
  requiredEnv: Array<{ name: string; secret?: boolean }>;
  stateDirs: Array<{ path: string; writeable?: boolean }>;
  dependencies: {
    tools: string[];
    skillIds: string[];
    capabilities: string[];
  };
}

export const STATUS_ORDER: TrustPolicyDashboardStatus[] = [
  "ready",
  "not_callable",
  "blocked",
  "quarantined",
  "approval_required",
  "medium_trust",
  "experimental",
  "unknown",
];
