import type { ApprovalCreateInput, ApprovalRequest } from "@goatcitadel/contracts";
import { ValidationError } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

// The closed set of approval risk levels. Approvals are persisted without a Zod
// schema (approval-repo), so an out-of-enum riskLevel coming from config/an
// upstream caller would otherwise be stored verbatim and later mis-rank the
// approval (e.g. an unknown level bypassing risk-gated auto-reject thresholds).
const APPROVAL_RISK_LEVELS: ReadonlySet<ApprovalRequest["riskLevel"]> = new Set([
  "safe",
  "caution",
  "danger",
  "nuclear",
]);

function isApprovalRiskLevel(value: unknown): value is ApprovalRequest["riskLevel"] {
  return typeof value === "string" && APPROVAL_RISK_LEVELS.has(value as ApprovalRequest["riskLevel"]);
}

export class ApprovalGate {
  public constructor(private readonly storage: Storage) {}

  public async create(input: ApprovalCreateInput): Promise<ApprovalRequest> {
    // Validate riskLevel against its enum at the gate (fail closed): never
    // persist an approval whose risk level is outside the known set.
    if (!isApprovalRiskLevel(input.riskLevel)) {
      throw new ValidationError({
        field: "riskLevel",
        message: `Unknown approval riskLevel: ${String(input.riskLevel)}`,
      });
    }

    const approval = this.storage.approvals.create(input);
    await this.storage.audit.append("approvals", {
      event: "approval.create",
      approvalId: approval.approvalId,
      kind: approval.kind,
      riskLevel: approval.riskLevel,
      status: approval.status,
    });
    return approval;
  }
}