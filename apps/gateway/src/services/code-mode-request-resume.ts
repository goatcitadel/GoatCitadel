import type { ChatToolRunRecord, PendingApprovalAction } from "@goatcitadel/contracts";
import { CODE_MODE_REQUEST_TOOL_NAME } from "@goatcitadel/policy-engine";
import type { ToolDomainExecutionFailure } from "./tool-domain-result-truth.js";

// Recognize the complete standalone request, not an instruction embedded in a broader prompt.
const STANDALONE_CODE_MODE_REQUEST =
  /^Use the governed code_mode\.request tool and open its operator approval card\. Goal: [^.!?\r\n]+\. Language: JavaScript\. Source: ([^\r\n]+?) Reads: none\.(?: This only requests approval for a bounded computation, with no workspace edits, shell commands, or network\.)?(?: Please request approval even if Code Mode is currently off\.)?(?: Report only the recorded result\.)?$/iu;

export function readStandaloneCodeModeSource(content: string): string | undefined {
  return STANDALONE_CODE_MODE_REQUEST.exec(content.trim())?.[1]?.trim();
}

/** Report the sole, successful, approved numeric result without a second model call. */
export function formatRecordedCodeModeResult(source: string, runs: readonly ChatToolRunRecord[]): string | undefined {
  if (runs.length !== 1) return undefined;
  const [run] = runs;
  if (
    !run ||
    run.toolName !== CODE_MODE_REQUEST_TOOL_NAME ||
    !run.approvalId ||
    run.reused ||
    run.status !== "executed" ||
    !run.finishedAt ||
    run.args?.source !== source ||
    (run.args.reads !== undefined && (!Array.isArray(run.args.reads) || run.args.reads.length !== 0)) ||
    run.result?.status !== "completed" ||
    typeof run.result.runId !== "string" ||
    !run.result.runId
  )
    return undefined;

  const result = run.result.result;
  const value =
    result && typeof result === "object" && "value" in result && Object.keys(result).length === 1
      ? result.value
      : result;
  return typeof value === "number" && Number.isFinite(value) ? `Code Mode returned **${value}**.` : undefined;
}

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
