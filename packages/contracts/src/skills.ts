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

export interface LoadedSkill {
  skillId: string;
  name: string;
  source: "bundled" | "managed" | "workspace" | "extra";
  dir: string;
  tags?: string[];
  declaredTools: string[];
  requires: string[];
  keywords: string[];
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
}

export interface SkillActivationPolicy {
  guardedAutoThreshold: number;
  requireFirstUseConfirmation: boolean;
}

export interface SkillListItem extends LoadedSkill {
  state: SkillRuntimeState;
  note?: string;
  stateUpdatedAt?: string;
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

export type BankrSafetyMode = "read_only" | "read_write";
export type BankrActionType =
  | "read"
  | "trade"
  | "transfer"
  | "sign"
  | "submit"
  | "deploy";

export type BankrActionStatus =
  | "preview_allowed"
  | "preview_blocked"
  | "executed"
  | "blocked"
  | "denied"
  | "failed";

export interface BankrSafetyPolicy {
  enabled: boolean;
  mode: BankrSafetyMode;
  dailyUsdCap: number;
  perActionUsdCap: number;
  requireApprovalEveryWrite: boolean;
  allowedChains: string[];
  allowedActionTypes: BankrActionType[];
  blockedSymbols?: string[];
}

export interface BankrNormalizedAction {
  actionType: BankrActionType;
  chain?: string;
  symbol?: string;
  usdEstimate?: number;
  prompt?: string;
}

export interface BankrActionPreviewRequest {
  prompt?: string;
  actionType?: BankrActionType;
  chain?: string;
  symbol?: string;
  usdEstimate?: number;
  sessionId?: string;
  actorId?: string;
}

export interface BankrActionPreviewResponse {
  allowed: boolean;
  reason: string;
  reasonCode: string;
  policy: BankrSafetyPolicy;
  normalized: BankrNormalizedAction;
  dailyUsageUsd: number;
  remainingDailyUsd: number;
  remainingPerActionUsd: number;
}

export interface BankrActionAuditRecord {
  actionId: string;
  sessionId: string;
  actorId: string;
  actionType: BankrActionType;
  chain?: string;
  symbol?: string;
  usdEstimate?: number;
  status: BankrActionStatus;
  approvalId?: string;
  policyReason?: string;
  details?: Record<string, unknown>;
  createdAt: string;
}

export type SkillSourceProvider = "agentskill" | "skillsmp" | "clawhub" | "github" | "local" | "external";

export type SkillImportSourceType = "local_path" | "local_zip" | "git_url" | "remote_bundle";
export type SkillSourceKind = "marketplace_listing" | "upstream_repo" | "reference" | "local";
export type SkillSourceInstallability = "direct" | "review_only" | "not_installable";

export interface SkillImportCandidate {
  sourceProvider: SkillSourceProvider;
  sourceType: SkillImportSourceType;
  sourceRef: string;
  sourceUrl?: string;
  repositoryUrl?: string;
  canonicalKey: string;
  skillRootPath?: string;
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
