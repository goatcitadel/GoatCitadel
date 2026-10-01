export type PromptPackExportFormat = "goatcitadel" | "promptfoo";

export interface PromptPackExportRecord {
  packId: string;
  format?: PromptPackExportFormat;
  /** Stable current report path, kept for backward-compatible export consumers. */
  path: string;
  contentType?: "text/markdown" | "application/json";
  exists: boolean;
  sizeBytes: number;
  updatedAt?: string;
  latestPath?: string;
  archiveDir?: string;
  latestSnapshotPath?: string;
  latestSnapshotExists?: boolean;
  latestSnapshotSizeBytes?: number;
  latestSnapshotUpdatedAt?: string;
  snapshotCount?: number;
  interop?: {
    promptfoo?: {
      compatible: true;
      configVersion: "promptfoo.config.v1";
      promptCount: number;
      providerCount: number;
      testCount: number;
      assertionCount?: number;
      runRowCount?: number;
      traceLinkCount?: number;
      toolUseExpectationCount?: number;
      redactionPosture?: "redacted_export" | "source_defined" | "unknown";
      seededSampling?: {
        deterministic: boolean;
        seed?: string;
        sampleCount?: number;
      };
      goatcitadelProvenance?: {
        packId: string;
        exportEndpoint: string;
        importedMaterialCallable: false;
        sideEffectPosture: "export_only" | "preview_only";
      };
      notes: string[];
    };
  };
}

export interface PromptPackPromptfooImportPreviewResponse {
  valid: boolean;
  format: "promptfoo";
  generatedAt: string;
  testCount: number;
  promptCount: number;
  providerCount: number;
  reviewAssetCount?: number;
  reviewAssets?: Array<{
    source: "promptfoo_redteam" | "garak_probe_corpus";
    assetKind: "red_team_case" | "probe_payload";
    count: number;
    callable: false;
    activationRequired: true;
    note: string;
  }>;
  warnings: string[];
  errors: string[];
  posture: {
    readOnly: true;
    sideEffectPosture: "preview_only";
    callsProviders: false;
    mutationPerformed: false;
    note: string;
  };
}
