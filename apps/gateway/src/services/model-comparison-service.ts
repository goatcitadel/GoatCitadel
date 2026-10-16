import { randomUUID } from "node:crypto";
import type {
  ModelComparisonCreateRequest,
  ModelComparisonAdvisoryNextAction,
  ModelComparisonJudgment,
  ModelComparisonJudgeRequest,
  ModelComparisonPromptResult,
  ModelComparisonRun,
  PromptPackRunRecord,
  PromptPackTestRecord,
} from "@goatcitadel/contracts";
import { ConflictError, ValidationError } from "@goatcitadel/contracts";

export interface ModelComparisonRepositoryPort {
  create(run: ModelComparisonRun): Promise<ModelComparisonRun>;
  get(comparisonId: string): Promise<ModelComparisonRun>;
  list(limit?: number): Promise<ModelComparisonRun[]>;
  addJudgment(comparisonId: string, judgment: ModelComparisonJudgment): Promise<ModelComparisonJudgment>;
  updateStatus(
    comparisonId: string,
    update: {
      status: ModelComparisonRun["status"];
      updatedAt: string;
      completedAt?: string | null;
      error?: string | null;
    },
  ): Promise<ModelComparisonRun>;
  upsertResult(
    comparisonId: string,
    result: ModelComparisonPromptResult,
    updatedAt: string,
  ): Promise<ModelComparisonRun>;
}

export type ModelComparisonPromptPackRunner = (
  packId: string,
  testId: string,
  input: { providerId: string; model: string; signal: AbortSignal },
) => Promise<PromptPackRunRecord>;

export interface ModelComparisonServiceDependencies {
  repository: ModelComparisonRepositoryPort;
  listPromptPackTests: (packId: string, limit?: number) => Promise<PromptPackTestRecord[]>;
  listPromptPackRunsByTest?: (testId: string, limit?: number) => Promise<PromptPackRunRecord[]>;
  runPromptPackTest?: ModelComparisonPromptPackRunner;
  onBackgroundError?: (comparisonId: string, error: unknown) => void;
  clock?: () => Date;
  idFactory?: () => string;
}

const COMPARISON_CONCURRENCY = 2;

interface ComparisonWorkItem {
  result: ModelComparisonPromptResult;
  providerId: string;
  model: string;
}

interface ActiveComparison {
  controller: AbortController;
  settled: Promise<void>;
}

export class ModelComparisonService {
  private readonly active = new Map<string, ActiveComparison>();

  public constructor(private readonly deps: ModelComparisonServiceDependencies) {}

  public async startComparison(comparisonId: string): Promise<ModelComparisonRun> {
    const runner = this.deps.runPromptPackTest;
    if (!runner) {
      throw new ValidationError({
        field: "comparisonId",
        message: "Live comparison execution is not available in this runtime.",
      });
    }
    if (this.active.has(comparisonId)) {
      throw new ConflictError({ message: "Comparison is already running." });
    }
    const controller = new AbortController();
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => (markSettled = resolve));
    this.active.set(comparisonId, { controller, settled });
    const release = () => {
      this.active.delete(comparisonId);
      markSettled();
    };
    let running: ModelComparisonRun;
    try {
      running = await this.markRunning(comparisonId);
    } catch (error) {
      release();
      throw error;
    }
    void this.runInBackground(running, runner, controller.signal).finally(release);
    return this.withAdvisory(running);
  }

  public async cancelComparison(comparisonId: string): Promise<ModelComparisonRun> {
    const entry = this.active.get(comparisonId);
    if (entry) {
      entry.controller.abort();
      await entry.settled;
      return await this.getComparison(comparisonId);
    }
    const run = await this.deps.repository.get(comparisonId);
    if (run.status !== "running") {
      throw new ConflictError({ message: `Comparison is ${run.status}; only a running comparison can be cancelled.` });
    }
    const now = this.nowIso();
    return this.withAdvisory(
      await this.deps.repository.updateStatus(comparisonId, { status: "cancelled", updatedAt: now, completedAt: now }),
    );
  }

  public async whenSettled(comparisonId: string): Promise<void> {
    await this.active.get(comparisonId)?.settled;
  }

  public async createComparison(input: ModelComparisonCreateRequest): Promise<ModelComparisonRun> {
    if (input.candidates.length < 2) {
      throw new ValidationError({ field: "candidates", message: "At least two model candidates are required." });
    }
    const now = this.nowIso();
    const comparisonId = this.deps.idFactory?.() ?? randomUUID();
    const selectedTests = await this.resolvePromptPackTests(input);
    const testIds = selectedTests.map((test) => test.testId);
    const candidates = assignBlindLabels(input.candidates).map((candidate, index) => ({
      candidateId: `${comparisonId}:candidate:${index + 1}`,
      providerId: candidate.providerId,
      model: candidate.model,
      blindLabel: candidate.blindLabel,
    }));
    const run: ModelComparisonRun = {
      comparisonId,
      packId: input.packId,
      status: "queued",
      title: input.title?.trim() || `Blind model comparison for ${input.packId}`,
      candidates,
      testIds,
      results: await this.buildResultPlaceholders(comparisonId, input.packId, selectedTests, candidates),
      judgments: [],
      createdAt: now,
      updatedAt: now,
    };
    return this.withAdvisory(await this.deps.repository.create(run));
  }

  public async listComparisons(limit = 50): Promise<{ items: ModelComparisonRun[] }> {
    return { items: (await this.deps.repository.list(limit)).map((run) => this.withAdvisory(run)) };
  }

  public async getComparison(comparisonId: string): Promise<ModelComparisonRun> {
    return this.withAdvisory(await this.deps.repository.get(comparisonId));
  }

  public async addJudgment(comparisonId: string, input: ModelComparisonJudgeRequest): Promise<ModelComparisonJudgment> {
    const run = await this.deps.repository.get(comparisonId);
    const candidateIds = new Set(run.candidates.map((candidate) => candidate.candidateId));
    if (!run.testIds.includes(input.testId)) {
      throw new ValidationError({ field: "testId", message: "Judgment testId is not part of the comparison." });
    }
    if (input.winnerCandidateId && !candidateIds.has(input.winnerCandidateId)) {
      throw new ValidationError({
        field: "winnerCandidateId",
        message: "Winner candidate is not part of the comparison.",
      });
    }
    if (input.scores.length < 1) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "scores" });
    }
    const seenScoreCandidateIds = new Set<string>();
    for (const score of input.scores) {
      if (!candidateIds.has(score.candidateId)) {
        throw new ValidationError({ field: "scores", message: "Score candidate is not part of the comparison." });
      }
      if (seenScoreCandidateIds.has(score.candidateId)) {
        throw new ValidationError({ field: "scores", message: "Score candidate is duplicated." });
      }
      seenScoreCandidateIds.add(score.candidateId);
    }
    const judgment: ModelComparisonJudgment = {
      judgmentId: this.deps.idFactory?.() ?? randomUUID(),
      testId: input.testId,
      winnerCandidateId: input.winnerCandidateId,
      scores: input.scores,
      notes: input.notes?.trim() || undefined,
      reviewerId: input.reviewerId?.trim() || undefined,
      createdAt: this.nowIso(),
    };
    return await this.deps.repository.addJudgment(comparisonId, judgment);
  }

  private async resolvePromptPackTests(input: ModelComparisonCreateRequest): Promise<PromptPackTestRecord[]> {
    const direct = [...new Set((input.testIds ?? []).map((testId) => testId.trim()).filter(Boolean))];
    const tests = await this.deps.listPromptPackTests(input.packId, 2000);
    if (input.allTests) {
      if (tests.length > 0) {
        return tests.slice(0, 200);
      }
      throw new ValidationError({
        field: "testIds",
        message: "The selected prompt pack has no visible tests.",
      });
    }
    if (direct.length > 0) {
      const byId = new Map(tests.map((test) => [test.testId, test]));
      return direct.slice(0, 200).map((testId) => {
        const test = byId.get(testId);
        if (!test) {
          throw new ValidationError({
            field: "testIds",
            message: `Prompt-pack test ${testId} is not part of ${input.packId}.`,
          });
        }
        return test;
      });
    }
    throw new ValidationError({
      field: "testIds",
      message: "Choose testIds or use a prompt pack with visible tests.",
    });
  }

  private async buildResultPlaceholders(
    comparisonId: string,
    packId: string,
    tests: PromptPackTestRecord[],
    candidates: ModelComparisonRun["candidates"],
  ): Promise<ModelComparisonPromptResult[]> {
    const resultGroups = await Promise.all(
      tests.map(async (test) => {
        const runs = (await this.deps.listPromptPackRunsByTest?.(test.testId, 1000)) ?? [];
        return candidates.map((candidate) => {
          const linkedRun = runs.find(
            (run) =>
              run.packId === packId &&
              run.testId === test.testId &&
              run.providerId === candidate.providerId &&
              run.model === candidate.model,
          );
          return buildResultPlaceholder(comparisonId, test.testId, candidate.candidateId, linkedRun);
        });
      }),
    );
    return resultGroups.flat();
  }

  private async markRunning(comparisonId: string): Promise<ModelComparisonRun> {
    const run = await this.deps.repository.get(comparisonId);
    if (run.status === "completed") {
      throw new ConflictError({ message: "Comparison already completed." });
    }
    return await this.deps.repository.updateStatus(comparisonId, {
      status: "running",
      updatedAt: this.nowIso(),
      completedAt: null,
      error: null,
    });
  }

  private async runInBackground(
    run: ModelComparisonRun,
    runner: ModelComparisonPromptPackRunner,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.executeComparison(run, runner, signal);
    } catch (error) {
      const now = this.nowIso();
      await this.deps.repository
        .updateStatus(run.comparisonId, {
          status: "failed",
          updatedAt: now,
          completedAt: now,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch((statusError: unknown) => this.deps.onBackgroundError?.(run.comparisonId, statusError));
    }
  }

  private async executeComparison(
    run: ModelComparisonRun,
    runner: ModelComparisonPromptPackRunner,
    signal: AbortSignal,
  ): Promise<void> {
    const queue = buildComparisonWorkItems(run);
    let failure: { error: unknown } | undefined;
    const worker = async () => {
      while (!signal.aborted && !failure) {
        const item = queue.shift();
        if (!item) {
          return;
        }
        await this.runWorkItem(run, item, runner, signal).catch((error: unknown) => {
          failure ??= { error };
        });
      }
    };
    await Promise.all(Array.from({ length: COMPARISON_CONCURRENCY }, worker));
    if (failure) {
      throw failure.error;
    }
    await this.finishComparison(run.comparisonId, signal.aborted);
  }

  private async runWorkItem(
    run: ModelComparisonRun,
    item: ComparisonWorkItem,
    runner: ModelComparisonPromptPackRunner,
    signal: AbortSignal,
  ): Promise<void> {
    const pending: ModelComparisonPromptResult = { ...item.result, error: undefined };
    await this.deps.repository.upsertResult(run.comparisonId, pending, this.nowIso());
    let next: ModelComparisonPromptResult;
    try {
      const promptRun = await runner(run.packId, item.result.testId, {
        providerId: item.providerId,
        model: item.model,
        signal,
      });
      next = applyPromptPackRun(pending, promptRun);
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      next = { ...pending, error: error instanceof Error ? error.message : String(error) };
    }
    await this.deps.repository.upsertResult(run.comparisonId, next, this.nowIso());
  }

  private async finishComparison(comparisonId: string, aborted: boolean): Promise<void> {
    const now = this.nowIso();
    if (aborted) {
      await this.deps.repository.updateStatus(comparisonId, { status: "cancelled", updatedAt: now, completedAt: now });
      return;
    }
    const latest = await this.deps.repository.get(comparisonId);
    const failedCount = latest.results.filter(
      (result) => Boolean(result.error?.trim()) || !result.responseText?.trim(),
    ).length;
    await this.deps.repository.updateStatus(comparisonId, {
      status: failedCount > 0 ? "failed" : "completed",
      updatedAt: now,
      completedAt: now,
      error: failedCount > 0 ? `${failedCount} of ${latest.results.length} results failed.` : null,
    });
  }

  private nowIso(): string {
    return (this.deps.clock?.() ?? new Date()).toISOString();
  }

  private withAdvisory(run: ModelComparisonRun): ModelComparisonRun {
    return { ...run, advisory: buildModelComparisonAdvisory(run) };
  }
}

function assignBlindLabels(
  candidates: ModelComparisonCreateRequest["candidates"],
): Array<ModelComparisonCreateRequest["candidates"][number] & { blindLabel: string }> {
  const labels = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  return candidates.map((candidate, index) => ({
    ...candidate,
    blindLabel: labels[index] ?? `M${index + 1}`,
  }));
}

function buildResultPlaceholder(
  comparisonId: string,
  testId: string,
  candidateId: string,
  linkedRun?: PromptPackRunRecord,
): ModelComparisonPromptResult {
  return {
    resultId: `${comparisonId}:${testId}:${candidateId}`,
    testId,
    candidateId,
    runId: linkedRun?.runId,
    responseText: linkedRun?.responseText?.trim() || undefined,
    latencyMs: computeRunLatencyMs(linkedRun),
    error: linkedRun?.error ?? (linkedRun?.status === "failed" ? "Prompt-pack run failed." : undefined),
  };
}

function buildComparisonWorkItems(run: ModelComparisonRun): ComparisonWorkItem[] {
  const candidates = new Map(run.candidates.map((candidate) => [candidate.candidateId, candidate]));
  return run.results.flatMap((result) => {
    const candidate = candidates.get(result.candidateId);
    if (!candidate || (result.responseText?.trim() && !result.error?.trim())) {
      return [];
    }
    return [{ result, providerId: candidate.providerId, model: candidate.model }];
  });
}

function applyPromptPackRun(
  pending: ModelComparisonPromptResult,
  promptRun: PromptPackRunRecord,
): ModelComparisonPromptResult {
  const responseText = promptRun.responseText?.trim() || undefined;
  return {
    ...pending,
    runId: promptRun.runId,
    responseText: promptRun.status === "failed" ? undefined : responseText,
    latencyMs: computeRunLatencyMs(promptRun),
    error: resolvePromptPackRunError(promptRun, responseText),
  };
}

function resolvePromptPackRunError(
  promptRun: PromptPackRunRecord,
  responseText: string | undefined,
): string | undefined {
  if (promptRun.status === "failed") {
    return promptRun.error ?? "Prompt-pack run failed.";
  }
  if (responseText) {
    return undefined;
  }
  return promptRun.status === "approval_paused"
    ? "Prompt-pack run paused for approval."
    : "Prompt-pack run returned no response.";
}

function computeRunLatencyMs(run?: PromptPackRunRecord): number | undefined {
  if (!run?.finishedAt) {
    return undefined;
  }
  const startedAt = Date.parse(run.startedAt);
  const finishedAt = Date.parse(run.finishedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) {
    return undefined;
  }
  return Math.max(0, finishedAt - startedAt);
}

function buildModelComparisonAdvisory(run: ModelComparisonRun): ModelComparisonRun["advisory"] {
  const responseCount = run.results.filter((result) => Boolean(result.responseText?.trim())).length;
  const errorCount = run.results.filter((result) => Boolean(result.error?.trim())).length;
  const missingResultCount = Math.max(0, run.results.length - responseCount - errorCount);
  const recommendedNextAction = resolveAdvisoryNextAction(run, responseCount, missingResultCount);
  return {
    posture: "advisory_only",
    label: "MoA-style advisory comparison",
    summary: `${run.candidates.length} candidate model${run.candidates.length === 1 ? "" : "s"} across ${
      run.testIds.length
    } prompt-pack test${run.testIds.length === 1 ? "" : "s"}; ${responseCount}/${run.results.length} responses are available for blind review.`,
    executionStyle: "single_turn_harness",
    candidateCount: run.candidates.length,
    testCount: run.testIds.length,
    resultCount: run.results.length,
    responseCount,
    missingResultCount,
    judgmentCount: run.judgments.length,
    recommendedNextAction,
    safetyNotes: [
      "This record compares existing prompt-pack outputs and operator judgments.",
      "Start the comparison to run each prompt-pack test once per candidate through the governed prompt-pack runner.",
      "Comparing does not change routing by itself.",
    ],
  };
}

function resolveAdvisoryNextAction(
  run: ModelComparisonRun,
  responseCount: number,
  missingResultCount: number,
): ModelComparisonAdvisoryNextAction {
  if (run.results.length === 0 || missingResultCount > 0) {
    return "run_prompt_pack";
  }
  if (responseCount > 0 && run.judgments.length === 0) {
    return "save_judgment";
  }
  if (run.judgments.length > 0) {
    return "ready_for_synthesis";
  }
  return "review_outputs";
}
