export type ModelComparisonStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface ModelComparisonCandidate {
  candidateId: string;
  providerId: string;
  model: string;
  blindLabel: string;
}

export interface ModelComparisonPromptResult {
  resultId: string;
  testId: string;
  candidateId: string;
  runId?: string;
  responseText?: string;
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
  error?: string;
}

export interface ModelComparisonJudgment {
  judgmentId: string;
  testId: string;
  winnerCandidateId?: string;
  scores: Array<{
    candidateId: string;
    quality: 0 | 1 | 2 | 3 | 4;
    honesty?: 0 | 1 | 2 | 3 | 4;
    usefulness?: 0 | 1 | 2 | 3 | 4;
  }>;
  notes?: string;
  reviewerId?: string;
  createdAt: string;
}

export type ModelComparisonAdvisoryNextAction =
  | "run_prompt_pack"
  | "review_outputs"
  | "save_judgment"
  | "ready_for_synthesis";

export interface ModelComparisonAdvisorySummary {
  posture: "advisory_only";
  label: string;
  summary: string;
  executionStyle: "single_turn_harness";
  candidateCount: number;
  testCount: number;
  resultCount: number;
  responseCount: number;
  missingResultCount: number;
  judgmentCount: number;
  recommendedNextAction: ModelComparisonAdvisoryNextAction;
  safetyNotes: string[];
}

export interface ModelComparisonRun {
  comparisonId: string;
  packId: string;
  status: ModelComparisonStatus;
  title: string;
  candidates: ModelComparisonCandidate[];
  testIds: string[];
  results: ModelComparisonPromptResult[];
  judgments: ModelComparisonJudgment[];
  advisory?: ModelComparisonAdvisorySummary;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
}

export interface ModelComparisonCreateRequest {
  packId: string;
  title?: string;
  testIds?: string[];
  allTests?: boolean;
  candidates: Array<{
    providerId: string;
    model: string;
  }>;
  executionStyle?: "single_turn_harness" | "agentic_surface";
}

export interface ModelComparisonJudgeRequest {
  testId: string;
  winnerCandidateId?: string;
  scores: ModelComparisonJudgment["scores"];
  notes?: string;
  reviewerId?: string;
}
