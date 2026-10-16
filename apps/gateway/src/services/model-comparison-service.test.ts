import { describe, expect, it } from "vitest";
import type {
  ModelComparisonPromptResult,
  ModelComparisonRun,
  PromptPackRunRecord,
  PromptPackTestRecord,
} from "@goatcitadel/contracts";
import { ConflictError } from "@goatcitadel/contracts";
import {
  ModelComparisonService,
  type ModelComparisonRepositoryPort,
  type ModelComparisonServiceDependencies,
} from "./model-comparison-service.js";

describe("ModelComparisonService", () => {
  it("creates blind comparisons from prompt-pack tests with stable labels and queued placeholders", async () => {
    const service = new ModelComparisonService({
      repository: new InMemoryModelComparisonRepository(),
      clock: () => new Date("2026-06-05T12:00:00.000Z"),
      idFactory: idSequence("comparison-1"),
      listPromptPackTests: async () => [testRecord("test-a"), testRecord("test-b")],
    });

    const run = await service.createComparison({
      packId: "pack-1",
      allTests: true,
      candidates: [
        { providerId: "openai", model: "gpt-5" },
        { providerId: "local-ai-ollama", model: "llama3.2" },
      ],
    });

    expect(run.status).toBe("queued");
    expect(run.testIds).toEqual(["test-a", "test-b"]);
    expect(run.candidates.map((candidate) => candidate.blindLabel)).toEqual(["A", "B"]);
    expect(run.results).toHaveLength(4);
    expect(run.results[0]?.runId).toBeUndefined();
    expect(run.results[0]?.error).toBeUndefined();
    expect(run.advisory).toMatchObject({
      posture: "advisory_only",
      label: "MoA-style advisory comparison",
      candidateCount: 2,
      testCount: 2,
      resultCount: 4,
      responseCount: 0,
      missingResultCount: 4,
      judgmentCount: 0,
      recommendedNextAction: "run_prompt_pack",
    });
  });

  it("selects requested prompt-pack tests and links latest matching prompt-pack runs", async () => {
    const service = new ModelComparisonService({
      repository: new InMemoryModelComparisonRepository(),
      clock: () => new Date("2026-06-05T12:00:00.000Z"),
      idFactory: idSequence("comparison-1"),
      listPromptPackTests: async () => [testRecord("test-a"), testRecord("test-b"), testRecord("test-c")],
      listPromptPackRunsByTest: async (testId) => runsByTestId[testId] ?? [],
    });

    const run = await service.createComparison({
      packId: "pack-1",
      testIds: ["test-b", "test-a", "test-b"],
      candidates: [
        { providerId: "openai", model: "gpt-5" },
        { providerId: "anthropic", model: "claude" },
      ],
    });

    expect(run.testIds).toEqual(["test-b", "test-a"]);
    const linked = run.results.find(
      (result) => result.testId === "test-b" && result.candidateId === run.candidates[0]?.candidateId,
    );
    expect(linked).toMatchObject({
      runId: "run-openai-test-b",
      responseText: "OpenAI answer for test B",
      latencyMs: 1250,
    });
    const placeholder = run.results.find(
      (result) => result.testId === "test-b" && result.candidateId === run.candidates[1]?.candidateId,
    );
    expect(placeholder?.runId).toBeUndefined();
    expect((await service.getComparison(run.comparisonId)).advisory).toMatchObject({
      responseCount: 1,
      missingResultCount: 3,
      recommendedNextAction: "run_prompt_pack",
    });
  });

  it("persists judgments only for comparison tests and candidates", async () => {
    const repository = new InMemoryModelComparisonRepository();
    const service = new ModelComparisonService({
      repository,
      clock: () => new Date("2026-06-05T12:00:00.000Z"),
      idFactory: idSequence("cmp", "judgment-1"),
      listPromptPackTests: async () => [testRecord("test-a")],
    });
    const run = await service.createComparison({
      packId: "pack-1",
      allTests: true,
      candidates: [
        { providerId: "openai", model: "gpt-5" },
        { providerId: "anthropic", model: "claude" },
      ],
    });

    const judgment = await service.addJudgment(run.comparisonId, {
      testId: "test-a",
      winnerCandidateId: run.candidates[0]?.candidateId,
      scores: run.candidates.map((candidate) => ({ candidateId: candidate.candidateId, quality: 3 })),
      reviewerId: "operator",
    });

    expect(judgment.judgmentId).toBe("judgment-1");
    expect(await service.getComparison(run.comparisonId)).toMatchObject({
      judgments: [
        expect.objectContaining({
          judgmentId: judgment.judgmentId,
          testId: "test-a",
          reviewerId: "operator",
        }),
      ],
      advisory: {
        judgmentCount: 1,
        recommendedNextAction: "run_prompt_pack",
      },
    });
    await expect(
      service.addJudgment(run.comparisonId, {
        testId: "missing-test",
        scores: [],
      }),
    ).rejects.toThrow(/testId/);
    await expect(
      service.addJudgment(run.comparisonId, {
        testId: "test-a",
        scores: [
          { candidateId: run.candidates[0]!.candidateId, quality: 2 },
          { candidateId: run.candidates[0]!.candidateId, quality: 3 },
        ],
      }),
    ).rejects.toThrow(/duplicated/);
  });
});

describe("ModelComparisonService execution", () => {
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
    runPromptPackTest: NonNullable<ModelComparisonServiceDependencies["runPromptPackTest"]>,
    extra: Pick<ModelComparisonServiceDependencies, "onBackgroundError"> = {},
  ) {
    const repository = new InMemoryModelComparisonRepository();
    const service = new ModelComparisonService({
      repository,
      clock: () => new Date("2026-10-15T00:00:00.000Z"),
      idFactory: idSequence("cmp-1"),
      listPromptPackTests: async () => [testRecord("test-a"), testRecord("test-b")],
      runPromptPackTest,
      ...extra,
    });
    const created = await service.createComparison({
      packId: "pack-1",
      allTests: true,
      candidates: [
        { providerId: "openai", model: "gpt-5" },
        { providerId: "anthropic", model: "claude" },
      ],
    });
    return { service, repository, created };
  }

  it("moves queued → running → completed and stores every response with at most 2 in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { service, created } = await setup(async (_packId, testId, input) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return promptRun({ testId, runId: `${testId}-${input.model}`, responseText: `${input.model} says hi` });
    });
    const started = await service.startComparison(created.comparisonId);
    expect(started.status).toBe("running");
    await service.whenSettled(created.comparisonId);
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
    const { service, created } = await setup(async (_packId, testId, input) => {
      if (input.model === "claude") throw new Error("provider down");
      return promptRun({ testId, responseText: "ok" });
    });
    await service.startComparison(created.comparisonId);
    await service.whenSettled(created.comparisonId);
    const done = await service.getComparison(created.comparisonId);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("2 of 4 results failed.");
    expect(done.results.filter((result) => result.responseText === "ok")).toHaveLength(2);
    expect(done.results.filter((result) => result.error === "provider down")).toHaveLength(2);
  });

  it("records a failed prompt-pack run as a result error and retries it on restart", async () => {
    const calls: string[] = [];
    let fail = true;
    const { service, created } = await setup(async (_packId, testId, input) => {
      calls.push(`${testId}:${input.model}`);
      return fail && input.model === "claude"
        ? promptRun({ testId, status: "failed", responseText: "", error: "tool blocked" })
        : promptRun({ testId, responseText: "  ok  " });
    });
    await service.startComparison(created.comparisonId);
    await service.whenSettled(created.comparisonId);
    const done = await service.getComparison(created.comparisonId);
    expect(done.status).toBe("failed");
    expect(done.results.filter((result) => result.responseText === "ok")).toHaveLength(2);
    const failed = done.results.filter((result) => result.error === "tool blocked");
    expect(failed).toHaveLength(2);
    expect(failed.every((result) => result.responseText === undefined)).toBe(true);
    expect(JSON.stringify(done.results.map((result) => result.responseText))).not.toContain("tool blocked");

    fail = false;
    calls.length = 0;
    await service.startComparison(created.comparisonId);
    await service.whenSettled(created.comparisonId);
    expect(calls.sort()).toEqual(["test-a:claude", "test-b:claude"]);
    expect((await service.getComparison(created.comparisonId)).status).toBe("completed");
  });

  it("restarting a failed comparison only re-runs missing or errored results", async () => {
    const calls: string[] = [];
    let fail = true;
    const { service, created } = await setup(async (_packId, testId, input) => {
      calls.push(`${testId}:${input.model}`);
      if (fail && input.model === "claude") throw new Error("provider down");
      return promptRun({ testId, responseText: "ok" });
    });
    await service.startComparison(created.comparisonId);
    await service.whenSettled(created.comparisonId);
    fail = false;
    calls.length = 0;
    await service.startComparison(created.comparisonId);
    await service.whenSettled(created.comparisonId);
    expect(calls.sort()).toEqual(["test-a:claude", "test-b:claude"]);
    const done = await service.getComparison(created.comparisonId);
    expect(done.status).toBe("completed");
    expect(done.error).toBeUndefined();
    expect(done.results.every((result) => result.error === undefined)).toBe(true);
  });

  it("rejects a second start while running and a start after completion", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { service, created } = await setup(async (_packId, testId) => {
      await gate;
      return promptRun({ testId });
    });
    await service.startComparison(created.comparisonId);
    await expect(service.startComparison(created.comparisonId)).rejects.toBeInstanceOf(ConflictError);
    release();
    await service.whenSettled(created.comparisonId);
    await expect(service.startComparison(created.comparisonId)).rejects.toThrow(/already completed/i);
    await expect(service.startComparison(created.comparisonId)).rejects.toBeInstanceOf(ConflictError);
    await expect(service.cancelComparison(created.comparisonId)).rejects.toBeInstanceOf(ConflictError);
  });

  it("cancel aborts the in-flight signal and ends cancelled", async () => {
    const signals: AbortSignal[] = [];
    const { service, created } = await setup(
      (_packId, _testId, input) =>
        new Promise((_resolve, reject) => {
          signals.push(input.signal);
          input.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    await service.startComparison(created.comparisonId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const cancelled = await service.cancelComparison(created.comparisonId);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.completedAt).toBeDefined();
    expect(cancelled.results.some((result) => result.error === "aborted")).toBe(false);
  });

  it("a stale running comparison (no live executor) can be cancelled or restarted", async () => {
    const { service, repository, created } = await setup(async (_packId, testId) => promptRun({ testId }));
    await repository.updateStatus(created.comparisonId, { status: "running", updatedAt: "2026-10-15T00:00:00.000Z" });
    const restarted = await service.startComparison(created.comparisonId);
    expect(restarted.status).toBe("running");
    await service.whenSettled(created.comparisonId);
    expect((await service.getComparison(created.comparisonId)).status).toBe("completed");

    const second = await setup(async (_packId, testId) => promptRun({ testId }));
    await second.repository.updateStatus(second.created.comparisonId, {
      status: "running",
      updatedAt: "2026-10-15T00:00:00.000Z",
    });
    const cancelled = await second.service.cancelComparison(second.created.comparisonId);
    expect(cancelled.status).toBe("cancelled");
  });

  it("marks the run failed instead of leaking a rejection when persistence breaks mid-run", async () => {
    const { service, repository, created } = await setup(async (_packId, testId) => promptRun({ testId }));
    repository.failUpsert = true;
    await service.startComparison(created.comparisonId);
    await service.whenSettled(created.comparisonId);
    const done = await service.getComparison(created.comparisonId);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("upsert broke");
  });

  it("reports the background error when the fallback failed-status write also breaks", async () => {
    const reported: Array<{ comparisonId: string; error: unknown }> = [];
    const { service, repository, created } = await setup(async (_packId, testId) => promptRun({ testId }), {
      onBackgroundError: (comparisonId, error) => reported.push({ comparisonId, error }),
    });
    repository.failUpsert = true;
    repository.failFailedStatus = true;
    await service.startComparison(created.comparisonId);
    await service.whenSettled(created.comparisonId);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.comparisonId).toBe(created.comparisonId);
    expect((reported[0]?.error as Error).message).toBe("status write broke");
    expect((await service.getComparison(created.comparisonId)).status).toBe("running");
  });

  it("ends failed when a prompt-pack run pauses for approval without a response", async () => {
    const { service, created } = await setup(async (_packId, testId, input) =>
      input.model === "claude"
        ? promptRun({ testId, status: "approval_paused", responseText: "" })
        : promptRun({ testId, responseText: "ok" }),
    );
    await service.startComparison(created.comparisonId);
    await service.whenSettled(created.comparisonId);
    const done = await service.getComparison(created.comparisonId);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("2 of 4 results failed.");
    const paused = done.results.filter((result) => result.error === "Prompt-pack run paused for approval.");
    expect(paused).toHaveLength(2);
    expect(paused.every((result) => result.responseText === undefined)).toBe(true);
  });

  it("ends failed when a completed prompt-pack run returns no response", async () => {
    const { service, created } = await setup(async (_packId, testId) => promptRun({ testId, responseText: "   " }));
    await service.startComparison(created.comparisonId);
    await service.whenSettled(created.comparisonId);
    const done = await service.getComparison(created.comparisonId);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("4 of 4 results failed.");
    expect(done.results.every((result) => result.error === "Prompt-pack run returned no response.")).toBe(true);
  });

  it("never ends completed while a result has no response, even if it was never run", async () => {
    const { service, repository, created } = await setup(async (_packId, testId) => promptRun({ testId }));
    const orphan = { resultId: "orphan", testId: "test-a", candidateId: "unknown-candidate" };
    await repository.upsertResult(created.comparisonId, orphan, "2026-10-15T00:00:00.000Z");
    await service.startComparison(created.comparisonId);
    await service.whenSettled(created.comparisonId);
    const done = await service.getComparison(created.comparisonId);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("1 of 5 results failed.");
  });

  it("whenSettled resolves immediately when nothing is running", async () => {
    const { service, created } = await setup(async (_packId, testId) => promptRun({ testId }));
    await expect(service.whenSettled(created.comparisonId)).resolves.toBeUndefined();
  });

  it("refuses to start without a live runner", async () => {
    const service = new ModelComparisonService({
      repository: new InMemoryModelComparisonRepository(),
      idFactory: idSequence("cmp-1"),
      listPromptPackTests: async () => [testRecord("test-a")],
    });
    const created = await service.createComparison({
      packId: "pack-1",
      allTests: true,
      candidates: [
        { providerId: "a", model: "a" },
        { providerId: "b", model: "b" },
      ],
    });
    await expect(service.startComparison(created.comparisonId)).rejects.toThrow(/not available/i);
  });

  it("judging is unchanged after a run", async () => {
    const { service, created } = await setup(async (_packId, testId) => promptRun({ testId }));
    await service.startComparison(created.comparisonId);
    await service.whenSettled(created.comparisonId);
    const judgment = await service.addJudgment(created.comparisonId, {
      testId: "test-a",
      winnerCandidateId: created.candidates[0]!.candidateId,
      scores: [{ candidateId: created.candidates[0]!.candidateId, quality: 4 }],
    });
    expect(judgment.testId).toBe("test-a");
  });
});

const runsByTestId: Record<string, PromptPackRunRecord[]> = {
  "test-b": [
    {
      runId: "run-openai-test-b",
      packId: "pack-1",
      testId: "test-b",
      status: "completed",
      providerId: "openai",
      model: "gpt-5",
      responseText: "OpenAI answer for test B",
      startedAt: "2026-06-05T12:00:00.000Z",
      finishedAt: "2026-06-05T12:00:01.250Z",
    },
  ],
};

class InMemoryModelComparisonRepository implements ModelComparisonRepositoryPort {
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
