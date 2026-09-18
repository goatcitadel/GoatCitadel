import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRemoteWorkerInlineActivity, type RemoteWorkerInlineActivityState } from "./useRemoteWorkerInlineActivity";

const apiMocks = vi.hoisted(() => ({ fetchRemoteWorkerAssignments: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/remote-workers", () => ({
  fetchRemoteWorkerAssignments: apiMocks.fetchRemoteWorkerAssignments,
}));
vi.mock("@goatcitadel/mission-control-shared/hooks/useEventStreamStatus", () => ({
  useEventStreamStatus: () => ({ state: "open", reconnectAttempts: 0 }),
}));
vi.mock("../../app/remote-worker-realtime", () => ({
  REMOTE_WORKER_REALTIME_COALESCE_MS: 0,
  RemoteWorkerRealtimeCursor: class {
    decide() {
      return { reload: true };
    }
    reset() {}
  },
  subscribeRemoteWorkerRealtime: () => () => undefined,
}));

function Harness({
  workspaceId,
  sessionId,
  turnId,
  onValue,
}: {
  workspaceId: string;
  sessionId?: string | null;
  turnId?: string | null;
  onValue: (value: RemoteWorkerInlineActivityState) => void;
}) {
  const value = useRemoteWorkerInlineActivity({ workspaceId, sessionId, turnId });
  onValue(value);
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useRemoteWorkerInlineActivity", () => {
  let renderer: ReactTestRenderer | null = null;
  let latest: RemoteWorkerInlineActivityState | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    latest = null;
  });

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
  });

  it("loads only the assignments bound to the active session and turn", async () => {
    apiMocks.fetchRemoteWorkerAssignments.mockResolvedValue({ items: [{ assignmentId: "assign-a" }] });
    await act(async () => {
      renderer = create(
        createElement(Harness, {
          workspaceId: "workspace-a",
          sessionId: "session-a",
          turnId: "turn-a",
          onValue: (value) => {
            latest = value;
          },
        }),
      );
    });
    await flush();
    expect(apiMocks.fetchRemoteWorkerAssignments).toHaveBeenCalledWith("workspace-a", {
      sessionId: "session-a",
      turnId: "turn-a",
      limit: 25,
    });
    expect(latest?.loading).toBe(false);
    expect(latest?.assignments).toHaveLength(1);
  });

  it("stays inert (no fetch) when there is no active turn", async () => {
    await act(async () => {
      renderer = create(
        createElement(Harness, {
          workspaceId: "workspace-a",
          sessionId: "session-a",
          turnId: null,
          onValue: (value) => {
            latest = value;
          },
        }),
      );
    });
    await flush();
    expect(apiMocks.fetchRemoteWorkerAssignments).not.toHaveBeenCalled();
    expect(latest?.loading).toBe(false);
    expect(latest?.assignments).toHaveLength(0);
  });

  it("surfaces an unavailable state instead of inventing activity", async () => {
    apiMocks.fetchRemoteWorkerAssignments.mockRejectedValue(new Error("gateway down"));
    await act(async () => {
      renderer = create(
        createElement(Harness, {
          workspaceId: "workspace-a",
          sessionId: "session-a",
          turnId: "turn-a",
          onValue: (value) => {
            latest = value;
          },
        }),
      );
    });
    await flush();
    expect(latest?.error).toMatch(/unavailable/u);
    expect(latest?.assignments).toHaveLength(0);
  });

  it.each(["workspaceId", "sessionId", "turnId"] as const)(
    "clears the previous %s before effects and rejects its late refresh",
    async (field) => {
      const initial = { workspaceId: "workspace-a", sessionId: "session-a", turnId: "turn-a" };
      apiMocks.fetchRemoteWorkerAssignments.mockResolvedValueOnce({ items: [{ assignmentId: "old-assignment" }] });
      const initialRead = (value: RemoteWorkerInlineActivityState) => {
        latest = value;
      };
      await act(async () => {
        renderer = create(createElement(Harness, { ...initial, onValue: initialRead }));
      });
      expect(latest?.assignments[0]?.assignmentId).toBe("old-assignment");
      const oldRevision = latest!.revision;
      let resolveOld!: (value: unknown) => void;
      apiMocks.fetchRemoteWorkerAssignments.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      );
      let oldReload!: Promise<void>;
      await act(async () => {
        oldReload = latest!.reload();
      });
      let resolveCurrent!: (value: unknown) => void;
      apiMocks.fetchRemoteWorkerAssignments.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveCurrent = resolve;
          }),
      );
      const renders: RemoteWorkerInlineActivityState[] = [];
      await act(async () =>
        renderer!.update(
          createElement(Harness, {
            ...initial,
            [field]: `${field}-b`,
            onValue: (value) => {
              latest = value;
              renders.push(value);
            },
          }),
        ),
      );
      expect(renders.length).toBeGreaterThan(0);
      expect(renders.every((value) => value.assignments.length === 0)).toBe(true);
      await act(async () => {
        resolveOld({ items: [{ assignmentId: "late-old-assignment" }] });
        await oldReload;
      });
      expect(latest?.assignments).toHaveLength(0);
      await act(async () => resolveCurrent({ items: [{ assignmentId: "current-assignment" }] }));
      expect(latest?.assignments[0]?.assignmentId).toBe("current-assignment");
      expect(latest!.revision).toBeGreaterThan(oldRevision);
    },
  );
});
