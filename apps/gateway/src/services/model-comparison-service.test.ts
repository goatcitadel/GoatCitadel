import { describe, expect, it } from "vitest";
import type { ModelComparisonRun, PromptPackRunRecord, PromptPackTestRecord } from "@goatcitadel/contracts";
import { ModelComparisonService, type ModelComparisonRepositoryPort } from "./model-comparison-service.js";

describe("ModelComparisonService", () => {
  it("creates blind comparisons from prompt-pack tests with stable labels and queued placeholders", () => {
    const service = new ModelComparisonService({
      repository: new InMemoryModelComparisonRepository(),
      clock: () => new Date("2026-06-05T12:00:00.000Z"),
      idFactory: idSequence("comparison-1"),
      listPromptPackTests: () => [testRecord("test-a"), testRecord("test-b")],
    });

    const run = service.createComparison({
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

  it("selects requested prompt-pack tests and links latest matching prompt-pack runs", () => {
    const service = new ModelComparisonService({
      repository: new InMemoryModelComparisonRepository(),
      clock: () => new Date("2026-06-05T12:00:00.000Z"),
      idFactory: idSequence("comparison-1"),
      listPromptPackTests: () => [testRecord("test-a"), testRecord("test-b"), testRecord("test-c")],
      listPromptPackRunsByTest: (testId) => runsByTestId[testId] ?? [],
    });

    const run = service.createComparison({
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
    expect(service.getComparison(run.comparisonId).advisory).toMatchObject({
      responseCount: 1,
      missingResultCount: 3,
      recommendedNextAction: "run_prompt_pack",
    });
  });

  it("persists judgments only for comparison tests and candidates", () => {
    const repository = new InMemoryModelComparisonRepository();
    const service = new ModelComparisonService({
      repository,
      clock: () => new Date("2026-06-05T12:00:00.000Z"),
      idFactory: idSequence("cmp", "judgment-1"),
      listPromptPackTests: () => [testRecord("test-a")],
    });
    const run = service.createComparison({
      packId: "pack-1",
      allTests: true,
      candidates: [
        { providerId: "openai", model: "gpt-5" },
        { providerId: "anthropic", model: "claude" },
      ],
    });

    const judgment = service.addJudgment(run.comparisonId, {
      testId: "test-a",
      winnerCandidateId: run.candidates[0]?.candidateId,
      scores: run.candidates.map((candidate) => ({ candidateId: candidate.candidateId, quality: 3 })),
      reviewerId: "operator",
    });

    expect(judgment.judgmentId).toBe("judgment-1");
    expect(service.getComparison(run.comparisonId)).toMatchObject({
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
    expect(() =>
      service.addJudgment(run.comparisonId, {
        testId: "missing-test",
        scores: [],
      }),
    ).toThrow(/testId/);
    expect(() =>
      service.addJudgment(run.comparisonId, {
        testId: "test-a",
        scores: [
          { candidateId: run.candidates[0]!.candidateId, quality: 2 },
          { candidateId: run.candidates[0]!.candidateId, quality: 3 },
        ],
      }),
    ).toThrow(/duplicated/);
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

  create(run: ModelComparisonRun): ModelComparisonRun {
    this.runs.set(run.comparisonId, cloneRun(run));
    return this.get(run.comparisonId);
  }

  get(comparisonId: string): ModelComparisonRun {
    const run = this.runs.get(comparisonId);
    if (!run) {
      throw new Error("not found");
    }
    return cloneRun(run);
  }

  list(): ModelComparisonRun[] {
    return Array.from(this.runs.values()).map(cloneRun);
  }

  addJudgment(comparisonId: string, judgment: ModelComparisonRun["judgments"][number]) {
    const run = this.get(comparisonId);
    run.judgments.push(judgment);
    run.updatedAt = judgment.createdAt;
    this.runs.set(comparisonId, cloneRun(run));
    return judgment;
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
