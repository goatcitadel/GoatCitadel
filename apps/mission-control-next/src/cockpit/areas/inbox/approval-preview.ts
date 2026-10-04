import type { ApprovalExplanationStatus, ApprovalRequest } from "@goatcitadel/contracts";

/** Exactly one explanation line: the summary when present, otherwise one status-specific sentence. */
export function approvalExplanationLine(summary: string | undefined, status: ApprovalExplanationStatus | undefined): string {
  const text = summary?.trim();
  if (text) return text;
  if (status === "pending") return "The explanation is still being prepared. Review the action preview before deciding.";
  if (status === "failed") return "The explanation could not be generated. Inspect the action preview before deciding.";
  return "No explanation was requested. Review the action preview before deciding.";
}
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
      ? "Durable run"
      : "Gateway request";
  return {
    title,
    summary,
    source,
    href: `/ops/approvals?approvalId=${encodeURIComponent(approval.approvalId)}&shell=classic`,
  };
}

export function approvalExpiryLabel(expiresAt: string | undefined, now = Date.now()): string | null {
  if (!expiresAt) return null;
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) return null;
  const remainingMinutes = Math.ceil((expiry - now) / 60_000);
  if (remainingMinutes <= 0) return "Expiry passed; verify its current status";
  if (remainingMinutes < 60) return `Expires in ${remainingMinutes} ${remainingMinutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.ceil(remainingMinutes / 60);
  return `Expires in about ${hours} ${hours === 1 ? "hour" : "hours"}`;
}

export function approvalCreatedLabel(createdAt: string): string {
  const created = Date.parse(createdAt);
  return Number.isFinite(created)
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(created)
    : "Time unavailable";
}
