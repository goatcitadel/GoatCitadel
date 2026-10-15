import type {
  ChamberSensitivity,
  CitadelGatehouseSummary,
  CitadelKind,
  CitadelLifecycleStatus,
  CitadelModelPolicy,
  CitadelRiskPosture,
  WardEffect,
} from "@goatcitadel/contracts";

/**
 * Citadel charter, chamber and ward enums in plain words. Each table is keyed by its contract enum so a new value fails
 * typecheck until it has a label; anything unexpected from the wire reads "Unknown" rather than the raw token.
 */
export const CITADEL_KIND_LABELS: Record<CitadelKind, string> = {
  personal: "Personal",
  company: "Company",
  project: "Project",
  household: "Household",
  client: "Client",
  creator: "Creator",
  learning: "Learning",
  team: "Team",
  custom: "Custom",
};
export const CHAMBER_SENSITIVITY_LABELS: Record<ChamberSensitivity, string> = {
  public: "Public",
  internal: "Internal",
  private: "Private",
  sensitive: "Sensitive",
  restricted: "Restricted",
  secret: "Secret",
};
export const CITADEL_RISK_POSTURE_LABELS: Record<CitadelRiskPosture, string> = {
  conservative: "Conservative",
  balanced: "Balanced",
  collaborative: "Collaborative",
  automation_forward: "Automation-forward",
};
export const CITADEL_MODEL_POLICY_LABELS: Record<CitadelModelPolicy, string> = {
  local_only: "Local models only",
  hybrid_guarded: "Local first, guarded cloud",
  approved_cloud: "Approved cloud models",
  hosted_team: "Hosted team models",
};
export const CITADEL_LIFECYCLE_LABELS: Record<CitadelLifecycleStatus, string> = {
  active: "Active",
  archived: "Archived",
};
export const WARD_EFFECT_LABELS: Record<WardEffect, string> = {
  allow: "Allow",
  deny: "Deny",
  require_approval: "Needs approval",
  require_dry_run: "Needs a dry run",
  redact: "Redact",
  route_local: "Keep on local models",
};
export const GATEHOUSE_SHARING_LABELS: Record<CitadelGatehouseSummary["sharingDefault"], string> = {
  private: "Private",
};
export const GATEHOUSE_EXTERNAL_WRITE_LABELS: Record<CitadelGatehouseSummary["externalWritesDefault"], string> = {
  approval_required: "Needs approval",
};

function lookup<K extends string>(table: Record<K, string>, value: string | null | undefined): string {
  return value && Object.hasOwn(table, value) ? table[value as K] : "Unknown";
}
export const presentCitadelKind = (value: string | null | undefined) => lookup(CITADEL_KIND_LABELS, value);
export const presentChamberSensitivity = (value: string | null | undefined) =>
  lookup(CHAMBER_SENSITIVITY_LABELS, value);
export const presentRiskPosture = (value: string | null | undefined) => lookup(CITADEL_RISK_POSTURE_LABELS, value);
export const presentModelPolicy = (value: string | null | undefined) => lookup(CITADEL_MODEL_POLICY_LABELS, value);
export const presentCitadelLifecycle = (value: string | null | undefined) => lookup(CITADEL_LIFECYCLE_LABELS, value);
export const presentWardEffect = (value: string | null | undefined) => lookup(WARD_EFFECT_LABELS, value);
export const presentGatehouseSharing = (value: string | null | undefined) => lookup(GATEHOUSE_SHARING_LABELS, value);
export const presentGatehouseExternalWrites = (value: string | null | undefined) =>
  lookup(GATEHOUSE_EXTERNAL_WRITE_LABELS, value);
