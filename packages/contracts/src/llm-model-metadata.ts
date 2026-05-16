export interface LlmModelMetadataEntry {
  contextWindow: number;
  outputTokenLimit: number;
  thinking?: "off" | "auto";
}

export interface LlmModelMetadataManifest {
  version: number;
  entries: Record<string, LlmModelMetadataEntry>;
}
