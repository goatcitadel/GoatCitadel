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
import { ValidationError } from "@goatcitadel/contracts";

export interface ModelComparisonRepositoryPort {
  create(run: ModelComparisonRun): Promise<ModelComparisonRun>;
  get(comparisonId: string): Promise<ModelComparisonRun>;
  list(limit?: number): Promise<ModelComparisonRun[]>;
  addJudgment(comparisonId: string, judgment: ModelComparisonJudgment): Promise<ModelComparisonJudgment>;
}

export interface ModelComparisonServiceDependencies {
  repository: ModelComparisonRepositoryPort;
  listPromptPackTests: (packId: string, limit?: number) => Promise<PromptPackTestRecord[]>;
  listPromptPackRunsByTest?: (testId: string, limit?: number) => Promise<PromptPackRunRecord[]>;
  clock?: () => Date;
  idFactory?: () => string;
}

export class ModelComparisonService {
  public constructor(private readonly deps: ModelComparisonServiceDependencies) {}

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
      "It does not start live provider execution or change routing by itself.",
      "Use governed Assembly or Cowork runs for live multi-model execution with approvals and budgets.",
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
