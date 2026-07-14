import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { NotFoundError, type DurableChildWatcherRecord, type DurableRunTimelineEvent } from "@goatcitadel/contracts";
import {
  normalizeDurableBackgroundTaskSignals,
  projectDurableBackgroundTaskRail,
} from "./durable-background-task-projection.js";

const parent = {
  runId: "parent-run",
  workflowKey: "chat.turn.execute",
  status: "running" as const,
  attemptCount: 1,
  maxAttempts: 3,
  version: 4,
  payload: { version: "chat.turn.execute.v1", sessionId: "parent-session" },
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:01.000Z",
};

const child = {
  runId: "child-run",
  workflowKey: "chat.turn.execute",
  status: "running" as const,
  attemptCount: 1,
  maxAttempts: 3,
  version: 7,
  payload: { version: "chat.turn.execute.v1", sessionId: "child-session", turnId: "child-turn" },
  workerHealth: "active" as const,
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:01.000Z",
};

const watcher: DurableChildWatcherRecord = {
  watcherId: "watcher-1",
  revision: 1,
  parentRunId: parent.runId,
  childRunId: child.runId,
  state: "attached",
  nextSequence: 5,
  lastConsumedSequence: 4,
  projectedNoticeCount: 4,
  source: "chat_delegation",
  metadata: {
    delegationRunId: "delegation-1",
    stepId: "step-1",
    childSessionId: "child-session",
    childTurnId: "child-turn",
  },
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:01.000Z",
};

function createStorage(overrides: Record<string, unknown> = {}) {
  const runs = new Map([
    [parent.runId, parent],
    [child.runId, child],
  ]);
  const storage = {
    durableRuns: {
      getRun: vi.fn((runId: string) => {
        const run = runs.get(runId);
        if (!run) throw new NotFoundError({ entity: "Durable run", id: runId });
        return run;
      }),
    },
    durableChildWatchers: { listByParent: vi.fn(() => [watcher]) },
    durableRunEvents: { listByRun: vi.fn(() => []) },
    chatSessionMeta: {
      get: vi.fn((sessionId: string) => ({ sessionId, workspaceId: "workspace-a" })),
    },
    chatDelegationRuns: {
      get: vi.fn(() => ({
        runId: "delegation-1",
        sessionId: "parent-session",
        taskId: "task-1",
        objective: "Synthesize child evidence",
        roles: ["Researcher"],
        mode: "parallel",
        status: "running",
        startedAt: "2026-07-13T00:00:00.000Z",
      })),
    },
    chatDelegationSteps: {
      get: vi.fn(() => ({
        stepId: "step-1",
        runId: "delegation-1",
        role: "Researcher",
        label: "Research current behavior",
        status: "running",
        index: 0,
        durableRunId: "child-run",
        childSessionId: "child-session",
        childTurnId: "child-turn",
        startedAt: "2026-07-13T00:00:00.000Z",
      })),
      listByRun: vi.fn(() => [
        {
          stepId: "step-1",
          runId: "delegation-1",
          role: "Researcher",
          label: "Research current behavior",
          status: "running",
          index: 0,
          durableRunId: "child-run",
          childSessionId: "child-session",
          childTurnId: "child-turn",
          startedAt: "2026-07-13T00:00:00.000Z",
        },
      ]),
    },
    chatToolRuns: { listByTurn: vi.fn(() => []) },
    approvals: { get: vi.fn() },
    chatTurnTraces: { get: vi.fn() },
    chatMessages: { get: vi.fn() },
    ...overrides,
  };
  return storage;
}

function project(storage = createStorage()) {
  return projectDurableBackgroundTaskRail(storage as never, {
    parentRunId: parent.runId,
    workspaceId: "workspace-a",
    sessionId: "parent-session",
    generatedAt: "2026-07-13T00:01:00.000Z",
  });
}

function signal(index: number, childSequence: number, childEventId: string): DurableRunTimelineEvent {
  return {
    eventId: `parent-event-${index}`,
    runId: parent.runId,
    sequence: index,
    eventType: "child_state_changed",
    payload: {
      watcherId: watcher.watcherId,
      childSequence,
      childEventId,
      childEventType: "run_completed",
    },
    createdAt: `2026-07-13T00:00:0${Math.min(index, 9)}.000Z`,
  };
}

describe("durable background-task projection", () => {
  it("keeps canonical run state authoritative over duplicate, stale, conflicting, and out-of-order signals", () => {
    const events = [
      signal(1, 2, "child-event-2"),
      signal(2, 1, "child-event-1"),
      signal(3, 2, "child-event-2"),
      signal(4, 2, "child-event-other"),
    ];
    const storage = createStorage({ durableRunEvents: { listByRun: vi.fn(() => events) } });

    const result = project(storage);

    expect(result.tasks[0]?.canonicalStatus).toBe("running");
    expect(result.tasks[0]?.signalIntegrity).toMatchObject({
      observedCount: 4,
      acceptedCount: 2,
      duplicateCount: 1,
      outOfOrderCount: 1,
      conflictingSequenceCount: 1,
      observationComplete: true,
      posture: "degraded",
    });
    expect(result.tasks[0]?.blockers.some((item) => item.kind === "signal_integrity")).toBe(true);
  });

  it("redacts public previews while hashing and counting the exact terminal output bytes", () => {
    const rawOutput = "Evidence with Bearer abcdefghijklmnopqrstuvwxyz and useful details.";
    const completedChild = { ...child, status: "completed" as const, finishedAt: "2026-07-13T00:02:00.000Z" };
    const storage = createStorage({
      durableRuns: { getRun: vi.fn((runId: string) => (runId === parent.runId ? parent : completedChild)) },
      chatDelegationRuns: {
        get: vi.fn(() => ({
          runId: "delegation-1",
          sessionId: "parent-session",
          taskId: "task-1",
          objective: "Synthesize",
          roles: ["Researcher"],
          mode: "parallel",
          status: "completed",
          finalSummary: "Bearer abcdefghijklmnopqrstuvwxyz synthesis",
          startedAt: "2026-07-13T00:00:00.000Z",
          finishedAt: "2026-07-13T00:02:00.000Z",
        })),
      },
      chatDelegationSteps: {
        get: vi.fn(() => ({
          stepId: "step-1",
          runId: "delegation-1",
          role: "Researcher",
          status: "completed",
          index: 0,
          output: rawOutput,
          durableRunId: "child-run",
          childSessionId: "child-session",
          childTurnId: "child-turn",
          startedAt: "2026-07-13T00:00:00.000Z",
          finishedAt: "2026-07-13T00:02:00.000Z",
        })),
        listByRun: vi.fn(() => [
          {
            stepId: "step-1",
            runId: "delegation-1",
            role: "Researcher",
            status: "completed",
            index: 0,
            output: rawOutput,
            durableRunId: "child-run",
            childSessionId: "child-session",
            childTurnId: "child-turn",
            startedAt: "2026-07-13T00:00:00.000Z",
            finishedAt: "2026-07-13T00:02:00.000Z",
          },
        ]),
      },
      chatToolRuns: {
        listByTurn: vi.fn(() => [
          {
            toolRunId: "tool-1",
            turnId: "child-turn",
            sessionId: "child-session",
            toolName: "shell",
            status: "approval_required",
            approvalId: "approval-1",
            error: "Bearer abcdefghijklmnopqrstuvwxyz error",
            startedAt: "2026-07-13T00:00:01.000Z",
          },
        ]),
      },
      approvals: {
        get: vi.fn(() => ({
          approvalId: "approval-1",
          kind: "tool",
          riskLevel: "danger",
          status: "pending",
          payload: {},
          preview: {},
          linkage: { sessionId: "child-session", toolName: "shell" },
          createdAt: "2026-07-13T00:00:01.000Z",
          explanationStatus: "not_requested",
        })),
      },
    });

    const result = project(storage);
    const output = result.tasks[0]!.output;

    expect(output.summary).toContain("[REDACTED]");
    expect(output.summary).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(output.sha256).toBe(createHash("sha256").update(Buffer.from(rawOutput)).digest("hex"));
    expect(output.byteCount).toBe(Buffer.byteLength(rawOutput));
    expect(result.synthesis.summary).toBe("Bearer [REDACTED] synthesis");
    expect(result.tasks[0]?.tools[0]?.error).toBe("Bearer [REDACTED] error");
    expect(result.tasks[0]?.blockers.some((item) => item.kind === "signal_integrity")).toBe(true);
    expect(result.tasks[0]?.blockers.some((item) => item.kind === "approval_required")).toBe(false);
    expect(result.synthesis.lineage[0]).toMatchObject({ sourceId: "step-1", childRunId: "child-run" });
  });

  it("binds synthesis lineage to one exact delegation generation and marks other watched children uncovered", () => {
    const childA = {
      ...child,
      runId: "child-a",
      status: "completed" as const,
      payload: { sessionId: "child-a-session", turnId: "child-a-turn" },
    };
    const childB = {
      ...child,
      runId: "child-b",
      status: "completed" as const,
      payload: { sessionId: "child-b-session", turnId: "child-b-turn" },
    };
    const watchers = [
      {
        ...watcher,
        watcherId: "watcher-a",
        childRunId: "child-a",
        metadata: {
          delegationRunId: "delegation-a",
          stepId: "step-a",
          childSessionId: "child-a-session",
          childTurnId: "child-a-turn",
        },
      },
      {
        ...watcher,
        watcherId: "watcher-b",
        childRunId: "child-b",
        metadata: {
          delegationRunId: "delegation-b",
          stepId: "step-b",
          childSessionId: "child-b-session",
          childTurnId: "child-b-turn",
        },
      },
    ];
    const steps = {
      "step-a": {
        stepId: "step-a",
        runId: "delegation-a",
        role: "Researcher",
        status: "completed",
        index: 0,
        output: "output-a",
        durableRunId: "child-a",
        childSessionId: "child-a-session",
        childTurnId: "child-a-turn",
        startedAt: "2026-07-13T00:00:00.000Z",
      },
      "step-b": {
        stepId: "step-b",
        runId: "delegation-b",
        role: "QA",
        status: "completed",
        index: 0,
        output: "output-b",
        durableRunId: "child-b",
        childSessionId: "child-b-session",
        childTurnId: "child-b-turn",
        startedAt: "2026-07-13T00:01:00.000Z",
      },
    } as const;
    const storage = createStorage({
      durableChildWatchers: { listByParent: vi.fn(() => watchers) },
      durableRuns: {
        getRun: vi.fn((runId: string) => (runId === parent.runId ? parent : runId === "child-a" ? childA : childB)),
      },
      chatDelegationRuns: {
        get: vi.fn((runId: string) => ({
          runId,
          sessionId: "parent-session",
          taskId: `task-${runId}`,
          objective: runId,
          roles: ["Researcher"],
          mode: "parallel",
          status: "completed",
          finalSummary: `summary-${runId}`,
          startedAt: runId === "delegation-b" ? "2026-07-13T00:01:00.000Z" : "2026-07-13T00:00:00.000Z",
        })),
      },
      chatDelegationSteps: {
        get: vi.fn((stepId: keyof typeof steps) => steps[stepId]),
        listByRun: vi.fn((runId: string) => [runId === "delegation-b" ? steps["step-b"] : steps["step-a"]]),
      },
      chatSessionMeta: { get: vi.fn((sessionId: string) => ({ sessionId, workspaceId: "workspace-a" })) },
    });

    const result = project(storage);

    expect(result.synthesis).toMatchObject({
      availability: "partial",
      delegationRunId: "delegation-b",
      lineage: [{ watcherId: "watcher-b", childRunId: "child-b", sourceId: "step-b" }],
      uncoveredChildRunIds: ["child-a"],
      uncoveredStepIds: [],
    });
    expect(result.synthesis.lineage.some((entry) => entry.childRunId === "child-a")).toBe(false);
    expect(result.unknowns.join(" ")).toContain("spans 2 delegation runs");
  });

  it("fails lineage verification when referenced delegation records are missing", () => {
    const storage = createStorage({
      chatDelegationRuns: {
        get: vi.fn(() => {
          throw new NotFoundError({ entity: "Delegation run", id: "delegation-1" });
        }),
      },
      chatDelegationSteps: {
        get: vi.fn(() => {
          throw new NotFoundError({ entity: "Delegation step", id: "step-1" });
        }),
        listByRun: vi.fn(() => []),
      },
    });

    const result = project(storage);

    expect(result.tasks[0]).toMatchObject({ scope: { verified: false }, controls: { cancel: { enabled: false } } });
    expect(result.synthesis).toMatchObject({ lineage: [], uncoveredChildRunIds: ["child-run"] });
  });

  it("degrades a deleted child session and rejects oversized metadata identifiers without leaking links", () => {
    const oversizedId = "x".repeat(201);
    const badWatcher = { ...watcher, metadata: { ...watcher.metadata, delegationRunId: oversizedId } };
    const storage = createStorage({
      durableChildWatchers: { listByParent: vi.fn(() => [badWatcher]) },
      chatSessionMeta: {
        get: vi.fn((sessionId: string) => {
          if (sessionId === "child-session") throw new NotFoundError({ entity: "Chat session", id: sessionId });
          return { sessionId, workspaceId: "workspace-a" };
        }),
      },
    });

    const result = project(storage);
    const task = result.tasks[0]!;

    expect(task.scope.verified).toBe(false);
    expect(task.scope.sessionId).toBe("parent-session");
    expect(task.canonicalStatus).toBe("unknown");
    expect(task.childVersion).toBeUndefined();
    expect(task.role).toBeUndefined();
    expect(task.startedAt).toBeUndefined();
    expect(task.label).toBe("Child child-run");
    expect(task.controls.cancel.enabled).toBe(false);
    expect(task.blockers.some((item) => item.kind === "scope_unverified")).toBe(true);
    expect(task.links).toEqual([{ kind: "durable_run", id: "child-run", label: "Child run" }]);
    expect(JSON.stringify(task)).not.toContain("Research current behavior");
    expect(task.links.some((link) => link.id === oversizedId)).toBe(false);
    expect(result.synthesis.lineage).toEqual([]);
  });

  it("degrades missing children and terminal children without concrete output", () => {
    const completedChild = { ...child, status: "completed" as const };
    const missingChildStorage = createStorage({
      durableRuns: {
        getRun: vi.fn((runId: string) => {
          if (runId === parent.runId) return parent;
          throw new NotFoundError({ entity: "Durable run", id: runId });
        }),
      },
    });
    expect(project(missingChildStorage).tasks[0]).toMatchObject({
      canonicalStatus: "missing",
      output: { availability: "missing" },
    });

    const missingOutputStorage = createStorage({
      durableRuns: { getRun: vi.fn((runId: string) => (runId === parent.runId ? parent : completedChild)) },
      chatDelegationSteps: {
        get: vi.fn(() => ({
          stepId: "step-1",
          runId: "delegation-1",
          role: "Researcher",
          status: "completed",
          index: 0,
          durableRunId: "child-run",
          childSessionId: "child-session",
          childTurnId: "child-turn",
          startedAt: "2026-07-13T00:00:00.000Z",
        })),
        listByRun: vi.fn(() => [
          {
            stepId: "step-1",
            runId: "delegation-1",
            role: "Researcher",
            status: "completed",
            index: 0,
            durableRunId: "child-run",
            childSessionId: "child-session",
            childTurnId: "child-turn",
            startedAt: "2026-07-13T00:00:00.000Z",
          },
        ]),
      },
      chatTurnTraces: {
        get: vi.fn(() => ({
          turnId: "child-turn",
          sessionId: "child-session",
          assistantMessageId: "deleted-message",
        })),
      },
      chatMessages: { get: vi.fn(() => undefined) },
    });
    const missingOutput = project(missingOutputStorage);
    expect(missingOutput.tasks[0]?.output.availability).toBe("missing");
    expect(missingOutput.tasks[0]?.blockers.some((item) => item.kind === "missing_output")).toBe(true);
    expect(missingOutput.synthesis.missingTerminalChildRunIds).toEqual(["child-run"]);
  });

  it("marks capped watcher and signal reads as incomplete instead of implying completeness", () => {
    const watchers = Array.from({ length: 500 }, (_, index) => ({
      ...watcher,
      watcherId: `watcher-${index}`,
      childRunId: `missing-child-${index}`,
      metadata: {},
    }));
    const events = Array.from({ length: 2_000 }, (_, index) => ({
      ...signal(index + 1, index + 1, `event-${index}`),
      payload: { watcherId: "unrelated", childSequence: index + 1, childEventId: `event-${index}` },
    }));
    const storage = createStorage({
      durableChildWatchers: { listByParent: vi.fn(() => watchers) },
      durableRunEvents: { listByRun: vi.fn(() => events) },
      durableRuns: {
        getRun: vi.fn((runId: string) => {
          if (runId === parent.runId) return parent;
          throw new NotFoundError({ entity: "Durable run", id: runId });
        }),
      },
    });

    const result = project(storage);

    expect(result.coverage).toEqual({
      watchers: { complete: false, observedCount: 500, limit: 500 },
      parentSignals: { complete: false, observedCount: 2_000, limit: 2_000 },
    });
    expect(result.tasks[0]?.signalIntegrity).toMatchObject({ observationComplete: false, posture: "degraded" });
    expect(result.unknowns).toEqual(
      expect.arrayContaining([expect.stringContaining("Watcher coverage"), expect.stringContaining("signal coverage")]),
    );
  });

  it("normalizes the same persisted inputs deterministically across projection restarts", () => {
    const events = [signal(1, 1, "child-event-1")];
    const storage = createStorage({ durableRunEvents: { listByRun: vi.fn(() => events) } });
    expect(project(storage)).toEqual(project(storage));
  });
});

describe("normalizeDurableBackgroundTaskSignals", () => {
  it("reports an incomplete empty observation as degraded", () => {
    expect(normalizeDurableBackgroundTaskSignals([], "watcher-1", false)).toMatchObject({
      observationComplete: false,
      posture: "degraded",
    });
  });
});
