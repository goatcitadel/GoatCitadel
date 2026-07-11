import type { ApprovalCreateInput, ApprovalObservabilityEffectInput, ApprovalRequest } from "@goatcitadel/contracts";
import { ValidationError } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

export type ApprovalCreateCommitPort = (approval: ApprovalRequest) => ApprovalCreateCommitResult;

export interface ApprovalCreateCommitFinalizer {
  finalize(approval: ApprovalRequest): readonly ApprovalObservabilityEffectInput[] | undefined;
}

export type ApprovalCreateCommitResult =
  | readonly ApprovalObservabilityEffectInput[]
  | ApprovalCreateCommitFinalizer
  | undefined;

export type ApprovalCreatePort = (
  input: ApprovalCreateInput,
  onCreated?: ApprovalCreateCommitPort,
) => Promise<ApprovalRequest>;

function isApprovalCreateCommitFinalizer(value: ApprovalCreateCommitResult): value is ApprovalCreateCommitFinalizer {
  return Boolean(value && typeof value === "object" && "finalize" in value);
}

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
  public constructor(
    private readonly storage: Storage,
    private readonly createApproval?: ApprovalCreatePort,
  ) {}

  public async create(input: ApprovalCreateInput, onCreated?: ApprovalCreateCommitPort): Promise<ApprovalRequest> {
    // Validate riskLevel against its enum at the gate (fail closed): never
    // persist an approval whose risk level is outside the known set.
    if (!isApprovalRiskLevel(input.riskLevel)) {
      throw new ValidationError({
        field: "riskLevel",
        message: `Unknown approval riskLevel: ${String(input.riskLevel)}`,
      });
    }

    if (this.createApproval) {
      return this.createApproval(input, onCreated);
    }

    // Compatibility fallback for direct policy-engine consumers. The shipped
    // Gateway always injects its canonical approval lifecycle through
    // `createApproval`, which atomically records creation evidence, reserves the
    // durable wait run, and queues retryable observability before returning.
    let approval!: ApprovalRequest;
    const runTransaction =
      this.storage.runImmediateTransaction?.bind(this.storage) ?? (<T>(callback: () => T): T => callback());
    runTransaction(() => {
      approval = this.storage.approvals.create(input);
      const extension = onCreated?.(approval);
      if (isApprovalCreateCommitFinalizer(extension)) {
        extension.finalize(approval);
      } else if (Array.isArray(extension) && extension.length > 0) {
        throw new Error(
          "Compatibility approval creation cannot commit observability effects without the canonical approval creation runtime.",
        );
      }
    });
    try {
      await this.storage.audit.append("approvals", {
        event: "approval.create",
        approvalId: approval.approvalId,
        kind: approval.kind,
        riskLevel: approval.riskLevel,
        status: approval.status,
      });
    } catch (error) {
      void error;
      // Compatibility consumers do not have the Gateway approval outbox. The
      // approval and registration transaction is nevertheless authoritative;
      // an unavailable advisory audit sink must not invite duplicate creation.
    }
    return approval;
  }
}
