import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  NotFoundError,
  type ChatDelegationRunRecord,
  type ChatDelegationStepRecord,
  type DurableChildWatcherRecord,
  type DurableRunTimelineEvent,
} from "@goatcitadel/contracts";
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

async function project(storage = createStorage()) {
  return await projectDurableBackgroundTaskRail(storage as never, {
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

function createSettlingProjection(status: "completed" | "cancelled" | "failed" | "dead_lettered" = "cancelled") {
  const payload: Record<string, unknown> = { ...child.payload };
  const terminalChild = { ...child, payload, status, version: 8, finishedAt: "2026-07-13T00:02:00.000Z" };
  const step: ChatDelegationStepRecord = {
    stepId: "step-1",
    runId: "delegation-1",
    role: "Researcher",
    status: "running",
    index: 0,
    durableRunId: child.runId,
    childSessionId: "child-session",
    childTurnId: "child-turn",
    startedAt: child.createdAt,
    output: "Unsettled step output must not be cited.",
  };
  const delegation: ChatDelegationRunRecord = {
    runId: "delegation-1",
    sessionId: "parent-session",
    taskId: "task-1",
    objective: "Synthesize child evidence",
    roles: ["Researcher"],
    mode: "sequential",
    status: "running",
    startedAt: child.createdAt,
    citations: [],
    finalSummary: "Unsettled synthesis must not be shown.",
  };
  const childMeta = { sessionId: "child-session", workspaceId: "workspace-a" };
  const storage = createStorage({
    durableRuns: { getRun: vi.fn((runId: string) => (runId === parent.runId ? parent : terminalChild)) },
    chatSessionMeta: {
      get: vi.fn((sessionId: string) =>
        sessionId === "child-session" ? childMeta : { sessionId, workspaceId: "workspace-a" },
      ),
    },
    chatDelegationRuns: { get: vi.fn(() => delegation) },
    chatDelegationSteps: { get: vi.fn(() => step), listByRun: vi.fn(() => [step]) },
  });
  return { storage, terminalChild, step, delegation, childMeta };
}

describe("durable background-task projection", () => {
  it.each(["completed", "cancelled", "failed", "dead_lettered"] as const)(
    "keeps canonical %s truth while withholding unsettled delegation output and synthesis",
    async (status) => {
      const { storage, terminalChild, step, delegation } = createSettlingProjection(status);
      const originalStep = structuredClone(step);
      const pending = await project(storage);
      expect(pending.tasks[0]).toMatchObject({
        canonicalStatus: status,
        childVersion: terminalChild.version,
        scope: { workspaceId: "workspace-a", sessionId: "child-session", verified: true },
        delegationRunId: delegation.runId,
        delegationStepId: step.stepId,
        output: { availability: "unknown" },
        controls: { cancel: { enabled: false }, detach: { enabled: false } },
      });
      expect(pending.tasks[0]!.blockers).toContainEqual({
        kind: "projection_incomplete",
        message: "The canonical child ended; its delegation step has not settled. Output and synthesis are withheld.",
      });
      expect(pending.tasks[0]!.blockers.some((item) => item.kind === "scope_unverified")).toBe(false);
      expect(pending.synthesis).toMatchObject({
        availability: "partial",
        lineage: [],
        missingTerminalChildRunIds: [child.runId],
      });
      expect(pending.synthesis.summary).toBeUndefined();
      expect(JSON.stringify(pending)).not.toContain("Unsettled");
      expect(step).toEqual(originalStep);
      expect(storage.chatTurnTraces.get).not.toHaveBeenCalled();

      // These are new canonical owner records returned by the next read, not projection writes.
      step.status = status === "dead_lettered" ? "failed" : status;
      step.output = "Recorded settled child output.";
      step.finishedAt = terminalChild.finishedAt;
      delegation.status = status === "completed" ? "completed" : "failed";
      delegation.finalSummary = "Recorded settled synthesis.";
      const settled = await project(storage);
      expect(settled.tasks[0]!.canonicalStatus).toBe(status);
      expect(settled.tasks[0]!.blockers.some((item) => item.kind === "projection_incomplete")).toBe(false);
      expect(settled.tasks[0]!.output).toMatchObject({
        availability: "available",
        source: "delegation_step",
        sourceId: step.stepId,
      });
      expect(settled.synthesis.summary).toBe(delegation.finalSummary);
      expect(settled.synthesis.lineage).toHaveLength(1);
      expect(settled.synthesis.availability).toBe(status === "completed" ? "available" : "partial");
    },
  );

  it.each(["durableRunId", "childSessionId", "childTurnId"] as const)(
    "withholds terminal truth while unsettled step %s is missing or foreign",
    async (field) => {
      for (const value of [undefined, "foreign-id"]) {
        const { storage, step } = createSettlingProjection();
        step[field] = value;
        const result = await project(storage);
        expect(result.tasks[0]).toMatchObject({
          canonicalStatus: "unknown",
          scope: { verified: false },
          output: { availability: "unknown" },
        });
        expect(result.tasks[0]!.childVersion).toBeUndefined();
        expect(result.tasks[0]!.links).toEqual([{ kind: "durable_run", id: child.runId, label: "Child run" }]);
        expect(result.synthesis.lineage).toEqual([]);
      }
    },
  );

  it.each(["sessionId", "turnId"] as const)(
    "requires the canonical child payload %s for pending-settlement identity",
    async (field) => {
      for (const value of [undefined, "foreign-id"]) {
        const { storage, terminalChild } = createSettlingProjection();
        if (value === undefined) delete terminalChild.payload[field];
        else terminalChild.payload[field] = value;
        const result = await project(storage);
        expect(result.tasks[0]).toMatchObject({ canonicalStatus: "unknown", scope: { verified: false } });
        expect(result.tasks[0]!.childVersion).toBeUndefined();
        expect(result.synthesis.lineage).toEqual([]);
      }
    },
  );

  it("keeps foreign step, delegation and workspace identities unverified during settlement", async () => {
    const mutations: Array<(fixture: ReturnType<typeof createSettlingProjection>) => void> = [
      ({ step }) => {
        step.stepId = "other-step";
      },
      ({ step }) => {
        step.runId = "other-delegation";
      },
      ({ delegation }) => {
        delegation.runId = "other-delegation";
      },
      ({ delegation }) => {
        delegation.sessionId = "other-parent-session";
      },
      ({ childMeta }) => {
        childMeta.workspaceId = "other-workspace";
      },
    ];
    for (const mutate of mutations) {
      const fixture = createSettlingProjection();
      mutate(fixture);
      const result = await project(fixture.storage);
      expect(result.tasks[0]).toMatchObject({ canonicalStatus: "unknown", scope: { verified: false } });
      expect(result.tasks[0]!.links).toEqual([{ kind: "durable_run", id: child.runId, label: "Child run" }]);
      expect(result.synthesis.lineage).toEqual([]);
    }
  });

  it.each(["delegationRunId", "stepId", "childSessionId", "childTurnId"] as const)(
    "rejects malformed watcher %s before exposing terminal child evidence",
    async (field) => {
      for (const value of ["", "bad\u0000id", "x".repeat(201), 42]) {
        const { storage } = createSettlingProjection();
        storage.durableChildWatchers.listByParent.mockReturnValue([
          { ...watcher, metadata: { ...watcher.metadata, [field]: value } },
        ]);
        const result = await project(storage);
        expect(result.tasks[0]).toMatchObject({
          canonicalStatus: "unknown",
          scope: { verified: false },
          output: { availability: "unknown" },
        });
        expect(result.tasks[0]!.childVersion).toBeUndefined();
        expect(result.tasks[0]!.links).toEqual([{ kind: "durable_run", id: child.runId, label: "Child run" }]);
        expect(result.synthesis.lineage).toEqual([]);
      }
    },
  );

  it("keeps canonical run state authoritative over duplicate, stale, conflicting, and out-of-order signals", async () => {
    const events = [
      signal(1, 2, "child-event-2"),
      signal(2, 1, "child-event-1"),
      signal(3, 2, "child-event-2"),
      signal(4, 2, "child-event-other"),
    ];
    const storage = createStorage({ durableRunEvents: { listByRun: vi.fn(() => events) } });

    const result = await project(storage);

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
    expect(result.tasks[0]?.attention).toMatchObject({
      state: "foreground",
      reason: "watcher_attached",
      required: true,
      requiredReason: "signal_integrity",
    });
    expect(result.tasks[0]?.blockers.some((item) => item.kind === "signal_integrity")).toBe(true);
  });

  it("projects persisted background attention separately from canonical waiting state", async () => {
    const detachedWatcher = {
      ...watcher,
      revision: 2,
      state: "detached" as const,
      detachedAt: "2026-07-13T00:00:02.000Z",
      updatedAt: "2026-07-13T00:00:02.000Z",
    };
    const waitingChild = { ...child, status: "waiting" as const, version: 8 };
    const storage = createStorage({
      durableChildWatchers: { listByParent: vi.fn(() => [detachedWatcher]) },
      durableRuns: { getRun: vi.fn((runId: string) => (runId === parent.runId ? parent : waitingChild)) },
    });

    const result = await project(storage);

    expect(result.tasks[0]?.attention).toEqual({
      state: "background",
      reason: "operator_continued_in_background",
      updatedAt: "2026-07-13T00:00:02.000Z",
      required: true,
      requiredReason: "waiting",
    });
    expect(result.tasks[0]?.canonicalStatus).toBe("waiting");
    expect(result.tasks[0]?.blockers).toContainEqual({ kind: "waiting", message: "Child run is waiting." });
    expect(result.tasks[0]?.blockers.some((item) => item.kind === "detached")).toBe(false);
  });

  it("projects a paused detached child as explicit required operator attention", async () => {
    const detachedWatcher = {
      ...watcher,
      revision: 2,
      state: "detached" as const,
      detachedAt: "2026-07-13T00:00:02.000Z",
      updatedAt: "2026-07-13T00:00:02.000Z",
    };
    const pausedChild = { ...child, status: "paused" as const, version: 8 };
    const storage = createStorage({
      durableChildWatchers: { listByParent: vi.fn(() => [detachedWatcher]) },
      durableRuns: { getRun: vi.fn((runId: string) => (runId === parent.runId ? parent : pausedChild)) },
    });

    const result = await project(storage);

    expect(result.tasks[0]?.canonicalStatus).toBe("paused");
    expect(result.tasks[0]?.attention).toEqual({
      state: "background",
      reason: "operator_continued_in_background",
      updatedAt: "2026-07-13T00:00:02.000Z",
      required: true,
      requiredReason: "paused",
    });
    expect(result.tasks[0]?.blockers).toContainEqual({
      kind: "paused",
      message: "Child run is paused and requires operator attention.",
    });
  });

  it("redacts public previews while hashing and counting the exact terminal output bytes", async () => {
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

    const result = await project(storage);
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

  it("binds synthesis lineage to one exact delegation generation and marks other watched children uncovered", async () => {
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

    const result = await project(storage);

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

  it("fails lineage verification when referenced delegation records are missing", async () => {
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

    const result = await project(storage);

    expect(result.tasks[0]).toMatchObject({ scope: { verified: false }, controls: { cancel: { enabled: false } } });
    expect(result.synthesis).toMatchObject({ lineage: [], uncoveredChildRunIds: ["child-run"] });
  });

  it("degrades a deleted child session and rejects oversized metadata identifiers without leaking links", async () => {
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

    const result = await project(storage);
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

  it("degrades missing children and terminal children without concrete output", async () => {
    const completedChild = { ...child, status: "completed" as const };
    const missingChildStorage = createStorage({
      durableRuns: {
        getRun: vi.fn((runId: string) => {
          if (runId === parent.runId) return parent;
          throw new NotFoundError({ entity: "Durable run", id: runId });
        }),
      },
    });
    expect((await project(missingChildStorage)).tasks[0]).toMatchObject({
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
    const missingOutput = await project(missingOutputStorage);
    expect(missingOutput.tasks[0]?.output.availability).toBe("missing");
    expect(missingOutput.tasks[0]?.blockers.some((item) => item.kind === "missing_output")).toBe(true);
    expect(missingOutput.synthesis.missingTerminalChildRunIds).toEqual(["child-run"]);
  });

  it("marks capped watcher and signal reads as incomplete instead of implying completeness", async () => {
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

    const result = await project(storage);

    expect(result.coverage).toEqual({
      watchers: { complete: false, observedCount: 500, limit: 500 },
      parentSignals: { complete: false, observedCount: 2_000, limit: 2_000 },
    });
    expect(result.tasks[0]?.signalIntegrity).toMatchObject({ observationComplete: false, posture: "degraded" });
    expect(result.unknowns).toEqual(
      expect.arrayContaining([expect.stringContaining("Watcher coverage"), expect.stringContaining("signal coverage")]),
    );
  });

  it("normalizes the same persisted inputs deterministically across projection restarts", async () => {
    const events = [signal(1, 1, "child-event-1")];
    const storage = createStorage({ durableRunEvents: { listByRun: vi.fn(() => events) } });
    expect(await project(storage)).toEqual(await project(storage));
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
