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
 * Who wrote an approval's explanation. A model-written one records its provider or model and arrives after the card,
 * so it is advisory and never stands in for the owner-written consequence (#499); one GoatCitadel wrote from the
 * request itself (a change plan's impact, #543) records neither.
 */
export function splitApprovalExplanation(explanation: ApprovalRequest["explanation"]): {
  owner?: NonNullable<ApprovalRequest["explanation"]>;
  model?: NonNullable<ApprovalRequest["explanation"]>;
} {
  if (!explanation) return {};
  return explanation.providerId || explanation.model ? { model: explanation } : { owner: explanation };
}
import { formatBytes, plural } from "@goatcitadel/mission-control-shared/content/format";
// Approval kinds are open strings (tool ids, "code_mode.run"), so they have no typed presenter.
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";

/**
 * Recorded review text that is diagnostics, not a decision input: content hashes and byte counts. Consequence lines
 * ("Approval permits …") stay visible even when they use internal words (DESIGN › Copy).
 */
const TECHNICAL_SUPPORT = /SHA-256|\bhash\b|\bbytes\b/iu;
const BYTE_COUNT = /(\d+) UTF-8 bytes( before redaction)?/u;
// Clause boundaries: a semicolon, or a sentence end followed by a capitalised sentence (so "e.g. foo" stays whole).
const CLAUSE_BOUNDARY = /;\s+|(?<=[.!?])\s+(?=[A-Z])/u;

function endSentence(clause: string): string {
  return /[.!?]$/u.test(clause) ? clause : `${clause}.`;
}

/**
 * Splits preview support lines into what the operator reads and what belongs in technical details (IN-L01). A line
 * that mixes a hash with decision inputs ("Redaction does not change approved executable arguments.") is split into
 * clauses: only the hash clauses move to technical details, a byte count stays visible as a plain size, and every
 * other clause stays visible.
 */
export function splitApprovalSupport(lines: readonly string[]): { visible: string[]; technical: string[] } {
  const visible: string[] = [];
  const technical: string[] = [];
  for (const line of lines) {
    if (!TECHNICAL_SUPPORT.test(line)) {
      visible.push(line);
      continue;
    }
    for (const raw of line.split(CLAUSE_BOUNDARY)) {
      const clause = raw.trim();
      if (!clause) continue;
      const size = BYTE_COUNT.exec(clause);
      if (size) visible.push(`Content size${size[2] ?? ""}: ${formatBytes(Number(size[1]))}`);
      else if (TECHNICAL_SUPPORT.test(clause)) technical.push(endSentence(clause));
      else visible.push(endSentence(clause));
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
