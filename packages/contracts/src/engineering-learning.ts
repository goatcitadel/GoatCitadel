export type EngineeringLearningStatus = "proposed" | "active" | "stale" | "superseded" | "rejected" | "archived";

export interface EngineeringLearningSource {
  sessionId?: string;
  turnId?: string;
  runId: string;
  patchArtifactId?: string;
  commitSha?: string;
}

export interface EngineeringLearningFileEvidence {
  path: string;
  sha256: string;
}

export interface EngineeringLearningRecord {
  learningId: string;
  workspaceId: string;
  projectId?: string;
  status: EngineeringLearningStatus;
  title: string;
  problem: string;
  rootCause: string;
  resolution: string;
  prevention: string;
  failedAttempts: string[];
  applicablePaths: string[];
  source: EngineeringLearningSource;
  fileEvidence: EngineeringLearningFileEvidence[];
  verificationEvidence: string[];
  provenanceHash: string;
  supersedesLearningId?: string;
  staleReasons?: string[];
  createdAt: string;
  updatedAt: string;
}

export type EngineeringLearningAction = "activate" | "update" | "consolidate" | "replace" | "reject" | "archive";

export interface EngineeringLearningListResponse {
  items: EngineeringLearningRecord[];
}

export interface EngineeringLearningProposalRequest {
  workspaceId: string;
  projectId?: string;
  source: EngineeringLearningSource;
  disposition: "completed";
  changedFiles: string[];
  verificationEvidence: string[];
  failedClaimVerification?: boolean;
  title: string;
  problem: string;
  rootCause: string;
  resolution: string;
  prevention: string;
  failedAttempts?: string[];
  applicablePaths?: string[];
}
