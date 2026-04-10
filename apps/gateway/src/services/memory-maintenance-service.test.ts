import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError } from "@goatcitadel/contracts";
import type {
  DurableRunCreateRequest,
  DurableRunRecord,
  MemoryMaintenancePolicyPatchInput,
  MemoryMaintenancePolicyRecord,
  MemoryMaintenanceRecommendationRecord,
  MemoryMaintenanceRunRecord,
  MemoryMaintenanceStateRecord,
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
  public readonly recommendations = new Map<string, MemoryMaintenanceRecommendationRecord>();
  public readonly changedSessionCounts: Map<string, number>;
  public readonly eligibleSessions: Map<string, EligibleSession[]>;

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

  public listActiveMemoryItems(_limit = 200): [] {
    return [];
  }

  public listRecentToolArtifacts(_workspaceId?: string, _since?: string, _limit = 100): [] {
    return [];
  }
}

function createHarness() {
  const changedSessionCounts = new Map<string, number>();
  const eligibleSessions = new Map<string, EligibleSession[]>();
  const memoryMaintenance = new FakeMemoryMaintenanceRepo(changedSessionCounts, eligibleSessions);
  const durableRuns = new Map<string, DurableRunRecord>();
  const sessionMeta = new Map<string, { workspaceId?: string; includeInHistory?: boolean; origin?: string }>();
  const sessionBindings = new Map<string, { transport: string; writable: boolean }>();
  const subagentSessionIds = new Set<string>();
  const publishRealtime = vi.fn();
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
    createDurableRun(input: DurableRunCreateRequest): DurableRunRecord {
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
    },
    config: {
      rootDir: "F:/code/personal-ai",
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
    sessionMeta,
    sessionBindings,
    changedSessionCounts,
    eligibleSessions,
    subagentSessionIds,
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

  it("queues a hybrid_due Dream run after a successful root turn when the session is eligible", async () => {
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

    await harness.service.noteSuccessfulRootTurn("sess-root");

    const runs = harness.memoryMaintenance.listRuns("default");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.triggerSource).toBe("hybrid_due");
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
});
