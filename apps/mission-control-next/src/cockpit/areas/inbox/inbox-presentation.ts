import type { OperatorInboxItem, OperatorInboxResponse } from "@goatcitadel/contracts";

export const INBOX_GROUPS = [
  { id: "needs_decision", label: "Needs decision", description: "Requests waiting for your answer" },
  { id: "proposals", label: "Proposals", description: "Changes to inspect before accepting" },
  { id: "needs_attention", label: "Needs attention", description: "Work that needs investigation or recovery" },
  { id: "updates", label: "Updates", description: "Completed work and other background changes" },
] as const;

/** Refuse counts and actions if the owner projection crosses the selected workspace. */
export function inboxMatchesWorkspace(projection: OperatorInboxResponse | undefined, workspaceId: string): projection is OperatorInboxResponse {
  return Boolean(projection && projection.workspaceId === workspaceId
    && projection.items.every((item) => item.source.workspaceId === workspaceId));
}

export function inboxKnownCount(projection: OperatorInboxResponse): { known: number; complete: boolean } {
  return Object.values(projection.counts).reduce((total, count) => ({
    known: total.known + count.known,
    complete: total.complete && count.complete,
  }), { known: 0, complete: true });
}

export function inboxCountLabel(projection: OperatorInboxResponse | undefined): string | null {
  if (!projection) return null;
  const count = inboxKnownCount(projection);
  if (count.complete && count.known === 0) return null;
  if (!count.complete && count.known === 0) return "?";
  return count.complete ? String(count.known) : `${count.known}+`;
}

export function inboxItemKindLabel(kind: OperatorInboxItem["kind"]): string {
  switch (kind) {
    case "approval": return "Approval";
    case "user_input": return "Question";
    case "change_plan": return "Change plan";
    case "memory_proposal": return "Memory proposal";
    case "document_proposal": return "Document proposal";
    case "capability_proposal": return "Capability proposal";
    case "improvement_proposal": return "Improvement proposal";
    case "failed_run": return "Failed run";
    case "dead_letter": return "Stopped run";
    case "runtime_health": return "Runtime health";
    case "backup_trust": return "Backup proof";
    case "spend_coverage": return "Spend coverage";
    case "task_deliverable": return "Task deliverable";
    case "completed_background_run": return "Background run";
  }
}
