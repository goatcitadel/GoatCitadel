import type { A2UICapability, A2UIContractId } from "./a2ui.js";

export type CompanionContractId = "companion.android.v1";

export type CompanionPrimaryTarget = "android";

export type CompanionBootstrapStatus = "docs_first" | "server_foundation";

export type CompanionRepoStrategy = "separate_repo";

export type CompanionTransportLane = "foreground_sse" | "push_refresh" | "manual_refresh";

export type CompanionAuthRequirement =
  | "device_identity"
  | "short_lived_access_token"
  | "rotating_refresh_token"
  | "request_signing"
  | "replay_protection";

export type CompanionServerPrerequisite =
  | "device_pairing"
  | "token_rotation"
  | "request_signing"
  | "sse_resume"
  | "per_device_audit";

export type CompanionBootstrapFeature =
  | "dashboard"
  | "chat"
  | "approvals"
  | "tasks"
  | "settings"
  | "event_feed";

export interface CompanionContract {
  contractId: CompanionContractId;
  label: string;
  pairedSurfaceContractId: A2UIContractId;
  primaryTarget: CompanionPrimaryTarget;
  bootstrapStatus: CompanionBootstrapStatus;
  repoStrategy: CompanionRepoStrategy;
  bootstrapRepo: string;
  targetCatalogIds: string[];
  deviceCapabilities: A2UICapability[];
  transportLanes: CompanionTransportLane[];
  authRequirements: CompanionAuthRequirement[];
  serverPrerequisites: CompanionServerPrerequisite[];
  bootstrapFeatures: CompanionBootstrapFeature[];
  notes: string[];
}
