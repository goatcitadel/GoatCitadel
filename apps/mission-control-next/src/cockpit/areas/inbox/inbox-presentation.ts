import type { OperatorInboxItem, OperatorInboxResponse } from "@goatcitadel/contracts";

export const INBOX_GROUPS = [
  { id: "needs_decision", label: "Needs decision", description: "Requests waiting for your answer" },
  { id: "proposals", label: "Proposals", description: "Changes to inspect before accepting" },
  { id: "needs_attention", label: "Needs attention", description: "Work that needs investigation or recovery" },
  { id: "updates", label: "Updates", description: "Completed work and other background changes" },
] as const;

/** Refuse counts and actions if the owner projection crosses the selected workspace. */
export function inboxMatchesWorkspace(
  projection: OperatorInboxResponse | undefined,
  workspaceId: string,
): projection is OperatorInboxResponse {
  return Boolean(
    projection &&
    projection.workspaceId === workspaceId &&
    projection.items.every((item) => item.source.workspaceId === workspaceId),
  );
}

export function inboxKnownCount(projection: OperatorInboxResponse): { known: number; complete: boolean } {
  return Object.values(projection.counts).reduce(
    (total, count) => ({ known: total.known + count.known, complete: total.complete && count.complete }),
    { known: 0, complete: true },
  );
}

const UNKNOWN_COUNT = "?";

/** Sources whose expected read failed or came back incomplete; declared limits are not gaps. */
export function inboxReadGaps(projection: OperatorInboxResponse) {
  return projection.coverage.filter((source) => source.state === "partial" || source.state === "unavailable");
}

/**
 * The Gateway marks a count incomplete for read gaps and for declared scopes ("limited") alike.
 * Declared limits remain lower bounds; the
 * scope itself is listed under "What this Inbox covers".
 */
export function inboxCountIsExact(projection: OperatorInboxResponse, complete: boolean): boolean {
  return complete;
}

/** Badge text: "3", "3+" when a read gap may hide more, "?" when nothing is known and a read failed. */
export function inboxCountLabel(projection: OperatorInboxResponse | undefined): string | null {
  if (!projection) return null;
  const count = projection.counts.needs_decision;
  if (count.known === 0) return !count.complete ? UNKNOWN_COUNT : null;
  return inboxCountIsExact(projection, count.complete) ? String(count.known) : `${count.known}+`;
}

/** "Inbox, 3 items" / "Inbox, at least 3 items": the count belongs in the control's name. */
export function inboxNavigationLabel(count: string | null): string {
  if (!count) return "Inbox";
  if (count === UNKNOWN_COUNT) return "Inbox, some sources could not be read";
  const lowerBound = count.endsWith("+");
  const number = lowerBound ? count.slice(0, -1) : count;
  const noun = number === "1" ? "decision" : "decisions";
  return lowerBound ? `Inbox, at least ${number} ${noun}` : `Inbox, ${number} ${noun}`;
}

export function inboxCountTitle(count: string): string {
  if (count === UNKNOWN_COUNT) return "Some decision coverage is incomplete";
  return count.endsWith("+") ? "At least this many outstanding decisions" : "Outstanding decisions";
}

export function inboxItemKindLabel(kind: OperatorInboxItem["kind"]): string {
  switch (kind) {
    case "approval":
      return "Approval";
    case "user_input":
      return "Question";
    case "change_plan":
      return "Change plan";
    case "memory_proposal":
      return "Memory proposal";
    case "document_proposal":
      return "Document proposal";
    case "capability_proposal":
      return "Capability proposal";
    case "improvement_proposal":
      return "Improvement proposal";
    case "failed_run":
      return "Failed run";
    case "dead_letter":
      return "Stopped run";
    case "runtime_health":
      return "Runtime health";
    case "backup_trust":
      return "Backup proof";
    case "spend_coverage":
      return "Spend coverage";
    case "task_deliverable":
      return "Task deliverable";
    case "completed_background_run":
      return "Background run";
  }
}
