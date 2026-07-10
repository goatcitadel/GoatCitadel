import { describe, expect, it, vi } from "vitest";
import type { RealtimeEvent } from "@goatcitadel/contracts";
import { RealtimeEventService } from "./realtime-event-service.js";

describe("RealtimeEventService", () => {
  it("publishes, emits, unsubscribes, and reads realtime events through storage", () => {
    const storage = fakeStorage();
    const service = new RealtimeEventService({ storage, getGatewayNodeId: () => "node-1" });
    const listener = vi.fn();
    const unsubscribe = service.subscribeRealtime(listener);

    const event = service.publishRealtime("heartbeat", "system", { ok: true });
    unsubscribe();
    service.publishRealtime("heartbeat", "system", { ok: false });

    expect(event).toEqual({ sequence: 1, eventType: "heartbeat", source: "system" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(event);
    expect(service.listRealtimeEvents()).toEqual([{ sequence: 1 }]);
    expect(service.listRealtimeEvents(5, "cursor-1")).toEqual([{ sequence: 1 }]);
    expect(service.listRealtimeEventsAfterSequence(2)).toEqual([{ sequence: 3 }]);
    expect(service.listRealtimeEventsAfterSequence(2, 7)).toEqual([{ sequence: 3 }]);
    expect(service.getRealtimeEventSequenceBounds()).toEqual({ oldestSequence: 1, newestSequence: 3 });
    expect(storage.realtimeEvents.list).toHaveBeenNthCalledWith(1, 100, undefined);
    expect(storage.realtimeEvents.list).toHaveBeenNthCalledWith(2, 5, "cursor-1");
    expect(storage.realtimeEvents.listAfterSequence).toHaveBeenNthCalledWith(1, 2, 100);
    expect(storage.realtimeEvents.listAfterSequence).toHaveBeenNthCalledWith(2, 2, 7);
  });

  it("projects new and legacy realtime payloads without mutating caller or storage truth", () => {
    const rawPayload = {
      webhookUrl: "https://hooks.example.test/services/team/realtime-secret",
      authorization: "Bearer short",
      DATABASE_PASSWORD: "hunter2",
      tokenId: "realtime-token-id",
      tokenBudget: 128,
    };
    const legacyEvent = {
      eventId: "event-legacy-1",
      sequence: 7,
      eventType: "legacy_event",
      source: "legacy",
      timestamp: "2026-07-09T12:00:00.000Z",
      payload: rawPayload,
    } as RealtimeEvent;
    const storage = fakeStorage();
    storage.realtimeEvents.append.mockImplementation((_eventType, _source, payload) => ({
      ...legacyEvent,
      payload,
    }));
    storage.realtimeEvents.list.mockReturnValue([legacyEvent] as never);
    storage.realtimeEvents.listAfterSequence.mockReturnValue([legacyEvent] as never);
    const service = new RealtimeEventService({ storage, getGatewayNodeId: () => "node-1" });

    const published = service.publishRealtime("legacy_event", "legacy", rawPayload);
    const listed = service.listRealtimeEvents();
    const after = service.listRealtimeEventsAfterSequence(0);

    for (const event of [published, listed[0], after[0]]) {
      expect(event?.payload).toEqual({
        webhookUrl: "[REDACTED]",
        authorization: "[REDACTED]",
        DATABASE_PASSWORD: "[REDACTED]",
        tokenId: "realtime-token-id",
        tokenBudget: 128,
      });
    }
    expect(storage.realtimeEvents.append).toHaveBeenCalledWith(
      "legacy_event",
      "legacy",
      expect.objectContaining({ webhookUrl: "[REDACTED]", authorization: "[REDACTED]" }),
      undefined,
    );
    expect(rawPayload.webhookUrl).toContain("realtime-secret");
    expect(rawPayload.authorization).toBe("Bearer short");
    expect(legacyEvent.payload).toBe(rawPayload);
  });

  it("requires explicit metadata for protected realtime events", () => {
    const storage = fakeStorage();
    const service = new RealtimeEventService({ storage, getGatewayNodeId: () => "node-1" });

    expect(() => service.publishRealtime("approval_created", "approvals", {})).toThrow(
      "Explicit realtime metadata is required",
    );
    expect(() =>
      service.publishRealtime("approval_resolved", "approvals", {}, { eventClass: "approval" } as never),
    ).toThrow("Explicit realtime metadata is required");
    expect(() =>
      service.publishRealtime("task_updated", "tasks", {}, {
        eventClass: "task",
        eventAuthority: "gateway",
        links: { taskId: "   " },
      } as never),
    ).toThrow("Explicit realtime metadata is required");
    expect(() => service.publishRealtime("progress", "orchestration", {})).toThrow(
      "Explicit realtime metadata is required",
    );

    service.publishRealtime(
      "approval_resolved",
      "approvals",
      { ok: true },
      {
        eventClass: "approval",
        eventAuthority: "gateway",
        links: { approvalId: "approval-1" },
        correlationId: "corr-1",
      },
    );
    service.publishRealtime(
      "orchestration_event",
      "workflow",
      { ok: true },
      {
        eventClass: "orchestration",
        eventAuthority: "gateway",
        links: { runId: "run-1" },
      },
    );

    expect(storage.realtimeEvents.append).toHaveBeenCalledWith(
      "approval_resolved",
      "approvals",
      { ok: true },
      {
        eventClass: "approval",
        eventAuthority: "gateway",
        links: { approvalId: "approval-1" },
        correlationId: "corr-1",
      },
    );
  });

  it("manages realtime stream leases with gateway node identity", () => {
    const storage = fakeStorage();
    const service = new RealtimeEventService({ storage, getGatewayNodeId: () => "node-2" });

    expect(
      service.openRealtimeStreamLease({
        streamName: "events",
        clientId: "client-1",
        requestedCursor: 12,
        connectedAt: "2026-05-14T00:00:00.000Z",
      }),
    ).toEqual({ leaseId: "lease-1" });
    expect(service.touchRealtimeStreamLease({ leaseId: "lease-1", lastSentSequence: 13 })).toEqual({
      leaseId: "lease-1",
      touched: true,
    });
    expect(service.closeRealtimeStreamLease({ leaseId: "lease-1", closeReason: "done" })).toEqual({
      leaseId: "lease-1",
      closed: true,
    });

    expect(storage.realtimeStreamLeases.open).toHaveBeenCalledWith({
      streamName: "events",
      clientId: "client-1",
      gatewayNodeId: "node-2",
      requestedCursor: 12,
      openedAt: "2026-05-14T00:00:00.000Z",
    });
    expect(storage.realtimeStreamLeases.touch).toHaveBeenCalledWith({ leaseId: "lease-1", lastSentSequence: 13 });
    expect(storage.realtimeStreamLeases.close).toHaveBeenCalledWith({ leaseId: "lease-1", closeReason: "done" });
  });
});

function fakeStorage() {
  const append = vi.fn((eventType: string, source: string) => ({ sequence: 1, eventType, source }) as RealtimeEvent);
  return {
    realtimeEvents: {
      append,
      list: vi.fn(() => [{ sequence: 1 }] as never),
      listAfterSequence: vi.fn(() => [{ sequence: 3 }] as never),
      getSequenceBounds: vi.fn(() => ({ oldestSequence: 1, newestSequence: 3 })),
    },
    realtimeStreamLeases: {
      open: vi.fn(() => ({ leaseId: "lease-1" }) as never),
      touch: vi.fn(() => ({ leaseId: "lease-1", touched: true }) as never),
      close: vi.fn(() => ({ leaseId: "lease-1", closed: true }) as never),
    },
  };
}
