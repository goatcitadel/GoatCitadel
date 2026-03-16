export const ASSEMBLY_DOMAIN_PRESETS = [
  "coding",
  "architecture",
  "writing",
  "seo",
  "analysis",
  "strategy",
] as const;

export type AssemblyDomainPreset = (typeof ASSEMBLY_DOMAIN_PRESETS)[number];

export const ASSEMBLY_MODES = [
  "consensus",
  "debate",
  "critique",
  "brainstorm",
] as const;

export type AssemblyMode = (typeof ASSEMBLY_MODES)[number];

export const ASSEMBLY_RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "stopped",
] as const;

export type AssemblyRunStatus = (typeof ASSEMBLY_RUN_STATUSES)[number];

export const ASSEMBLY_STAGES = [
  "A0_normalize",
  "A1_submit",
  "A2_blind_review",
  "A3_adversarial_challenge",
  "A4_defense_and_revision",
  "A5_convergence",
  "A6_synthesis",
  "S0_normalize",
  "S1_submit",
  "S2_blind_review",
  "S3_revise",
  "S4_convergence",
  "S5_synthesis",
  "completed",
] as const;

export type AssemblyStage = (typeof ASSEMBLY_STAGES)[number];

export const ASSEMBLY_ARTIFACT_TYPES = [
  "problem",
  "proposal",
  "peer_review",
  "adversarial_review",
  "defense_response",
  "convergence_score",
  "result",
] as const;

export type AssemblyArtifactType = (typeof ASSEMBLY_ARTIFACT_TYPES)[number];

export const ASSEMBLY_REVIEW_VERDICTS = [
  "accept",
  "reject",
  "revise",
  "merge",
] as const;

export type AssemblyReviewVerdict = (typeof ASSEMBLY_REVIEW_VERDICTS)[number];

export const ASSEMBLY_ADVERSARIAL_OBJECTION_CLASSES = [
  "critical_flaw",
  "moderate_risk",
  "edge_case_concern",
  "speculative_concern",
] as const;

export type AssemblyAdversarialObjectionClass =
  (typeof ASSEMBLY_ADVERSARIAL_OBJECTION_CLASSES)[number];

export const ASSEMBLY_ADVERSARIAL_STRICTNESS_LEVELS = [
  "light",
  "balanced",
  "aggressive",
] as const;

export type AssemblyAdversarialStrictness =
  (typeof ASSEMBLY_ADVERSARIAL_STRICTNESS_LEVELS)[number];

export const ASSEMBLY_ADVERSARIAL_SELECTION_STRATEGIES = [
  "user_selected",
  "auto_selected_by_reputation",
  "rotate_among_participants",
] as const;

export type AssemblyAdversarialSelectionStrategy =
  (typeof ASSEMBLY_ADVERSARIAL_SELECTION_STRATEGIES)[number];

export const ASSEMBLY_EXPORT_TARGETS = [
  "artifact",
  "chat",
  "task",
] as const;

export type AssemblyExportTarget = (typeof ASSEMBLY_EXPORT_TARGETS)[number];

export interface AssemblyParticipantModel {
  participantId: string;
  providerId: string;
  model: string;
  label?: string;
}

export interface AssemblyContextRef {
  kind: "session" | "task" | "file" | "url" | "note";
  ref: string;
  label?: string;
}

export interface AssemblyEvidenceItem {
  evidenceId: string;
  label: string;
  detail: string;
  kind?: "source" | "code" | "benchmark" | "claim" | "experience";
  sourceUrl?: string;
  confidence?: number;
}

export interface AssemblyTestPlanItem {
  testId: string;
  title: string;
  detail: string;
  kind?: "unit" | "integration" | "manual" | "experiment" | "review";
}

export interface AssemblyProblem {
  runId: string;
  domain: AssemblyDomainPreset;
  title: string;
  originalPrompt: string;
  normalizedStatement: string;
  objectives: string[];
  constraints: string[];
  evaluationCriteria: string[];
  contextRefs: AssemblyContextRef[];
  createdAt: string;
}

export interface AssemblySettings {
  mode: AssemblyMode;
  participantModels: AssemblyParticipantModel[];
  maxRounds: number;
  maxCritiquePasses: number;
  maxInterModelExchanges: number;
  convergenceThreshold: number;
  stagnationWindow: number;
  timeBudgetMs: number;
  tokenBudget: number;
  costBudgetUsd: number;
  domainPreset: AssemblyDomainPreset;
  synthesisStyle: "concise" | "balanced" | "detailed";
  exportTargets: AssemblyExportTarget[];
}

export interface AdversarialSettings {
  enabled: boolean;
  reviewerCount: number;
  selectionStrategy: AssemblyAdversarialSelectionStrategy;
  strictness: AssemblyAdversarialStrictness;
  requireMitigations: boolean;
  requireEvidenceTags: boolean;
  defenseRoundEnabled: boolean;
  repetitiveObjectionCutoff: boolean;
  minorityReportRequired: boolean;
  reviewerModelRefs?: string[];
}

export interface AssemblyUsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs?: number;
}

export interface ModelProposal {
  runId: string;
  roundIndex: number;
  proposalId: string;
  authorModelRef: string;
  blindedAuthorToken: string;
  abstract: string;
  diagnosis: string;
  proposedSolution: string;
  reasoning: string;
  risks: string[];
  assumptions: string[];
  confidence: number;
  evidence: AssemblyEvidenceItem[];
  testPlan: AssemblyTestPlanItem[];
  schemaVersion: number;
  usage?: AssemblyUsageSummary;
  createdAt: string;
  updatedAt: string;
}

export interface AssemblyReviewScores {
  correctness: number;
  reasoningStrength: number;
  practicality: number;
  evidenceQuality: number;
  riskAwareness: number;
  testability: number;
  clarity: number;
}

export interface PeerReview {
  runId: string;
  roundIndex: number;
  reviewId: string;
  proposalId: string;
  blindedReviewerToken: string;
  strengths: string[];
  weaknesses: string[];
  missingAssumptions: string[];
  failureScenarios: string[];
  scores: AssemblyReviewScores;
  verdict: AssemblyReviewVerdict;
  mergeTargetProposalId?: string;
  confidence: number;
  createdAt: string;
}

export interface AssemblyAdversarialObjection {
  objectionId: string;
  title: string;
  detail: string;
  classification: AssemblyAdversarialObjectionClass;
  evidenceBasis: "evidence_based" | "speculative";
  mitigation?: string;
  predictedImpact?: string;
}

export interface AdversarialReview {
  runId: string;
  roundIndex: number;
  reviewId: string;
  proposalId: string;
  blindedReviewerToken: string;
  strengthsFirst: string[];
  objections: AssemblyAdversarialObjection[];
  overallAssessment: string;
  usefulnessPending: boolean;
  createdAt: string;
}

export interface DefenseResponse {
  runId: string;
  roundIndex: number;
  responseId: string;
  proposalId: string;
  challengedReviewIds: string[];
  acceptedPoints: string[];
  rejectedPoints: string[];
  revisionsMade: string[];
  unresolvedDisputes: string[];
  updatedConfidence: number;
  createdAt: string;
}

export interface ConvergenceDimensionScores {
  rootCause: number;
  solutionDesign: number;
  riskAnalysis: number;
  implementationScope: number;
  evidenceStrength: number;
  confidenceStability: number;
  testPlanAlignment: number;
}

export interface AssemblyDisagreementCluster {
  clusterId: string;
  topic: string;
  proposalIds: string[];
  severity: "low" | "medium" | "high";
  summary: string;
}

export interface ConvergenceScore {
  runId: string;
  roundIndex: number;
  dimensionScores: ConvergenceDimensionScores;
  proposalSupportScores: Record<string, number>;
  compositeScore: number;
  stagnationDelta: number;
  disagreementClusters: AssemblyDisagreementCluster[];
  minorityFlags: string[];
  createdAt: string;
}

export interface AssemblyStopCheck {
  shouldStop: boolean;
  reason?:
    | "converged"
    | "stagnated"
    | "budget_exceeded"
    | "max_rounds"
    | "max_critique_passes"
    | "max_inter_model_exchanges"
    | "repetitive_objections";
  details?: string;
}

export interface AssemblyRound {
  roundId: string;
  runId: string;
  roundIndex: number;
  stage: AssemblyStage;
  status: "queued" | "running" | "completed" | "failed" | "skipped";
  participantIds: string[];
  artifactIds: string[];
  convergenceSnapshot?: ConvergenceScore;
  stopCheck?: AssemblyStopCheck;
  startedAt: string;
  finishedAt?: string;
}

export interface AssemblyMinorityReport {
  summary: string;
  proposalIds: string[];
  reasons: string[];
}

export interface AssemblyContributionSummaryItem {
  modelRef: string;
  contributionRole: "proposal" | "review" | "adversary" | "synthesis";
  summary: string;
}

export interface AssemblyResultExportRecord {
  target: AssemblyExportTarget;
  status: "available" | "generated" | "failed" | "not_requested";
  relPath?: string;
  detail?: string;
}

export interface AssemblyResult {
  runId: string;
  recommendation: string;
  disagreements: AssemblyDisagreementCluster[];
  riskAnalysis: string[];
  implementationPlan: string[];
  minorityReport?: AssemblyMinorityReport;
  modelContributionSummary: AssemblyContributionSummaryItem[];
  exports: AssemblyResultExportRecord[];
  finalUsage?: AssemblyUsageSummary;
  createdAt: string;
}

export interface ModelReputationDomainScore {
  accuracy: number;
  reasoningStrength: number;
  critiqueQuality: number;
  consensusLeadership: number;
  stability: number;
  adversarialUsefulness: number;
  sampleCount: number;
}

export interface ModelReputation {
  modelRef: string;
  providerId: string;
  modelId: string;
  overall: number;
  byDomain: Partial<Record<AssemblyDomainPreset, ModelReputationDomainScore>>;
  accuracy: number;
  reasoningStrength: number;
  critiqueQuality: number;
  consensusLeadership: number;
  stability: number;
  adversarialUsefulness: number;
  sampleCount: number;
  updatedAt: string;
}

export interface AssemblyRunRecord {
  runId: string;
  workspaceId?: string;
  sourceSessionId?: string;
  sourceTaskId?: string;
  title: string;
  status: AssemblyRunStatus;
  currentStage: AssemblyStage;
  currentRoundIndex: number;
  problem: AssemblyProblem;
  settings: AssemblySettings;
  adversarialSettings: AdversarialSettings;
  result?: AssemblyResult;
  stopReason?: string;
  usage?: AssemblyUsageSummary;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

export interface AssemblyArtifactRecord {
  artifactId: string;
  runId: string;
  roundIndex: number;
  stage: AssemblyStage;
  artifactType: AssemblyArtifactType;
  participantModelRef?: string;
  blindedAuthorToken?: string;
  payload:
    | AssemblyProblem
    | ModelProposal
    | PeerReview
    | AdversarialReview
    | DefenseResponse
    | ConvergenceScore
    | AssemblyResult;
  createdAt: string;
}

export interface CreateAssemblyRunInput {
  workspaceId?: string;
  sourceSessionId?: string;
  sourceTaskId?: string;
  title?: string;
  prompt: string;
  contextRefs?: AssemblyContextRef[];
  settings: AssemblySettings;
  adversarialSettings?: AdversarialSettings;
}

export interface AssemblyRunDetailResponse {
  run: AssemblyRunRecord;
  rounds: AssemblyRound[];
  artifacts: AssemblyArtifactRecord[];
}
