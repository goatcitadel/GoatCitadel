import type {
  PromptPackRecord,
  PromptPackSecurityEvalPackRecord,
  PromptPackSecurityQualityGateRecord,
} from "./prompt-pack.js";
import type { LlmEvalProofRunRecord } from "./llm.js";

export type OpsQualityAvailabilityState = "available" | "not_available" | "unknown";

export type OpsDesignQualitySeverity = "P0" | "P1" | "P2" | "P3";
export type OpsDesignQualityCheckStatus = "passing" | "advisory" | "blocking" | "unknown";

export interface OpsDesignQualityCheck {
  id: string;
  label: string;
  severity: OpsDesignQualitySeverity;
  status: OpsDesignQualityCheckStatus;
  owner: string;
  evidence: string;
  nextAction?: string;
}

export interface OpsDesignQualitySnapshot {
  state: OpsQualityAvailabilityState;
  posture: {
    readOnly: true;
    sideEffectPosture: "audit_only";
    source: "repo_files";
    callsProviders: false;
    mutationPerformed: false;
    note: string;
  };
  summary: {
    totalChecks: number;
    passingCount: number;
    advisoryCount: number;
    blockingCount: number;
    unknownCount: number;
    p0Count: number;
    p1Count: number;
    p2Count: number;
    p3Count: number;
  };
  checks: OpsDesignQualityCheck[];
  warnings: string[];
  error?: string;
}

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
    designQualityCheckCount: number;
    designQualityBlockingCount: number;
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
  designQuality: OpsDesignQualitySnapshot;
  warnings: string[];
  nextChecks: Array<{
    label: string;
    command: string;
    reason: string;
  }>;
}
