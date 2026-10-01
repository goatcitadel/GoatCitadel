import { describe, expect, it, vi } from "vitest";
import { NotFoundError } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { InboxProjectionService, type InboxProjectionDependencies } from "./inbox-projection-service.js";

function dependencies(): InboxProjectionDependencies {
  return {
    storage: {
      approvals: { listPage: vi.fn(async () => ({ items: [] })) },
      changePlans: { list: vi.fn(async () => []) },
      documentPatchProposals: { list: vi.fn(async () => []) },
      capabilityProposals: { list: vi.fn(async () => []) },
      chatTurnTraces: { listActive: vi.fn(async () => []) },
      chatSessionMeta: { get: vi.fn(async () => undefined), listBySessionIds: vi.fn(async () => new Map()) },
      taskDeliverables: { listRecentByWorkspace: vi.fn(async () => []) },
      durableChildWatchers: { listRecentCompletedDelegations: vi.fn(async () => []) },
      durableRuns: { getRunsByIds: vi.fn(async () => new Map()) },
      chatDelegationRuns: { get: vi.fn() },
      chatDelegationSteps: { get: vi.fn() },
    },
    memory: { listTraceMemoryCandidates: vi.fn(async () => []) },
    memoryProposalsEnabled: vi.fn(async () => true),
    improvement: { listCuratorReviewItems: vi.fn(async () => ({ generatedAt: "now", items: [] })) },
    durable: {
      listRunHistory: vi.fn(async () => ({ items: [] })),
      listDeadLetters: vi.fn(async () => []),
      getRun: vi.fn(),
    },
    runtimeHealth: {
      getDatabaseHealthSnapshot: vi.fn(async () => ({ configured: true, reachable: true, issues: [] })),
      getDaemonStatus: vi.fn(async () => ({ running: true, diagnostics: [] })),
      inspectLatestBackupTrust: vi.fn(async () => ({
        observedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        verified: true,
        contractVerified: true,
      })),
    },
  } as unknown as InboxProjectionDependencies;
}

describe("Gateway inbox projection", () => {
  it("treats disabled memory proposals as an explicit source setting", async () => {
    const deps = dependencies();
    vi.mocked(deps.memoryProposalsEnabled).mockResolvedValue(false);
    const projection = await new InboxProjectionService(deps).getProjection("workspace-a");
    expect(projection.coverage.find((entry) => entry.source === "memory_proposals")).toMatchObject({
      state: "not_enabled",
      detail: "Memory proposals are turned off in Settings.",
    });
    expect(deps.memory.listTraceMemoryCandidates).not.toHaveBeenCalled();
    expect(projection.counts.proposals).toEqual({ known: 0, complete: true });
    expect(projection.items).toEqual([]);
  });

  it("derives installation attention from owner health while omitting private diagnostics", async () => {
    const deps = dependencies();
    vi.mocked(deps.runtimeHealth.getDatabaseHealthSnapshot).mockResolvedValue({
      reachable: false,
      issues: ["private database path"],
    } as never);
    vi.mocked(deps.runtimeHealth.getDaemonStatus).mockResolvedValue({
      running: true,
      diagnostics: [{ severity: "critical", detail: "private command" }],
    } as never);
    vi.mocked(deps.runtimeHealth.inspectLatestBackupTrust).mockResolvedValue({
      observedAt: new Date().toISOString(),
      verified: false,
      contractVerified: false,
      issueCodes: ["private-backup-path"],
    } as never);

    const service = new InboxProjectionService(deps);
    const first = await service.getProjection("workspace-a");
    expect(
      first.items
        .filter((item) => item.group === "needs_attention")
        .map((item) => item.id)
        .sort(),
    ).toEqual(["backup_trust:latest", "runtime_health:daemon", "runtime_health:database"].sort());
    expect(first.coverage.find((entry) => entry.source === "backup_trust")?.state).toBe("current");
    expect(first.items.every((item) => item.source.workspaceId === "workspace-a")).toBe(true);
    expect(JSON.stringify(first)).not.toMatch(/private database path|private command|private-backup-path/);

    const second = await service.getProjection("workspace-b");
    expect(deps.runtimeHealth.inspectLatestBackupTrust).toHaveBeenCalledOnce();
    expect(second.coverage.find((entry) => entry.source === "backup_trust")?.state).toBe("limited");
    expect(second.items.every((item) => item.source.workspaceId === "workspace-b")).toBe(true);
  });

  it("keeps independent health sources visible when backup verification fails", async () => {
    const deps = dependencies();
    vi.mocked(deps.runtimeHealth.inspectLatestBackupTrust).mockRejectedValue(new Error("private backup path"));
    const onSourceError = vi.fn();
    const projection = await new InboxProjectionService(deps).getProjection("workspace-a", onSourceError);
    expect(projection.items.map((item) => item.id)).not.toContain("spend_coverage:seven_days");
    expect(projection.coverage.find((entry) => entry.source === "backup_trust")?.state).toBe("unavailable");
    expect(projection.counts.needs_attention.complete).toBe(false);
    expect(JSON.stringify(projection)).not.toContain("private backup path");
    expect(onSourceError).toHaveBeenCalledWith("backup_trust", expect.any(Error));
  });

  it("keeps canonical ownership, risk, and workspace scope while omitting approval payloads", async () => {
    const deps = dependencies();
    vi.mocked(deps.storage.approvals.listPage).mockResolvedValue({
      items: [
        {
          approvalId: "approval-a",
          kind: "tool.invoke",
          status: "pending",
          riskLevel: "nuclear",
          payload: { secret: "do-not-project" },
          preview: { command: "do-not-project" },
          linkage: { workspaceId: "workspace-a", sessionId: "session-a", toolName: "shell" },
          createdAt: "2026-09-28T12:00:00.000Z",
        },
      ],
    } as never);
    vi.mocked(deps.storage.chatTurnTraces.listActive).mockResolvedValue([
      {
        turnId: "turn-a",
        sessionId: "session-a",
        startedAt: "2026-09-28T12:01:00.000Z",
        pendingUserInput: { promptId: "prompt-a", title: "Choose a file", question: "Which file?" },
      },
      {
        turnId: "turn-b",
        sessionId: "session-b",
        startedAt: "2026-09-28T12:02:00.000Z",
        pendingUserInput: { promptId: "prompt-b", title: "Private", question: "Foreign workspace" },
      },
    ] as never);
    vi.mocked(deps.storage.chatSessionMeta.get).mockImplementation(
      async (sessionId) => ({ workspaceId: sessionId === "session-a" ? "workspace-a" : "workspace-b" }) as never,
    );
    vi.mocked(deps.durable.listRunHistory).mockResolvedValue({
      items: [
        {
          runId: "run-a",
          status: "failed",
          payload: { workspaceId: "workspace-a" },
          metadata: {},
          createdAt: "2026-09-28T12:00:00.000Z",
          updatedAt: "2026-09-28T12:00:00.000Z",
        },
        {
          runId: "run-b",
          status: "failed",
          payload: { workspaceId: "workspace-b" },
          metadata: {},
          createdAt: "2026-09-28T12:00:00.000Z",
          updatedAt: "2026-09-28T12:00:00.000Z",
        },
        {
          runId: "run-mismatch",
          status: "failed",
          payload: { workspaceId: "workspace-a" },
          metadata: { workspaceId: "workspace-b" },
          createdAt: "2026-09-28T12:00:00.000Z",
          updatedAt: "2026-09-28T12:00:00.000Z",
        },
      ],
    } as never);

    const projection = await new InboxProjectionService(deps).getProjection("workspace-a");
    expect(projection.authority).toBe("derived_projection");
    expect(projection.items.map((item) => item.id)).toEqual([
      "user_input:prompt-a",
      "approval:approval-a",
      "failed_run:run-a",
    ]);
    expect(projection.items[0]?.source).toMatchObject({
      workspaceId: "workspace-a",
      sessionId: "session-a",
      turnId: "turn-a",
      promptId: "prompt-a",
    });
    expect(projection.items[1]).toMatchObject({
      riskLevel: "nuclear",
      source: { approvalId: "approval-a", sessionId: "session-a" },
    });
    expect(JSON.stringify(projection)).not.toContain("do-not-project");
    expect(JSON.stringify(projection)).not.toContain("Foreign workspace");
    expect(projection.counts.needs_decision).toEqual({ known: 2, complete: true });
    expect(projection.counts.needs_attention).toEqual({ known: 1, complete: false });
    expect(projection.coverage.find((entry) => entry.source === "durable_runs")?.state).toBe("partial");
    expect(deps.storage.approvals.listPage).toHaveBeenCalledWith({
      status: "pending",
      limit: 200,
      workspaceId: "workspace-a",
    });
  });

  it("finds workspace failures even when more than a full global sample belongs to another workspace", async () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
    try {
      const deps = dependencies();
      vi.mocked(deps.durable.listRunHistory).mockImplementation(async (query) =>
        storage.durableRuns.listRunHistory(query),
      );
      storage.durableRuns.createRun({
        runId: "older-failure",
        workflowKey: "chat.turn.execute",
        status: "failed",
        payload: { workspaceId: "workspace-a" },
        now: "2026-09-28T12:00:00.000Z",
      });
      storage.durableRuns.createRun({
        runId: "completed-local",
        workflowKey: "chat.turn.execute",
        status: "completed",
        payload: { workspaceId: "workspace-a" },
        now: "2026-09-28T12:01:00.000Z",
      });
      for (let index = 0; index < 205; index += 1) {
        storage.durableRuns.createRun({
          runId: `foreign-${index}`,
          workflowKey: "chat.turn.execute",
          status: "failed",
          payload: { workspaceId: "workspace-b" },
          now: "2026-09-30T12:00:00.000Z",
        });
      }

      const projection = await new InboxProjectionService(deps).getProjection("workspace-a");
      expect(deps.durable.listRunHistory).toHaveBeenCalledWith({ workspaceId: "workspace-a", limit: 200 });
      expect(projection.items.map((item) => item.id)).toEqual(["failed_run:older-failure"]);
      expect(projection.coverage.find((entry) => entry.source === "durable_runs")?.state).toBe("current");
      expect(JSON.stringify(projection)).not.toContain("foreign-");
      expect(JSON.stringify(projection)).not.toContain("completed-local");
    } finally {
      storage.close();
    }
  });

  it("marks run coverage partial when the scoped page has a cursor even if it has no failures", async () => {
    const deps = dependencies();
    vi.mocked(deps.durable.listRunHistory).mockResolvedValue({
      items: [
        {
          runId: "completed-run",
          status: "completed",
          payload: { workspaceId: "workspace-a" },
          createdAt: "2026-09-30T12:00:00.000Z",
          updatedAt: "2026-09-30T12:00:00.000Z",
        },
      ],
      nextCursor: "more-workspace-runs",
    } as never);
    const projection = await new InboxProjectionService(deps).getProjection("workspace-a");
    expect(projection.coverage.find((entry) => entry.source === "durable_runs")).toMatchObject({
      state: "partial",
      detail: "Only the most recent workspace runs were checked. Older failures may be omitted.",
    });
    expect(projection.counts.needs_attention).toEqual({ known: 0, complete: false });
    expect(projection.items).toEqual([]);
  });

  it("marks approval coverage partial when the scoped owner has another page", async () => {
    const deps = dependencies();
    vi.mocked(deps.storage.approvals.listPage).mockResolvedValue({
      items: [
        {
          approvalId: "approval-a",
          kind: "tool.invoke",
          status: "pending",
          riskLevel: "danger",
          linkage: { workspaceId: "workspace-a" },
          createdAt: "2026-09-28T12:00:00.000Z",
        },
      ],
      nextCursor: "more-scoped-approvals",
    } as never);
    const projection = await new InboxProjectionService(deps).getProjection("workspace-a");
    expect(projection.items.map((item) => item.id)).toContain("approval:approval-a");
    expect(projection.coverage.find((entry) => entry.source === "approvals")?.state).toBe("partial");
    expect(projection.counts.needs_decision.complete).toBe(false);
  });

  it("marks a failed owner unavailable while retaining independently verified items", async () => {
    const deps = dependencies();
    vi.mocked(deps.memory.listTraceMemoryCandidates).mockRejectedValue(new Error("database/private-path"));
    vi.mocked(deps.storage.documentPatchProposals.list).mockResolvedValue([
      {
        proposalId: "document-a",
        workspaceId: "workspace-a",
        targetKind: "personal_note",
        sessionId: "session-a",
        state: "pending",
        createdAt: "2026-09-28T12:00:00.000Z",
        updatedAt: "2026-09-28T12:01:00.000Z",
      },
    ] as never);
    const onSourceError = vi.fn();
    const projection = await new InboxProjectionService(deps).getProjection("workspace-a", onSourceError);
    expect(projection.items.map((item) => item.id)).toContain("document_proposal:document-a");
    expect(projection.coverage.find((entry) => entry.source === "memory_proposals")?.state).toBe("unavailable");
    expect(projection.counts.proposals).toEqual({ known: 1, complete: false });
    expect(JSON.stringify(projection)).not.toContain("database/private-path");
    expect(onSourceError).toHaveBeenCalledWith("memory_proposals", expect.any(Error));
  });

  it("projects only scoped waiting change plans with canonical origin and risk", async () => {
    const deps = dependencies();
    const waiting = {
      planId: "plan-a",
      status: "awaiting_confirmation",
      revision: 2,
      title: "Change model",
      summary: "Use a reviewed model",
      origin: { workspaceId: "workspace-a", sessionId: "session-a", turnId: "turn-a" },
      sessionId: "wrong-compatibility-session",
      risk: "caution",
      createdAt: "2026-09-28T12:00:00.000Z",
      updatedAt: "2026-09-28T12:01:00.000Z",
    };
    vi.mocked(deps.storage.changePlans.list).mockImplementation(async ({ status }) =>
      status === "awaiting_confirmation"
        ? ([
            waiting,
            { ...waiting, planId: "plan-foreign", origin: { workspaceId: "workspace-b" }, title: "Foreign plan" },
            { ...waiting, planId: "plan-resolved", status: "completed", title: "Resolved plan" },
          ] as never)
        : [],
    );

    const projection = await new InboxProjectionService(deps).getProjection("workspace-a");
    expect(projection.items.map((item) => item.id)).toEqual(["change_plan:plan-a"]);
    expect(projection.items[0]).toMatchObject({
      group: "needs_decision",
      riskLevel: "caution",
      source: {
        workspaceId: "workspace-a",
        planId: "plan-a",
        planRevision: 2,
        planStatus: "awaiting_confirmation",
        sessionId: "session-a",
        turnId: "turn-a",
      },
      href: "/chat?sessionId=session-a&shell=classic",
    });
    expect(projection.coverage.find((entry) => entry.source === "change_plans")?.state).toBe("partial");
    expect(JSON.stringify(projection)).not.toContain("Foreign plan");
    expect(JSON.stringify(projection)).not.toContain("Resolved plan");
    expect(JSON.stringify(projection)).not.toContain("wrong-compatibility-session");
  });

  it("projects only pending document proposals in the selected workspace without their diff", async () => {
    const deps = dependencies();
    const pending = {
      proposalId: "document-a",
      workspaceId: "workspace-a",
      targetKind: "personal_note",
      state: "pending",
      proposedContent: "private proposed text",
      derivedDiff: "private replacement diff",
      createdAt: "2026-09-28T12:00:00.000Z",
      updatedAt: "2026-09-28T12:01:00.000Z",
    };
    vi.mocked(deps.storage.documentPatchProposals.list).mockResolvedValue([
      pending,
      { ...pending, proposalId: "document-foreign", workspaceId: "workspace-b" },
      { ...pending, proposalId: "document-resolved", state: "applied" },
    ] as never);

    const projection = await new InboxProjectionService(deps).getProjection("workspace-a");
    expect(projection.items.map((item) => item.id)).toEqual(["document_proposal:document-a"]);
    expect(projection.items[0]).toMatchObject({
      source: { workspaceId: "workspace-a", proposalId: "document-a" },
      href: "/library/notes?shell=classic",
    });
    expect(projection.coverage.find((entry) => entry.source === "document_proposals")?.state).toBe("partial");
    expect(JSON.stringify(projection)).not.toContain("private proposed text");
    expect(JSON.stringify(projection)).not.toContain("private replacement diff");
    expect(JSON.stringify(projection)).not.toContain("document-foreign");
    expect(JSON.stringify(projection)).not.toContain("document-resolved");
  });

  it("carries the exact memory candidate ID and excludes mis-scoped owner records", async () => {
    const deps = dependencies();
    vi.mocked(deps.memory.listTraceMemoryCandidates).mockResolvedValue([
      {
        candidateId: "candidate-a",
        workspaceId: "workspace-a",
        status: "proposed",
        proposedInsight: "Keep this fact",
        sourceText: "do-not-project",
        sourceSessionId: "unverified-session",
        createdAt: "2026-09-28T12:00:00.000Z",
        updatedAt: "2026-09-28T12:01:00.000Z",
      },
      {
        candidateId: "candidate-b",
        workspaceId: "workspace-b",
        status: "proposed",
        proposedInsight: "Foreign fact",
        createdAt: "2026-09-28T12:00:00.000Z",
      },
      {
        candidateId: "candidate-c",
        workspaceId: "workspace-a",
        status: "promoted",
        proposedInsight: "Resolved fact",
        createdAt: "2026-09-28T12:00:00.000Z",
      },
    ] as never);

    const projection = await new InboxProjectionService(deps).getProjection("workspace-a");
    expect(projection.items.map((entry) => entry.id)).toEqual(["memory_proposal:candidate-a"]);
    expect(projection.items[0]?.source).toEqual({ workspaceId: "workspace-a", proposalId: "candidate-a" });
    expect(projection.coverage.find((entry) => entry.source === "memory_proposals")?.state).toBe("partial");
    expect(JSON.stringify(projection)).not.toContain("Foreign fact");
    expect(JSON.stringify(projection)).not.toContain("Resolved fact");
    expect(JSON.stringify(projection)).not.toContain("do-not-project");
  });

  it("projects only unresolved dead letters with a readable workspace run and an exact owner ID", async () => {
    const deps = dependencies();
    vi.mocked(deps.durable.listDeadLetters).mockResolvedValue([
      {
        deadLetterId: "dead-a",
        runId: "run-a",
        reason: "Needs recovery",
        payload: { secret: "do-not-project" },
        createdAt: "2026-09-28T12:00:00.000Z",
      },
      {
        deadLetterId: "dead-b",
        runId: "run-b",
        reason: "Foreign workspace",
        payload: {},
        createdAt: "2026-09-28T12:01:00.000Z",
      },
      {
        deadLetterId: "dead-c",
        runId: "run-a",
        reason: "Resolved",
        payload: {},
        createdAt: "2026-09-28T12:02:00.000Z",
        resolvedAt: "2026-09-28T12:03:00.000Z",
      },
    ] as never);
    vi.mocked(deps.durable.getRun).mockImplementation(
      async (runId) =>
        ({
          runId,
          payload: { workspaceId: runId === "run-a" ? "workspace-a" : "workspace-b" },
          metadata: {},
        }) as never,
    );

    const projection = await new InboxProjectionService(deps).getProjection("workspace-a");
    expect(projection.items.map((item) => item.id)).toEqual(["dead_letter:dead-a"]);
    expect(projection.items[0]).toMatchObject({
      kind: "dead_letter",
      source: { workspaceId: "workspace-a", runId: "run-a", deadLetterId: "dead-a" },
    });
    expect(JSON.stringify(projection)).not.toContain("do-not-project");
    expect(JSON.stringify(projection)).not.toContain("Foreign workspace");
  });

  it("shows recent scoped task deliverables without exposing paths or treating updates as complete", async () => {
    const deps = dependencies();
    const recent = new Date(Date.now() - 60_000).toISOString();
    const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    vi.mocked(deps.storage.taskDeliverables.listRecentByWorkspace).mockResolvedValue([
      {
        deliverableId: "delivery-a",
        taskId: "task-a",
        workspaceId: "workspace-a",
        taskTitle: "Write report",
        deliverableType: "file",
        title: "Report",
        path: "do-not-project",
        description: "do-not-project",
        createdAt: recent,
      },
      {
        deliverableId: "delivery-old",
        taskId: "task-a",
        workspaceId: "workspace-a",
        taskTitle: "Write report",
        deliverableType: "file",
        title: "Old report",
        createdAt: old,
      },
      {
        deliverableId: "delivery-wrong",
        taskId: "task-b",
        workspaceId: "workspace-b",
        taskTitle: "Foreign task",
        deliverableType: "file",
        title: "Wrong task",
        createdAt: recent,
      },
    ] as never);

    const projection = await new InboxProjectionService(deps).getProjection("workspace-a");
    expect(deps.storage.taskDeliverables.listRecentByWorkspace).toHaveBeenCalledWith(
      "workspace-a",
      expect.any(String),
      51,
    );
    expect(projection.items.map((item) => item.id)).toEqual(["task_deliverable:delivery-a"]);
    expect(projection.items[0]).toMatchObject({
      kind: "task_deliverable",
      group: "updates",
      source: { workspaceId: "workspace-a", taskId: "task-a", deliverableId: "delivery-a" },
      href: "/ops/kanban?shell=classic&taskId=task-a",
    });
    expect(projection.coverage.find((entry) => entry.source === "background_updates")?.state).toBe("partial");
    expect(projection.counts.updates).toEqual({ known: 1, complete: false });
    expect(JSON.stringify(projection)).not.toContain("do-not-project");
    expect(JSON.stringify(projection)).not.toContain("Foreign task");
    expect(JSON.stringify(projection)).not.toContain("Old report");
  });

  it("shows only completed Chat delegations with matching run, watcher, and session scope", async () => {
    const deps = dependencies();
    const recent = new Date(Date.now() - 60_000).toISOString();
    const watcher = (id: string, parentRunId: string, childRunId: string, childSessionId: string) => ({
      watcherId: id,
      parentRunId,
      childRunId,
      source: "chat_delegation",
      metadata: {
        delegationRunId: `delegation-${id}`,
        stepId: `step-${id}`,
        childSessionId,
        childTurnId: `turn-${id}`,
      },
    });
    vi.mocked(deps.storage.durableChildWatchers.listRecentCompletedDelegations).mockResolvedValue([
      { watcher: watcher("good", "parent-good", "child-good", "session-good"), finishedAt: recent },
      { watcher: watcher("foreign", "parent-foreign", "child-foreign", "session-foreign"), finishedAt: recent },
      { watcher: watcher("conflict", "parent-good", "child-conflict", "wrong-session"), finishedAt: recent },
      { watcher: watcher("wrong-scope", "parent-good", "child-wrong-scope", "session-foreign"), finishedAt: recent },
      {
        watcher: watcher("run-mismatch", "parent-good", "child-run-mismatch", "session-run-mismatch"),
        finishedAt: recent,
      },
      { watcher: watcher("orphan", "parent-good", "child-orphan", "session-orphan"), finishedAt: recent },
      { watcher: watcher("wrong-step", "parent-good", "child-wrong-step", "session-wrong-step"), finishedAt: recent },
    ] as never);
    const runs: Record<string, unknown> = {
      "parent-good": {
        runId: "parent-good",
        workflowKey: "chat.turn.execute",
        payload: { workspaceId: "workspace-a", sessionId: "parent-session" },
        metadata: {},
      },
      "child-good": {
        runId: "child-good",
        workflowKey: "chat.turn.execute",
        status: "completed",
        payload: {
          workspaceId: "workspace-a",
          sessionId: "session-good",
          turnId: "turn-good",
          secret: "do-not-project",
        },
        metadata: {},
        finishedAt: recent,
      },
      "parent-foreign": {
        runId: "parent-foreign",
        workflowKey: "chat.turn.execute",
        payload: { workspaceId: "workspace-b", sessionId: "foreign-parent-session" },
        metadata: {},
      },
      "child-foreign": {
        runId: "child-foreign",
        workflowKey: "chat.turn.execute",
        status: "completed",
        payload: { workspaceId: "workspace-b", sessionId: "session-foreign", turnId: "turn-foreign" },
        metadata: {},
        finishedAt: recent,
      },
      "child-conflict": {
        runId: "child-conflict",
        workflowKey: "chat.turn.execute",
        status: "completed",
        payload: { workspaceId: "workspace-a", sessionId: "session-conflict", turnId: "turn-conflict" },
        metadata: {},
        finishedAt: recent,
      },
      "child-wrong-scope": {
        runId: "child-wrong-scope",
        workflowKey: "chat.turn.execute",
        status: "completed",
        payload: { workspaceId: "workspace-a", sessionId: "session-foreign", turnId: "turn-wrong-scope" },
        metadata: {},
        finishedAt: recent,
      },
      "child-run-mismatch": {
        runId: "child-run-mismatch",
        workflowKey: "chat.turn.execute",
        status: "completed",
        payload: { workspaceId: "workspace-a", sessionId: "session-run-mismatch", turnId: "turn-run-mismatch" },
        metadata: { workspaceId: "workspace-b" },
        finishedAt: recent,
      },
      "child-orphan": {
        runId: "child-orphan",
        workflowKey: "chat.turn.execute",
        status: "completed",
        payload: { workspaceId: "workspace-a", sessionId: "session-orphan", turnId: "turn-orphan" },
        metadata: {},
        finishedAt: recent,
      },
      "child-wrong-step": {
        runId: "child-wrong-step",
        workflowKey: "chat.turn.execute",
        status: "completed",
        payload: { workspaceId: "workspace-a", sessionId: "session-wrong-step", turnId: "turn-wrong-step" },
        metadata: {},
        finishedAt: recent,
      },
    };
    vi.mocked(deps.storage.durableRuns.getRunsByIds).mockResolvedValue(new Map(Object.entries(runs)) as never);
    vi.mocked(deps.storage.chatSessionMeta.listBySessionIds).mockImplementation(
      async (sessionIds, workspaceId) =>
        new Map(
          sessionIds
            .filter((sessionId) => {
              const owner =
                sessionId.startsWith("foreign") || sessionId === "session-foreign" ? "workspace-b" : "workspace-a";
              return owner === workspaceId;
            })
            .map((sessionId) => [sessionId, { workspaceId }]),
        ) as never,
    );
    vi.mocked(deps.storage.chatDelegationRuns.get).mockImplementation(async (runId) => {
      if (runId === "delegation-good" || runId === "delegation-wrong-step") {
        return { runId, parentRunId: "parent-good", sessionId: "parent-session" } as never;
      }
      throw new NotFoundError({ entity: "Delegation run", id: runId });
    });
    vi.mocked(deps.storage.chatDelegationSteps.get).mockImplementation(async (stepId) => {
      if (stepId === "step-good" || stepId === "step-wrong-step") {
        return {
          stepId,
          runId: stepId.replace("step-", "delegation-"),
          durableRunId: stepId === "step-good" ? "child-good" : "different-child",
          childSessionId: stepId === "step-good" ? "session-good" : "session-wrong-step",
          childTurnId: stepId === "step-good" ? "turn-good" : "turn-wrong-step",
        } as never;
      }
      throw new NotFoundError({ entity: "Delegation step", id: stepId });
    });

    const projection = await new InboxProjectionService(deps).getProjection("workspace-a");
    expect(deps.storage.durableChildWatchers.listRecentCompletedDelegations).toHaveBeenCalledWith(
      "workspace-a",
      expect.any(String),
      51,
    );
    expect(deps.storage.durableRuns.getRunsByIds).toHaveBeenCalledOnce();
    expect(deps.storage.chatSessionMeta.listBySessionIds).toHaveBeenCalledWith(expect.any(Array), "workspace-a");
    expect(deps.storage.chatDelegationRuns.get).toHaveBeenCalledWith("delegation-good");
    expect(deps.storage.chatDelegationRuns.get).toHaveBeenCalledWith("delegation-orphan");
    expect(projection.items.map((item) => item.id)).toEqual(["completed_background_run:good"]);
    expect(projection.items[0]).toMatchObject({
      kind: "completed_background_run",
      group: "updates",
      createdAt: recent,
      source: { workspaceId: "workspace-a", runId: "child-good" },
      href: "/ops/runtime?runId=child-good&shell=classic",
    });
    expect(projection.coverage.find((entry) => entry.source === "completed_background_runs")?.state).toBe("partial");
    expect(projection.counts.updates).toEqual({ known: 1, complete: false });
    expect(JSON.stringify(projection)).not.toContain("do-not-project");
    expect(JSON.stringify(projection)).not.toContain("session-foreign");
    expect(JSON.stringify(projection)).not.toContain("child-conflict");
    expect(JSON.stringify(projection)).not.toContain("child-orphan");
    expect(JSON.stringify(projection)).not.toContain("child-wrong-step");
  });

  it("requires persisted delegation lineage even when a watcher claims the Chat delegation source", async () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
    try {
      const recent = new Date(Date.now() - 60_000).toISOString();
      for (const sessionId of ["parent-session", "child-session", "orphan-session"]) {
        storage.chatSessionMeta.ensure(sessionId, recent, "workspace-a");
      }
      storage.durableRuns.createRun({
        runId: "parent-run",
        workflowKey: "chat.turn.execute",
        payload: { workspaceId: "workspace-a", sessionId: "parent-session", turnId: "parent-turn" },
        now: recent,
      });
      for (const [runId, sessionId, turnId] of [
        ["child-run", "child-session", "child-turn"],
        ["orphan-run", "orphan-session", "orphan-turn"],
      ]) {
        storage.durableRuns.createRun({
          runId,
          workflowKey: "chat.turn.execute",
          status: "completed",
          payload: { workspaceId: "workspace-a", sessionId, turnId },
          finishedAt: recent,
          now: recent,
        });
      }
      storage.chatDelegationRuns.create({
        runId: "delegation-run",
        parentRunId: "parent-run",
        sessionId: "parent-session",
        taskId: "task-a",
        objective: "Complete a task",
        roles: ["Coder"],
        mode: "sequential",
        status: "completed",
        startedAt: recent,
        finishedAt: recent,
      });
      storage.chatDelegationSteps.create({
        stepId: "step-a",
        runId: "delegation-run",
        role: "Coder",
        index: 0,
        status: "completed",
        durableRunId: "child-run",
        childSessionId: "child-session",
        childTurnId: "child-turn",
        startedAt: recent,
        finishedAt: recent,
      });
      storage.durableChildWatchers.create({
        watcherId: "watcher-a",
        parentRunId: "parent-run",
        childRunId: "child-run",
        source: "chat_delegation",
        metadata: {
          delegationRunId: "delegation-run",
          stepId: "step-a",
          childSessionId: "child-session",
          childTurnId: "child-turn",
        },
      });
      storage.durableChildWatchers.create({
        watcherId: "watcher-orphan",
        parentRunId: "parent-run",
        childRunId: "orphan-run",
        source: "chat_delegation",
        metadata: {
          delegationRunId: "missing-run",
          stepId: "missing-step",
          childSessionId: "orphan-session",
          childTurnId: "orphan-turn",
        },
      });
      const deps = { ...dependencies(), storage: createSqliteAsyncStorage(storage) };

      const projection = await new InboxProjectionService(deps).getProjection("workspace-a");
      expect(projection.items.map((item) => item.id)).toEqual(["completed_background_run:watcher-a"]);
      expect(projection.coverage.find((entry) => entry.source === "completed_background_runs")?.state).toBe("partial");
    } finally {
      storage.close();
    }
  });

  it("keeps task deliverables visible when the completed-run owner is unavailable", async () => {
    const deps = dependencies();
    const recent = new Date(Date.now() - 60_000).toISOString();
    vi.mocked(deps.storage.taskDeliverables.listRecentByWorkspace).mockResolvedValue([
      {
        deliverableId: "delivery-a",
        taskId: "task-a",
        workspaceId: "workspace-a",
        taskTitle: "Write report",
        deliverableType: "file",
        title: "Report",
        createdAt: recent,
      },
    ] as never);
    vi.mocked(deps.storage.durableChildWatchers.listRecentCompletedDelegations).mockRejectedValue(
      new Error("database/private-path"),
    );

    const projection = await new InboxProjectionService(deps).getProjection("workspace-a");
    expect(projection.items.map((item) => item.id)).toEqual(["task_deliverable:delivery-a"]);
    expect(projection.coverage.find((entry) => entry.source === "completed_background_runs")?.state).toBe(
      "unavailable",
    );
    expect(projection.counts.updates).toEqual({ known: 1, complete: false });
    expect(JSON.stringify(projection)).not.toContain("database/private-path");
  });

  it("marks Updates unavailable when its owner read fails without exposing the error", async () => {
    const deps = dependencies();
    vi.mocked(deps.storage.taskDeliverables.listRecentByWorkspace).mockRejectedValue(
      new Error("database/private-path"),
    );
    vi.mocked(deps.storage.documentPatchProposals.list).mockResolvedValue([
      {
        proposalId: "document-a",
        workspaceId: "workspace-a",
        targetKind: "personal_note",
        state: "pending",
        createdAt: "2026-09-28T12:00:00.000Z",
        updatedAt: "2026-09-28T12:01:00.000Z",
      },
    ] as never);
    const onSourceError = vi.fn();
    const projection = await new InboxProjectionService(deps).getProjection("workspace-a", onSourceError);
    expect(projection.items.map((item) => item.id)).toEqual(["document_proposal:document-a"]);
    expect(projection.coverage.find((entry) => entry.source === "background_updates")).toMatchObject({
      state: "unavailable",
    });
    expect(projection.counts.updates).toEqual({ known: 0, complete: false });
    expect(onSourceError).toHaveBeenCalledWith("background_updates", expect.any(Error));
    expect(JSON.stringify(projection)).not.toContain("database/private-path");
  });
});
