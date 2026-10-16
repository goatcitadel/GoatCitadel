import { describe, expect, it } from "vitest";
import type {
  ModelComparisonPromptResult,
  ModelComparisonRun,
  PromptPackRunRecord,
  PromptPackTestRecord,
} from "@goatcitadel/contracts";
import { ConflictError } from "@goatcitadel/contracts";
import {
  createModelComparisonRoutePort,
  ModelComparisonExecutionService,
  type ModelComparisonExecutionServiceDependencies,
  type ModelComparisonRunStatePort,
} from "./model-comparison-execution-service.js";
import { ModelComparisonService, type ModelComparisonRepositoryPort } from "./model-comparison-service.js";

describe("ModelComparisonExecutionService", () => {
  function promptRun(overrides: Partial<PromptPackRunRecord>): PromptPackRunRecord {
    return {
      runId: "run",
      packId: "pack-1",
      testId: "test-a",
      sessionId: "s",
      status: "completed",
      providerId: "p",
      model: "m",
      startedAt: "2026-10-15T00:00:00.000Z",
      finishedAt: "2026-10-15T00:00:01.500Z",
      responseText: "answer",
      ...overrides,
    } as PromptPackRunRecord;
  }

  async function setup(
    runPromptPackTest: ModelComparisonExecutionServiceDependencies["runPromptPackTest"],
    extra: Pick<ModelComparisonExecutionServiceDependencies, "onBackgroundError"> = {},
  ) {
    const repository = new InMemoryModelComparisonRepository();
    const clock = () => new Date("2026-10-15T00:00:00.000Z");
    const service = new ModelComparisonService({
      repository,
      clock,
      idFactory: idSequence("cmp-1"),
      listPromptPackTests: async () => [testRecord("test-a"), testRecord("test-b")],
    });
    const executor = new ModelComparisonExecutionService({ repository, clock, runPromptPackTest, ...extra });
    const created = await service.createComparison({
      packId: "pack-1",
      allTests: true,
      candidates: [
        { providerId: "openai", model: "gpt-5" },
        { providerId: "anthropic", model: "claude" },
      ],
    });
    return { service, executor, repository, created };
  }

  it("moves queued → running → completed and stores every response with at most 2 in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { service, executor, created } = await setup(async (_packId, testId, input) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return promptRun({ testId, runId: `${testId}-${input.model}`, responseText: `${input.model} says hi` });
    });
    const started = await executor.startComparison(created.comparisonId);
    expect(started.status).toBe("running");
    await executor.whenSettled(created.comparisonId);
    const done = await service.getComparison(created.comparisonId);
    expect(done.status).toBe("completed");
    expect(done.completedAt).toBeDefined();
    expect(done.results.every((result) => Boolean(result.responseText))).toBe(true);
    expect(done.results[0]?.latencyMs).toBe(1500);
    expect(maxInFlight).toBe(2);
    expect(JSON.stringify(done.results)).not.toContain("anthropic");
    expect(done.advisory?.safetyNotes.join(" ")).not.toContain("does not start live provider execution");
  });

  it("ends failed but keeps completed results when one candidate fails", async () => {
    const { service, executor, created } = await setup(async (_packId, testId, input) => {
      if (input.model === "claude") throw new Error("provider down");
      return promptRun({ testId, responseText: "ok" });
    });
    await executor.startComparison(created.comparisonId);
    await executor.whenSettled(created.comparisonId);
    const done = await service.getComparison(created.comparisonId);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("2 of 4 results failed.");
    expect(done.results.filter((result) => result.responseText === "ok")).toHaveLength(2);
    expect(done.results.filter((result) => result.error === "provider down")).toHaveLength(2);
  });

  it("records a failed prompt-pack run as a result error and retries it on restart", async () => {
    const calls: string[] = [];
    let fail = true;
    const { service, executor, created } = await setup(async (_packId, testId, input) => {
      calls.push(`${testId}:${input.model}`);
      return fail && input.model === "claude"
        ? promptRun({ testId, status: "failed", responseText: "", error: "tool blocked" })
        : promptRun({ testId, responseText: "  ok  " });
    });
    await executor.startComparison(created.comparisonId);
    await executor.whenSettled(created.comparisonId);
    const done = await service.getComparison(created.comparisonId);
    expect(done.status).toBe("failed");
    expect(done.results.filter((result) => result.responseText === "ok")).toHaveLength(2);
    const failed = done.results.filter((result) => result.error === "tool blocked");
    expect(failed).toHaveLength(2);
    expect(failed.every((result) => result.responseText === undefined)).toBe(true);
    expect(JSON.stringify(done.results.map((result) => result.responseText))).not.toContain("tool blocked");

    fail = false;
    calls.length = 0;
    await executor.startComparison(created.comparisonId);
    await executor.whenSettled(created.comparisonId);
    expect(calls.sort()).toEqual(["test-a:claude", "test-b:claude"]);
    expect((await service.getComparison(created.comparisonId)).status).toBe("completed");
  });

  it("restarting a failed comparison only re-runs missing or errored results", async () => {
    const calls: string[] = [];
    let fail = true;
    const { service, executor, created } = await setup(async (_packId, testId, input) => {
      calls.push(`${testId}:${input.model}`);
      if (fail && input.model === "claude") throw new Error("provider down");
      return promptRun({ testId, responseText: "ok" });
    });
    await executor.startComparison(created.comparisonId);
    await executor.whenSettled(created.comparisonId);
    fail = false;
    calls.length = 0;
    await executor.startComparison(created.comparisonId);
    await executor.whenSettled(created.comparisonId);
    expect(calls.sort()).toEqual(["test-a:claude", "test-b:claude"]);
    const done = await service.getComparison(created.comparisonId);
    expect(done.status).toBe("completed");
    expect(done.error).toBeUndefined();
    expect(done.results.every((result) => result.error === undefined)).toBe(true);
  });

  it("rejects a second start while running and a start after completion", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { executor, created } = await setup(async (_packId, testId) => {
      await gate;
      return promptRun({ testId });
    });
    await executor.startComparison(created.comparisonId);
    await expect(executor.startComparison(created.comparisonId)).rejects.toBeInstanceOf(ConflictError);
    release();
    await executor.whenSettled(created.comparisonId);
    await expect(executor.startComparison(created.comparisonId)).rejects.toThrow(/already completed/i);
    await expect(executor.startComparison(created.comparisonId)).rejects.toBeInstanceOf(ConflictError);
    await expect(executor.cancelComparison(created.comparisonId)).rejects.toBeInstanceOf(ConflictError);
  });

  it("cancel aborts the in-flight signal and ends cancelled", async () => {
    const signals: AbortSignal[] = [];
    const { executor, created } = await setup(
      (_packId, _testId, input) =>
        new Promise((_resolve, reject) => {
          signals.push(input.signal);
          input.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    await executor.startComparison(created.comparisonId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const cancelled = await executor.cancelComparison(created.comparisonId);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.completedAt).toBeDefined();
    expect(cancelled.results.some((result) => result.error === "aborted")).toBe(false);
  });

  it("a stale running comparison (no live executor) can be cancelled or restarted", async () => {
    const { service, executor, repository, created } = await setup(async (_packId, testId) => promptRun({ testId }));
    await repository.updateStatus(created.comparisonId, { status: "running", updatedAt: "2026-10-15T00:00:00.000Z" });
    const restarted = await executor.startComparison(created.comparisonId);
    expect(restarted.status).toBe("running");
    await executor.whenSettled(created.comparisonId);
    expect((await service.getComparison(created.comparisonId)).status).toBe("completed");

    const second = await setup(async (_packId, testId) => promptRun({ testId }));
    await second.repository.updateStatus(second.created.comparisonId, {
      status: "running",
      updatedAt: "2026-10-15T00:00:00.000Z",
    });
    const cancelled = await second.executor.cancelComparison(second.created.comparisonId);
    expect(cancelled.status).toBe("cancelled");
  });

  it("marks the run failed instead of leaking a rejection when persistence breaks mid-run", async () => {
    const { service, executor, repository, created } = await setup(async (_packId, testId) => promptRun({ testId }));
    repository.failUpsert = true;
    await executor.startComparison(created.comparisonId);
    await executor.whenSettled(created.comparisonId);
    const done = await service.getComparison(created.comparisonId);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("upsert broke");
  });

  it("reports the background error when the fallback failed-status write also breaks", async () => {
    const reported: Array<{ comparisonId: string; error: unknown }> = [];
    const { service, executor, repository, created } = await setup(async (_packId, testId) => promptRun({ testId }), {
      onBackgroundError: (comparisonId, error) => reported.push({ comparisonId, error }),
    });
    repository.failUpsert = true;
    repository.failFailedStatus = true;
    await executor.startComparison(created.comparisonId);
    await executor.whenSettled(created.comparisonId);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.comparisonId).toBe(created.comparisonId);
    expect((reported[0]?.error as Error).message).toBe("status write broke");
    expect((await service.getComparison(created.comparisonId)).status).toBe("running");
  });

  it("ends failed when a prompt-pack run pauses for approval without a response", async () => {
    const { service, executor, created } = await setup(async (_packId, testId, input) =>
      input.model === "claude"
        ? promptRun({ testId, status: "approval_paused", responseText: "" })
        : promptRun({ testId, responseText: "ok" }),
    );
    await executor.startComparison(created.comparisonId);
    await executor.whenSettled(created.comparisonId);
    const done = await service.getComparison(created.comparisonId);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("2 of 4 results failed.");
    const paused = done.results.filter((result) => result.error === "Prompt-pack run paused for approval.");
    expect(paused).toHaveLength(2);
    expect(paused.every((result) => result.responseText === undefined)).toBe(true);
  });

  it("never offers a paused run's partial text for blind judging", async () => {
    const { service, executor, created } = await setup(async (_packId, testId, input) =>
      input.model === "claude"
        ? promptRun({ testId, status: "approval_paused", responseText: "partial answer before approval" })
        : promptRun({ testId, responseText: "ok" }),
    );
    await executor.startComparison(created.comparisonId);
    await executor.whenSettled(created.comparisonId);
    const done = await service.getComparison(created.comparisonId);
    expect(done.status).toBe("failed");
    const paused = done.results.filter((result) => result.error === "Prompt-pack run paused for approval.");
    expect(paused).toHaveLength(2);
    expect(paused.every((result) => result.responseText === undefined)).toBe(true);
    expect(JSON.stringify(done.results)).not.toContain("partial answer before approval");
  });

  it("ends failed when a completed prompt-pack run returns no response", async () => {
    const { service, executor, created } = await setup(async (_packId, testId) =>
      promptRun({ testId, responseText: "   " }),
    );
    await executor.startComparison(created.comparisonId);
    await executor.whenSettled(created.comparisonId);
    const done = await service.getComparison(created.comparisonId);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("4 of 4 results failed.");
    expect(done.results.every((result) => result.error === "Prompt-pack run returned no response.")).toBe(true);
  });

  it("never ends completed while a result has no response, even if it was never run", async () => {
    const { service, executor, repository, created } = await setup(async (_packId, testId) => promptRun({ testId }));
    const orphan = { resultId: "orphan", testId: "test-a", candidateId: "unknown-candidate" };
    await repository.upsertResult(created.comparisonId, orphan, "2026-10-15T00:00:00.000Z");
    await executor.startComparison(created.comparisonId);
    await executor.whenSettled(created.comparisonId);
    const done = await service.getComparison(created.comparisonId);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("1 of 5 results failed.");
  });

  it("whenSettled resolves immediately when nothing is running", async () => {
    const { executor, created } = await setup(async (_packId, testId) => promptRun({ testId }));
    await expect(executor.whenSettled(created.comparisonId)).resolves.toBeUndefined();
  });

  it("serves records and run control through one route port", async () => {
    const { service, executor, created } = await setup(async (_packId, testId) => promptRun({ testId }));
    const port = createModelComparisonRoutePort(service, executor);
    expect((await port.listComparisons(10)).items.map((run) => run.comparisonId)).toEqual([created.comparisonId]);
    expect((await port.startComparison(created.comparisonId)).status).toBe("running");
    await executor.whenSettled(created.comparisonId);
    expect((await port.getComparison(created.comparisonId)).status).toBe("completed");
    await expect(port.cancelComparison(created.comparisonId)).rejects.toBeInstanceOf(ConflictError);
    const judgment = await port.addJudgment(created.comparisonId, {
      testId: "test-a",
      scores: [{ candidateId: created.candidates[0]!.candidateId, quality: 3 }],
    });
    expect(judgment.testId).toBe("test-a");
  });

  it("judging is unchanged after a run", async () => {
    const { service, executor, created } = await setup(async (_packId, testId) => promptRun({ testId }));
    await executor.startComparison(created.comparisonId);
    await executor.whenSettled(created.comparisonId);
    const judgment = await service.addJudgment(created.comparisonId, {
      testId: "test-a",
      winnerCandidateId: created.candidates[0]!.candidateId,
      scores: [{ candidateId: created.candidates[0]!.candidateId, quality: 4 }],
    });
    expect(judgment.testId).toBe("test-a");
  });
});

class InMemoryModelComparisonRepository implements ModelComparisonRepositoryPort, ModelComparisonRunStatePort {
  private readonly runs = new Map<string, ModelComparisonRun>();
  public failUpsert = false;
  public failFailedStatus = false;

  async create(run: ModelComparisonRun): Promise<ModelComparisonRun> {
    this.runs.set(run.comparisonId, cloneRun(run));
    return await this.get(run.comparisonId);
  }

  async get(comparisonId: string): Promise<ModelComparisonRun> {
    const run = this.runs.get(comparisonId);
    if (!run) {
      throw new Error("not found");
    }
    return cloneRun(run);
  }

  async list(): Promise<ModelComparisonRun[]> {
    return Array.from(this.runs.values()).map(cloneRun);
  }

  async addJudgment(comparisonId: string, judgment: ModelComparisonRun["judgments"][number]) {
    const run = await this.get(comparisonId);
    run.judgments.push(judgment);
    run.updatedAt = judgment.createdAt;
    this.runs.set(comparisonId, cloneRun(run));
    return judgment;
  }

  async updateStatus(
    comparisonId: string,
    update: {
      status: ModelComparisonRun["status"];
      updatedAt: string;
      completedAt?: string | null;
      error?: string | null;
    },
  ): Promise<ModelComparisonRun> {
    if (this.failFailedStatus && update.status === "failed") {
      throw new Error("status write broke");
    }
    const run = this.runs.get(comparisonId);
    if (!run) {
      throw new Error("not found");
    }
    const next: ModelComparisonRun = {
      ...run,
      status: update.status,
      updatedAt: update.updatedAt,
      completedAt: update.completedAt === undefined ? run.completedAt : (update.completedAt ?? undefined),
      error: update.error === undefined ? run.error : (update.error ?? undefined),
    };
    this.runs.set(comparisonId, cloneRun(next));
    return await this.get(comparisonId);
  }

  async upsertResult(
    comparisonId: string,
    result: ModelComparisonPromptResult,
    updatedAt: string,
  ): Promise<ModelComparisonRun> {
    if (this.failUpsert) {
      throw new Error("upsert broke");
    }
    const run = this.runs.get(comparisonId);
    if (!run) {
      throw new Error("not found");
    }
    const exists = run.results.some((item) => item.resultId === result.resultId);
    const results = exists
      ? run.results.map((item) => (item.resultId === result.resultId ? result : item))
      : [...run.results, result];
    this.runs.set(comparisonId, cloneRun({ ...run, results, updatedAt }));
    return await this.get(comparisonId);
  }
}

function cloneRun(run: ModelComparisonRun): ModelComparisonRun {
  return JSON.parse(JSON.stringify(run)) as ModelComparisonRun;
}

function idSequence(...ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? `id-${index}`;
}

function testRecord(testId: string): PromptPackTestRecord {
  return {
    testId,
    packId: "pack-1",
    code: testId,
    name: testId,
    prompt: "Prompt",
    expectedBehavior: "Expected",
    tags: [],
    createdAt: "2026-06-05T12:00:00.000Z",
    updatedAt: "2026-06-05T12:00:00.000Z",
  } as PromptPackTestRecord;
}
