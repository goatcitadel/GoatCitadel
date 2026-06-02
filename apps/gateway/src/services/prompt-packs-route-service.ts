import type { PromptPackService } from "./prompt-pack-service.js";

export interface PromptPacksRoutePort {
  importPromptPack: PromptPackService["importPromptPack"];
  previewPromptPackImport: PromptPackService["previewPromptPackImport"];
  importBuiltinPromptPack: PromptPackService["importBuiltinPromptPack"];
  listSecurityEvalPacks: PromptPackService["listSecurityEvalPacks"];
  listSecurityQualityGates: PromptPackService["listSecurityQualityGates"];
  listPromptPacks: PromptPackService["listPromptPacks"];
  listPromptPackTests: PromptPackService["listPromptPackTests"];
  runPromptPackTest: PromptPackService["runPromptPackTest"];
  scorePromptPackTest: PromptPackService["scorePromptPackTest"];
  autoScorePromptPackTest: PromptPackService["autoScorePromptPackTest"];
  autoScorePromptPackBatch: PromptPackService["autoScorePromptPackBatch"];
  getPromptPackReport: PromptPackService["getPromptPackReport"];
  listPromptPackTestReviews: PromptPackService["listPromptPackTestReviews"];
  runPromptPackBenchmark: PromptPackService["runPromptPackBenchmark"];
  getPromptPackBenchmarkStatus: PromptPackService["getPromptPackBenchmarkStatus"];
  cancelPromptPackBenchmark: PromptPackService["cancelPromptPackBenchmark"];
  runPromptPackReplayRegression: PromptPackService["runPromptPackReplayRegression"];
  getPromptPackReplayRegressionStatus: PromptPackService["getPromptPackReplayRegressionStatus"];
  getPromptPackCapabilityTrends: PromptPackService["getPromptPackCapabilityTrends"];
  getPromptPackExport: PromptPackService["getPromptPackExport"];
  exportPromptPack: PromptPackService["exportPromptPack"];
  resetPromptPackRunsAndScores: PromptPackService["resetPromptPackRunsAndScores"];
}

export class PromptPacksRouteService {
  public constructor(private readonly promptPacks: PromptPacksRoutePort) {}

  public importPromptPack(input: Parameters<PromptPacksRoutePort["importPromptPack"]>[0]) {
    return this.promptPacks.importPromptPack(input);
  }

  public previewPromptPackImport(input: Parameters<PromptPacksRoutePort["previewPromptPackImport"]>[0]) {
    return this.promptPacks.previewPromptPackImport(input);
  }

  public importBuiltinPromptPack(packKey: string) {
    return this.promptPacks.importBuiltinPromptPack(packKey);
  }

  public listSecurityEvalPacks() {
    return this.promptPacks.listSecurityEvalPacks();
  }

  public listSecurityQualityGates() {
    return this.promptPacks.listSecurityQualityGates();
  }

  public listPromptPacks(limit: number) {
    return this.promptPacks.listPromptPacks(limit);
  }

  public listPromptPackTests(packId: string, limit: number) {
    return this.promptPacks.listPromptPackTests(packId, limit);
  }

  public runPromptPackTest(
    packId: string,
    testId: string,
    input: Parameters<PromptPacksRoutePort["runPromptPackTest"]>[2],
  ) {
    return this.promptPacks.runPromptPackTest(packId, testId, input);
  }

  public scorePromptPackTest(input: Parameters<PromptPacksRoutePort["scorePromptPackTest"]>[0]) {
    return this.promptPacks.scorePromptPackTest(input);
  }

  public reviewPromptPackTest(input: Parameters<PromptPacksRoutePort["scorePromptPackTest"]>[0]) {
    return this.promptPacks.scorePromptPackTest(input);
  }

  public autoScorePromptPackTest(input: Parameters<PromptPacksRoutePort["autoScorePromptPackTest"]>[0]) {
    return this.promptPacks.autoScorePromptPackTest(input);
  }

  public autoScorePromptPackBatch(input: Parameters<PromptPacksRoutePort["autoScorePromptPackBatch"]>[0]) {
    return this.promptPacks.autoScorePromptPackBatch(input);
  }

  public getPromptPackReport(packId: string) {
    return this.promptPacks.getPromptPackReport(packId);
  }

  public listPromptPackTestReviews(packId: string, testId: string) {
    return this.promptPacks.listPromptPackTestReviews(packId, testId);
  }

  public runPromptPackBenchmark(packId: string, input: Parameters<PromptPacksRoutePort["runPromptPackBenchmark"]>[1]) {
    return this.promptPacks.runPromptPackBenchmark(packId, input);
  }

  public getPromptPackBenchmarkStatus(benchmarkRunId: string) {
    return this.promptPacks.getPromptPackBenchmarkStatus(benchmarkRunId);
  }

  public cancelPromptPackBenchmark(benchmarkRunId: string) {
    return this.promptPacks.cancelPromptPackBenchmark(benchmarkRunId);
  }

  public runPromptPackReplayRegression(
    packId: string,
    input: Parameters<PromptPacksRoutePort["runPromptPackReplayRegression"]>[1],
  ) {
    return this.promptPacks.runPromptPackReplayRegression(packId, input);
  }

  public getPromptPackReplayRegressionStatus(runId: string) {
    return this.promptPacks.getPromptPackReplayRegressionStatus(runId);
  }

  public getPromptPackCapabilityTrends(packId: string) {
    return this.promptPacks.getPromptPackCapabilityTrends(packId);
  }

  public getPromptPackExport(packId: string, format?: Parameters<PromptPacksRoutePort["getPromptPackExport"]>[1]) {
    return this.promptPacks.getPromptPackExport(packId, format);
  }

  public exportPromptPack(packId: string, options?: Parameters<PromptPacksRoutePort["exportPromptPack"]>[1]) {
    return this.promptPacks.exportPromptPack(packId, options);
  }

  public resetPromptPackRunsAndScores(
    packId: string,
    options?: Parameters<PromptPacksRoutePort["resetPromptPackRunsAndScores"]>[1],
  ) {
    return this.promptPacks.resetPromptPackRunsAndScores(packId, options);
  }
}
