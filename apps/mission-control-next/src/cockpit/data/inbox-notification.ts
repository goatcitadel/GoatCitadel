import type { OperatorInboxItem, OperatorInboxResponse, RealtimeEvent } from "@goatcitadel/contracts";
import type { DerivedRealtimeNotification } from "@goatcitadel/mission-control-shared/state/realtime-derived";
import { inboxMatchesWorkspace } from "../areas/inbox/inbox-presentation";

/** Select a current owner-projected item; never manufacture an Inbox record from a signal. */
export function resolveInboxNotificationItem(
  projection: OperatorInboxResponse,
  event: RealtimeEvent,
  notification: DerivedRealtimeNotification,
  workspaceId: string,
): OperatorInboxItem | undefined {
  if (
    !inboxMatchesWorkspace(projection, workspaceId) ||
    projection.authority !== "derived_projection" ||
    event.eventAuthority === "durable_history" ||
    (event.links?.workspaceId && event.links.workspaceId !== workspaceId)
  )
    return undefined;
  const links = event.links;
  if (!links) return undefined;
  const runId = links.runId ?? links.durableRunId;
  if (links.runId && links.durableRunId && links.runId !== links.durableRunId) return undefined;
  const matches = projection.items.filter((item) => {
    if (item.expiresAt && !(Date.parse(item.expiresAt) > Date.now())) return false;
    if (links.sessionId && item.source.sessionId !== links.sessionId) return false;
    if (links.turnId && item.source.turnId !== links.turnId) return false;
    switch (notification.attentionKind) {
      case "approval_waiting":
        return item.kind === "approval" && Boolean(links.approvalId) && item.source.approvalId === links.approvalId;
      case "operator_blocked":
        return (
          ["user_input", "change_plan"].includes(item.kind) &&
          Boolean(runId || (links.sessionId && links.turnId)) &&
          (!runId || item.source.runId === runId)
        );
      case "run_failed":
        return ["failed_run", "dead_letter"].includes(item.kind) && Boolean(runId) && item.source.runId === runId;
      case "run_completed":
        return item.kind === "completed_background_run" && Boolean(runId) && item.source.runId === runId;
      case "handoff_ready":
        return item.kind === "task_deliverable" && Boolean(links.taskId) && item.source.taskId === links.taskId;
      default:
        return false;
    }
  });
  // Ambiguous signals still refresh Inbox, but do not choose a record for the operator.
  return matches.length === 1 ? matches[0] : undefined;
}

export function inboxItemLocation(item: OperatorInboxItem): string {
  if (item.kind === "approval" && item.source.approvalId)
    return `/inbox?${new URLSearchParams({ approvalId: item.source.approvalId, workspaceId: item.source.workspaceId })}`;
  return `/inbox?${new URLSearchParams({ workspaceId: item.source.workspaceId, item: item.id })}`;
}

/** Tools whose approval summary names a command or code the operator wrote nothing of; it must not pop up by itself. */
const TOAST_SUMMARY_WITHHELD_TOOLS = new Set(["shell.exec", "shell.exec_background", "code_mode.run"]);

/**
 * The description an unprompted toast shows for an Inbox item: its summary, except for an approval of a shell command or
 * a code run, whose summary names the command or code and stays in the Inbox row and detail.
 */
export function inboxToastDescription(item: OperatorInboxItem): string | undefined {
  const toolName = item.source.toolName;
  return item.kind === "approval" && toolName && TOAST_SUMMARY_WITHHELD_TOOLS.has(toolName) ? undefined : item.summary;
}
