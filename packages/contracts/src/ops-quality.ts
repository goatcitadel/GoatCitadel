import type {
  PromptPackRecord,
  PromptPackSecurityEvalPackRecord,
  PromptPackSecurityQualityGateRecord,
} from "./prompt-pack.js";
import type { LlmEvalProofRunRecord } from "./llm.js";

export type OpsQualityAvailabilityState = "available" | "not_available" | "unknown";

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
  warnings: string[];
  nextChecks: Array<{
    label: string;
    command: string;
    reason: string;
  }>;
}
