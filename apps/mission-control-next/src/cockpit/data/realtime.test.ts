import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { invalidateForEvent } from "./realtime";
import { queryKeys } from "./query-keys";

describe("cockpit realtime invalidation", () => {
  const invalidation = {
    eventId: "inbox.changed:owner",
    sequence: 3,
    timestamp: "2026-09-30T14:00:00.000Z",
    eventType: "inbox.changed",
    source: "operator_inbox",
    eventClass: "operational_signal" as const,
    eventAuthority: "retained_stream" as const,
    links: { workspaceId: "workspace-a" },
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
    invalidateForEvent(queryClient, {
      ...invalidation,
      links: {},
      payload: { ...invalidation.payload, scope: "all_workspaces" },
    });
    expect(spy).toHaveBeenCalledExactlyOnceWith({ queryKey: ["approvals", "operator-inbox"] });
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
      eventId: "run-1",
      sequence: 2,
      eventType: "run_failed",
      source: "durable",
      timestamp: "2026-09-28T00:00:00.000Z",
      eventAuthority: "retained_stream",
      links: { runId: "r-1" },
      payload: {},
    });
    expect(topics).toContain("tasks");
    expect(spy).toHaveBeenCalledWith({ queryKey: ["tasks"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["approvals", "operator-inbox"] });
  });

  it("refreshes Inbox for a proposal transition without an owner topic", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    invalidateForEvent(queryClient, {
      eventId: "proposal-1",
      sequence: 3,
      eventType: "capability_proposal_created",
      source: "capabilities",
      timestamp: "2026-09-28T00:00:00.000Z",
      eventAuthority: "retained_stream",
      payload: {},
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["approvals", "operator-inbox"] });
  });

  it("refreshes Inbox when a pending approval is published", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    invalidateForEvent(queryClient, {
      eventId: "approval-1",
      sequence: 5,
      eventType: "approval_requested",
      source: "approvals",
      timestamp: "2026-09-28T00:00:00.000Z",
      eventAuthority: "retained_stream",
      links: { approvalId: "a-1" },
      payload: {},
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["approvals", "operator-inbox"] });
  });

  it("does not refresh Inbox from durable history replay", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    invalidateForEvent(queryClient, {
      eventId: "history-1",
      sequence: 4,
      eventType: "change_plan_updated",
      source: "chat",
      timestamp: "2026-09-28T00:00:00.000Z",
      eventAuthority: "durable_history",
      payload: {},
    });
    expect(spy).not.toHaveBeenCalledWith({ queryKey: ["approvals", "operator-inbox"] });
  });

  it("refreshes only the health readers for a llama.cpp runtime signal", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    const topics = invalidateForEvent(queryClient, {
      eventId: "llama-1",
      sequence: 6,
      eventType: "system",
      source: "llamacpp",
      timestamp: "2026-10-03T00:00:00.000Z",
      eventAuthority: "retained_stream",
      payload: { type: "llamacpp_refreshed", status: { healthy: true, activeModelId: "gemma-local" } },
    });
    expect(topics).toEqual([]);
    expect(spy).toHaveBeenCalledExactlyOnceWith({ queryKey: ["system", "health"] });
  });

  it("ignores replayed llama.cpp history", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    invalidateForEvent(queryClient, {
      eventId: "llama-2",
      sequence: 7,
      eventType: "system",
      source: "llamacpp",
      timestamp: "2026-10-03T00:00:00.000Z",
      eventAuthority: "durable_history",
      payload: { type: "llamacpp_refreshed" },
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it.each(["llamacpp_stdout", "llamacpp_stderr"])(
    "never refreshes health for llama-server output (%s)",
    (eventType) => {
      const queryClient = new QueryClient();
      const spy = vi.spyOn(queryClient, "invalidateQueries");
      expect(
        invalidateForEvent(queryClient, {
          eventId: `log-${eventType}`,
          sequence: 8,
          eventType,
          source: "llamacpp",
          timestamp: "2026-10-03T00:00:00.000Z",
          eventAuthority: "retained_stream",
          payload: { message: "srv  log_server_r: request: GET /health 127.0.0.1 200" },
        }),
      ).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it("refreshes the health query the readers actually use when llama-server exits", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.health("workspace-a"), { checks: [] });
    invalidateForEvent(queryClient, {
      eventId: "llama-exit",
      sequence: 9,
      eventType: "llamacpp_exited",
      source: "llamacpp",
      timestamp: "2026-10-03T00:00:00.000Z",
      eventAuthority: "retained_stream",
      payload: { unexpected: true, code: 1 },
    });
    expect(queryClient.getQueryState(queryKeys.health("workspace-a"))?.isInvalidated).toBe(true);
  });
});
