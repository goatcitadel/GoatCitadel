import type { CapabilityCategory, SkillLifecycleRecord, SkillLifecycleState } from "./capabilities.js";

export interface SkillFrontmatter {
  name: string;
  description: string;
  metadata?: {
    version?: string;
    tags?: string[];
    tools?: string[];
    requires?: string[];
    keywords?: string[];
  };
}

export interface SkillRoutingHints {
  phrases: string[];
  keywords: string[];
  surfaces: Array<"chat" | "cowork" | "code" | "library" | "ops" | "settings">;
  whenToUse: string[];
  whenNotToUse: string[];
  confidenceBoost?: number;
}

export interface LoadedSkill {
  skillId: string;
  name: string;
  source: "bundled" | "managed" | "workspace" | "extra";
  dir: string;
  tags?: string[];
  declaredTools: string[];
  requires: string[];
  keywords: string[];
  routingHints?: SkillRoutingHints;
  instructionBody: string;
  mtime: string;
}

export type SkillRuntimeState = "enabled" | "sleep" | "disabled";

export interface SkillStateRecord {
  skillId: string;
  state: SkillRuntimeState;
  note?: string;
  updatedAt: string;
  firstAutoApprovedAt?: string;
  pinned?: boolean;
  usageCount?: number;
  lastUsedAt?: string;
}

export interface SkillActivationPolicy {
  guardedAutoThreshold: number;
  requireFirstUseConfirmation: boolean;
}

export interface SkillListItem extends LoadedSkill {
  state: SkillRuntimeState;
  note?: string;
  stateUpdatedAt?: string;
  pinned?: boolean;
  usageCount?: number;
  lastUsedAt?: string;
  capabilityCategory?: CapabilityCategory;
  lifecycleState?: SkillLifecycleState;
  lifecycle?: SkillLifecycleRecord;
  callable?: boolean;
  trustLabel?: string;
  reviewWarning?: string;
}

export interface SkillActivationDecision {
  selected: Array<
    LoadedSkill & {
      state: SkillRuntimeState;
      confidence: number;
      requiresConfirmation: boolean;
    }
  >;
  reasons: Record<string, string[]>;
  blocked: Array<{ skill: string; reason: string }>;
  suppressed: Array<{
    skill: string;
    state: SkillRuntimeState;
    confidence: number;
    reason: string;
  }>;
}

export interface SkillResolveInput {
  text: string;
  explicitSkills?: string[];
}

export type SkillSourceProvider = "agentskill" | "skillsmp" | "clawhub" | "github" | "local" | "external";

export type SkillImportSourceType = "local_path" | "local_zip" | "git_url" | "remote_bundle";
export type SkillSourceKind = "marketplace_listing" | "upstream_repo" | "reference" | "local";
export type SkillSourceInstallability = "direct" | "review_only" | "not_installable";

export type SkillImportCompatibilitySource = "goatcitadel_skill_bundle" | "agent_skills" | "agents_md" | "skill_md";
export type SkillImportCompatibilityCallability = "review_only" | "governed_candidate" | "callable";

export interface SkillImportCompatibility {
  sources: SkillImportCompatibilitySource[];
  warnings: string[];
  callability: SkillImportCompatibilityCallability;
}

export interface SkillImportCandidate {
  sourceProvider: SkillSourceProvider;
  sourceType: SkillImportSourceType;
  sourceRef: string;
  sourceUrl?: string;
  repositoryUrl?: string;
  canonicalKey: string;
  skillRootPath?: string;
  provenance?: SkillImportProvenance;
  externalToolMappings?: SkillImportExternalToolMapping[];
  scriptDisposition?: SkillImportScriptDisposition;
  bundleManifest?: SkillBundleManifestValidation;
  compatibility?: SkillImportCompatibility;
}

export interface SkillImportProvenance {
  sourceProvider: SkillSourceProvider;
  sourceRef: string;
  sourceType: SkillImportSourceType;
  capturedAt: string;
  repositoryUrl?: string;
  sourceUrl?: string;
  commitSha?: string;
  nonCallableUntilActivated: true;
}

export interface SkillImportExternalToolMapping {
  declaredTool: string;
  mappedCapabilityId?: string;
  mappedCapabilityLabel?: string;
  disposition: "mapped" | "unmapped";
  reason: string;
}

export interface SkillImportScriptDisposition {
  action: "none" | "blocked_until_activation" | "review_required";
  scriptFiles: string[];
  notes: string[];
}

export type SkillBundleAssetKind = "skill" | "reference" | "template" | "script" | "metadata";

export interface SkillBundleManifestAsset {
  path: string;
  sha256: string;
  kind: SkillBundleAssetKind;
  bytes?: number;
  callable?: false;
}

/** An environment variable a skill declares it needs to operate. */
export interface SkillRequiredEnvVar {
  name: string;
  description?: string;
  required?: boolean;
  secret?: boolean;
}

/** A state directory a skill declares it reads/writes. */
export interface SkillStateDir {
  path: string;
  description?: string;
  writeable?: boolean;
}

/** Dependencies a skill declares (governance metadata; surfaced, not auto-installed). */
export interface SkillDeclaredDependencies {
  tools?: string[];
  skillIds?: string[];
  capabilities?: string[];
}

export interface SkillBundleManifest {
  manifestVersion: "goatcitadel.skill-bundle.v1";
  skillId?: string;
  name?: string;
  generatedAt?: string;
  allowedDirectories?: string[];
  /** Declared env vars the skill needs (governance: surfaced at import for operator review). */
  requiredEnv?: SkillRequiredEnvVar[];
  /** Declared state directories the skill reads/writes. */
  stateDirs?: SkillStateDir[];
  /** Declared tool/skill/capability dependencies. */
  declaredDependencies?: SkillDeclaredDependencies;
  scriptDisposition: "review_only_non_callable";
  assets: SkillBundleManifestAsset[];
}

export interface SkillBundleManifestValidation {
  status: "absent" | "valid" | "invalid";
  manifestPath?: string;
  assetsVerified: number;
  assetPaths: string[];
  scriptDisposition?: SkillBundleManifest["scriptDisposition"];
  /** Validated declared-governance metadata (env/state/deps), when the manifest declares any. */
  declaredMetadata?: {
    requiredEnv: SkillRequiredEnvVar[];
    stateDirs: SkillStateDir[];
    dependencies: SkillDeclaredDependencies;
  };
  warnings: string[];
  errors: string[];
}

export interface SkillSourceSearchRecord {
  provider: SkillSourceProvider;
  providerLabel: string;
  available: boolean;
  status: "ok" | "degraded" | "unavailable";
  error?: string;
  latencyMs?: number;
}

export interface SkillSourceResultRecord {
  sourceProvider: SkillSourceProvider;
  sourceUrl: string;
  repositoryUrl?: string;
  upstreamUrl?: string;
  name: string;
  description: string;
  tags: string[];
  updatedAt?: string;
  sourceKind?: SkillSourceKind;
  skillFamily?: string;
  installability?: SkillSourceInstallability;
  installHint?: string;
  matchReason?: string;
  matchedTerms?: string[];
  alreadyInstalled?: boolean;
}

export interface SkillMergedSourceResult extends SkillSourceResultRecord {
  canonicalKey: string;
  alternateProviders: SkillSourceProvider[];
  qualityScore: number;
  freshnessScore: number;
  trustScore: number;
  combinedScore: number;
}

export interface SkillSourceListResponse {
  query?: string;
  generatedAt: string;
  providers: SkillSourceSearchRecord[];
  items: SkillMergedSourceResult[];
}

export interface SkillSourceLookupParsedSource {
  sourceProvider: SkillSourceProvider;
  sourceKind: SkillSourceKind;
  sourceUrl: string;
  installability: SkillSourceInstallability;
  upstreamUrl?: string;
  repositoryUrl?: string;
}

export interface SkillSourceLookupResponse {
  query: string;
  generatedAt: string;
  providers: SkillSourceSearchRecord[];
  parsedSource?: SkillSourceLookupParsedSource;
  bestMatch?: SkillMergedSourceResult;
  items: SkillMergedSourceResult[];
}

export interface SkillImportValidationChecks {
  frontmatterValid: boolean;
  descriptionQuality: boolean;
  suspiciousScripts: boolean;
  networkIndicators: boolean;
  licenseDetected: boolean;
}

export interface SkillImportValidationResult {
  valid: boolean;
  riskLevel: "low" | "medium" | "high";
  reviewDisposition?: "allow" | "conditional" | "reference_only" | "reject";
  reviewMessage?: string;
  errors: string[];
  warnings: string[];
  checks: SkillImportValidationChecks;
  candidate: SkillImportCandidate;
  inferredSkillName?: string;
  inferredSkillId?: string;
  installPath?: string;
  declaredTools: string[];
  requires: string[];
  networkSignals: string[];
  suspiciousSignals: string[];
  licenseFiles: string[];
  instructionPreview?: string;
  externalToolMappings?: SkillImportExternalToolMapping[];
  scriptDisposition?: SkillImportScriptDisposition;
  provenance?: SkillImportProvenance;
  bundleManifest?: SkillBundleManifestValidation;
  compatibility?: SkillImportCompatibility;
  nativeOverlaps?: Array<{
    overlapFamily: string;
    nativeAlternativeName: string;
    nativeDestination: string;
    blockingReason: string;
  }>;
}

export interface SkillImportHistoryRecord {
  importId: string;
  action: "validate" | "install";
  outcome: "accepted" | "rejected" | "failed";
  sourceProvider: SkillSourceProvider;
  sourceRef: string;
  sourceType: SkillImportSourceType;
  canonicalKey: string;
  skillName?: string;
  skillId?: string;
  riskLevel?: "low" | "medium" | "high";
  details?: Record<string, unknown>;
  createdAt: string;
}

export interface SkillOutputDocumentDirective {
  kind: "document";
  fileName: string;
  mimeType: string;
  content: string;
}

export type SkillOutputDirective = SkillOutputDocumentDirective;

export interface SkillOutputParseResult {
  text: string;
  directives: SkillOutputDirective[];
}

export type SkillCatalogExposureLevel = "hidden" | "inspectable" | "suggestable" | "callable";
export type SkillCatalogRiskTier = "low" | "medium" | "high";

export interface SkillCatalogCoverageEntry {
  skillId: string;
  owner: string;
  source: LoadedSkill["source"] | "external";
  riskTier: SkillCatalogRiskTier;
  expectedTests: string[];
  catalogExposure: SkillCatalogExposureLevel;
}

export interface SkillCatalogAuditFinding {
  skillId?: string;
  path?: string;
  severity: "error" | "warning";
  code:
    | "missing_coverage"
    | "invalid_frontmatter"
    | "empty_body"
    | "unresolved_placeholder"
    | "catalog_budget_exceeded"
    | "stale_generated_routing"
    | "duplicate_skill";
  message: string;
}

export interface SkillCatalogAuditResult {
  ok: boolean;
  generatedAt: string;
  skillCount: number;
  tokenEstimate: number;
  tokenBudget: number;
  coverageEntries: SkillCatalogCoverageEntry[];
  findings: SkillCatalogAuditFinding[];
}

export type SkillExportTarget = "codex" | "claude" | "generic-markdown";

export interface SkillExportTargetProfile {
  target: SkillExportTarget;
  label: string;
  description: string;
  supportsFrontmatter: boolean;
  suppressesInternalMetadata: boolean;
  previewOnly: boolean;
}

export interface SkillExportRequest {
  skillIds: string[];
  target: SkillExportTarget;
  includeReferences?: boolean;
  actorId?: string;
}

export interface SkillExportRenderedFile {
  relativePath: string;
  content: string;
  sha256: string;
}

export interface SkillExportPreviewResponse {
  target: SkillExportTarget;
  generatedAt: string;
  boundaryWarning: string;
  files: SkillExportRenderedFile[];
}

export interface SkillExportPackageResponse extends SkillExportPreviewResponse {
  packageId: string;
  evidenceRef?: string;
}
