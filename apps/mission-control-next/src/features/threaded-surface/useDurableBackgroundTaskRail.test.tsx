import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DurableBackgroundTaskItem, DurableBackgroundTaskRailResponse } from "@goatcitadel/contracts";
import {
  controlDurableBackgroundTask,
  fetchDurableBackgroundTaskRail,
} from "@goatcitadel/mission-control-shared/api/durable";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import {
  useDurableBackgroundTaskRail,
  __resetBackgroundControlsForTests,
  type DurableBackgroundTaskRailState,
} from "./useDurableBackgroundTaskRail";

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
    attention: {
      state: "foreground",
      reason: "watcher_attached",
      updatedAt: "2026-07-13T00:00:00.000Z",
      required: false,
    },
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
    __resetBackgroundControlsForTests();
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

describe("background control reviews and retained outcomes", () => {
  let owner: DurableBackgroundTaskRailState;
  let renderer: ReactTestRenderer;
  function Capture({ runId = "review-run" }: { runId?: string }) {
    owner = useDurableBackgroundTaskRail({ parentRunId: runId, workspaceId: "workspace-a", sessionId: "session-a" });
    return null;
  }
  const rail = () => ({ ...snapshot("review-run"), tasks: [activeTask("watcher-review")] });
  const conflict = (
    body: unknown = { error: "Durable run child-1 changed from version 7 to 8 before cancellation." },
  ) =>
    new ApiRequestError("HTTP 409", {
      kind: "http",
      method: "POST",
      path: "/api/v1/durable/runs/review-run/background-tasks/watcher-review/control",
      status: 409,
      body,
    });
  beforeEach(async () => {
    __resetBackgroundControlsForTests();
    mockedFetch.mockReset();
    mockedControl.mockReset();
    mockedFetch.mockResolvedValue(rail());
    await act(async () => {
      renderer = create(<Capture />);
    });
  });
  afterEach(() => {
    act(() => renderer.unmount());
    vi.unstubAllGlobals();
  });

  it("returns no review when neither a parent nor a snapshot is available", async () => {
    function NoParentCapture() {
      owner = useDurableBackgroundTaskRail({ workspaceId: "workspace-a", sessionId: "session-a" });
      return null;
    }
    await act(async () => { renderer.update(<NoParentCapture />); });
    expect(owner.snapshot).toBeNull();
    expect(owner.review("watcher-review")).toBeNull();
    expect(mockedControl).not.toHaveBeenCalled();
  });

  it("withholds a known stale review after polling instead of silently upgrading its versions", async () => {
    const review = owner.review("watcher-review")!;
    const newer = rail();
    newer.tasks[0]!.childVersion = 8;
    mockedFetch.mockResolvedValue(newer);
    await act(async () => {
      await owner.refresh();
    });
    await act(async () => {
      expect(await owner.control("watcher-review", "cancel", "reviewed reason", review)).toBe(false);
    });
    expect(mockedControl).not.toHaveBeenCalled();
    expect(owner.snapshot?.tasks[0]?.childVersion).toBe(8);
    expect(owner.controlFailure?.kind).toBe("conflict");
    expect(owner.error).toContain("Close this review");
    await act(async () => {
      await owner.refresh();
      await owner.control("watcher-review", "cancel", undefined, review);
    });
    expect(mockedControl).not.toHaveBeenCalled();
    expect(owner.error).toContain("Close this review");
    expect(owner.review("watcher-review")?.childVersion).toBe(8);
  });

  it("preserves a proven owner conflict through refresh and requires another explicit review", async () => {
    const review = owner.review("watcher-review")!;
    mockedControl.mockRejectedValue(conflict());
    await act(async () => {
      await owner.control("watcher-review", "cancel", "reviewed reason", review);
    });
    expect(mockedControl).toHaveBeenCalledWith(
      "review-run",
      "watcher-review",
      expect.objectContaining({ expectedChildVersion: 7, expectedWatcherRevision: 1 }),
    );
    expect(owner.error).toContain("Close this review");
    await act(async () => {
      await owner.refresh();
      await owner.control("watcher-review", "cancel", undefined, review);
    });
    expect(owner.controlFailure?.kind).toBe("conflict");
    expect(mockedControl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["lost response", () => new Error("connection lost")],
    ["generic conflict", () => conflict({ error: "Owner unavailable" })],
    [
      "committed conflict",
      () =>
        conflict({
          error: "Durable run child-1 changed from version 7 to 8 before cancellation.",
          mutationCommitted: true,
        }),
    ],
    [
      "foreign child",
      () => conflict({ error: "Durable run another-child changed from version 7 to 8 before cancellation." }),
    ],
  ])("retains the unknown lock across refresh and remount: %s", async (_label, error) => {
    mockedControl.mockRejectedValue(error());
    await act(async () => {
      await owner.control("watcher-review", "cancel");
    });
    expect(owner.controlFailure?.kind).toBe("unknown");
    act(() => renderer.unmount());
    await act(async () => {
      renderer = create(<Capture />);
    });
    await act(async () => {
      await owner.refresh();
      await owner.control("watcher-review", "cancel");
    });
    expect(owner.error).toContain("unconfirmed");
    expect(mockedControl).toHaveBeenCalledTimes(1);
  });

  it("rejects retained scope and navigation ABA callbacks without dispatch", async () => {
    const review = owner.review("watcher-review")!;
    const oldControl = owner.control;
    mockedFetch.mockImplementation(async (runId) => ({ ...rail(), parent: { ...rail().parent, runId } }));
    await act(async () => {
      renderer.update(<Capture runId="other-run" />);
    });
    await act(async () => {
      renderer.update(<Capture />);
    });
    expect(await oldControl("watcher-review", "cancel", undefined, review)).toBe(false);
    expect(await owner.control("watcher-review", "cancel", undefined, review)).toBe(false);
    expect(mockedControl).not.toHaveBeenCalled();
  });

  it("a retained refresh cannot dispatch or strand the terminal current scope", async () => {
    const oldRefresh = owner.refresh;
    mockedFetch.mockResolvedValue(snapshot("terminal-b"));
    await act(async () => {
      renderer.update(<Capture runId="terminal-b" />);
    });
    const readCount = mockedFetch.mock.calls.length;
    await act(async () => {
      await oldRefresh();
    });
    expect(mockedFetch).toHaveBeenCalledTimes(readCount);
    expect(owner.snapshot?.parent.runId).toBe("terminal-b");
    expect(owner.refreshing).toBe(false);
  });

  it("dismissal and replacement make retained confirmations inert", async () => {
    const oldReview = owner.review("watcher-review")!;
    owner.dismissReview(oldReview);
    await act(async () => {
      expect(await owner.control("watcher-review", "cancel", undefined, oldReview)).toBe(false);
    });
    const replaced = owner.review("watcher-review")!;
    const newest = owner.review("watcher-review")!;
    owner.dismissReview(replaced);
    await act(async () => {
      expect(await owner.control("watcher-review", "cancel", undefined, replaced)).toBe(false);
    });
    expect(owner.isReviewCurrent(newest)).toBe(true);
    expect(mockedControl).not.toHaveBeenCalled();
  });

  it("admits one POST synchronously and keeps an unknown late result after unmount", async () => {
    const write = deferred<Awaited<ReturnType<typeof controlDurableBackgroundTask>>>();
    mockedControl.mockReturnValue(write.promise);
    let pending!: Promise<boolean>;
    const review = owner.review("watcher-review")!;
    await act(async () => {
      pending = owner.control("watcher-review", "cancel", undefined, review);
      expect(await owner.control("watcher-review", "cancel", undefined, review)).toBe(false);
    });
    act(() => renderer.unmount());
    await act(async () => {
      write.reject(new Error("lost after write"));
      await pending;
    });
    await act(async () => {
      renderer = create(<Capture />);
    });
    expect(owner.controlFailure?.kind).toBe("unknown");
    expect(mockedControl).toHaveBeenCalledTimes(1);
  });
});
