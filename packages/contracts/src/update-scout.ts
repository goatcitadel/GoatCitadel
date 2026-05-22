export interface UpdateScoutSource {
  sourceRef: string;
  sourceType?: "skill" | "package" | "repo" | "url";
  currentVersion?: string;
}

export interface UpdateScoutRequest {
  sources: UpdateScoutSource[];
  workspaceId?: string;
  createImprovementCandidate?: boolean;
}

export interface UpdateScoutReportItem {
  sourceRef: string;
  sourceType: NonNullable<UpdateScoutSource["sourceType"]>;
  currentVersion?: string;
  latestVersion?: string;
  releaseNotesUrl?: string;
  compatibilityNotes: string[];
  risk: "low" | "medium" | "high" | "unknown";
  recommendedProofLanes: string[];
  improvementCandidateId?: string;
  status: "review_ready" | "degraded" | "unsupported";
  message?: string;
}

export interface UpdateScoutReport {
  generatedAt: string;
  workspaceId: string;
  appliedUpdates: false;
  items: UpdateScoutReportItem[];
  warnings: string[];
}
