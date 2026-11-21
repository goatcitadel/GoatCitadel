import type { TraceMemoryCandidateRecord } from "./memory.js";
export interface LearningUseLink {
  kind: "memory" | "skill";
  ref: string;
  sourceHash: string;
  state: "used_in_turn";
  href: string;
}
export interface LearningAppliedLink {
  kind: "memory" | "skill";
  ref: string;
  state: "saved_not_ready" | "recall_ready" | "superseded" | "forgotten" | "revoked" | "awaiting_apply" | "unknown";
  href: string;
  sourceHash?: string;
}
export type LearningProposalLink =
  | { kind: "memory"; candidate: TraceMemoryCandidateRecord; href: string }
  | {
      kind: "skill";
      proposalId: string;
      candidateId: string;
      versionId?: string;
      sourceHash?: string;
      state: string;
      href: string;
    };
export interface TurnLearningReceipt {
  version: 1;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  proposals: LearningProposalLink[];
  applied: LearningAppliedLink[];
  usedSources: LearningUseLink[];
  jobs: { jobId: string; state: string; reason?: string; href: string }[];
  warnings: string[];
  truncated: boolean;
}
