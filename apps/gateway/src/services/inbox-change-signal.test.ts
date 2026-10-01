import { describe, expect, it } from "vitest";
import type { RealtimeEvent } from "@goatcitadel/contracts";
import { deriveInboxChangeSignal } from "./inbox-change-signal.js";

function event(overrides: Partial<RealtimeEvent> = {}): RealtimeEvent {
  return {
    eventId: "committed-owner-event", sequence: 2, timestamp: "2026-09-30T14:00:00.000Z",
    eventType: "approval_created", source: "approvals", eventClass: "domain_fact",
    eventAuthority: "retained_stream", links: { approvalId: "approval", workspaceId: "workspace-a" },
    payload: {}, ...overrides,
  };
}

describe("Inbox committed-owner invalidation mapping", () => {
  it.each([
    ["approvals", "approval_created", "approvals"], ["approvals", "approval_resolved", "approvals"],
    ["tasks", "task_created", "tasks"], ["tasks", "task_updated", "tasks"],
    ["tasks", "task_deleted", "tasks"], ["tasks", "deliverable_added", "tasks"],
    ["chat", "chat_thread_updated", "chat"],
    ...["created", "staging", "applying", "rolling_back", "cancelled", "rollback_requested", "awaiting_approval",
      "verifying", "awaiting_input", "awaiting_confirmation", "monitoring", "completed", "applied",
      "manual_required", "failed", "rolled_back", "rollback_failed", "expired"]
      .map((transition) => ["evolution_control_plane", `change_plan.${transition}`, "change_plans"]),
  ])("maps exact producer %s / %s", (source, eventType, family) => {
    expect(deriveInboxChangeSignal(event({ source, eventType }))).toEqual({
      eventType: "inbox.changed", source: "operator_inbox",
      payload: { sourceEventId: "committed-owner-event", family, scope: "workspace" },
      options: { eventClass: "operational_signal", eventAuthority: "retained_stream", links: { workspaceId: "workspace-a" } },
      delivery: { deliveryId: "inbox.changed:committed-owner-event", occurredAt: "2026-09-30T14:00:00.000Z" },
    });
  });

  it.each(["durable_run_failed", "durable_run_dead_lettered", "durable_run_retry_scheduled", "durable_dead_letter_recovered",
    "durable_run_paused", "durable_run_resumed", "durable_run_cancelled", "durable_run_woken", "durable_run_waiting", "durable_run_completed"])
  ("maps exact durable transition %s without inferring a workspace", (type) => {
    const result = deriveInboxChangeSignal(event({ source: "durable", eventType: "system", links: { runId: "run" }, payload: { type } }));
    expect(result?.payload).toEqual({ sourceEventId: "committed-owner-event", family: "durable_runs", scope: "all_workspaces" });
    expect(result?.options.links).toEqual({});
  });

  it.each([
    { eventAuthority: "durable_history" }, { eventAuthority: "derived_projection" }, { eventAuthority: undefined },
    { eventClass: "ui_notification" }, { eventId: "" }, { eventId: "x".repeat(513) }, { eventId: "bad\nevent" },
    { timestamp: "invalid" }, { source: "untrusted" }, { eventType: "approval_created_extra" },
    { source: "operator_inbox", eventType: "inbox.changed" },
    { source: "memory", eventType: "system", payload: { type: "memory_trace_candidate_proposed" } },
    { source: "durable", eventType: "system", payload: { type: "durable_worker_event_loop_lag" } },
    { source: "durable", eventType: "durable_run_failed" },
    { source: "evolution_control_plane", eventType: "change_plan.unknown" },
    { source: "chat", eventType: "chat_preview_updated" },
    { links: { workspaceId: " workspace-a" } }, { payload: { workspaceId: "workspace-b" } },
  ] satisfies Array<Partial<RealtimeEvent>>)("rejects non-admitted or contradictory source evidence %j", (overrides) => {
    expect(deriveInboxChangeSignal(event(overrides))).toBeUndefined();
  });

  it("copies no private payload, domain labels, action linkage or ambient attribution", () => {
    const result = deriveInboxChangeSignal(event({ payload: {
      workspaceId: "workspace-a", title: "private title", token: "synthetic-secret",
      status: "approved", count: 40, actorId: "private-actor", command: "private command",
    }, correlationId: "private-correlation" }));
    expect(Object.keys(result!.payload).sort()).toEqual(["family", "scope", "sourceEventId"]);
    expect(result!.options.links).toEqual({ workspaceId: "workspace-a" });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  });

  it("does not promote an unlinked payload workspace into a canonical scope", () => {
    const result = deriveInboxChangeSignal(event({ links: {}, payload: { workspaceId: "workspace-a" } }));
    expect(result?.payload.scope).toBe("all_workspaces");
    expect(result?.options.links).toEqual({});
  });
});
