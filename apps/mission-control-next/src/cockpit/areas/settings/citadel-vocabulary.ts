import type {
  ChamberSensitivity,
  CitadelGatehouseSummary,
  CitadelKind,
  CitadelLifecycleStatus,
  CitadelModelPolicy,
  CitadelRiskPosture,
  MasonAnswers,
  WardEffect,
} from "@goatcitadel/contracts";

/**
 * Citadel charter, chamber and ward enums in plain words. Each table is keyed by its contract enum so a new value fails
 * typecheck until it has a label; a value the table does not know yet reads sentence-cased ("high_trust" → "High
 * trust") so the operator still sees what was recorded, and only a missing value reads "Unknown".
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

/** "someNewKey" / "high_trust" → "Some new key" / "High trust"; empty input reads as an empty string. */
function sentenceCase(value: string): string {
  const words = value
    .replace(/([a-z\d])([A-Z])/gu, "$1 $2")
    .replace(/[_.-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

function lookup<K extends string>(table: Record<K, string>, value: string | null | undefined): string {
  if (!value?.trim()) return "Unknown";
  return Object.hasOwn(table, value) ? table[value as K] : sentenceCase(value) || "Unknown";
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

/** Mason answer and charter field names in plain words; the answer form's own labels where it has them. */
export const MASON_ANSWER_LABELS: Record<keyof MasonAnswers, string> = {
  kind: "Kind",
  purpose: "Purpose",
  name: "Blueprint name",
  goals: "Goals",
  sensitiveAreas: "Sensitive areas",
  boundaries: "Boundaries",
  successDefinition: "What success looks like",
  riskPosture: "Risk setting",
  preferLocalForSensitive: "Prefer local AI for sensitive work",
};

/** "successDefinition" → "What success looks like"; an unknown key reads as a sentence ("someNewKey" → "Some new key"). */
export function presentMasonAnswerKey(key: string): string {
  if (Object.hasOwn(MASON_ANSWER_LABELS, key)) return MASON_ANSWER_LABELS[key as keyof MasonAnswers];
  return sentenceCase(key) || "Answer";
}

/** An answer's value in plain words: kinds and risk settings by label, lists joined, booleans as Yes or No. */
export function presentMasonAnswerValue(key: string, value: unknown): string {
  if (key === "kind") return presentCitadelKind(typeof value === "string" ? value : undefined);
  if (key === "riskPosture") return presentRiskPosture(typeof value === "string" ? value : undefined);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value))
    return (
      value
        .map(String)
        .filter((item) => item.trim())
        .join("; ") || "None specified"
    );
  if (value === undefined || value === null || value === "") return "None specified";
  return String(value);
}
