import type { RealtimeEvent } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import {
  RemoteWorkerRealtimeCursor,
  projectRemoteWorkerRealtimeEvent,
  publishRemoteWorkerRealtimeEvent,
  subscribeRemoteWorkerRealtime,
  type RemoteWorkerRealtimeSignal,
} from "./remote-worker-realtime";

function workerEvent(overrides: Partial<RealtimeEvent> = {}, payload: Record<string, unknown> = {}): RealtimeEvent {
  return {
    eventId: "evt-1",
    sequence: 1,
    eventType: "remote_worker_changed",
    source: "remote_workers",
    timestamp: "2026-07-15T12:00:00.000Z",
    eventClass: "operational_signal",
    eventAuthority: "retained_stream",
    links: { workspaceId: "workspace-a", workerId: "worker-a" },
    payload: {
      workspaceId: "workspace-a",
      workerId: "worker-a",
      operation: "quarantined",
      workerGeneration: 2,
      controlRevision: 1,
      watermark: 5,
      ...payload,
    },
    ...overrides,
  } as RealtimeEvent;
}

function assignmentEvent(): RealtimeEvent {
  return {
    eventId: "evt-2",
    sequence: 2,
    eventType: "remote_worker_assignment_changed",
    source: "remote_workers",
    timestamp: "2026-07-15T12:00:00.000Z",
    eventClass: "operational_signal",
    eventAuthority: "retained_stream",
    links: { workspaceId: "workspace-a", assignmentId: "assign-a" },
    payload: {
      workspaceId: "workspace-a",
      assignmentId: "assign-a",
      operation: "leased",
      assignmentGeneration: 1,
      leaseRevision: 3,
      watermark: 7,
    },
  } as RealtimeEvent;
}

describe("projectRemoteWorkerRealtimeEvent", () => {
  it("projects a content-free worker change signal", () => {
    const signal = projectRemoteWorkerRealtimeEvent(workerEvent());
    expect(signal).toEqual({
      kind: "change",
      entity: "worker",
      workspaceId: "workspace-a",
      entityId: "worker-a",
      operation: "quarantined",
      generation: 2,
      revision: 1,
      watermark: 5,
    });
  });

  it("projects a content-free assignment change signal", () => {
    expect(projectRemoteWorkerRealtimeEvent(assignmentEvent())).toMatchObject({
      entity: "assignment",
      entityId: "assign-a",
      revision: 3,
      watermark: 7,
    });
  });

  it("recognizes the retained replay-gap marker", () => {
    const gap = projectRemoteWorkerRealtimeEvent({
      eventId: "evt",
      sequence: 9,
      eventType: "system",
      source: "events",
      timestamp: "2026-07-15T12:00:00.000Z",
      eventClass: "ui_notification",
      eventAuthority: "retained_stream",
      payload: { kind: "replay_gap" },
    } as RealtimeEvent);
    expect(gap).toEqual({ kind: "replay_gap" });
  });

  it("rejects foreign links, extra payload keys, and non-retained authority", () => {
    expect(
      projectRemoteWorkerRealtimeEvent(workerEvent({ links: { workspaceId: "workspace-a", workerId: "worker-b" } })),
    ).toBeUndefined();
    expect(projectRemoteWorkerRealtimeEvent(workerEvent({}, { extra: "smuggled" }))).toBeUndefined();
    expect(projectRemoteWorkerRealtimeEvent(workerEvent({ eventAuthority: "durable_history" }))).toBeUndefined();
    expect(projectRemoteWorkerRealtimeEvent(workerEvent({ source: "gateway" }))).toBeUndefined();
  });
});

describe("RemoteWorkerRealtimeCursor", () => {
  it("deduplicates by watermark and flags a gap for a full reload", () => {
    const cursor = new RemoteWorkerRealtimeCursor();
    const change = (watermark: number): RemoteWorkerRealtimeSignal => ({
      kind: "change",
      entity: "worker",
      workspaceId: "workspace-a",
      entityId: "worker-a",
      operation: "control_revised",
      generation: 2,
      revision: 1,
      watermark,
    });
    expect(cursor.decide(change(5))).toEqual({ reload: true, reason: "change" });
    expect(cursor.decide(change(5))).toEqual({ reload: false });
    expect(cursor.decide(change(4))).toEqual({ reload: false });
    expect(cursor.decide(change(6))).toEqual({ reload: true, reason: "change" });
    expect(cursor.decide(change(9))).toEqual({ reload: true, reason: "watermark_gap" });
  });

  it("discards all watermarks on a replay gap", () => {
    const cursor = new RemoteWorkerRealtimeCursor();
    cursor.decide({
      kind: "change",
      entity: "assignment",
      workspaceId: "workspace-a",
      entityId: "assign-a",
      operation: "leased",
      generation: 1,
      revision: 3,
      watermark: 7,
    });
    expect(cursor.decide({ kind: "replay_gap" })).toEqual({ reload: true, reason: "replay_gap" });
    // After a gap the same watermark is treated as new (cache discarded).
    expect(
      cursor.decide({
        kind: "change",
        entity: "assignment",
        workspaceId: "workspace-a",
        entityId: "assign-a",
        operation: "leased",
        generation: 1,
        revision: 3,
        watermark: 7,
      }),
    ).toEqual({ reload: true, reason: "change" });
  });
});

describe("publishRemoteWorkerRealtimeEvent", () => {
  it("fans validated signals out to subscribers and ignores irrelevant events", () => {
    const received: RemoteWorkerRealtimeSignal[] = [];
    const unsubscribe = subscribeRemoteWorkerRealtime((signal) => received.push(signal));
    publishRemoteWorkerRealtimeEvent(workerEvent());
    publishRemoteWorkerRealtimeEvent({ eventType: "task_updated", source: "gateway", payload: {} } as RealtimeEvent);
    unsubscribe();
    publishRemoteWorkerRealtimeEvent(workerEvent());
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ entity: "worker", entityId: "worker-a" });
  });
});
