import type {MemoryClaim} from "./memory-claims.js";
/** Effective capabilities, never permission to promote memory or activate code. */
export interface BackgroundLearningDestination {
  state: "ready" | "disabled" | "blocked" | "unavailable";
  reasonCode?: string;
}
export interface BackgroundLearningReadiness {
  source: BackgroundLearningDestination;
  provider: BackgroundLearningDestination;
  budget: BackgroundLearningDestination;
  memory: BackgroundLearningDestination;
  skill: BackgroundLearningDestination;
  maintenance: BackgroundLearningDestination;
  canExtractMemory: boolean;
  canDraftSkill: boolean;
  canEvaluateMaintenance: boolean;
}

export interface LearningReviewSource {
  workspaceId: string;
  sessionId: string;
  sessionIncarnationId: string;
  controllerGeneration: number;
  parentRunId: string;
  postCommitGenerationId: string;
  sourceTurnId: string;
  effectExecutionId: string;
  sourceHash: string;
}

export interface LearningDispatchBudget {
  providerId:string;
  model:string;
  pricingCatalogVersion:string;
  pricingCatalogHash:string;
  /** Conservative estimate from the frozen catalog; never reported usage. */
  reservedCostUsd:number;
  dailyCostCeilingUsd:number;
}
export interface LearningReviewJob {
  version: 1;
  jobId: string;
  runId: string;
  workspaceId: string;
  sessionId: string;
  sessionIncarnationId: string;
  controllerGeneration: number;
  kind: "review" | "maintenance";
  /** Frozen requested destinations; legacy review jobs requested memory only. */
  destinations?:("memory"|"skill")[];
  status: "pending" | "running" | "deferred" | "delayed" | "awaiting_reconciliation" | "completed" | "cancelled";
  revision: number;
  sources: LearningReviewSource[];
  due: boolean;
  firstQueuedAt: string;
  frozenAt?: string;
  updatedAt: string;
  cursor: number;
  dispatchGeneration: number;
  operation?: {
    operationId: string;
    stage: "memory" | "skill";
    from: number;
    through: number;
    generation: number;
    status: "dispatching" | "settled" | "not_started" | "unknown";
    budget?:LearningDispatchBudget;
    budgetDay?:string;
    /** Proposal data only; never an automatic recall source. */
    result?: Record<string, unknown>;
  };
  candidateIds: string[];
  skillProposalIds: string[];
  completedStages: string[];
  sourceDispositions?: Array<{sourceIndex:number;sourceTurnId:string;sourceHash:string;reason:"source_changed"|"source_size_limit";recordedAt:string}>;
  discardedBatches?:Array<{from:number;through:number;operationId:string;reason:"source_batch_changed";recordedAt:string}>;
  stageResults?:Array<{stage:"memory"|"skill";from:number;through:number;candidateIds:string[];skillProposalIds:string[]}>;
  reasonCode?: string;
}
export interface LearningReviewClaim {
  runId: string;
  leaseOwnerId: string;
}
/** Review-only maintenance. Replacement targets are explicit and never inferred from prose. */
export interface GovernedMemoryMaintenancePlan {
  version:1;
  jobId:string;
  workspaceId:string;
  operation:"add"|"merge"|"supersede";
  sources:LearningReviewSource[];
  proposedInsight:string;
  claim?:MemoryClaim;
  /** One prior entry per atomic reviewed replacement. No implicit deletions. */
  targets:{learningId:string;sourceHash:string}[];
  clarificationRequired?:string;
}
