import type { RealtimeEvent } from "@goatcitadel/contracts";

// These exact producers publish after their canonical owner writes. Keep this
// list separate from notification heuristics: a diagnostic is not a mutation.
const APPROVAL_EVENTS = new Set(["approval_created", "approval_resolved"]);
const TASK_EVENTS = new Set(["task_created", "task_updated", "task_deleted", "deliverable_added"]);
const PLAN_EVENTS = new Set([
  "change_plan.created", "change_plan.staging", "change_plan.applying", "change_plan.rolling_back",
  "change_plan.cancelled", "change_plan.rollback_requested", "change_plan.awaiting_approval",
  "change_plan.verifying", "change_plan.awaiting_input", "change_plan.awaiting_confirmation",
  "change_plan.monitoring", "change_plan.completed", "change_plan.applied", "change_plan.manual_required",
  "change_plan.failed", "change_plan.rolled_back", "change_plan.rollback_failed", "change_plan.expired",
]);
const DURABLE_TRANSITIONS = new Set([
  "durable_run_failed", "durable_run_dead_lettered", "durable_run_retry_scheduled",
  "durable_dead_letter_recovered", "durable_run_paused", "durable_run_resumed",
  "durable_run_cancelled", "durable_run_woken", "durable_run_waiting", "durable_run_completed",
]);

type InboxChangeFamily = "approvals" | "change_plans" | "tasks" | "chat" | "durable_runs";

export interface InboxChangeSignal {
  eventType: "inbox.changed";
  source: "operator_inbox";
  payload: { sourceEventId: string; family: InboxChangeFamily; scope: "workspace" | "all_workspaces" };
  options: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links">;
  delivery: { deliveryId: string; occurredAt: string };
}

function ownerFamily(event: RealtimeEvent): InboxChangeFamily | undefined {
  if (event.source === "approvals" && APPROVAL_EVENTS.has(event.eventType)) return "approvals";
  if (event.source === "tasks" && TASK_EVENTS.has(event.eventType)) return "tasks";
  if (event.source === "evolution_control_plane" && PLAN_EVENTS.has(event.eventType)) return "change_plans";
  if (event.source === "chat" && event.eventType === "chat_thread_updated") return "chat";
  if (event.source === "durable" && event.eventType === "system"
    && typeof event.payload.type === "string" && DURABLE_TRANSITIONS.has(event.payload.type)) return "durable_runs";
  return undefined;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && value.trim() === value
    && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

/** Invalidation only. The source event must already be retained; no owner state is inferred. */
export function deriveInboxChangeSignal(event: RealtimeEvent): InboxChangeSignal | undefined {
  if (event.eventAuthority !== "retained_stream" || event.eventType === "inbox.changed"
    || !["domain_fact", "operational_signal"].includes(event.eventClass ?? "")
    || !validIdentifier(event.eventId) || !Number.isFinite(Date.parse(event.timestamp))
    || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return undefined;
  const family = ownerFamily(event);
  if (!family) return undefined;
  const linkedWorkspace = event.links?.workspaceId;
  const payloadWorkspace = event.payload.workspaceId;
  if ((linkedWorkspace !== undefined && !validIdentifier(linkedWorkspace))
    || (payloadWorkspace !== undefined && !validIdentifier(payloadWorkspace))
    || (linkedWorkspace && payloadWorkspace && linkedWorkspace !== payloadWorkspace)) return undefined;
  // Only the retained structured link supplies scope. Never invent a default or
  // look up domain records here; absent scope means all Inbox queries may refresh.
  return {
    eventType: "inbox.changed",
    source: "operator_inbox",
    payload: { sourceEventId: event.eventId, family, scope: linkedWorkspace ? "workspace" : "all_workspaces" },
    options: {
      eventClass: "operational_signal",
      eventAuthority: "retained_stream",
      links: linkedWorkspace ? { workspaceId: linkedWorkspace } : {},
    },
    delivery: { deliveryId: `inbox.changed:${event.eventId}`, occurredAt: event.timestamp },
  };
}
