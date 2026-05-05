import type { CapabilityProposalRecord } from "./capabilities.js";
import type { ImprovementCandidateRecord, ImprovementSignalRecord } from "./improvement.js";

export type SkillEvaluationRunStatus = "preview" | "completed" | "proposal_created" | "rejected";

export interface SkillEvaluationScenario {
  scenarioId: string;
  title: string;
  prompt: string;
  expectedOutcome: string;
  tags?: string[];
}

export interface SkillEvaluationScenarioDraft {
  scenarioId?: string;
  title: string;
  prompt: string;
  expectedOutcome: string;
  tags?: string[];
}

export interface SkillEvaluationCriterion {
  criterionId: string;
  label: string;
  description: string;
  requiredTerms?: string[];
}

export interface SkillEvaluationCriterionDraft {
  criterionId?: string;
  label: string;
  description: string;
  requiredTerms?: string[];
}

export interface SkillEvaluationCriterionResult {
  criterionId: string;
  passed: boolean;
  rationale: string;
}

export interface SkillEvaluationScenarioResult {
  scenarioId: string;
  passed: boolean;
  passRate: number;
  outputPreview: string;
  criteria: SkillEvaluationCriterionResult[];
}

export interface SkillEvaluationScoreBreakdown {
  total: number;
  passed: number;
  passRate: number;
}

export interface SkillEvaluationRoundResult {
  score: SkillEvaluationScoreBreakdown;
  scenarioResults: SkillEvaluationScenarioResult[];
  instructionHash: string;
}

export interface SkillEvaluationMutationSummary {
  summary: string;
  patchPreview: string;
  beforeInstructionBody: string;
  afterInstructionBody: string;
  changedSections: string[];
  missingCoverageTerms: string[];
}

export interface SkillEvaluationOperatorTruth {
  executesScripts: false;
  writesSkillFile: false;
  proposalOnly: true;
}

export interface SkillEvaluationRunRecord {
  runId: string;
  skillId: string;
  skillName: string;
  status: SkillEvaluationRunStatus;
  createdAt: string;
  updatedAt: string;
  scenarios: SkillEvaluationScenario[];
  criteria: SkillEvaluationCriterion[];
  baselineResult: SkillEvaluationRoundResult;
  candidateResult?: SkillEvaluationRoundResult;
  mutation?: SkillEvaluationMutationSummary;
  accepted: boolean;
  improvementDelta: number;
  targetPassRate: number;
  maxRounds: number;
  proposalId?: string;
  improvementCandidateId?: string;
  ledgerSignalId?: string;
  warnings: string[];
  operatorTruth: SkillEvaluationOperatorTruth;
}

export interface SkillEvaluationPreviewRequest {
  scenarios?: SkillEvaluationScenarioDraft[];
  criteria?: SkillEvaluationCriterionDraft[];
  maxRounds?: number;
  targetPassRate?: number;
}

export type SkillEvaluationRunRequest = SkillEvaluationPreviewRequest;

export interface SkillEvaluationPreviewResponse {
  run: SkillEvaluationRunRecord;
}

export interface SkillEvaluationRunResponse {
  run: SkillEvaluationRunRecord;
  improvementSignal?: ImprovementSignalRecord;
  improvementCandidate?: ImprovementCandidateRecord;
}

export interface SkillEvaluationListResponse {
  items: SkillEvaluationRunRecord[];
}

export interface SkillEvaluationProposalResponse {
  run: SkillEvaluationRunRecord;
  proposal: CapabilityProposalRecord;
}
