import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DurableBackgroundTaskItem, DurableBackgroundTaskRailResponse } from "@goatcitadel/contracts";
import {
  controlDurableBackgroundTask,
  fetchDurableBackgroundTaskRail,
} from "@goatcitadel/mission-control-shared/api/durable";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import { useDurableBackgroundTaskRail, type DurableBackgroundTaskRailState } from "./useDurableBackgroundTaskRail";

vi.mock("@goatcitadel/mission-control-shared/api/durable", () => ({
  fetchDurableBackgroundTaskRail: vi.fn(),
  controlDurableBackgroundTask: vi.fn(),
}));

const mockedFetch = vi.mocked(fetchDurableBackgroundTaskRail);
const mockedControl = vi.mocked(controlDurableBackgroundTask);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function snapshot(runId: string): DurableBackgroundTaskRailResponse {
  return {
    version: "durable.background_task_rail.v1",
    generatedAt: "2026-07-13T00:00:00.000Z",
    scope: { workspaceId: "workspace-a", sessionId: "session-a", verified: true },
    parent: { runId, status: "completed", version: 1, links: [] },
    coverage: {
      watchers: { complete: true, observedCount: 0, limit: 500 },
      parentSignals: { complete: true, observedCount: 0, limit: 2_000 },
    },
    tasks: [],
    synthesis: {
      availability: "missing",
      lineage: [],
      missingTerminalChildRunIds: [],
      uncoveredChildRunIds: [],
      uncoveredStepIds: [],
    },
    unknowns: [],
  };
}

function activeTask(watcherId: string): DurableBackgroundTaskItem {
  return {
    watcherId,
    watcherRevision: 1,
    watcherState: "attached",
    watcherUpdatedAt: "2026-07-13T00:00:00.000Z",
    childRunId: "child-1",
    canonicalStatus: "waiting",
    childVersion: 7,
    label: "Research parity",
    scope: { workspaceId: "workspace-a", sessionId: "session-a", verified: true },
    tools: [],
    toolCoverage: { complete: true, observedCount: 0, limit: 200 },
    approvals: [],
    output: { availability: "not_terminal" },
    blockers: [],
    signalIntegrity: {
      observedCount: 1,
      acceptedCount: 1,
      duplicateCount: 0,
      outOfOrderCount: 0,
      conflictingSequenceCount: 0,
      highestAcceptedSequence: 1,
      observationComplete: true,
      posture: "clean",
    },
    controls: {
      detach: { enabled: true },
      reattach: { enabled: false, reason: "Watcher is attached." },
      cancel: { enabled: true },
    },
    links: [],
  };
}

function Harness({ parentRunId }: { parentRunId: string }) {
  const rail = useDurableBackgroundTaskRail({
    parentRunId,
    workspaceId: "workspace-a",
    sessionId: "session-a",
  });
  return <span>{rail.snapshot?.parent.runId ?? rail.error ?? (rail.loading ? "loading" : "empty")}</span>;
}

function text(renderer: ReactTestRenderer): string {
  const value = renderer.toJSON();
  if (!value || Array.isArray(value)) return "";
  return String(value.children?.join("") ?? "");
}

describe("useDurableBackgroundTaskRail", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedControl.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not let a stale response from a prior selected run overwrite the current scope", async () => {
    const first = deferred<DurableBackgroundTaskRailResponse>();
    const second = deferred<DurableBackgroundTaskRailResponse>();
    mockedFetch.mockImplementation((runId) => (runId === "run-a" ? first.promise : second.promise));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness parentRunId="run-a" />);
    });
    expect(text(renderer)).toBe("loading");

    await act(async () => {
      renderer.update(<Harness parentRunId="run-b" />);
    });
    await act(async () => second.resolve(snapshot("run-b")));
    expect(text(renderer)).toBe("run-b");

    await act(async () => first.resolve(snapshot("run-a")));
    expect(text(renderer)).toBe("run-b");
  });

  it("surfaces fetch errors without inventing canonical state", async () => {
    mockedFetch.mockRejectedValue(new Error("scope unavailable"));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness parentRunId="run-a" />);
    });
    expect(text(renderer)).toBe("scope unavailable");
  });

  it("keeps a rail 404 as an error but renders an operator sentence, not the API envelope", async () => {
    mockedFetch.mockRejectedValue(
      new ApiRequestError('API error 404: {"error":"Durable background-task rail run-a not found"}', {
        kind: "http",
        method: "GET",
        path: "/api/v1/chat/runs/run-a/background-tasks",
        status: 404,
      }),
    );
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness parentRunId="run-a" />);
    });
    expect(text(renderer)).toBe("No background-task rail exists for this run in the active workspace/session scope.");
  });

  it("MCNEXT-013: a control success that ends polling still clears the masked in-flight refresh's refreshing flag", async () => {
    vi.useFakeTimers();
    const running = snapshot("run-a");
    running.parent.status = "running";
    running.tasks = [activeTask("watcher-1")];
    const cancelled = snapshot("run-a");
    cancelled.tasks = [{ ...activeTask("watcher-1"), watcherRevision: 2, canonicalStatus: "cancelled" }];
    const pollFetch = deferred<DurableBackgroundTaskRailResponse>();
    mockedFetch.mockResolvedValueOnce(running).mockImplementation(() => pollFetch.promise);
    mockedControl.mockResolvedValue({
      version: "durable.background_task_control.v1",
      action: "cancel",
      watcherId: "watcher-1",
      childRunId: "child-1",
      outcome: "applied",
      rail: cancelled,
    });

    let captured: DurableBackgroundTaskRailState | null = null;
    function CaptureHarness() {
      captured = useDurableBackgroundTaskRail({
        parentRunId: "run-a",
        workspaceId: "workspace-a",
        sessionId: "session-a",
      });
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CaptureHarness />);
    });
    expect(captured!.snapshot?.parent.status).toBe("running");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(captured!.refreshing).toBe(true);

    // The cancel lands while that poll refresh is still in flight; its rail is
    // fully terminal, so polling stops and no later refresh will ever run.
    let controlled = false;
    await act(async () => {
      controlled = await captured!.control("watcher-1", "cancel");
    });
    expect(controlled).toBe(true);

    // The masked poll response settles: it must neither clobber the control
    // rail nor leave `refreshing` stuck true forever.
    await act(async () => pollFetch.resolve(running));
    expect(captured!.snapshot?.tasks[0]?.canonicalStatus).toBe("cancelled");
    expect(captured!.refreshing).toBe(false);
    act(() => renderer.unmount());
  });

  it("keeps polling after all children finish while the parent is still synthesizing", async () => {
    vi.useFakeTimers();
    const synthesizing = snapshot("run-a");
    synthesizing.parent.status = "running";
    mockedFetch.mockResolvedValue(synthesizing);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness parentRunId="run-a" />);
    });
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(mockedFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    act(() => renderer.unmount());
  });
});
