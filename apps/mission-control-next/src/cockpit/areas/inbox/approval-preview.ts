import type { ApprovalExplanationStatus, ApprovalRequest } from "@goatcitadel/contracts";

/** Exactly one explanation line: the summary when present, otherwise one status-specific sentence. */
export function approvalExplanationLine(
  summary: string | undefined,
  status: ApprovalExplanationStatus | undefined,
): string {
  const text = summary?.trim();
  if (text) return text;
  if (status === "pending")
    return "The explanation is still being prepared. Review the action preview before deciding.";
  if (status === "failed") return "The explanation could not be generated. Inspect the action preview before deciding.";
  return "No explanation was requested. Review the action preview before deciding.";
}
import { plural } from "@goatcitadel/mission-control-shared/content/format";
// Approval kinds are open strings (tool ids, "code_mode.run"), so they have no typed presenter.
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";

/** A preview of one owner queue, not the cross-owner Inbox projection. */
export function approvalPreview(approval: ApprovalRequest): {
  title: string;
  summary: string;
  source: string;
  href: string;
} {
  const title = humanizeToken(approval.kind) || "Approval request";
  const summary = approval.explanation?.summary?.trim() || "Review the exact request and its effects before deciding.";
  const source = approval.linkage?.sessionId
    ? "Conversation"
    : approval.linkage?.durableRunId || approval.linkage?.runId
      ? "Run"
      : "Request";
  return {
    title,
    summary,
    source,
    // The cockpit Inbox owns approval decisions (GL-05).
    href: `/inbox?approvalId=${encodeURIComponent(approval.approvalId)}`,
  };
}

export function approvalExpiryLabel(expiresAt: string | undefined, now = Date.now()): string | null {
  if (!expiresAt) return null;
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) return null;
  const remainingMinutes = Math.ceil((expiry - now) / 60_000);
  if (remainingMinutes <= 0) return "Expiry passed; verify its current status";
  if (remainingMinutes < 60) return `Expires in ${plural(remainingMinutes, "minute")}`;
  const hours = Math.ceil(remainingMinutes / 60);
  return `Expires in about ${plural(hours, "hour")}`;
}
