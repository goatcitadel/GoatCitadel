import type { PendingApprovalAction } from "@goatcitadel/contracts";
import { CODE_MODE_REQUEST_TOOL_NAME } from "@goatcitadel/policy-engine";
import type { ToolDomainExecutionFailure } from "./tool-domain-result-truth.js";

/**
 * Whether an approved `code_mode.request` that ran but reported a failure (Code Mode switched off, or the guest
 * returned an error) counts as executed-with-error. The waiting Chat turn then resumes with the error in the tool
 * result, so the model can explain or try again, instead of the turn ending as failed. A refused or blocked
 * execution, and anything that needs manual reconciliation, still fails the turn.
 */
export function isResumableCodeModeRequestFailure(
  pendingAction: Pick<PendingApprovalAction, "actionType" | "request"> | undefined,
  outcome: unknown,
  failure: ToolDomainExecutionFailure | undefined,
): boolean {
  return (
    pendingAction?.actionType === "tool.invoke" &&
    pendingAction.request?.toolName === CODE_MODE_REQUEST_TOOL_NAME &&
    outcome === "executed" &&
    failure?.kind === "failed" &&
    !failure.manualReconciliationRequired
  );
}
