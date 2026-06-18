export type ChangeRiskLevel = "safe" | "warning" | "critical";

export interface ChangeRiskInputItem {
  field: string;
  from: unknown;
  to: unknown;
}

export interface ChangeRiskEvaluationRequest {
  pageId: string;
  changes: ChangeRiskInputItem[];
}

export interface ChangeRiskEvaluationItem {
  field: string;
  level: ChangeRiskLevel;
  reasonCodes: string[];
  hint?: string;
}

export interface ChangeRiskEvaluationResponse {
  pageId: string;
  overall: ChangeRiskLevel;
  items: ChangeRiskEvaluationItem[];
}
