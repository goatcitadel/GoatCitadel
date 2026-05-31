import type {
  PromptPackRecord,
  PromptPackSecurityEvalPackRecord,
  PromptPackSecurityQualityGateRecord,
} from "./prompt-pack.js";
import type { LlmEvalProofRunRecord } from "./llm.js";

export type OpsQualityAvailabilityState = "available" | "not_available" | "unknown";

export type OpsQualitySecurityExecutionState =
  | "definition_missing"
  | "definition_only"
  | "run_required"
  | "scoring_required"
  | "review_required"
  | "failing"
  | "passing"
  | "unknown";

export interface OpsQualitySecurityExecutionItem {
  packKey: string;
  title: string;
  state: OpsQualitySecurityExecutionState;
  importedPackId?: string;
  testCount: number;
  completedRuns: number;
  failedRuns: number;
  needsScoreCount: number;
  passCount: number;
  failCount: number;
  reviewCount: number;
  runCoverage: number;
  scoredCoverage: number;
  effectivePassRate: number;
  passThreshold: number;
  modeCounts: PromptPackSecurityEvalPackRecord["modeCounts"];
  toolTierCounts: PromptPackSecurityEvalPackRecord["toolTierCounts"];
  capabilityTargets: string[];
  likelyFailureClasses: string[];
  failingCodes: string[];
  blockers: string[];
  nextActions: string[];
  posture: {
    readOnly: true;
    sideEffectPosture: "audit_only";
    source: "stored_prompt_pack_report";
    callsProviders: false;
    mutationPerformed: false;
    note: string;
  };
}

export interface OpsQualitySnapshotResponse {
  version: "ops.quality_snapshot.v1";
  generatedAt: string;
  sourceEndpoint: "/api/v1/ops/quality";
  posture: {
    readOnly: true;
    sideEffectPosture: "audit_only";
    note: string;
  };
  metricScope: {
    scope: "bounded_read";
    promptPackLimit: number;
    evalRunLimit: number;
    note: string;
  };
  metrics: {
    promptPackCount: number;
    promptPackTestCount: number;
    redTeamPackCount: number;
    redTeamTestCount: number;
    evalRunCount: number;
    paretoModelCount: number;
    securityGateCount: number;
    passingSecurityGateCount: number;
    securityExecutionReadyCount: number;
    securityExecutionBlockedCount: number;
  };
  promptPacks: {
    state: OpsQualityAvailabilityState;
    items: PromptPackRecord[];
    error?: string;
  };
  evalProof: {
    state: OpsQualityAvailabilityState;
    items: LlmEvalProofRunRecord[];
    error?: string;
  };
  securityEvalPacks: {
    state: OpsQualityAvailabilityState;
    items: PromptPackSecurityEvalPackRecord[];
    warnings: string[];
    error?: string;
  };
  securityQualityGates: {
    state: OpsQualityAvailabilityState;
    items: PromptPackSecurityQualityGateRecord[];
    warnings: string[];
    error?: string;
  };
  securityExecution: {
    state: OpsQualityAvailabilityState;
    items: OpsQualitySecurityExecutionItem[];
    warnings: string[];
    error?: string;
  };
  warnings: string[];
  nextChecks: Array<{
    label: string;
    command: string;
    reason: string;
  }>;
}
