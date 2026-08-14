import type { IntegrationCatalogEntry, IntegrationConnection } from "./integrations.js";
import type { ChannelProbeReport } from "./channel-probes.js";

export type ChannelArchetype =
  | "local_surface"
  | "webhook_destination"
  | "bot_token_target"
  | "workspace_server_token"
  | "oauth_install"
  | "bridge_dependent"
  | "platform_api_resource_ids";

export type ChannelSetupTier = "tier_1" | "tier_2" | "tier_3" | "tier_4";

export type ChannelSetupLifecycleMode = "create" | "edit" | "repair" | "rotate_secret" | "retest";

export type ChannelSetupManualModePolicy = "hidden-until-needed" | "available-secondary" | "expert-forward";

export type ChannelSetupValidationLevel =
  | "structural"
  | "semantic"
  | "live-auth"
  | "live-send"
  | "bridge-health"
  | "manual-confirm";

export type ChannelSetupDifficulty = "beginner" | "intermediate" | "advanced";
export type ChannelSetupStatus = "idle" | "ok" | "warn" | "error";
export type ChannelSetupNoticeTone = "info" | "success" | "warning" | "critical";
export type ChannelSetupFailureCategory =
  | "missing_input"
  | "malformed_value"
  | "credential_rejected"
  | "permission_mismatch"
  | "destination_mismatch"
  | "platform_unavailable"
  | "bridge_unavailable"
  | "deprecated_path"
  | "unknown";

export type ChannelSetupHydrationStatus = "clean" | "partial" | "opaque-secret" | "legacy-shape" | "invalid-runtime";

export type ChannelSetupStepKind =
  | "intro"
  | "prerequisites"
  | "instruction"
  | "decision"
  | "field-collection"
  | "review"
  | "test"
  | "confirm";

export type ChannelSetupFieldType = "text" | "secret" | "url" | "id" | "select" | "boolean" | "textarea";

export type ChannelSetupRichBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[]; ordered?: boolean }
  | { kind: "note"; tone: ChannelSetupNoticeTone; title?: string; text: string }
  | { kind: "link"; label: string; href: string; external?: boolean }
  | { kind: "code"; code: string; language?: string };

export interface ChannelSetupFieldOption {
  value: string;
  label: string;
  hint?: string;
}

export interface ChannelSetupFieldDefinition {
  key: string;
  label: string;
  type: ChannelSetupFieldType;
  required: boolean;
  defaultValue?: string | boolean;
  explanation: string;
  whyNeeded?: string;
  whereToFind?: ChannelSetupRichBlock[];
  looksLike?: string;
  commonMistakes?: string[];
  sensitive?: boolean;
  canChangeLater?: boolean;
  placeholder?: string;
  options?: ChannelSetupFieldOption[];
}

export interface ChannelSetupChecklistItem {
  id: string;
  label: string;
  detail?: string;
}

export interface ChannelSetupTroubleshootingItem {
  id: string;
  title: string;
  body: string;
  failureCategory?: ChannelSetupFailureCategory;
  nextSteps?: string[];
}

export interface ChannelSetupStepDefinition {
  id: string;
  kind: ChannelSetupStepKind;
  title: string;
  description?: string;
  body?: ChannelSetupRichBlock[];
  fields?: ChannelSetupFieldDefinition[];
  checklist?: ChannelSetupChecklistItem[];
  troubleshooting?: ChannelSetupTroubleshootingItem[];
  successCriteria?: string[];
  visibleWhenFieldEquals?: {
    fieldKey: string;
    value: string | boolean;
  };
}

export interface ChannelSetupWizardContent {
  archetype: ChannelArchetype;
  contentVersion: string;
  estimatedMinutes: number;
  difficulty: ChannelSetupDifficulty;
  manualModePolicy: ChannelSetupManualModePolicy;
  introSummary: string;
  prerequisites: string[];
  steps: ChannelSetupStepDefinition[];
}

export interface ChannelSetupValidationStrategy {
  validationVersion: string;
  levels: ChannelSetupValidationLevel[];
}

export interface ChannelSetupTestStrategy {
  testVersion: string;
  levels: ChannelSetupValidationLevel[];
  safePreFinalize: boolean;
  supportsManualConfirmation: boolean;
}

export interface ChannelSetupFailureMapEntry {
  category: ChannelSetupFailureCategory;
  title: string;
  summary: string;
  likelyCauses: string[];
  nextSteps: string[];
}

export interface ChannelSetupTroubleshootingMap {
  commonFailures: ChannelSetupFailureMapEntry[];
}

export interface ChannelSetupTelemetryMeta {
  tier: ChannelSetupTier;
  namespace: string;
}

export interface ChannelSetupLifecyclePolicy {
  supportedModes: ChannelSetupLifecycleMode[];
  supportsDrafts: boolean;
  supportsEdit: boolean;
  supportsRepair: boolean;
  supportsRotateSecret: boolean;
  supportsRetest: boolean;
}

export interface ChannelSetupVolatilityMeta {
  officialDocsUrl?: string;
  lastReviewedAt: string;
  volatility: "low" | "medium" | "high";
  deprecationRisk: "low" | "medium" | "high";
  preferredPathLabel?: string;
  legacyPathLabel?: string;
}

export interface ChannelSetupCatalogMeta {
  catalogId: string;
  key: IntegrationCatalogEntry["key"];
  label: string;
  description: string;
  kind: IntegrationCatalogEntry["kind"];
  capabilities: string[];
  maturity: IntegrationCatalogEntry["maturity"];
  supportedModes: string[];
}

export interface ChannelSetupAdapterMeta {
  adapterVersion: string;
  secretFieldKeys: string[];
}

export interface ChannelSetupDefinition {
  catalog: ChannelSetupCatalogMeta;
  wizard: ChannelSetupWizardContent;
  adapter: ChannelSetupAdapterMeta;
  validation: ChannelSetupValidationStrategy;
  testing: ChannelSetupTestStrategy;
  troubleshooting: ChannelSetupTroubleshootingMap;
  telemetry: ChannelSetupTelemetryMeta;
  lifecycle: ChannelSetupLifecyclePolicy;
  volatility: ChannelSetupVolatilityMeta;
}

export interface ChannelSetupHydrationResult {
  status: ChannelSetupHydrationStatus;
  fieldState: Record<string, "configured" | "missing" | "needs_replacement" | "unknown">;
  warnings: string[];
  rawLegacyConfig?: Record<string, unknown>;
}

export interface ChannelSetupSecretState {
  configured: boolean;
  custody: "temporary" | "connection";
  /** Internal opaque locator. Public Gateway projections omit this field. */
  secretRef?: string;
}

export interface ChannelSetupDraft {
  draftId: string;
  /** Positive compare-and-swap revision for every draft mutation and external check. */
  revision: number;
  catalogId: string;
  connectionId?: string;
  lifecycleMode: ChannelSetupLifecycleMode;
  label?: string;
  enabled: boolean;
  draft: Record<string, unknown>;
  secretState: Record<string, ChannelSetupSecretState>;
  contentVersion: string;
  adapterVersion: string;
  validationVersion: string;
  testVersion: string;
  hydration?: ChannelSetupHydrationResult;
  lastValidatedAt?: string;
  lastTestedAt?: string;
  lastFailureCategory?: ChannelSetupFailureCategory;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelSetupDraftCreateInput {
  catalogId: string;
  connectionId?: string;
  lifecycleMode?: ChannelSetupLifecycleMode;
}

export interface ChannelSetupDraftUpdateInput {
  expectedRevision: number;
  label?: string;
  enabled?: boolean;
  draft?: Record<string, unknown>;
  lastFailureCategory?: ChannelSetupFailureCategory;
}

export interface ChannelSetupIssue {
  key: string;
  level: "info" | "warn" | "error";
  message: string;
  detail?: string;
  fieldKey?: string;
  failureCategory?: ChannelSetupFailureCategory;
  nextSteps?: string[];
}

export interface ChannelSetupValidationResult {
  draftId: string;
  draftRevision: number;
  status: ChannelSetupStatus;
  levels: ChannelSetupValidationLevel[];
  issues: ChannelSetupIssue[];
  checkedAt: string;
}

export interface ChannelSetupTestResult {
  draftId: string;
  draftRevision: number;
  status: ChannelSetupStatus;
  levels: ChannelSetupValidationLevel[];
  issues: ChannelSetupIssue[];
  checkedAt: string;
  recommendedNextAction?: string;
  probe?: ChannelProbeReport;
}

export interface ChannelSetupFinalizeResult {
  draftRevision: number;
  connection: IntegrationConnection;
  validation: ChannelSetupValidationResult;
  test?: ChannelSetupTestResult;
}
