import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DurableBackgroundTaskRailResponse } from "@goatcitadel/contracts";
import { DurableBackgroundTaskRail } from "./DurableBackgroundTaskRail";
import { useDurableBackgroundTaskRail } from "./useDurableBackgroundTaskRail";

vi.mock("./useDurableBackgroundTaskRail", () => ({
  useDurableBackgroundTaskRail: vi.fn(),
  isTerminalStatus: (status: string) =>
    status === "completed" || status === "failed" || status === "cancelled" || status === "dead_lettered",
}));

// Keep the rail test hermetic: the inline remote-worker activity is exercised in
// its own suite. Here we only assert the rail threads scope into it (no second
// surface — it renders INSIDE the existing rail).
const railMocks = vi.hoisted(() => ({ inlineProps: [] as Array<Record<string, unknown>> }));
vi.mock("./RemoteWorkerInlineActivity", () => ({
  RemoteWorkerInlineActivity: (props: Record<string, unknown>) => {
    railMocks.inlineProps.push(props);
    return null;
  },
}));

const mockedUseRail = vi.mocked(useDurableBackgroundTaskRail);
const control = vi.fn(async () => true);
const refresh = vi.fn(async () => undefined);

const snapshot: DurableBackgroundTaskRailResponse = {
  version: "durable.background_task_rail.v1",
  generatedAt: "2026-07-13T00:00:00.000Z",
  scope: { workspaceId: "workspace-a", sessionId: "session-a", verified: true },
  parent: {
    runId: "parent-run",
    status: "waiting",
    version: 4,
    links: [{ kind: "durable_run", id: "parent-run", label: "Parent run" }],
  },
  coverage: {
    watchers: { complete: true, observedCount: 2, limit: 500 },
    parentSignals: { complete: true, observedCount: 4, limit: 2_000 },
  },
  tasks: [
    {
      watcherId: "watcher-running",
      watcherRevision: 1,
      watcherState: "attached",
      watcherUpdatedAt: "2026-07-13T00:00:00.000Z",
      childRunId: "child-running",
      canonicalStatus: "waiting",
      childVersion: 7,
      workerHealth: "active",
      label: "Research parity",
      role: "Researcher",
      scope: { workspaceId: "workspace-a", sessionId: "child-session", verified: true },
      tools: [
        {
          toolRunId: "tool-1",
          toolName: "web.search",
          status: "approval_required",
          approvalId: "approval-1",
          startedAt: "2026-07-13T00:00:00.000Z",
          links: [{ kind: "approval", id: "approval-1", label: "Approval" }],
        },
      ],
      toolCoverage: { complete: true, observedCount: 1, limit: 200 },
      approvals: [
        {
          approvalId: "approval-1",
          status: "pending",
          riskLevel: "caution",
          links: [{ kind: "approval", id: "approval-1", label: "Approval" }],
        },
      ],
      output: { availability: "not_terminal" },
      blockers: [{ kind: "approval_required", message: "Operator approval is required." }],
      attention: {
        state: "foreground",
        reason: "watcher_attached",
        updatedAt: "2026-07-13T00:00:00.000Z",
        required: true,
        requiredReason: "approval_required",
      },
      signalIntegrity: {
        observedCount: 3,
        acceptedCount: 2,
        duplicateCount: 1,
        outOfOrderCount: 0,
        conflictingSequenceCount: 0,
        highestAcceptedSequence: 2,
        observationComplete: true,
        posture: "degraded",
      },
      controls: {
        detach: { enabled: true },
        reattach: { enabled: false, reason: "Watcher is attached." },
        cancel: { enabled: true },
      },
      links: [
        { kind: "durable_run", id: "child-running", label: "Child run" },
        { kind: "chat_session", id: "child-session", label: "Child chat" },
      ],
    },
    {
      watcherId: "watcher-terminal",
      watcherRevision: 2,
      watcherState: "detached",
      watcherUpdatedAt: "2026-07-13T00:00:00.000Z",
      childRunId: "child-terminal",
      canonicalStatus: "completed",
      childVersion: 9,
      label: "Verify results",
      role: "QA",
      scope: { workspaceId: "workspace-a", sessionId: "qa-session", verified: true },
      tools: [],
      toolCoverage: { complete: true, observedCount: 0, limit: 200 },
      approvals: [],
      output: {
        availability: "available",
        source: "delegation_step",
        sourceId: "step-qa",
        summary: "All focused checks passed.",
        sha256: "a".repeat(64),
        byteCount: 26,
      },
      blockers: [],
      attention: {
        state: "background",
        reason: "operator_continued_in_background",
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
        detach: { enabled: false, reason: "Watcher is detached." },
        reattach: { enabled: true },
        cancel: { enabled: false, reason: "Child run is already completed." },
      },
      links: [{ kind: "durable_run", id: "child-terminal", label: "Child run" }],
    },
  ],
  synthesis: {
    availability: "available",
    summary: "Research and verification are synthesized.",
    delegationRunId: "delegation-1",
    lineage: [
      {
        watcherId: "watcher-terminal",
        childRunId: "child-terminal",
        source: "delegation_step",
        sourceId: "step-qa",
        sha256: "a".repeat(64),
        byteCount: 26,
        links: [{ kind: "durable_run", id: "child-terminal", label: "Child run" }],
      },
    ],
    missingTerminalChildRunIds: [],
    uncoveredChildRunIds: [],
    uncoveredStepIds: [],
  },
  unknowns: ["One runtime field is unavailable."],
};

function instanceText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(instanceText).join("");
  if (value && typeof value === "object" && "children" in value) {
    return instanceText((value as { children?: unknown }).children);
  }
  return "";
}

function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find((candidate) => instanceText(candidate.children).includes(label));
}

describe("DurableBackgroundTaskRail", () => {
  beforeEach(() => {
    control.mockClear();
    refresh.mockClear();
    railMocks.inlineProps.length = 0;
    mockedUseRail.mockReturnValue({
      snapshot,
      loading: false,
      refreshing: false,
      error: null,
      pendingWatcherId: null,
      refresh,
      control,
    });
  });

  it("threads workspace/session/turn scope into the inline remote-worker activity inside the existing rail", () => {
    act(() => {
      create(
        <DurableBackgroundTaskRail
          parentRunId="parent-run"
          workspaceId="workspace-a"
          sessionId="session-a"
          turnId="turn-a"
          queuedCount={0}
          streamStatus="open"
          queueLabels={[]}
        />,
      );
    });
    expect(railMocks.inlineProps.at(-1)).toMatchObject({
      workspaceId: "workspace-a",
      sessionId: "session-a",
      turnId: "turn-a",
    });
  });

  it("renders live tools, blockers, terminal evidence, lineage, typed links, and attention state without raw JSON", () => {
    const onOpenSemanticLink = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <DurableBackgroundTaskRail
          parentRunId="parent-run"
          workspaceId="workspace-a"
          sessionId="session-a"
          queuedCount={0}
          streamStatus="idle"
          queueLabels={[]}
          onOpenSemanticLink={onOpenSemanticLink}
        />,
      );
    });
    const text = instanceText(renderer.toJSON());
    expect(text).toContain("Research parity");
    expect(text).toContain("web.search");
    expect(text).toContain("Operator approval is required.");
    expect(text).toContain("All focused checks passed.");
    expect(text).toContain("Parent synthesis");
    expect(text).toContain("Continuing in background");
    expect(text).toContain("execution policy and approvals are unchanged");
    expect(text).toContain("Needs attention: approval required");
    expect(text).not.toContain('"canonicalStatus"');
    expect(renderer.root.findAll((node) => node.props["data-link-kind"] === "durable_run")).not.toHaveLength(0);
    const detach = renderer.root.findByProps({
      "aria-label": "Continue background task child-running in background",
    });
    const reattach = renderer.root.findByProps({
      "aria-label": "Bring background task child-terminal to foreground",
    });
    expect(detach).toBeDefined();
    expect(reattach).toBeDefined();
    act(() => detach.props.onClick());
    expect(control).toHaveBeenCalledWith("watcher-running", "detach", undefined);
    act(() => reattach.props.onClick());
    expect(control).toHaveBeenCalledWith("watcher-terminal", "reattach", undefined);
    act(() => button(renderer, "Child run")!.props.onClick());
    expect(onOpenSemanticLink).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "durable_run", id: "child-running" }),
      expect.any(Array),
    );
  });

  it("keeps runtime unknowns collapsed behind a controlled, inspectable disclosure", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <DurableBackgroundTaskRail
          parentRunId="parent-run"
          workspaceId="workspace-a"
          sessionId="session-a"
          queuedCount={0}
          streamStatus="idle"
          queueLabels={[]}
        />,
      );
    });

    const trigger = renderer.root.find(
      (node) => node.type === "button" && node.props.className === "mc-next-background-rail__unknowns-trigger",
    );
    const unknownsId = trigger.props["aria-controls"] as string;
    const unknowns = () => renderer.root.findByProps({ id: unknownsId });

    expect(trigger.props["aria-expanded"]).toBe(false);
    expect(unknowns().props.hidden).toBe(true);

    act(() => trigger.props.onClick());
    expect(renderer.root.findByProps({ "aria-controls": unknownsId }).props["aria-expanded"]).toBe(true);
    expect(unknowns().props.hidden).toBe(false);

    act(() => {
      renderer.update(
        <DurableBackgroundTaskRail
          parentRunId="parent-run"
          workspaceId="workspace-a"
          sessionId="session-a"
          queuedCount={0}
          streamStatus="idle"
          queueLabels={[]}
        />,
      );
    });
    expect(renderer.root.findByProps({ "aria-controls": unknownsId }).props["aria-expanded"]).toBe(true);
  });

  it("releases the local explorer observer only after canonical detach succeeds and keeps the task inspectable", async () => {
    const onContinueInBackground = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <DurableBackgroundTaskRail
          parentRunId="parent-run"
          workspaceId="workspace-a"
          sessionId="session-a"
          queuedCount={0}
          streamStatus="open"
          queueLabels={[]}
          onContinueInBackground={onContinueInBackground}
        />,
      );
    });

    const detach = renderer.root.findByProps({
      "aria-label": "Continue background task child-running in background",
    });
    await act(async () => {
      detach.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(control).toHaveBeenCalledWith("watcher-running", "detach", undefined);
    expect(onContinueInBackground).toHaveBeenCalledWith(
      expect.objectContaining({ watcherId: "watcher-running", childRunId: "child-running" }),
    );
    expect(
      renderer.root.findByProps({
        "aria-label": "Continue background task child-running in background",
      }),
    ).toBeDefined();

    control.mockResolvedValueOnce(false);
    await act(async () => {
      detach.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onContinueInBackground).toHaveBeenCalledTimes(1);
  });

  it("refreshes a repaired terminal background explorer after restart without remounting the rail", async () => {
    const onBackgroundTaskSettled = vi.fn(async () => true);
    const explorerRecovered: DurableBackgroundTaskRailResponse = {
      ...snapshot,
      tasks: [
        {
          ...snapshot.tasks[0]!,
          watcherState: "detached",
          childRunId: "durable-explorer-child",
          canonicalStatus: "completed",
          childVersion: 8,
          delegationRunId: "explorer-background",
          delegationStepId: "explorer-background-step",
          blockers: [],
          output: {
            availability: "available",
            source: "delegation_step",
            sourceId: "explorer-background-step",
            summary: "The persisted Explorer answer.",
            sha256: "b".repeat(64),
            byteCount: 30,
          },
          attention: {
            state: "background",
            reason: "operator_continued_in_background",
            updatedAt: "2026-07-13T00:01:00.000Z",
            required: false,
          },
        },
      ],
    };
    mockedUseRail.mockReturnValue({
      snapshot: null,
      loading: true,
      refreshing: false,
      error: null,
      pendingWatcherId: null,
      refresh,
      control,
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DurableBackgroundTaskRail
          parentRunId="parent-run"
          workspaceId="workspace-a"
          sessionId="session-a"
          queuedCount={0}
          streamStatus="open"
          queueLabels={[]}
          onBackgroundTaskSettled={onBackgroundTaskSettled}
        />,
      );
      await Promise.resolve();
    });
    expect(onBackgroundTaskSettled).not.toHaveBeenCalled();

    mockedUseRail.mockReturnValue({
      snapshot: explorerRecovered,
      loading: false,
      refreshing: false,
      error: null,
      pendingWatcherId: null,
      refresh,
      control,
    });
    await act(async () => {
      renderer.update(
        <DurableBackgroundTaskRail
          parentRunId="parent-run"
          workspaceId="workspace-a"
          sessionId="session-a"
          queuedCount={0}
          streamStatus="idle"
          queueLabels={[]}
          onBackgroundTaskSettled={onBackgroundTaskSettled}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onBackgroundTaskSettled).toHaveBeenCalledTimes(1);
    expect(onBackgroundTaskSettled).toHaveBeenCalledWith(
      expect.objectContaining({
        childRunId: "durable-explorer-child",
        delegationRunId: "explorer-background",
        delegationStepId: "explorer-background-step",
        canonicalStatus: "completed",
      }),
    );

    mockedUseRail.mockReturnValue({
      snapshot: { ...explorerRecovered },
      loading: false,
      refreshing: false,
      error: null,
      pendingWatcherId: null,
      refresh,
      control,
    });
    await act(async () => {
      renderer.update(
        <DurableBackgroundTaskRail
          parentRunId="parent-run"
          workspaceId="workspace-a"
          sessionId="session-a"
          queuedCount={0}
          streamStatus="idle"
          queueLabels={[]}
          onBackgroundTaskSettled={onBackgroundTaskSettled}
        />,
      );
      await Promise.resolve();
    });
    expect(onBackgroundTaskSettled).toHaveBeenCalledTimes(1);
  });

  it("bounds persisted-report retries when the terminal rail can no longer poll", async () => {
    vi.useFakeTimers();
    const onBackgroundTaskSettled = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("detail temporarily unavailable"))
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const explorerCompleted: DurableBackgroundTaskRailResponse = {
      ...snapshot,
      tasks: [
        {
          ...snapshot.tasks[1]!,
          watcherId: "delegation-child:explorer-background-step",
          childRunId: "durable-explorer-child",
          delegationRunId: "explorer-background",
          delegationStepId: "explorer-background-step",
        },
      ],
    };
    mockedUseRail.mockReturnValue({
      snapshot: explorerCompleted,
      loading: false,
      refreshing: false,
      error: null,
      pendingWatcherId: null,
      refresh,
      control,
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DurableBackgroundTaskRail
          parentRunId="parent-run"
          workspaceId="workspace-a"
          sessionId="session-a"
          queuedCount={0}
          streamStatus="idle"
          queueLabels={[]}
          onBackgroundTaskSettled={onBackgroundTaskSettled}
        />,
      );
      await Promise.resolve();
    });
    expect(onBackgroundTaskSettled).toHaveBeenCalledTimes(1);

    mockedUseRail.mockReturnValue({
      snapshot: { ...explorerCompleted, generatedAt: "2026-07-13T00:02:00.000Z" },
      loading: false,
      refreshing: false,
      error: null,
      pendingWatcherId: null,
      refresh,
      control,
    });
    await act(async () => {
      renderer.update(
        <DurableBackgroundTaskRail
          parentRunId="parent-run"
          workspaceId="workspace-a"
          sessionId="session-a"
          queuedCount={0}
          streamStatus="idle"
          queueLabels={[]}
          onBackgroundTaskSettled={onBackgroundTaskSettled}
        />,
      );
      await Promise.resolve();
    });
    expect(onBackgroundTaskSettled).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(onBackgroundTaskSettled).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(onBackgroundTaskSettled).toHaveBeenCalledTimes(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(onBackgroundTaskSettled).toHaveBeenCalledTimes(3);
    renderer.unmount();
    vi.useRealTimers();
  });

  it("announces an in-place attention change once but not initial state after reload", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <DurableBackgroundTaskRail
          parentRunId="parent-run"
          workspaceId="workspace-a"
          sessionId="session-a"
          queuedCount={0}
          streamStatus="idle"
          queueLabels={[]}
        />,
      );
    });
    const announcement = () =>
      instanceText(renderer.root.findByProps({ className: "mc-next-background-rail__announcement" }).children);
    expect(announcement()).toBe("");

    const backgrounded: DurableBackgroundTaskRailResponse = {
      ...snapshot,
      tasks: snapshot.tasks.map((task) =>
        task.watcherId === "watcher-running"
          ? {
              ...task,
              watcherState: "detached",
              attention: {
                state: "background",
                reason: "operator_continued_in_background",
                updatedAt: "2026-07-13T00:01:00.000Z",
                required: true,
                requiredReason: "approval_required",
              },
            }
          : task,
      ),
    };
    mockedUseRail.mockReturnValue({
      snapshot: backgrounded,
      loading: false,
      refreshing: false,
      error: null,
      pendingWatcherId: null,
      refresh,
      control,
    });
    act(() => {
      renderer.update(
        <DurableBackgroundTaskRail
          parentRunId="parent-run"
          workspaceId="workspace-a"
          sessionId="session-a"
          queuedCount={0}
          streamStatus="idle"
          queueLabels={[]}
        />,
      );
    });
    expect(announcement()).toContain("will continue in background");

    act(() => renderer.unmount());
    act(() => {
      renderer = create(
        <DurableBackgroundTaskRail
          parentRunId="parent-run"
          workspaceId="workspace-a"
          sessionId="session-a"
          queuedCount={0}
          streamStatus="idle"
          queueLabels={[]}
        />,
      );
    });
    expect(announcement()).toBe("");
  });

  it("requires an inline confirmation before cancelling a running child", async () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <DurableBackgroundTaskRail
          parentRunId="parent-run"
          workspaceId="workspace-a"
          sessionId="session-a"
          queuedCount={0}
          streamStatus="idle"
          queueLabels={[]}
        />,
      );
    });

    act(() => button(renderer, "Cancel child")!.props.onClick());
    expect(control).not.toHaveBeenCalled();
    expect(instanceText(renderer.toJSON())).toContain("Completed work stays in its evidence record");
    const dialog = renderer.root.find((node) => node.props.role === "alertdialog");
    expect(dialog.props["aria-describedby"]).toBeTruthy();
    expect(dialog.props["aria-modal"]).toBe("false");

    act(() => dialog.props.onKeyDown({ key: "Escape", preventDefault: vi.fn() }));
    expect(instanceText(renderer.toJSON())).not.toContain("Completed work stays in its evidence record");
    act(() => button(renderer, "Cancel child")!.props.onClick());

    await act(async () => button(renderer, "Confirm cancel")!.props.onClick());
    expect(control).toHaveBeenCalledWith("watcher-running", "cancel", "Operator cancelled from Chat");
  });

  it("shows loading, error, empty, and no-selected-run states truthfully", () => {
    mockedUseRail.mockReturnValue({
      snapshot: null,
      loading: true,
      refreshing: false,
      error: "Gateway unavailable",
      pendingWatcherId: null,
      refresh,
      control,
    });
    let loading!: ReactTestRenderer;
    act(() => {
      loading = create(
        <DurableBackgroundTaskRail
          parentRunId="parent"
          workspaceId="workspace-a"
          sessionId="session-a"
          queuedCount={0}
          streamStatus="idle"
          queueLabels={[]}
        />,
      );
    });
    expect(instanceText(loading.toJSON())).toContain("Gateway unavailable");
    expect(instanceText(loading.toJSON())).toContain("Loading durable child state");

    let fallback!: ReactTestRenderer;
    act(() => {
      fallback = create(
        <DurableBackgroundTaskRail
          workspaceId="workspace-a"
          queuedCount={2}
          streamStatus="streaming"
          queueLabels={["Draft", "Verify"]}
        />,
      );
    });
    expect(instanceText(fallback.toJSON())).toContain("2 queued");
    expect(instanceText(fallback.toJSON())).toContain("Draft");
  });
});
