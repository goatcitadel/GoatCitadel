export type LlmModelLifecycleStatus = "available" | "experimental" | "deprecated" | "retired";

export interface LlmModelMetadataEntry {
  contextWindow: number;
  outputTokenLimit: number;
  thinking?: "off" | "auto";
  /** Lifecycle status of the model. Absent implies "available". */
  status?: LlmModelLifecycleStatus;
  /** ISO date (YYYY-MM-DD) the model is scheduled to retire, when known. */
  retiresOn?: string;
}

export interface LlmModelMetadataManifest {
  version: number;
  entries: Record<string, LlmModelMetadataEntry>;
}
