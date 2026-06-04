import type { TaskPriority, TaskRecord } from "./tasks.js";

export type ReviewReadinessLaneStatus = "missing" | "stale" | "current";

export interface ReviewReadinessLane {
  lane: string;
  status: ReviewReadinessLaneStatus;
  artifactRef?: string;
  lastRunAt?: string;
  rerunHint: string;
}

export interface ReviewReadinessSummary {
  branch: string;
  sha: string;
  generatedAt: string;
  lanes: ReviewReadinessLane[];
  openFindings: number;
  linkedTasks: TaskRecord[];
  releaseProof?: {
    sourceCertificate: "release-certificate.json";
    exactShaStatus: "exact" | "partial" | "missing" | "unknown";
    artifacts: Array<{
      name: string;
      platformArch: string;
      signatureStatus: "signed" | "unsigned" | "experimental";
      sha256: string;
      sizeBytes: number;
      sourceWorkflow: string;
      exactShaStatus: string;
      certificateInclusion: "included" | "missing";
      acceptedCaveats: string[];
    }>;
  };
}

export interface ReviewFindingInput {
  source: string;
  component: string;
  title: string;
  files: string[];
  priority?: TaskPriority;
  summary?: string;
  evidenceRef?: string;
}

export interface ReviewFindingImportResult {
  importedAt: string;
  created: TaskRecord[];
  updated: TaskRecord[];
  skipped: ReviewFindingInput[];
}
