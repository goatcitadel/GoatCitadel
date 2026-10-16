import type { ModelComparisonExecutionService } from "./model-comparison-execution-service.js";
import type { ModelComparisonService } from "./model-comparison-service.js";

export interface ModelComparisonRoutePort {
  createComparison: ModelComparisonService["createComparison"];
  listComparisons: ModelComparisonService["listComparisons"];
  getComparison: ModelComparisonService["getComparison"];
  addJudgment: ModelComparisonService["addJudgment"];
  startComparison: ModelComparisonExecutionService["startComparison"];
  cancelComparison: ModelComparisonExecutionService["cancelComparison"];
}
