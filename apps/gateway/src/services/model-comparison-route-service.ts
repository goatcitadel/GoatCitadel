import type { ModelComparisonCreateRequest, ModelComparisonJudgeRequest } from "@goatcitadel/contracts";
import type { ModelComparisonService } from "./model-comparison-service.js";

export interface ModelComparisonRoutePort {
  createComparison: ModelComparisonService["createComparison"];
  listComparisons: ModelComparisonService["listComparisons"];
  getComparison: ModelComparisonService["getComparison"];
  addJudgment: ModelComparisonService["addJudgment"];
  startComparison: ModelComparisonService["startComparison"];
  cancelComparison: ModelComparisonService["cancelComparison"];
}

export class ModelComparisonRouteService {
  public constructor(private readonly modelComparisons: ModelComparisonRoutePort) {}

  public createModelComparison(input: ModelComparisonCreateRequest) {
    return this.modelComparisons.createComparison(input);
  }

  public listModelComparisons(limit: number) {
    return this.modelComparisons.listComparisons(limit);
  }

  public getModelComparison(comparisonId: string) {
    return this.modelComparisons.getComparison(comparisonId);
  }

  public judgeModelComparison(comparisonId: string, input: ModelComparisonJudgeRequest) {
    return this.modelComparisons.addJudgment(comparisonId, input);
  }

  public startModelComparison(comparisonId: string) {
    return this.modelComparisons.startComparison(comparisonId);
  }

  public cancelModelComparison(comparisonId: string) {
    return this.modelComparisons.cancelComparison(comparisonId);
  }
}
