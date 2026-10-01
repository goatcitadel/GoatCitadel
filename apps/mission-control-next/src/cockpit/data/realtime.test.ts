import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { invalidateForEvent } from "./realtime";

describe("cockpit realtime invalidation", () => {
  const invalidation = {
    eventId: "inbox.changed:owner", sequence: 3, timestamp: "2026-09-30T14:00:00.000Z",
    eventType: "inbox.changed", source: "operator_inbox", eventClass: "operational_signal" as const,
    eventAuthority: "retained_stream" as const, links: { workspaceId: "workspace-a" },
    payload: { sourceEventId: "owner", family: "approvals", scope: "workspace" },
  };

  it("refreshes only the exact scoped Inbox query from its dedicated signal", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    expect(invalidateForEvent(queryClient, invalidation)).toEqual([]);
    expect(spy).toHaveBeenCalledExactlyOnceWith({ queryKey: ["approvals", "operator-inbox", "workspace-a"] });
  });

  it("refreshes all Inbox queries only for an explicitly unscoped signal", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    invalidateForEvent(queryClient, { ...invalidation, links: {}, payload: { ...invalidation.payload, scope: "all_workspaces" } });
    expect(spy).toHaveBeenCalledExactlyOnceWith({ queryKey: ["approvals", "operator-inbox"] });
  });

  it.each([
    { source: "other" }, { eventAuthority: "durable_history" }, { eventAuthority: "derived_projection" },
    { eventClass: "ui_notification" }, { links: {} }, { links: { workspaceId: " " } },
    { payload: { scope: "all_workspaces" } }, { payload: { scope: "unknown" } },
  ])("rejects malformed or non-current Inbox signal scope %j", (overrides) => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    invalidateForEvent(queryClient, { ...invalidation, ...overrides } as typeof invalidation);
    expect(spy).not.toHaveBeenCalled();
  });

  it("invalidates queries for each event owner topic", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    const topics = invalidateForEvent(queryClient, {
      eventId: "e-1",
      sequence: 1,
      eventType: "chat_thread_updated",
      source: "chat",
      timestamp: "2026-09-28T00:00:00.000Z",
      links: { sessionId: "s-1" },
      payload: {},
    } as never);
    expect(topics).toContain("chat");
    expect(spy).toHaveBeenCalledWith({ queryKey: ["chat"] });
  });

  it("refreshes Work and Inbox from a retained run link", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    const topics = invalidateForEvent(queryClient, {
      eventId: "run-1", sequence: 2, eventType: "run_failed", source: "durable",
      timestamp: "2026-09-28T00:00:00.000Z", eventAuthority: "retained_stream",
      links: { runId: "r-1" }, payload: {},
    });
    expect(topics).toContain("tasks");
    expect(spy).toHaveBeenCalledWith({ queryKey: ["tasks"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["approvals", "operator-inbox"] });
  });

  it("refreshes Inbox for a proposal transition without an owner topic", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    invalidateForEvent(queryClient, {
      eventId: "proposal-1", sequence: 3, eventType: "capability_proposal_created", source: "capabilities",
      timestamp: "2026-09-28T00:00:00.000Z", eventAuthority: "retained_stream", payload: {},
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["approvals", "operator-inbox"] });
  });

  it("refreshes Inbox when a pending approval is published", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    invalidateForEvent(queryClient, {
      eventId: "approval-1", sequence: 5, eventType: "approval_requested", source: "approvals",
      timestamp: "2026-09-28T00:00:00.000Z", eventAuthority: "retained_stream",
      links: { approvalId: "a-1" }, payload: {},
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["approvals", "operator-inbox"] });
  });

  it("does not refresh Inbox from durable history replay", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    invalidateForEvent(queryClient, {
      eventId: "history-1", sequence: 4, eventType: "change_plan_updated", source: "chat",
      timestamp: "2026-09-28T00:00:00.000Z", eventAuthority: "durable_history", payload: {},
    });
    expect(spy).not.toHaveBeenCalledWith({ queryKey: ["approvals", "operator-inbox"] });
  });
});
