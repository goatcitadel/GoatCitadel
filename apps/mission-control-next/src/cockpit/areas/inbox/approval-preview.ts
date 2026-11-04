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

/**
 * Who wrote an approval's explanation. The explainer writes one itself only for a change plan, from the plan's own
 * impact and with no model (#543); every other explanation is model-written, even when its provider or model was
 * saved empty. A model-written one arrives after the card, so it is advisory and never stands in for the
 * owner-written consequence (#499).
 */
export function splitApprovalExplanation(approval: Pick<ApprovalRequest, "kind" | "explanation">): {
  owner?: NonNullable<ApprovalRequest["explanation"]>;
  model?: NonNullable<ApprovalRequest["explanation"]>;
} {
  const explanation = approval.explanation;
  if (!explanation) return {};
  const ownerWritten = approval.kind === "change_plan_effect" && !explanation.providerId && !explanation.model;
  return ownerWritten ? { owner: explanation } : { model: explanation };
}
import { formatBytes, plural } from "@goatcitadel/mission-control-shared/content/format";
// Approval kinds are open strings (tool ids, "code_mode.run"), so they have no typed presenter.
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";

// Match the memory preview owners' exact metadata formats. A word like "hash" can be part of a title or decision.
const ORIGINAL_CONTENT = /^Content Summary: Exact original content: (\d+) UTF-8 bytes; (SHA-256 [\da-f]{64}\.)(?:\s+([\s\S]+))?$/iu;
const REQUESTED_CONTENT = /^(?:Content Summary: )?Requested content: (\d+) UTF-8 bytes before redaction\.$/u;

/**
 * Present the memory preview's byte count and put its digest under technical details. Keep all decision text visible.
 */
export function splitApprovalSupport(lines: readonly string[]): { visible: string[]; technical: string[] } {
  const visible: string[] = [];
  const technical: string[] = [];
  for (const line of lines) {
    const original = ORIGINAL_CONTENT.exec(line);
    if (original) {
      visible.push(`Content size: ${formatBytes(Number(original[1]))}`);
      technical.push(original[2]!);
      if (original[3]) visible.push(original[3]);
    } else {
      const requested = REQUESTED_CONTENT.exec(line);
      visible.push(requested ? `Content size before redaction: ${formatBytes(Number(requested[1]))}` : line);
    }
  }
  return { visible, technical };
}

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
  if (remainingMinutes <= 0) return "Expired";
  if (remainingMinutes < 60) return `Expires in ${plural(remainingMinutes, "minute")}`;
  // Hours round to the nearest hour; past two days the label reads in days (IN-N09).
  const hours = Math.round(remainingMinutes / 60);
  if (hours < 48) return `Expires in about ${plural(hours, "hour")}`;
  return `Expires in about ${plural(Math.round(hours / 24), "day")}`;
}
