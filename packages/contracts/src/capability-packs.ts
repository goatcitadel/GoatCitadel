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
