import { describe, expect, it, vi } from "vitest";
import { PromptPacksRouteService, type PromptPacksRoutePort } from "./prompt-packs-route-service.js";

function createPromptPacksPort() {
  return {
    importPromptPack: vi.fn((input: unknown) => ({ op: "import", input })),
    previewPromptPackImport: vi.fn((input: unknown) => ({ op: "preview", input })),
    importBuiltinPromptPack: vi.fn((packKey: string) => ({ op: "builtin-import", packKey })),
    listSecurityEvalPacks: vi.fn(() => ({ op: "security-eval-packs" })),
    listSecurityQualityGates: vi.fn(() => ({ op: "security-quality-gates" })),
    listPromptPacks: vi.fn((limit: number) => [{ op: "list", limit }]),
    listPromptPackTests: vi.fn((packId: string, limit: number) => [{ op: "tests", packId, limit }]),
    runPromptPackTest: vi.fn(async (packId: string, testId: string, input: unknown) => ({
      op: "run",
      packId,
      testId,
      input,
    })),
    scorePromptPackTest: vi.fn(async (input: unknown) => ({ op: "score", input })),
    autoScorePromptPackTest: vi.fn(async (input: unknown) => ({ op: "auto-score", input })),
    autoScorePromptPackBatch: vi.fn(async (input: unknown) => ({ op: "batch", input })),
    getPromptPackReport: vi.fn((packId: string) => ({ op: "report", packId })),
    listPromptPackTestReviews: vi.fn((packId: string, testId: string) => [{ op: "reviews", packId, testId }]),
    runPromptPackBenchmark: vi.fn((packId: string, input: unknown) => ({ op: "benchmark", packId, input })),
    getPromptPackBenchmarkStatus: vi.fn((benchmarkRunId: string) => ({ op: "benchmark-status", benchmarkRunId })),
    cancelPromptPackBenchmark: vi.fn((benchmarkRunId: string) => ({ op: "benchmark-cancel", benchmarkRunId })),
    runPromptPackReplayRegression: vi.fn((packId: string, input: unknown) => ({
      op: "replay",
      packId,
      input,
    })),
    getPromptPackReplayRegressionStatus: vi.fn((runId: string) => ({ op: "replay-status", runId })),
    getPromptPackCapabilityTrends: vi.fn((packId: string) => ({ op: "trends", packId })),
    getPromptPackExport: vi.fn((packId: string, format?: string) => ({ op: "get-export", packId, format })),
    exportPromptPack: vi.fn((packId: string, options?: unknown) => ({ op: "export", packId, options })),
    resetPromptPackRunsAndScores: vi.fn((packId: string, options?: unknown) => ({
      op: "reset",
      packId,
      options,
    })),
  };
}

describe("PromptPacksRouteService", () => {
  it("delegates prompt-pack route calls without reshaping inputs or outputs", async () => {
    const port = createPromptPacksPort();
    const service = new PromptPacksRouteService(port as unknown as PromptPacksRoutePort);

    expect(service.importPromptPack({ content: "# Pack", sourceLabel: "fixture.md" })).toEqual({
      op: "import",
      input: { content: "# Pack", sourceLabel: "fixture.md" },
    });
    expect(service.previewPromptPackImport({ content: "prompts: []", format: "promptfoo" })).toEqual({
      op: "preview",
      input: { content: "prompts: []", format: "promptfoo" },
    });
    expect(service.importBuiltinPromptPack("security-red-team-v6")).toEqual({
      op: "builtin-import",
      packKey: "security-red-team-v6",
    });
    expect(service.listSecurityEvalPacks()).toEqual({ op: "security-eval-packs" });
    expect(service.listSecurityQualityGates()).toEqual({ op: "security-quality-gates" });
    expect(service.listPromptPacks(25)).toEqual([{ op: "list", limit: 25 }]);
    expect(service.listPromptPackTests("pack-1", 50)).toEqual([{ op: "tests", packId: "pack-1", limit: 50 }]);
    await expect(service.runPromptPackTest("pack-1", "test-1", { mode: "agentic" } as never)).resolves.toEqual({
      op: "run",
      packId: "pack-1",
      testId: "test-1",
      input: { mode: "agentic" },
    });
    await expect(service.scorePromptPackTest({ packId: "pack-1", testId: "test-1" } as never)).resolves.toEqual({
      op: "score",
      input: { packId: "pack-1", testId: "test-1" },
    });
    await expect(service.reviewPromptPackTest({ packId: "pack-2", testId: "test-2" } as never)).resolves.toEqual({
      op: "score",
      input: { packId: "pack-2", testId: "test-2" },
    });
    await expect(service.autoScorePromptPackTest({ packId: "pack-1", testId: "test-1" } as never)).resolves.toEqual({
      op: "auto-score",
      input: { packId: "pack-1", testId: "test-1" },
    });
    await expect(service.autoScorePromptPackBatch({ packId: "pack-1" } as never)).resolves.toEqual({
      op: "batch",
      input: { packId: "pack-1" },
    });

    expect(service.getPromptPackReport("pack-1")).toEqual({ op: "report", packId: "pack-1" });
    expect(service.listPromptPackTestReviews("pack-1", "test-1")).toEqual([
      { op: "reviews", packId: "pack-1", testId: "test-1" },
    ]);
    expect(service.runPromptPackBenchmark("pack-1", { providers: [] } as never)).toEqual({
      op: "benchmark",
      packId: "pack-1",
      input: { providers: [] },
    });
    expect(service.getPromptPackBenchmarkStatus("bench-1")).toEqual({
      op: "benchmark-status",
      benchmarkRunId: "bench-1",
    });
    expect(service.cancelPromptPackBenchmark("bench-1")).toEqual({
      op: "benchmark-cancel",
      benchmarkRunId: "bench-1",
    });
    expect(service.runPromptPackReplayRegression("pack-1", { testCodes: ["A"] } as never)).toEqual({
      op: "replay",
      packId: "pack-1",
      input: { testCodes: ["A"] },
    });
    expect(service.getPromptPackReplayRegressionStatus("replay-1")).toEqual({
      op: "replay-status",
      runId: "replay-1",
    });
    expect(service.getPromptPackCapabilityTrends("pack-1")).toEqual({ op: "trends", packId: "pack-1" });
    expect(service.getPromptPackExport("pack-1", "promptfoo")).toEqual({
      op: "get-export",
      packId: "pack-1",
      format: "promptfoo",
    });
    expect(service.exportPromptPack("pack-1", { format: "promptfoo" })).toEqual({
      op: "export",
      packId: "pack-1",
      options: { format: "promptfoo" },
    });
    expect(service.resetPromptPackRunsAndScores("pack-1", { clearRuns: true })).toEqual({
      op: "reset",
      packId: "pack-1",
      options: { clearRuns: true },
    });
    expect(service.resetPromptPackRunsAndScores("pack-2")).toEqual({
      op: "reset",
      packId: "pack-2",
      options: undefined,
    });

    expect(port.reviewPromptPackTest).toBeUndefined();
    expect(port.scorePromptPackTest).toHaveBeenCalledWith({ packId: "pack-2", testId: "test-2" });
  });
});
