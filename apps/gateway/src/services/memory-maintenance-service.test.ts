import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError } from "@goatcitadel/contracts";
import type {
  ChatCompletionResponse,
  DurableRunCreateRequest,
  DurableRunRecord,
  MemoryItemRecord,
  MemoryMaintenanceChangeRecord,
  MemoryMaintenancePolicyPatchInput,
  MemoryMaintenancePolicyRecord,
  MemoryMaintenanceRecommendationRecord,
  MemoryMaintenanceRunRecord,
  MemoryMaintenanceRunSourceRecord,
  MemoryMaintenanceStateRecord,
  TranscriptEvent,
} from "@goatcitadel/contracts";
import { MemoryMaintenanceService } from "./memory-maintenance-service.js";
import type { ServiceContext } from "./service-context.js";

type EligibleSession = {
  sessionId: string;
  modifiedAt: string;
};

class FakeMemoryMaintenanceRepo {
  public readonly policies = new Map<string, MemoryMaintenancePolicyRecord>();
  public readonly states = new Map<string, MemoryMaintenanceStateRecord>();
  public readonly runs = new Map<string, MemoryMaintenanceRunRecord>();
  public readonly runSources = new Map<string, MemoryMaintenanceRunSourceRecord[]>();
  public readonly runChanges = new Map<string, MemoryMaintenanceChangeRecord[]>();
  public readonly recommendations = new Map<string, MemoryMaintenanceRecommendationRecord>();
  public readonly changedSessionCounts: Map<string, number>;
  public readonly eligibleSessions: Map<string, EligibleSession[]>;
  public readonly activeMemoryItems: MemoryItemRecord[] = [];
  public readonly recentToolArtifacts: Array<{
    artifactId: string;
    sessionId: string;
    toolName: string;
    byteLength: number;
    contentType?: string;
    snippet?: string;
    createdAt: string;
  }> = [];

  public constructor(changedSessionCounts: Map<string, number>, eligibleSessions: Map<string, EligibleSession[]>) {
    this.changedSessionCounts = changedSessionCounts;
    this.eligibleSessions = eligibleSessions;
  }

  public findPolicy(workspaceId: string): MemoryMaintenancePolicyRecord | undefined {
    return this.policies.get(workspaceId);
  }

  public upsertPolicy(record: MemoryMaintenancePolicyRecord): MemoryMaintenancePolicyRecord {
    this.policies.set(record.workspaceId, { ...record });
    return this.requirePolicy(record.workspaceId);
  }

  public patchPolicy(
    workspaceId: string,
    patch: MemoryMaintenancePolicyPatchInput,
    defaults: MemoryMaintenancePolicyRecord,
    now = new Date().toISOString(),
  ): MemoryMaintenancePolicyRecord {
    const current = this.findPolicy(workspaceId) ?? defaults;
    return this.upsertPolicy({
      ...current,
      enabled: patch.enabled ?? current.enabled,
      runMode: patch.runMode ?? current.runMode,
      timingStrategy: patch.timingStrategy ?? current.timingStrategy,
      schedule: patch.schedule === undefined ? current.schedule : (patch.schedule ?? undefined),
      timeZone: patch.timeZone ?? current.timeZone,
      minHoursSinceLastSuccess: patch.minHoursSinceLastSuccess ?? current.minHoursSinceLastSuccess,
      minChangedSessions: patch.minChangedSessions ?? current.minChangedSessions,
      providerId: patch.providerId === undefined ? current.providerId : (patch.providerId ?? undefined),
      model: patch.model === undefined ? current.model : (patch.model ?? undefined),
      executionTarget: patch.executionTarget ?? current.executionTarget,
      unavailableModelPolicy: patch.unavailableModelPolicy ?? current.unavailableModelPolicy,
      createdAt: current.createdAt,
      updatedAt: now,
    });
  }

  public requirePolicy(workspaceId: string): MemoryMaintenancePolicyRecord {
    const record = this.findPolicy(workspaceId);
    if (!record) {
      throw new NotFoundError({ entity: "Memory maintenance policy", id: workspaceId });
    }
    return record;
  }

  public findState(workspaceId: string): MemoryMaintenanceStateRecord | undefined {
    return this.states.get(workspaceId);
  }

  public upsertState(record: MemoryMaintenanceStateRecord): MemoryMaintenanceStateRecord {
    this.states.set(record.workspaceId, { ...record });
    return this.requireState(record.workspaceId);
  }

  public lockStateForUpdate(fallback: MemoryMaintenanceStateRecord): MemoryMaintenanceStateRecord {
    return this.findState(fallback.workspaceId) ?? this.upsertState(fallback);
  }

  public requireState(workspaceId: string): MemoryMaintenanceStateRecord {
    const record = this.findState(workspaceId);
    if (!record) {
      throw new NotFoundError({ entity: "Memory maintenance state", id: workspaceId });
    }
    return record;
  }

  public createRun(record: MemoryMaintenanceRunRecord): MemoryMaintenanceRunRecord {
    this.runs.set(record.runId, { ...record });
    return this.getRun(record.runId);
  }

  public getRun(runId: string): MemoryMaintenanceRunRecord {
    const record = this.runs.get(runId);
    if (!record) {
      throw new NotFoundError({ entity: "Memory maintenance run", id: runId });
    }
    return record;
  }

  public updateRun(record: MemoryMaintenanceRunRecord): MemoryMaintenanceRunRecord {
    this.runs.set(record.runId, { ...record });
    return this.getRun(record.runId);
  }

  public replaceRunSources(
    runId: string,
    records: MemoryMaintenanceRunSourceRecord[],
  ): MemoryMaintenanceRunSourceRecord[] {
    this.runSources.set(
      runId,
      records.map((record) => ({ ...record })),
    );
    return this.listRunSources(runId);
  }

  public listRunSources(runId: string): MemoryMaintenanceRunSourceRecord[] {
    return [...(this.runSources.get(runId) ?? [])].map((record) => ({ ...record }));
  }

  public replaceRunChanges(runId: string, records: MemoryMaintenanceChangeRecord[]): MemoryMaintenanceChangeRecord[] {
    this.runChanges.set(
      runId,
      records.map((record) => ({ ...record })),
    );
    return this.listRunChanges(runId);
  }

  public listRunChanges(runId: string): MemoryMaintenanceChangeRecord[] {
    return [...(this.runChanges.get(runId) ?? [])].map((record) => ({ ...record }));
  }

  public listRuns(workspaceId: string, limit = 100): MemoryMaintenanceRunRecord[] {
    return [...this.runs.values()]
      .filter((record) => record.workspaceId === workspaceId)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, limit);
  }

  public createRecommendation(
    record: Omit<MemoryMaintenanceRecommendationRecord, "recommendationId"> & { recommendationId?: string },
  ): MemoryMaintenanceRecommendationRecord {
    const recommendationId = record.recommendationId ?? `mmrec_${this.recommendations.size + 1}`;
    const created = {
      ...record,
      recommendationId,
    };
    this.recommendations.set(recommendationId, created);
    return created;
  }

  public getRecommendation(recommendationId: string): MemoryMaintenanceRecommendationRecord {
    const record = this.recommendations.get(recommendationId);
    if (!record) {
      throw new NotFoundError({ entity: "Memory maintenance recommendation", id: recommendationId });
    }
    return record;
  }

  public updateRecommendation(record: MemoryMaintenanceRecommendationRecord): MemoryMaintenanceRecommendationRecord {
    this.recommendations.set(record.recommendationId, { ...record });
    return this.getRecommendation(record.recommendationId);
  }

  public listRecommendations(workspaceId: string, limit = 100): MemoryMaintenanceRecommendationRecord[] {
    return [...this.recommendations.values()]
      .filter((record) => record.workspaceId === workspaceId)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, limit);
  }

  public listEnabledPolicyWorkspaceIds(): string[] {
    return [...this.policies.values()]
      .filter((policy) => policy.enabled)
      .map((policy) => policy.workspaceId)
      .sort((left, right) => left.localeCompare(right));
  }

  public countChangedSessions(workspaceId: string, _since?: string): number {
    return this.changedSessionCounts.get(workspaceId) ?? 0;
  }

  public listEligibleSessions(workspaceId: string, _since?: string, limit = 100): EligibleSession[] {
    return (this.eligibleSessions.get(workspaceId) ?? []).slice(0, limit);
  }

  public listActiveMemoryItems(limit = 200): MemoryItemRecord[] {
    return this.activeMemoryItems.slice(0, limit);
  }

  public listRecentToolArtifacts(workspaceId?: string, since?: string, limit = 100): typeof this.recentToolArtifacts {
    const sinceMs = since ? Date.parse(since) : Number.NaN;
    return this.recentToolArtifacts
      .filter((artifact) => {
        if (workspaceId && !artifact.sessionId.startsWith(workspaceId === "default" ? "sess" : workspaceId)) {
          return false;
        }
        if (Number.isFinite(sinceMs) && Date.parse(artifact.createdAt) <= sinceMs) {
          return false;
        }
        return true;
      })
      .slice(0, limit);
  }
}

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

function createHarness() {
  const changedSessionCounts = new Map<string, number>();
  const eligibleSessions = new Map<string, EligibleSession[]>();
  const memoryMaintenance = new FakeMemoryMaintenanceRepo(changedSessionCounts, eligibleSessions);
  const durableRuns = new Map<string, DurableRunRecord>();
  const transcripts = new Map<string, TranscriptEvent[]>();
  const sessionMeta = new Map<string, { workspaceId?: string; includeInHistory?: boolean; origin?: string }>();
  const sessionBindings = new Map<string, { transport: string; writable: boolean }>();
  const subagentSessionIds = new Set<string>();
  const publishRealtime = vi.fn();
  const chatCompletions = vi.fn(
    async (): Promise<ChatCompletionResponse> => ({
      id: "completion-1",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "# Workspace Memory\n\n## Stable Context\nModel output.",
          },
        },
      ],
    }),
  );
  const listModels = vi.fn(async () => [{ id: "qwen3", name: "qwen3" }]);
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "goat-mm-"));
  tempDirs.add(rootDir);
  let durableRunCounter = 0;

  const gatewaySql = {
    prepare(sql: string) {
      if (sql.includes("AS changed_sessions")) {
        return {
          get: ({ workspaceId }: { workspaceId: string }) => ({
            count: changedSessionCounts.get(workspaceId) ?? 0,
          }),
        };
      }
      if (sql.includes("SELECT meta.session_id AS session_id")) {
        return {
          all: ({ workspaceId, limit }: { workspaceId: string; limit: number }) =>
            (eligibleSessions.get(workspaceId) ?? []).slice(0, limit).map((session) => ({
              session_id: session.sessionId,
              modified_at: session.modifiedAt,
            })),
        };
      }
      if (sql.includes("FROM task_subagent_sessions")) {
        return {
          get: (sessionId: string) => (subagentSessionIds.has(sessionId) ? { 1: 1 } : undefined),
        };
      }
      throw new Error(`Unsupported SQL in test harness: ${sql}`);
    },
  };

  const callbacks = {
    createDurableRun(input: DurableRunCreateRequest, _options?: { deferRealtime?: boolean }): DurableRunRecord {
      durableRunCounter += 1;
      const now = new Date().toISOString();
      const run = {
        runId: `durable-${durableRunCounter}`,
        workflowKey: input.workflowKey,
        status: "queued",
        attemptCount: 0,
        maxAttempts: 1,
        payload: input.payload ?? {},
        metadata: input.metadata,
        createdAt: now,
        updatedAt: now,
      } as unknown as DurableRunRecord;
      durableRuns.set(run.runId, run);
      return run;
    },
    getDurableRun(runId: string): DurableRunRecord {
      const run = durableRuns.get(runId);
      if (!run) {
        throw new Error(`Unknown durable run ${runId}`);
      }
      return run;
    },
  };

  const ctx = {
    storage: {
      memoryMaintenance,
      chatSessionMeta: {
        get: (sessionId: string) => sessionMeta.get(sessionId),
      },
      chatSessionBindings: {
        get: (sessionId: string) => sessionBindings.get(sessionId),
      },
      taskSubagents: {
        findByAgentSessionId: (sessionId: string) =>
          subagentSessionIds.has(sessionId)
            ? {
                subagentSessionId: `subagent-${sessionId}`,
                taskId: "task-1",
                agentSessionId: sessionId,
                agentName: "worker",
                status: "active",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              }
            : undefined,
      },
      transcripts: {
        read: async (sessionId: string) => {
          const events = transcripts.get(sessionId);
          if (!events) {
            const error = new Error(`Transcript ${sessionId} not found`) as NodeJS.ErrnoException;
            error.code = "ENOENT";
            throw error;
          }
          return events;
        },
      },
    },
    config: {
      rootDir,
      assistant: {
        workspaceDir: "workspace",
      },
    },
    llmService: {
      getRuntimeConfig: vi.fn(() => ({
        activeProviderId: "ollama",
        activeModel: "qwen3",
        providers: [
          {
            providerId: "ollama",
            label: "Ollama",
            baseUrl: "http://127.0.0.1:11434/v1",
            apiStyle: "openai-chat-completions",
            defaultModel: "qwen3",
            hasApiKey: false,
            apiKeySource: "none",
          },
        ],
      })),
      listModels,
      chatCompletions,
    },
    policyEngine: {},
    publishRealtime,
    requireFeatureEnabled: vi.fn(),
    isFeatureEnabled: vi.fn(() => true),
    gatewaySql,
    normalizeWorkspaceId: (workspaceId?: string) => workspaceId?.trim() || "default",
  } as unknown as ServiceContext;

  const service = new MemoryMaintenanceService(ctx, callbacks);

  return {
    service,
    memoryMaintenance,
    durableRuns,
    callbacks,
    publishRealtime,
    chatCompletions,
    listModels,
    transcripts,
    sessionMeta,
    sessionBindings,
    changedSessionCounts,
    eligibleSessions,
    subagentSessionIds,
    rootDir,
    workspaceRoot: path.join(rootDir, "workspace"),
  };
}

function messageEvent(content: string, type: "message.user" | "message.assistant" = "message.user"): TranscriptEvent {
  return {
    id: `evt-${content.slice(0, 8)}`,
    type,
    timestamp: "2026-04-02T09:30:00.000Z",
    payload: {
      message: {
        content,
      },
    },
  } as unknown as TranscriptEvent;
}

function makeMemoryItem(
  input: Partial<MemoryItemRecord> & Pick<MemoryItemRecord, "itemId" | "title" | "content">,
): MemoryItemRecord {
  return {
    namespace: "default.notes",
    metadata: { workspaceId: "default" },
    pinned: false,
    status: "active",
    lifecycleState: "active",
    createdAt: "2026-04-02T08:00:00.000Z",
    updatedAt: "2026-04-02T09:00:00.000Z",
    ...input,
  };
}

function completionWithContent(content: unknown): ChatCompletionResponse {
  return {
    id: "completion-override",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content,
        },
      },
    ],
  };
}

describe("MemoryMaintenanceService due evaluation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-02T10:05:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("queues a scheduled Dream run when the schedule is due and thresholds are met", async () => {
    const harness = createHarness();
    harness.changedSessionCounts.set("default", 3);

    harness.service.patchPolicy("default", {
      enabled: true,
      runMode: "scheduled",
      timingStrategy: "fixed",
      timeZone: "UTC",
      schedule: {
        frequency: "daily",
        hour: 10,
        minute: 0,
      },
      minHoursSinceLastSuccess: 1,
      minChangedSessions: 2,
      providerId: "ollama",
      model: "qwen3",
    });
    harness.memoryMaintenance.upsertState({
      ...harness.memoryMaintenance.requireState("default"),
      lastSuccessfulRunAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    });

    await harness.service.runDueEvaluation();

    const runs = harness.memoryMaintenance.listRuns("default");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      workspaceId: "default",
      triggerSource: "scheduled",
      status: "queued",
      providerId: "ollama",
      model: "qwen3",
    });
    expect(harness.memoryMaintenance.requireState("default").activeRunId).toBe(runs[0]?.runId);
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "system",
      "memory",
      expect.objectContaining({
        type: "memory_maintenance_run_created",
        workspaceId: "default",
        runId: runs[0]?.runId,
        triggerSource: "scheduled",
      }),
    );

    await harness.service.runDueEvaluation();
    expect(harness.memoryMaintenance.listRuns("default")).toHaveLength(1);
  });

  it("queues a hybrid_due Dream run without live publication inside a fenced post-turn transaction", () => {
    const harness = createHarness();
    harness.changedSessionCounts.set("default", 4);
    harness.sessionMeta.set("sess-root", {
      workspaceId: "default",
      includeInHistory: true,
      origin: "operator",
    });
    harness.sessionBindings.set("sess-root", {
      transport: "llm",
      writable: true,
    });

    harness.service.patchPolicy("default", {
      enabled: true,
      runMode: "hybrid",
      timingStrategy: "recommendation_first",
      timeZone: "UTC",
      schedule: {
        frequency: "daily",
        hour: 10,
        minute: 0,
      },
      minHoursSinceLastSuccess: 1,
      minChangedSessions: 2,
    });
    harness.memoryMaintenance.upsertState({
      ...harness.memoryMaintenance.requireState("default"),
      lastSuccessfulRunAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    });

    const createDurableRun = vi.spyOn(harness.callbacks, "createDurableRun");
    const result = harness.service.noteSuccessfulRootTurnSync("sess-root");

    const runs = harness.memoryMaintenance.listRuns("default");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.triggerSource).toBe("hybrid_due");
    expect(result).toMatchObject({
      status: "enqueued",
      memoryMaintenanceRunId: runs[0]?.runId,
      durableRunId: runs[0]?.durableRunId,
    });
    expect(createDurableRun).toHaveBeenCalledWith(expect.any(Object), { deferRealtime: true });
    expect(harness.publishRealtime).not.toHaveBeenCalled();
  });

  it("does not queue a scheduled-only Dream run from post-turn evaluation", async () => {
    const harness = createHarness();
    harness.changedSessionCounts.set("default", 4);
    harness.sessionMeta.set("sess-root", {
      workspaceId: "default",
      includeInHistory: true,
      origin: "operator",
    });
    harness.sessionBindings.set("sess-root", {
      transport: "llm",
      writable: true,
    });

    harness.service.patchPolicy("default", {
      enabled: true,
      runMode: "scheduled",
      timingStrategy: "fixed",
      timeZone: "UTC",
      schedule: {
        frequency: "daily",
        hour: 10,
        minute: 0,
      },
      minHoursSinceLastSuccess: 1,
      minChangedSessions: 2,
    });
    harness.memoryMaintenance.upsertState({
      ...harness.memoryMaintenance.requireState("default"),
      lastSuccessfulRunAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    });

    await harness.service.noteSuccessfulRootTurn("sess-root");

    expect(harness.memoryMaintenance.listRuns("default")).toHaveLength(0);
  });

  it("normalizes workspace read APIs while refreshing state and preserving queued records", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-02T10:10:00.000Z"));

    try {
      const harness = createHarness();
      harness.changedSessionCounts.set("workspace-a", 4);

      const policy = harness.service.getPolicy(" workspace-a ");
      expect(policy).toMatchObject({
        workspaceId: "workspace-a",
        enabled: false,
        runMode: "hybrid",
        executionTarget: "local",
      });

      const queuedRun = harness.service.runNow({
        workspaceId: "workspace-a",
        triggerSource: "manual",
      });
      const recommendation = harness.memoryMaintenance.createRecommendation({
        workspaceId: "workspace-a",
        kind: "threshold_adjustment",
        status: "queued",
        summary: "Lower threshold",
        proposedPatch: {
          minChangedSessions: 2,
        },
        createdAt: "2026-04-02T10:09:00.000Z",
        updatedAt: "2026-04-02T10:09:00.000Z",
      });

      expect(harness.service.listRuns("workspace-a", 5)).toEqual([queuedRun]);
      expect(harness.memoryMaintenance.requireState("workspace-a")).toMatchObject({
        workspaceId: "workspace-a",
        activeRunId: queuedRun.runId,
        changedSessionCount: 4,
      });
      expect(harness.service.listRecommendations(" workspace-a ", 5)).toEqual([recommendation]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("matches a weekly schedule in the policy time zone across a UTC date boundary", async () => {
    vi.setSystemTime(new Date("2026-04-03T06:01:00.000Z"));
    const harness = createHarness();
    harness.changedSessionCounts.set("default", 2);

    harness.service.patchPolicy("default", {
      enabled: true,
      runMode: "scheduled",
      timingStrategy: "fixed",
      timeZone: "America/Los_Angeles",
      schedule: {
        frequency: "weekly",
        weekday: 4,
        hour: 23,
        minute: 0,
      },
      minHoursSinceLastSuccess: 1,
      minChangedSessions: 2,
    });
    harness.memoryMaintenance.upsertState({
      ...harness.memoryMaintenance.requireState("default"),
      lastSuccessfulRunAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    });

    expect(harness.service.getStatus("default").nextDueAt).toBe("2026-04-03T06:00:00.000Z");

    await harness.service.runDueEvaluation();

    const runs = harness.memoryMaintenance.listRuns("default");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.triggerSource).toBe("scheduled");
  }, 30_000);
});

describe("MemoryMaintenanceService durable execution", () => {
  it("collects source evidence, renders the prompt, normalizes markdown, and records snapshot provenance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-02T10:20:00.000Z"));

    try {
      const harness = createHarness();
      const memoryDir = path.join(harness.workspaceRoot, "memory");
      const maintenanceDir = path.join(memoryDir, "maintenance");
      await fs.mkdir(maintenanceDir, { recursive: true });
      await fs.writeFile(
        path.join(memoryDir, "project.md"),
        "Repo path is F:/code/personal-ai. Keep operator-visible runtime truth in memory.",
        "utf8",
      );
      const previousSnapshotName = "20260401-010000-previous.md";
      const previousSnapshotAbs = path.join(maintenanceDir, previousSnapshotName);
      const latestAbs = path.join(maintenanceDir, "latest.md");
      await fs.writeFile(previousSnapshotAbs, "# Workspace Memory\n\nprevious snapshot", "utf8");
      await fs.writeFile(latestAbs, "# Workspace Memory\n\nprior latest", "utf8");
      await fs.utimes(previousSnapshotAbs, new Date("2026-04-01T01:00:00.000Z"), new Date("2026-04-01T01:00:00.000Z"));
      await fs.utimes(latestAbs, new Date("2026-04-01T02:00:00.000Z"), new Date("2026-04-01T02:00:00.000Z"));

      harness.eligibleSessions.set("default", [
        {
          sessionId: "sess-source",
          modifiedAt: "2026-04-02T09:40:00.000Z",
        },
      ]);
      harness.transcripts.set("sess-source", [
        messageEvent("Please keep model, tool, and source truth visible."),
        messageEvent("I will cite exact evidence refs.", "message.assistant"),
      ]);
      harness.memoryMaintenance.activeMemoryItems.push(
        makeMemoryItem({
          itemId: "mem-1",
          title: "Operator truth",
          content: "Surface model/provider/tool provenance in maintenance output.",
        }),
      );
      harness.memoryMaintenance.recentToolArtifacts.push({
        artifactId: "artifact-1",
        sessionId: "sess-source",
        toolName: "browser.search",
        byteLength: 64,
        contentType: "text/markdown",
        snippet: "Search result evidence retained for memory maintenance.",
        createdAt: "2026-04-02T09:45:00.000Z",
      });
      harness.chatCompletions.mockResolvedValueOnce(
        completionWithContent([
          {
            text: "## Stable Context\nDream keeps source refs.\n\n## Active Threads\n- Validate memory maintenance provenance.\n\n## Watchlist\n- Avoid stale claims.\n\n## References\n- transcript: sess-source",
          },
        ]),
      );

      harness.service.patchPolicy("default", {
        enabled: true,
        runMode: "manual",
        timingStrategy: "recommendation_first",
        timeZone: "UTC",
        minHoursSinceLastSuccess: 1,
        minChangedSessions: 1,
        providerId: "ollama",
        model: "qwen3",
      });

      const queuedRun = harness.service.runNow({
        workspaceId: "default",
        triggerSource: "manual",
      });
      const durableRun = harness.callbacks.getDurableRun(queuedRun.durableRunId!);

      const result = await harness.service.executeDurableRun(durableRun);

      expect(result).toMatchObject({
        memoryMaintenanceRunId: queuedRun.runId,
        workspaceId: "default",
        status: "completed",
        summary: "Dream keeps source refs.",
        sourceSessionCount: 1,
        changedArtifactCount: 2,
      });

      const prompt = harness.chatCompletions.mock.calls[0]?.[0].messages?.[1]?.content;
      expect(prompt).toContain("## Transcript sess-source");
      expect(prompt).toContain("## Memory File memory/project.md");
      expect(prompt).toContain("## Prior Maintenance Artifact memory/maintenance/latest.md");
      expect(prompt).toContain("## Memory Item mem-1");
      expect(prompt).toContain("## Retained Tool Artifact artifact-1");
      expect(prompt).toContain("Source Catalog");

      const provenance = harness.service.getRunProvenance(queuedRun.runId);
      expect(provenance.sources.map((source) => source.sourceRef).sort()).toEqual([
        "artifact-1",
        "mem-1",
        "memory/maintenance/latest.md",
        "memory/project.md",
        "sess-source",
      ]);
      expect(provenance.sources.map((source) => source.sourceKind).sort()).toEqual([
        "artifact",
        "file",
        "file",
        "memory_item",
        "transcript",
      ]);
      expect(provenance.changes).toHaveLength(2);
      expect(provenance.changes[1]).toMatchObject({
        changeKind: "updated",
        targetRef: "memory/maintenance/latest.md",
        beforeRef: `memory/maintenance/${previousSnapshotName}`,
      });

      const latestMarkdown = await fs.readFile(latestAbs, "utf8");
      expect(latestMarkdown).toContain("workspace: default");
      expect(latestMarkdown).toContain("provider: ollama");
      expect(latestMarkdown).toContain("# Workspace Memory");
      expect(latestMarkdown).toContain("Dream keeps source refs.");
      expect(latestMarkdown).not.toContain("# Workspace Memory\n\n# Workspace Memory");
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to generated maintenance markdown when the model returns no text and no sources exist", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-02T11:00:00.000Z"));

    try {
      const harness = createHarness();
      harness.chatCompletions.mockResolvedValueOnce(completionWithContent(""));
      harness.service.patchPolicy("default", {
        enabled: true,
        runMode: "manual",
        timingStrategy: "recommendation_first",
        timeZone: "UTC",
        minHoursSinceLastSuccess: 1,
        minChangedSessions: 1,
      });

      const queuedRun = harness.service.runNow({
        workspaceId: "default",
        triggerSource: "manual",
      });
      const durableRun = harness.callbacks.getDurableRun(queuedRun.durableRunId!);

      const result = await harness.service.executeDurableRun(durableRun);

      expect(result).toMatchObject({
        status: "completed",
        sourceSessionCount: 0,
        changedArtifactCount: 2,
      });
      const prompt = harness.chatCompletions.mock.calls[0]?.[0].messages?.[1]?.content;
      expect(prompt).toContain("No eligible transcript, file, memory-item, or retained artifact sources");

      const latestMarkdown = await fs.readFile(
        path.join(harness.workspaceRoot, "memory", "maintenance", "latest.md"),
        "utf8",
      );
      expect(latestMarkdown).toContain(
        "Automatic consolidation fallback was used for workspace default because the model returned no markdown output.",
      );
      expect(latestMarkdown).toContain("## References\n- none");
      expect(harness.service.getRunProvenance(queuedRun.runId).sources).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips unavailable local model execution and queues an execution-target recommendation", async () => {
    const harness = createHarness();
    harness.listModels.mockResolvedValueOnce([{ id: "other-model", name: "other-model" }]);
    harness.service.patchPolicy("default", {
      enabled: true,
      runMode: "manual",
      timingStrategy: "recommendation_first",
      timeZone: "UTC",
      minHoursSinceLastSuccess: 1,
      minChangedSessions: 1,
      providerId: "ollama",
      model: "missing-model",
      executionTarget: "local",
      unavailableModelPolicy: "skip",
    });

    const queuedRun = harness.service.runNow({
      workspaceId: "default",
      triggerSource: "manual",
    });
    const durableRun = harness.callbacks.getDurableRun(queuedRun.durableRunId!);

    const result = await harness.service.executeDurableRun(durableRun);

    expect(result).toMatchObject({
      memoryMaintenanceRunId: queuedRun.runId,
      workspaceId: "default",
      status: "skipped",
    });
    expect(result.summary).toContain("Configured local model ollama/missing-model is unavailable.");
    expect(harness.chatCompletions).not.toHaveBeenCalled();
    expect(harness.memoryMaintenance.getRun(queuedRun.runId)).toMatchObject({
      status: "skipped",
      sourceSessionCount: 0,
      changedArtifactCount: 0,
    });
    expect(harness.memoryMaintenance.requireState("default").activeRunId).toBeUndefined();
    expect(harness.memoryMaintenance.listRecommendations("default")).toEqual([
      expect.objectContaining({
        kind: "execution_target_adjustment",
        status: "queued",
        proposedPatch: {
          executionTarget: "cloud",
        },
      }),
    ]);
  });

  it("marks current durable-backed runs as failed for non-abort execution errors", async () => {
    const harness = createHarness();
    harness.service.patchPolicy("default", {
      enabled: true,
      runMode: "manual",
      timingStrategy: "recommendation_first",
      timeZone: "UTC",
      minHoursSinceLastSuccess: 1,
      minChangedSessions: 1,
      providerId: "ollama",
      model: "qwen3",
    });

    const queuedRun = harness.service.runNow({
      workspaceId: "default",
      triggerSource: "manual",
    });
    const durableRun = harness.callbacks.getDurableRun(queuedRun.durableRunId!);

    vi.spyOn(harness.service as never, "collectSources").mockRejectedValue(new Error("source scan failed") as never);

    await expect(harness.service.executeDurableRun(durableRun)).rejects.toThrow("source scan failed");

    expect(harness.memoryMaintenance.getRun(queuedRun.runId)).toMatchObject({
      status: "failed",
      error: "source scan failed",
      summary: "Memory maintenance run failed.",
    });
    expect(harness.memoryMaintenance.requireState("default").activeRunId).toBeUndefined();
  });

  it("does not finalize a durable-backed run as failed when execution aborts", async () => {
    const harness = createHarness();
    harness.service.patchPolicy("default", {
      enabled: true,
      runMode: "manual",
      timingStrategy: "recommendation_first",
      timeZone: "UTC",
      minHoursSinceLastSuccess: 1,
      minChangedSessions: 1,
      providerId: "ollama",
      model: "qwen3",
    });

    const queuedRun = harness.service.runNow({
      workspaceId: "default",
      triggerSource: "manual",
    });
    const durableRun = harness.callbacks.getDurableRun(queuedRun.durableRunId!);
    const controller = new AbortController();

    vi.spyOn(harness.service as never, "checkExecutionAvailability").mockResolvedValue({
      available: true,
    });
    vi.spyOn(harness.service as never, "collectSources").mockImplementation(async () => {
      controller.abort(new Error("lease lost"));
      throw controller.signal.reason;
    });

    await expect(harness.service.executeDurableRun(durableRun, { signal: controller.signal })).rejects.toThrow(
      "lease lost",
    );

    expect(harness.memoryMaintenance.getRun(queuedRun.runId).status).toBe("running");
    expect(harness.memoryMaintenance.requireState("default").activeRunId).toBe(queuedRun.runId);
  });

  it("normalizes durable workflow payloads and ignores malformed durable records", () => {
    const harness = createHarness();
    const queuedRun = harness.service.runNow({
      workspaceId: " workspace-a ",
      triggerSource: "manual",
    });
    const durableRun = harness.callbacks.getDurableRun(queuedRun.durableRunId!);

    expect(harness.service.parseWorkflowPayload(durableRun)).toMatchObject({
      workspaceId: "workspace-a",
      memoryMaintenanceRunId: queuedRun.runId,
      triggerSource: "manual",
    });
    expect(
      harness.service.parseWorkflowPayload({
        ...durableRun,
        payload: null,
      } as unknown as DurableRunRecord),
    ).toBeUndefined();
    expect(
      harness.service.parseWorkflowPayload({
        ...durableRun,
        payload: {
          ...(durableRun.payload as Record<string, unknown>),
          version: "other.workflow",
        },
      } as DurableRunRecord),
    ).toBeUndefined();
    expect(
      harness.service.parseWorkflowPayload({
        ...durableRun,
        payload: {
          ...(durableRun.payload as Record<string, unknown>),
          workspaceId: 42,
        },
      } as unknown as DurableRunRecord),
    ).toBeUndefined();
  });

  it("syncs queued, running, failed, dead-lettered, and cancelled durable statuses into maintenance state", () => {
    const harness = createHarness();
    const queuedRun = harness.service.runNow({
      workspaceId: "default",
      triggerSource: "manual",
    });
    const durableRun = harness.callbacks.getDurableRun(queuedRun.durableRunId!);

    harness.service.syncFromDurableRun({
      ...durableRun,
      status: "running",
      startedAt: "2026-04-02T13:00:00.000Z",
      updatedAt: "2026-04-02T13:00:00.000Z",
    } as DurableRunRecord);
    expect(harness.memoryMaintenance.getRun(queuedRun.runId)).toMatchObject({
      status: "running",
      durableRunId: durableRun.runId,
      startedAt: "2026-04-02T13:00:00.000Z",
    });
    expect(harness.memoryMaintenance.requireState("default").activeRunId).toBe(queuedRun.runId);

    harness.service.syncFromDurableRun({
      ...durableRun,
      status: "failed",
      lastError: "durable failed",
      updatedAt: "2026-04-02T13:01:00.000Z",
    } as DurableRunRecord);
    expect(harness.memoryMaintenance.getRun(queuedRun.runId)).toMatchObject({
      status: "failed",
      error: "durable failed",
      summary: "Memory maintenance run failed.",
    });
    expect(harness.memoryMaintenance.requireState("default").activeRunId).toBeUndefined();

    const deadLetteredRun = harness.service.runNow({
      workspaceId: "default",
      triggerSource: "manual",
    });
    const durableDeadLetteredRun = harness.callbacks.getDurableRun(deadLetteredRun.durableRunId!);
    harness.service.syncFromDurableRun({
      ...durableDeadLetteredRun,
      status: "dead_lettered",
      updatedAt: "2026-04-02T13:02:00.000Z",
    } as DurableRunRecord);
    expect(harness.memoryMaintenance.getRun(deadLetteredRun.runId)).toMatchObject({
      status: "failed",
      error: "Memory maintenance durable run failed.",
    });

    const cancelledRun = harness.service.runNow({
      workspaceId: "default",
      triggerSource: "manual",
    });
    const durableCancelledRun = harness.callbacks.getDurableRun(cancelledRun.durableRunId!);
    harness.service.syncFromDurableRun({
      ...durableCancelledRun,
      status: "cancelled",
      lastError: "operator cancelled",
      updatedAt: "2026-04-02T13:03:00.000Z",
    } as DurableRunRecord);
    expect(harness.memoryMaintenance.getRun(cancelledRun.runId)).toMatchObject({
      status: "cancelled",
      error: "operator cancelled",
    });
    expect(harness.memoryMaintenance.requireState("default").activeRunId).toBeUndefined();
  });

  it("ignores non-memory durable runs, missing maintenance records, and cancelled already-finalized runs", () => {
    const harness = createHarness();
    const queuedRun = harness.service.runNow({
      workspaceId: "default",
      triggerSource: "manual",
    });
    const durableRun = harness.callbacks.getDurableRun(queuedRun.durableRunId!);

    harness.service.syncFromDurableRun({
      ...durableRun,
      workflowKey: "other.workflow",
      status: "failed",
      lastError: "ignored",
    } as DurableRunRecord);
    expect(harness.memoryMaintenance.getRun(queuedRun.runId).status).toBe("queued");

    harness.service.syncFromDurableRun({
      ...durableRun,
      payload: {
        ...(durableRun.payload as Record<string, unknown>),
        memoryMaintenanceRunId: "missing-run",
      },
      status: "failed",
      lastError: "missing ignored",
    } as DurableRunRecord);
    expect(harness.memoryMaintenance.getRun(queuedRun.runId).status).toBe("queued");

    harness.memoryMaintenance.updateRun({
      ...harness.memoryMaintenance.getRun(queuedRun.runId),
      status: "completed",
      finishedAt: "2026-04-02T13:04:00.000Z",
    });
    harness.service.syncFromDurableRun({
      ...durableRun,
      status: "cancelled",
      lastError: "late cancel",
    } as DurableRunRecord);
    expect(harness.memoryMaintenance.getRun(queuedRun.runId).status).toBe("completed");
    expect(harness.memoryMaintenance.requireState("default").activeRunId).toBeUndefined();
  });
});

describe("MemoryMaintenanceService recommendations", () => {
  it("accepts a queued recommendation by patching policy and marking it applied", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-02T12:00:00.000Z"));

    try {
      const harness = createHarness();
      harness.service.patchPolicy("default", {
        enabled: true,
        runMode: "hybrid",
        timingStrategy: "recommendation_first",
        timeZone: "UTC",
        minHoursSinceLastSuccess: 24,
        minChangedSessions: 6,
      });
      const recommendation = harness.memoryMaintenance.createRecommendation({
        workspaceId: "default",
        kind: "threshold_adjustment",
        status: "queued",
        summary: "Lower threshold",
        proposedPatch: {
          minChangedSessions: 3,
        },
        rationale: "Backlog has grown.",
        createdAt: "2026-04-02T11:00:00.000Z",
        updatedAt: "2026-04-02T11:00:00.000Z",
      });

      const result = harness.service.acceptRecommendation(recommendation.recommendationId);

      expect(result.policy.minChangedSessions).toBe(3);
      expect(result.recommendation).toMatchObject({
        recommendationId: recommendation.recommendationId,
        status: "applied",
        appliedAt: "2026-04-02T12:00:00.000Z",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a queued recommendation without mutating the policy", () => {
    const harness = createHarness();
    harness.service.patchPolicy("default", {
      enabled: true,
      runMode: "hybrid",
      timingStrategy: "recommendation_first",
      timeZone: "UTC",
      minHoursSinceLastSuccess: 24,
      minChangedSessions: 6,
    });
    const recommendation = harness.memoryMaintenance.createRecommendation({
      workspaceId: "default",
      kind: "threshold_adjustment",
      status: "queued",
      summary: "Lower threshold",
      proposedPatch: {
        minChangedSessions: 3,
      },
      createdAt: "2026-04-02T11:00:00.000Z",
      updatedAt: "2026-04-02T11:00:00.000Z",
    });

    const rejected = harness.service.rejectRecommendation(recommendation.recommendationId);

    expect(rejected).toMatchObject({
      recommendationId: recommendation.recommendationId,
      status: "rejected",
    });
    expect(harness.memoryMaintenance.requirePolicy("default").minChangedSessions).toBe(6);
  });
});
