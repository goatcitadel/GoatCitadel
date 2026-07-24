import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchRemoteWorkerAssignmentEvents,
  fetchRemoteWorkerAssignments,
  fetchRemoteWorkerDetail,
  fetchRemoteWorkerReconciliation,
  fetchRemoteWorkerRegistry,
} from "./remote-workers";

const apiMocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("./client-core.js", () => ({ request: apiMocks.request }));

beforeEach(() => {
  apiMocks.request.mockReset();
});

function capturedUrl(): string {
  return apiMocks.request.mock.calls[0]![0] as string;
}

describe("remote-worker Ops client URL construction", () => {
  it("builds the registry, detail, and reconciliation read URLs", async () => {
    apiMocks.request.mockRejectedValue(new Error("stop"));
    await expect(fetchRemoteWorkerRegistry("workspace-a", { limit: 10, cursor: "opaque" })).rejects.toThrow();
    expect(capturedUrl()).toBe("/api/v1/ops/workspaces/workspace-a/remote-workers?limit=10&cursor=opaque");

    apiMocks.request.mockReset().mockRejectedValue(new Error("stop"));
    await expect(fetchRemoteWorkerDetail("workspace-a", "worker-a")).rejects.toThrow();
    expect(capturedUrl()).toBe("/api/v1/ops/workspaces/workspace-a/remote-workers/worker-a");

    apiMocks.request.mockReset().mockRejectedValue(new Error("stop"));
    await expect(fetchRemoteWorkerReconciliation("workspace-a", "worker-a")).rejects.toThrow();
    expect(capturedUrl()).toBe("/api/v1/ops/workspaces/workspace-a/remote-workers/worker-a/reconciliation");
  });

  it("binds exact worker/session/turn filters and paging on the assignment reads", async () => {
    apiMocks.request.mockRejectedValue(new Error("stop"));
    await expect(
      fetchRemoteWorkerAssignments("workspace-a", {
        workerId: "worker-a",
        sessionId: "session-a",
        turnId: "turn-a",
        limit: 20,
        cursor: "opaque",
      }),
    ).rejects.toThrow();
    expect(capturedUrl()).toBe(
      "/api/v1/ops/workspaces/workspace-a/remote-worker-assignments?workerId=worker-a&sessionId=session-a&turnId=turn-a&limit=20&cursor=opaque",
    );

    apiMocks.request.mockReset().mockRejectedValue(new Error("stop"));
    await expect(
      fetchRemoteWorkerAssignmentEvents("workspace-a", "assign-a", { afterSequence: 3, limit: 25 }),
    ).rejects.toThrow();
    expect(capturedUrl()).toBe(
      "/api/v1/ops/workspaces/workspace-a/remote-worker-assignments/assign-a/events?afterSequence=3&limit=25",
    );
  });

  it("rejects invalid workspace/identifier scopes before any network call", async () => {
    await expect(fetchRemoteWorkerRegistry("bad workspace")).rejects.toThrow(/workspace scope/u);
    await expect(fetchRemoteWorkerDetail("workspace-a", "bad worker")).rejects.toThrow(/worker id/u);
    await expect(fetchRemoteWorkerAssignments("workspace-a", { sessionId: "bad session" })).rejects.toThrow(
      /session id/u,
    );
    expect(apiMocks.request).not.toHaveBeenCalled();
  });

  it("validates the server envelope and returns a frozen event page on success", async () => {
    apiMocks.request.mockResolvedValue({
      schemaVersion: "goatcitadel.remote-worker-assignment-event-page.v1",
      readOnly: true,
      mutationSemantics: "none",
      workspaceId: "workspace-a",
      assignmentId: "assign-a",
      assignmentGeneration: 1,
      items: [
        {
          sequence: 1,
          eventId: "e1",
          eventType: "status",
          receivedAt: "2026-07-15T12:00:00.000Z",
          workerSentThrough: 1,
        },
      ],
      nextAfterSequence: 1,
      omitted: { transcriptDeltas: 0, terminalOutputs: 0, diagnostics: 0 },
      observedAt: "2026-07-15T12:00:00.000Z",
    });
    const page = await fetchRemoteWorkerAssignmentEvents("workspace-a", "assign-a");
    expect(page.items[0]?.eventType).toBe("status");
    expect(Object.isFrozen(page)).toBe(true);
  });

  it("throws when the server returns a smuggled or malformed envelope", async () => {
    apiMocks.request.mockResolvedValue({ schemaVersion: "wrong", items: [{ payload: { secret: "x" } }] });
    await expect(fetchRemoteWorkerAssignmentEvents("workspace-a", "assign-a")).rejects.toThrow();
  });
});
