export type CapabilityPackTrustTier = "trusted" | "restricted" | "community";
export type CapabilityPackAssetKind = "skill" | "addon" | "mcp_template" | "plugin" | "runtime_preset";
export type CapabilityPackInstallMode = "enabled" | "disabled" | "review_required" | "unsupported";

export interface CapabilityPackAsset {
  kind: CapabilityPackAssetKind;
  id: string;
  label: string;
  description?: string;
  runtimeSupport: "available" | "requires_configuration" | "unsupported";
  installMode: CapabilityPackInstallMode;
  warnings?: string[];
}

export interface CapabilityPackPolicyDefaults {
  requireFirstUseApproval: boolean;
  memoryWriteAuthority: "trusted_lifecycle_only" | "agent_proposals" | "operator_controlled";
  redactionMode: "none" | "basic" | "strict";
  autoRunEnabled: boolean;
}

export interface CapabilityPackProvenance {
  source: "bundled" | "local_file";
  publisher: string;
  reference?: string;
  contentHash?: string;
}

export interface CapabilityPackManifest {
  packId: string;
  name: string;
  description: string;
  version: string;
  trustTier: CapabilityPackTrustTier;
  tags: string[];
  assets: CapabilityPackAsset[];
  policyDefaults: CapabilityPackPolicyDefaults;
  provenance: CapabilityPackProvenance;
  installWarnings: string[];
}

export interface CapabilityPackPreview {
  manifest: CapabilityPackManifest;
  unsupportedAssets: CapabilityPackAsset[];
  installPlan: Array<{
    assetId: string;
    kind: CapabilityPackAssetKind;
    outcome: CapabilityPackInstallMode;
    reason: string;
  }>;
  policyChanges: CapabilityPackPolicyDefaults;
  reviewRequired: boolean;
}

export interface CapabilityPackInstallResult {
  packId: string;
  installedAt: string;
  actorId: string;
  preview: CapabilityPackPreview;
  stagedAssets: CapabilityPackPreview["installPlan"];
  evidenceEnvelopeId?: string;
}

export type CapabilityPackLifecycleStatus = "staged_for_review";
export type CapabilityPackMaterializationStatus = "materialization_recorded";
export type CapabilityPackMaterializedAssetOutcome = "evidence_recorded" | "review_recorded" | "blocked" | "skipped";
export type CapabilityPackMaterializedAssetActivationSemantics =
  | "evidence_only"
  | "requires_existing_surface"
  | "blocked"
  | "none";

export interface CapabilityPackMaterializeRequest {
  actorId?: string;
  confirmReview: boolean;
  assetIds?: string[];
  note?: string;
}

export interface CapabilityPackMaterializedAsset {
  assetId: string;
  kind: CapabilityPackAssetKind;
  requested: boolean;
  outcome: CapabilityPackMaterializedAssetOutcome;
  reason: string;
  callableState: "unchanged";
  activationSemantics: CapabilityPackMaterializedAssetActivationSemantics;
}

export interface CapabilityPackMaterializationSummary {
  evidenceEnvelopeId?: string;
  materializedAt: string;
  actorId: string;
  status: CapabilityPackMaterializationStatus;
  assetCount: number;
}

export interface CapabilityPackMaterializeResult {
  packId: string;
  actorId: string;
  materializedAt: string;
  status: CapabilityPackMaterializationStatus;
  sourceEvidenceEnvelopeId: string;
  evidenceEnvelopeId?: string;
  assets: CapabilityPackMaterializedAsset[];
  limitations: string[];
}

export interface CapabilityPackStagedRecord {
  packId: string;
  name: string;
  version: string;
  trustTier: CapabilityPackTrustTier;
  source: CapabilityPackProvenance["source"];
  actorId: string;
  stagedAt: string;
  status: CapabilityPackLifecycleStatus;
  reviewRequired: boolean;
  stagedAssets: CapabilityPackPreview["installPlan"];
  evidenceEnvelopeId?: string;
  contentHash?: string;
  latestMaterialization?: CapabilityPackMaterializationSummary;
}

export interface CapabilityPackStagedResponse {
  items: CapabilityPackStagedRecord[];
}

export interface CapabilityPackExportResponse {
  exportedAt: string;
  readOnly: true;
  mutationSemantics: "none";
  manifest: CapabilityPackManifest;
  staged?: CapabilityPackStagedRecord;
  evidence: {
    source: "bundled_catalog" | "staged_evidence";
    evidenceEnvelopeId?: string;
    contentHash?: string;
  };
  limitations: string[];
}
