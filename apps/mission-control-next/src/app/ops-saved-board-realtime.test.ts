import type { RealtimeEvent } from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  OpsSavedBoardRealtimeCursor,
  projectOpsSavedBoardRealtimeEvent,
  publishOpsSavedBoardRealtimeEvent,
  subscribeOpsSavedBoardRealtime,
} from "./ops-saved-board-realtime";

describe("ops saved board retained invalidation", () => {
  it("projects only the exact content-free retained event envelope", () => {
    expect(projectOpsSavedBoardRealtimeEvent(changeEvent())).toEqual({
      kind: "change",
      workspaceId: "ws-1",
      boardId: "board-1",
      revision: 2,
      epoch: "epoch-1",
      operation: "update",
    });

    for (const event of [
      changeEvent({ source: "spoofed" }),
      changeEvent({ eventAuthority: "derived_projection" }),
      changeEvent({ links: { workspaceId: "ws-foreign" } }),
      changeEvent({ payload: { ...changeEvent().payload, name: "leaked board content" } }),
      changeEvent({ payload: { ...changeEvent().payload, revision: 0 } }),
      changeEvent({ payload: { ...changeEvent().payload, epoch: " epoch-1 " } }),
    ]) {
      expect(projectOpsSavedBoardRealtimeEvent(event)).toBeUndefined();
    }
  });

  it("isolates subscribers and projects a replay gap without board bytes", () => {
    const first = vi.fn(() => {
      throw new Error("subscriber failed");
    });
    const second = vi.fn();
    const unsubscribeFirst = subscribeOpsSavedBoardRealtime(first);
    const unsubscribeSecond = subscribeOpsSavedBoardRealtime(second);
    publishOpsSavedBoardRealtimeEvent(
      changeEvent({
        eventType: "system",
        source: "events",
        eventClass: "ui_notification",
        payload: { kind: "replay_gap", leaked: "ignored" },
      }),
    );
    expect(first).toHaveBeenCalledWith({ kind: "replay_gap" });
    expect(second).toHaveBeenCalledWith({ kind: "replay_gap" });
    unsubscribeFirst();
    unsubscribeSecond();
  });

  it("rejects duplicate and stale revisions while detecting gaps and epoch changes", () => {
    const cursor = new OpsSavedBoardRealtimeCursor();
    cursor.replaceCanonicalRecords([{ boardId: "board-1", revision: 2 }]);

    expect(cursor.decide(signal({ revision: 2 }))).toEqual({ reload: false });
    expect(cursor.decide(signal({ revision: 1 }))).toEqual({ reload: false });
    expect(cursor.decide(signal({ revision: 3 }))).toEqual({ reload: true, reason: "change" });
    expect(cursor.decide(signal({ revision: 3 }))).toEqual({ reload: false });
    expect(cursor.decide(signal({ revision: 6 }))).toEqual({ reload: true, reason: "revision_gap" });
    expect(cursor.decide(signal({ revision: 1, epoch: "epoch-2" }))).toEqual({
      reload: true,
      reason: "epoch_change",
    });
    expect(cursor.decide({ kind: "replay_gap" })).toEqual({ reload: true, reason: "replay_gap" });
  });
});

function signal(overrides: Partial<ReturnType<typeof baseSignal>> = {}) {
  return { ...baseSignal(), ...overrides };
}

function baseSignal() {
  return {
    kind: "change" as const,
    workspaceId: "ws-1",
    boardId: "board-1",
    revision: 2,
    epoch: "epoch-1",
    operation: "update" as const,
  };
}

function changeEvent(overrides: Partial<RealtimeEvent> = {}): RealtimeEvent {
  return {
    eventId: "event-1",
    sequence: 1,
    eventType: "ops_saved_board_changed",
    source: "ops_saved_boards",
    timestamp: "2026-07-14T20:00:00.000Z",
    eventClass: "operational_signal",
    eventAuthority: "retained_stream",
    links: { workspaceId: "ws-1" },
    payload: {
      workspaceId: "ws-1",
      boardId: "board-1",
      revision: 2,
      epoch: "epoch-1",
      operation: "update",
    },
    ...overrides,
  };
}
