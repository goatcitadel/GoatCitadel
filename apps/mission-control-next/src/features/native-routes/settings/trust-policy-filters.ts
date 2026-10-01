import type { TrustPolicySkillDeclaredMetadata } from "@goatcitadel/mission-control-shared/api/trust";
import {
  STATUS_ORDER,
  type TrustPolicyDashboardStatus,
  type TrustPolicyMatrixRow,
  type TrustPolicyStatusFilter,
  type TrustPolicyKindFilter,
} from "./trust-policy-types";
import { normalizeDeclaredGovernance } from "./trust-policy-governance";

export function summarizeTrustPolicyRows(rows: TrustPolicyMatrixRow[]): Record<TrustPolicyDashboardStatus, number> {
  const counts = STATUS_ORDER.reduce(
    (next, status) => ({ ...next, [status]: 0 }),
    {} as Record<TrustPolicyDashboardStatus, number>,
  );
  for (const row of rows) {
    counts[normalizeTrustPolicyStatus(row.status)] += 1;
  }
  return counts;
}

export function filterTrustPolicyRows(
  rows: TrustPolicyMatrixRow[],
  filters: { search: string; statusFilter: TrustPolicyStatusFilter; kindFilter: TrustPolicyKindFilter },
): TrustPolicyMatrixRow[] {
  const query = filters.search.trim().toLowerCase();
  return rows.filter((row) => {
    const status = normalizeTrustPolicyStatus(row.status);
    if (filters.kindFilter !== "all" && row.kind !== filters.kindFilter) {
      return false;
    }
    if (filters.statusFilter === "needs_review") {
      if (
        status !== "blocked" &&
        status !== "quarantined" &&
        status !== "approval_required" &&
        status !== "medium_trust"
      ) {
        return false;
      }
    } else if (filters.statusFilter !== "all" && status !== filters.statusFilter) {
      return false;
    }
    if (!query) {
      return true;
    }
    return trustPolicyRowSearchText(row).includes(query);
  });
}

export function trustPolicyRowSearchText(row: TrustPolicyMatrixRow): string {
  return [
    row.label,
    row.kind,
    row.source,
    row.status,
    row.trustState,
    row.owner,
    row.callableState,
    row.grants?.join(" "),
    row.blockers?.join(" "),
    row.actionNeeded,
    row.bundleWarnings?.join(" "),
    row.missingRequiredEnv?.join(" "),
    declaredGovernanceSearchText(row.declaredMetadata),
    row.lastUse?.label,
    row.lastUse?.runId,
    row.lastUse?.approvalId,
    row.lastUse?.evidenceRef,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
}

export function declaredGovernanceSearchText(meta: TrustPolicySkillDeclaredMetadata | undefined): string | undefined {
  const normalized = normalizeDeclaredGovernance(meta);
  if (!normalized) {
    return undefined;
  }
  const parts = [
    ...normalized.requiredEnv.map((env) => env.name),
    ...normalized.stateDirs.map((dir) => dir.path),
    ...normalized.dependencies.tools,
    ...normalized.dependencies.skillIds,
    ...normalized.dependencies.capabilities,
  ].filter((value): value is string => Boolean(value?.trim()));
  return parts.length ? parts.join(" ") : undefined;
}

export function normalizeTrustPolicyStatus(status: TrustPolicyDashboardStatus | undefined): TrustPolicyDashboardStatus {
  return STATUS_ORDER.includes(status as TrustPolicyDashboardStatus)
    ? (status as TrustPolicyDashboardStatus)
    : "unknown";
}

export function labelForTrustPolicyStatus(status: TrustPolicyDashboardStatus): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "not_callable":
      return "Not callable";
    case "blocked":
      return "Blocked";
    case "quarantined":
      return "Quarantined";
    case "approval_required":
      return "Approval required";
    case "medium_trust":
      return "Medium trust";
    case "experimental":
      return "Experimental";
    default:
      return "Unknown";
  }
}

export function labelForCallableState(row: TrustPolicyMatrixRow): string {
  if (row.callableState === "approval_required") {
    return "Approval required";
  }
  if (row.callableState === "blocked") {
    return "Blocked";
  }
  if (row.callableState === "inspectable") {
    return "Not callable";
  }
  if (row.callable === false || row.callableState === "not_callable") {
    return "Not callable";
  }
  if (row.callable === true || row.callableState === "callable") {
    return "Ready";
  }
  return "Unknown";
}

export function formatList(values: string[] | undefined, emptyLabel: string): string {
  const clean = values?.map((value) => value.trim()).filter(Boolean) ?? [];
  return clean.length ? clean.join(", ") : emptyLabel;
}

export function formatLastUse(row: TrustPolicyMatrixRow): string {
  const lastUse = row.lastUse;
  if (!lastUse) {
    return "No last-use evidence";
  }
  const parts = [
    lastUse.label,
    formatEvidenceDate(lastUse.at),
    lastUse.runId ? `run ${lastUse.runId}` : undefined,
    lastUse.approvalId ? `approval ${lastUse.approvalId}` : undefined,
    lastUse.evidenceRef,
  ].filter((part): part is string => Boolean(part?.trim()));
  return parts.length ? parts.join(" - ") : "No last-use evidence";
}

export function formatEvidenceDate(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}
