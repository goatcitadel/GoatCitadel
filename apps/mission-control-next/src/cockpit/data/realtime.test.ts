import { describe, expect, it, vi } from "vitest";
import type { RealtimeEvent } from "@goatcitadel/contracts";
import { invalidateForEvent, realtimeRefreshSignal } from "./realtime";
import { queryKeys } from "./query-keys";

const base = {
  eventId: "e1",
  sequence: 1,
  timestamp: "2026-10-05T10:00:00.000Z",
  eventAuthority: "retained_stream",
  eventClass: "domain_fact",
  payload: {},
} as const;
const sink = () => ({ invalidate: vi.fn(), refresh: vi.fn(), unmapped: vi.fn() });

describe("invalidateForEvent", () => {
  it("bridges a mapped chat event into the refresh bus", () => {
    const s = sink();
    invalidateForEvent({ ...base, eventType: "chat_thread_updated", source: "chat" }, s);
    expect(s.invalidate).toHaveBeenCalledWith(["chat"]);
    expect(s.refresh).toHaveBeenCalledWith("chat", expect.objectContaining({ eventType: "chat_thread_updated" }));
    expect(s.unmapped).not.toHaveBeenCalled();
  });

  it("names the conversation an event belongs to in its refresh signal", () => {
    const event = { ...base, eventType: "chat_thread_updated", source: "chat", links: { sessionId: "s-9" } };
    expect(realtimeRefreshSignal(event)).toEqual({
      reason: "chat_thread_updated",
      source: "chat",
      eventType: "chat_thread_updated",
      eventId: "e1",
      sessionId: "s-9",
    });
    expect(realtimeRefreshSignal({ ...event, links: undefined }).sessionId).toBeUndefined();
  });

  it("refreshes nothing for llama.cpp process output", () => {
    const s = sink();
    invalidateForEvent({ ...base, eventType: "llamacpp_stderr", source: "llamacpp" }, s);
    invalidateForEvent({ ...base, eventType: "llamacpp_stdout", source: "llamacpp" }, s);
    expect(s.invalidate).not.toHaveBeenCalled();
    expect(s.refresh).not.toHaveBeenCalled();
    expect(s.unmapped).not.toHaveBeenCalled();
  });

  // The Gateway publishes llama.cpp events in two real shapes: route lifecycle with eventType "system"
  // and the type in payload.type, and runtime events with the runtime's own type as eventType.
  it("refreshes only the health readers for both llama.cpp status shapes", () => {
    for (const shape of [
      { eventType: "system", payload: { type: "llamacpp_refreshed" } },
      { eventType: "llamacpp_exited", payload: { unexpected: true, code: 1 } },
    ]) {
      const s = sink();
      invalidateForEvent({ ...base, ...shape, source: "llamacpp" }, s);
      expect(s.invalidate).toHaveBeenCalledExactlyOnceWith(queryKeys.healthAll());
      expect(s.refresh).toHaveBeenCalledExactlyOnceWith("llamaCpp", expect.anything());
    }
  });

  it("ignores durable-history replays", () => {
    const s = sink();
    invalidateForEvent({ ...base, eventType: "system", source: "llamacpp", eventAuthority: "durable_history" }, s);
    invalidateForEvent(
      { ...base, eventType: "change_plan_updated", source: "chat", eventAuthority: "durable_history" },
      s,
    );
    expect(s.invalidate).not.toHaveBeenCalled();
    expect(s.refresh).not.toHaveBeenCalled();
  });

  it("refreshes Work and the Inbox from a durable run signal", () => {
    const s = sink();
    invalidateForEvent({ ...base, eventType: "system", source: "durable", links: { runId: "r-1" } }, s);
    expect(s.invalidate).toHaveBeenCalledWith(["tasks"]);
    expect(s.invalidate).toHaveBeenCalledWith(queryKeys.inboxAll());
  });

  it("refreshes the Inbox for a proposal and a pending approval", () => {
    const proposal = sink();
    invalidateForEvent({ ...base, eventType: "capability_proposal_created", source: "capabilities" }, proposal);
    expect(proposal.invalidate).toHaveBeenCalledWith(queryKeys.inboxAll());
    const approval = sink();
    invalidateForEvent(
      { ...base, eventType: "approval_created", source: "approvals", links: { approvalId: "a" } },
      approval,
    );
    expect(approval.invalidate).toHaveBeenCalledWith(["approvals"]);
  });

  it("sends an unmapped event to the throttled topic fallback, never to surface", () => {
    const s = sink();
    invalidateForEvent({ ...base, eventType: "x_new", source: "x_owner", links: { taskId: "t" } }, s);
    expect(s.unmapped).toHaveBeenCalledWith("tasks", expect.anything());
    expect(s.unmapped).not.toHaveBeenCalledWith("surface", expect.anything());
    expect(s.invalidate).not.toHaveBeenCalled();
  });

  describe("inbox.changed", () => {
    const invalidation: RealtimeEvent = {
      eventId: "inbox.changed:owner",
      sequence: 3,
      timestamp: "2026-09-30T14:00:00.000Z",
      eventType: "inbox.changed",
      source: "operator_inbox",
      eventClass: "operational_signal",
      eventAuthority: "retained_stream",
      links: { workspaceId: "ws-1" },
      payload: { sourceEventId: "owner", family: "approvals", scope: "workspace" },
    };

    it("keeps inbox.changed workspace scoping", () => {
      const s = sink();
      invalidateForEvent(invalidation, s);
      expect(s.invalidate).toHaveBeenCalledExactlyOnceWith(queryKeys.inbox("ws-1"));
      expect(s.refresh).not.toHaveBeenCalled();
    });

    it("refreshes all Inbox queries only for an explicitly unscoped signal", () => {
      const s = sink();
      invalidateForEvent(
        { ...invalidation, links: {}, payload: { ...invalidation.payload, scope: "all_workspaces" } },
        s,
      );
      expect(s.invalidate).toHaveBeenCalledExactlyOnceWith(queryKeys.inboxAll());
    });

    it.each([
      { source: "other" },
      { eventAuthority: "durable_history" },
      { eventAuthority: "derived_projection" },
      { eventClass: "ui_notification" },
      { links: {} },
      { links: { workspaceId: " " } },
      { payload: { scope: "all_workspaces" } },
      { payload: { scope: "unknown" } },
    ])("rejects malformed or non-current Inbox signal scope %j", (overrides) => {
      const s = sink();
      invalidateForEvent({ ...invalidation, ...overrides } as RealtimeEvent, s);
      expect(s.invalidate).not.toHaveBeenCalled();
      expect(s.unmapped).not.toHaveBeenCalled();
    });
  });
});
