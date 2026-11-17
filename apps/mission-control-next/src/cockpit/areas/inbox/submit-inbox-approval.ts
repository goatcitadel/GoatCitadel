import type {
  ApprovalRequest,
  ChatToolGrantDuration,
  OperatorInboxItem,
  ToolGrantRecord,
} from "@goatcitadel/contracts";
import { formatAbsoluteTime } from "@goatcitadel/mission-control-shared/content/format";
import { resolveApproval } from "@goatcitadel/mission-control-shared/api/client";
import { approveChatToolTemporarily } from "@goatcitadel/mission-control-shared/api/chat";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import type { ReactNode } from "react";
import { approvalDecisionMessage, approvalExpiredUnresolved } from "./approval-settlement";
import { updateInboxApprovalAttempt } from "./inbox-approval-attempts";
import { CHANGED_APPROVAL_RECORD, canResolveInboxApproval, matchesInboxApprovalDecision } from "./inbox-approval-guard";
import { runPrepareApprove, type PrepareApprove } from "./prepare-approve";
import type { SpecialistEvidence } from "./specialist-approval-evidence";
import { specialistEvidenceKey } from "./specialist-approval-key";

type Submission = {
  approval: ApprovalRequest;
  decision: "approve" | "reject";
  workspaceId: string;
  item?: OperatorInboxItem;
  token: symbol;
  specializedReview: boolean;
  specialistReady: boolean;
  specialistEvidence?: SpecialistEvidence;
  specialistCode?: typeof import("./specialist-approval-code");
  prepareApprove?: PrepareApprove;
  readCurrent: () => Promise<ApprovalRequest | null>;
  isCurrent: () => boolean;
  canRecoverConflict?: () => boolean;
  temporaryGrant?: { sessionId: string; duration: ChatToolGrantDuration };
  onError: (line: ReactNode) => void;
  onInvalidated: (message?: string, line?: ReactNode) => void;
};

const APPROVED_IN_ANOTHER_TAB = "Approved in another tab";
const DENIED_IN_ANOTHER_TAB = "Denied in another tab";

type ApprovalSubmission = { message: string; decisionElsewhere?: "approve" | "reject"; grant?: ToolGrantRecord };

/** Revalidate the reviewed record and caller after loading code and before dispatch. */
export async function submitInboxApproval({
  approval,
  decision,
  workspaceId,
  item,
  token,
  specializedReview,
  specialistReady,
  specialistEvidence,
  specialistCode,
  prepareApprove,
  readCurrent,
  isCurrent,
  canRecoverConflict,
  temporaryGrant,
  onError,
  onInvalidated,
}: Submission): Promise<ApprovalSubmission | undefined> {
  if (!isCurrent()) return;
  function recordedDecision(settled: ApprovalRequest | null): ApprovalSubmission | undefined {
    if (!settled || !canRecoverConflict?.()) return;
    const decisionElsewhere = settled.status === "rejected" ? "reject" : "approve";
    if (!matchesInboxApprovalDecision(item, approval, settled, workspaceId, decisionElsewhere)) return;
    const message =
      approvalExpiredUnresolved(settled) || settled.resolutionOutcome === "expired"
        ? "Approval expired."
        : settled.resolutionOutcome === "withdrawn"
          ? "Approval withdrawn."
          : settled.resolutionOutcome === "policy_blocked"
            ? "Approval blocked by policy."
            : decisionElsewhere === "reject"
              ? DENIED_IN_ANOTHER_TAB
              : APPROVED_IN_ANOTHER_TAB;
    updateInboxApprovalAttempt(
      workspaceId,
      approval.approvalId,
      token,
      "resolved",
      "Refreshing the recorded decision…",
    );
    return { message, decisionElsewhere };
  }
  let mutationAttempted = false;
  try {
    const latest = await readCurrent();
    const other = recordedDecision(latest);
    if (other) return other;
    if (!isCurrent()) return;
    const record = latest ?? undefined;
    if (
      !canResolveInboxApproval(
        item,
        approval,
        record,
        workspaceId,
        Date.now(),
        specialistReady || decision === "reject",
      )
    ) {
      onError(CHANGED_APPROVAL_RECORD);
      if (approval.kind.startsWith("mcp.") && approval.preview?.reviewKind === "mcp.operation") {
        onInvalidated(CHANGED_APPROVAL_RECORD);
      } else {
        onInvalidated();
      }
      return;
    }
    if (specializedReview && decision === "approve") {
      if (!specialistCode) return;
      const fresh = await specialistCode.readSpecialistEvidence(approval);
      if (!isCurrent()) return;
      if (
        !canResolveInboxApproval(item, approval, record, workspaceId, Date.now(), true) ||
        !specialistEvidence ||
        !specialistCode.specialistEvidenceMatches(approval, fresh) ||
        specialistEvidenceKey(fresh) !== specialistEvidenceKey(specialistEvidence)
      ) {
        const message = "Specialist review changed. Refresh and review the current target before approving.";
        onError(message);
        onInvalidated(message);
        return;
      }
    }
    if (decision === "approve" && prepareApprove) {
      const failure = await runPrepareApprove(prepareApprove, workspaceId, approval.approvalId, token);
      // Preparation may already have changed something. The owner explains why a departed review stopped.
      const outlived = !isCurrent();
      if (outlived) onInvalidated(failure?.summary, failure?.line);
      else if (failure) onError(failure.line);
      if (outlived || failure) return;
    }
    updateInboxApprovalAttempt(
      workspaceId,
      approval.approvalId,
      token,
      "submitted",
      "Recording the approval decision…",
    );
    mutationAttempted = true;
    if (temporaryGrant) {
      const result = await approveChatToolTemporarily(
        temporaryGrant.sessionId,
        approval.approvalId,
        temporaryGrant.duration,
      );
      const settled = await readCurrent();
      if (!matchesInboxApprovalDecision(item, approval, settled ?? undefined, workspaceId, "approve")) {
        throw new Error("The recorded decision does not match the reviewed action.");
      }
      const grant = result.grant;
      const expires = Date.parse(grant?.expiresAt ?? "");
      if (
        grant &&
        (grant.scope !== "session" ||
          grant.scopeRef !== temporaryGrant.sessionId ||
          grant.toolPattern !== approval.kind ||
          grant.decision !== "allow" ||
          grant.grantType !== "ttl" ||
          !Number.isFinite(expires))
      ) {
        throw new Error("The recorded allowance does not match this Chat and tool.");
      }
      const message = grant
        ? `Approved. This tool is allowed in this Chat until ${formatAbsoluteTime(expires)}.`
        : "Approved once. The temporary allowance could not be created.";
      updateInboxApprovalAttempt(workspaceId, approval.approvalId, token, "resolved", message);
      return { message, grant };
    }
    const result = await resolveApproval(approval.approvalId, decision);
    if (!matchesInboxApprovalDecision(item, approval, result.approval, workspaceId, decision)) {
      throw new Error("The returned record does not confirm this approval and decision.");
    }
    const message = approvalDecisionMessage(result.approval, result.effects);
    updateInboxApprovalAttempt(workspaceId, approval.approvalId, token, "resolved", message);
    return { message };
  } catch (cause) {
    if (mutationAttempted) {
      if (isApiRequestError(cause) && cause.status === 409 && canRecoverConflict?.()) {
        // The competing decision may have replaced the mounted review. Re-read the same scoped record
        // without requiring that old leaf to stay mounted, and never submit a second decision here.
        const other = recordedDecision(await readCurrent().catch(() => null));
        if (other) return other;
      }
      updateInboxApprovalAttempt(
        workspaceId,
        approval.approvalId,
        token,
        "uncertain",
        "Decision outcome is uncertain. Check again to read the current record before taking another action.",
      );
    } else if (isCurrent()) {
      onError(`Could not check the current approval. ${describeApiError(cause).summary}`);
    }
  }
}
