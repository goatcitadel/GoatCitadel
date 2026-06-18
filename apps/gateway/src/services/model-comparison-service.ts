import { randomUUID } from "node:crypto";
import type {
  ModelComparisonCreateRequest,
  ModelComparisonJudgment,
  ModelComparisonJudgeRequest,
  ModelComparisonPromptResult,
  ModelComparisonRun,
  PromptPackRunRecord,
  PromptPackTestRecord,
} from "@goatcitadel/contracts";
import { ValidationError } from "@goatcitadel/contracts";

export interface ModelComparisonRepositoryPort {
  create(run: ModelComparisonRun): ModelComparisonRun;
  get(comparisonId: string): ModelComparisonRun;
  list(limit?: number): ModelComparisonRun[];
  addJudgment(comparisonId: string, judgment: ModelComparisonJudgment): ModelComparisonJudgment;
}

export interface ModelComparisonServiceDependencies {
  repository: ModelComparisonRepositoryPort;
  listPromptPackTests: (packId: string, limit?: number) => PromptPackTestRecord[];
  listPromptPackRunsByTest?: (testId: string, limit?: number) => PromptPackRunRecord[];
  clock?: () => Date;
  idFactory?: () => string;
}

export class ModelComparisonService {
  public constructor(private readonly deps: ModelComparisonServiceDependencies) {}

  public createComparison(input: ModelComparisonCreateRequest): ModelComparisonRun {
    if (input.candidates.length < 2) {
      throw new ValidationError({ field: "candidates", message: "At least two model candidates are required." });
    }
    const now = this.nowIso();
    const comparisonId = this.deps.idFactory?.() ?? randomUUID();
    const selectedTests = this.resolvePromptPackTests(input);
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
      results: this.buildResultPlaceholders(comparisonId, input.packId, selectedTests, candidates),
      judgments: [],
      createdAt: now,
      updatedAt: now,
    };
    return this.deps.repository.create(run);
  }

  public listComparisons(limit = 50): { items: ModelComparisonRun[] } {
    return { items: this.deps.repository.list(limit) };
  }

  public getComparison(comparisonId: string): ModelComparisonRun {
    return this.deps.repository.get(comparisonId);
  }

  public addJudgment(comparisonId: string, input: ModelComparisonJudgeRequest): ModelComparisonJudgment {
    const run = this.deps.repository.get(comparisonId);
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
    return this.deps.repository.addJudgment(comparisonId, judgment);
  }

  private resolvePromptPackTests(input: ModelComparisonCreateRequest): PromptPackTestRecord[] {
    const direct = [...new Set((input.testIds ?? []).map((testId) => testId.trim()).filter(Boolean))];
    const tests = this.deps.listPromptPackTests(input.packId, 2000);
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

  private buildResultPlaceholders(
    comparisonId: string,
    packId: string,
    tests: PromptPackTestRecord[],
    candidates: ModelComparisonRun["candidates"],
  ): ModelComparisonPromptResult[] {
    return tests.flatMap((test) => {
      const runs = this.deps.listPromptPackRunsByTest?.(test.testId, 1000) ?? [];
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
    });
  }

  private nowIso(): string {
    return (this.deps.clock?.() ?? new Date()).toISOString();
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
