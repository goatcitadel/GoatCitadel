import type {
  AddonRuntimeStatus,
  AddonTrustTier,
  CapabilityCatalogEntry,
  FilesystemReadAccessMode,
  LocalOperatorOverrideRecord,
  McpCostTier,
  McpServerCategory,
  McpServerPolicy,
  McpServerStatus,
  McpTransport,
  McpTrustTier,
  PermissionProfileRecord,
  PermissionSurface,
  SkillDeclaredDependencies,
  SkillLifecycleState,
  SkillRequiredEnvVar,
  SkillRuntimeState,
  SkillStateDir,
  ToolApprovalMode,
  ToolGrantConstraints,
  ToolGrantDecision,
  ToolGrantScope,
  ToolGrantType,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export type TrustPolicyPosture =
  | "callable"
  | "non_callable"
  | "blocked"
  | "quarantined"
  | "disabled"
  | "not_installed"
  | "unavailable"
  /** Usable, but declares elevated governance metadata an operator should review before trusting. */
  | "medium_trust_unverified";

/**
 * Declared governance metadata a skill surfaces for operator review: the env
 * vars it needs, the state directories it reads/writes, and the tool/skill/
 * capability dependencies it declares. Populated from the skill bundle manifest.
 */
export interface TrustPolicySkillDeclaredMetadata {
  requiredEnv: SkillRequiredEnvVar[];
  stateDirs: SkillStateDir[];
  dependencies: SkillDeclaredDependencies;
}

export interface TrustPolicySourceStatus {
  key: string;
  owner: string;
  status: "available" | "unavailable";
  itemCount: number;
  error?: string;
}

export interface TrustPolicyPermissionProfile {
  profileId?: string;
  label?: string;
  builtin: boolean;
  status: PermissionProfileRecord["status"] | string;
  posture: TrustPolicyPosture;
  scope?: PermissionProfileRecord["scope"] | string;
  scopeRef?: string;
  approvalMode?: ToolApprovalMode | string;
  readAccessMode?: FilesystemReadAccessMode | string;
  defaultForSurfaces?: Array<PermissionSurface | string>;
  allow?: string[];
  deny?: string[];
  source: "tools.permissionProfiles";
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string;
}

export interface TrustPolicyToolGrant {
  grantId?: string;
  toolPattern?: string;
  decision?: ToolGrantDecision | string;
  posture: TrustPolicyPosture;
  scope?: ToolGrantScope | string;
  scopeRef?: string;
  grantType?: ToolGrantType | string;
  constraints?: ToolGrantConstraints | Record<string, unknown>;
  usesRemaining?: number;
  source: "tools.grants";
  createdBy?: string;
  createdAt?: string;
  expiresAt?: string;
  revokedAt?: string;
}

export interface TrustPolicyLocalOperatorOverride {
  overrideId?: string;
  operatorId?: string;
  scope?: LocalOperatorOverrideRecord["scope"] | string;
  scopeRef?: string;
  status: LocalOperatorOverrideRecord["status"] | string;
  posture: TrustPolicyPosture;
  reason?: string;
  source: "tools.localOperatorOverrides";
  createdBy?: string;
  createdAt?: string;
  expiresAt?: string;
  revokedAt?: string;
}

export interface TrustPolicyCapability extends Pick<
  CapabilityCatalogEntry,
  | "capabilityId"
  | "kind"
  | "category"
  | "summary"
  | "callable"
  | "lifecycleState"
  | "trustLabel"
  | "reviewWarning"
  | "toolName"
  | "skillId"
  | "proposalId"
  | "candidateId"
  | "declaredTools"
  | "requires"
> {
  title?: string;
  posture: TrustPolicyPosture;
  source: "capabilities.catalog";
}

export interface TrustPolicyMcpTool {
  toolName?: string;
  enabled: boolean;
  description?: string;
  posture: TrustPolicyPosture;
  source: "mcp.tools";
  updatedAt?: string;
}

export interface TrustPolicyMcpServer {
  serverId?: string;
  label?: string;
  transport?: McpTransport | string;
  enabled: boolean;
  status?: McpServerStatus | string;
  trustTier?: McpTrustTier | string;
  posture: TrustPolicyPosture;
  category?: McpServerCategory | string;
  costTier?: McpCostTier | string;
  policy?: McpServerPolicy | Record<string, unknown>;
  verifiedAt?: string;
  lastConnectedAt?: string;
  lastError?: string;
  source: "mcp.servers";
  tools: TrustPolicyMcpTool[];
  createdAt?: string;
  updatedAt?: string;
}

export interface TrustPolicySkill {
  skillId?: string;
  name?: string;
  sourceKind?: string;
  state: SkillRuntimeState | string;
  lifecycleState?: SkillLifecycleState | string;
  callable: boolean;
  posture: TrustPolicyPosture;
  capabilityCategory?: string;
  trustLabel?: string;
  reviewWarning?: string;
  usageCount?: number;
  lastUsedAt?: string;
  declaredTools?: string[];
  requires?: string[];
  /** Declared governance metadata (env/state dirs/dependencies) for operator review. */
  declaredMetadata?: TrustPolicySkillDeclaredMetadata;
  /** Medium-risk graduated-trust warnings raised by the skill's declared metadata. */
  bundleWarnings?: string[];
  /** Names of required env vars the skill declares that are not configured in the runtime. */
  missingRequiredEnv?: string[];
  source: "skills.lifecycle";
}

export interface TrustPolicyAddon {
  addonId?: string;
  label?: string;
  trustTier?: AddonTrustTier | string;
  category?: string;
  runtimeType?: string;
  webEntryMode?: string;
  sameOwnerAsGoatCitadel?: boolean;
  status: AddonRuntimeStatus | "not_installed" | string;
  posture: TrustPolicyPosture;
  enabled?: boolean;
  source: "addons.catalog" | "addons.installed";
  installedAt?: string;
  updatedAt?: string;
  lastError?: string;
}

export interface TrustPolicyLastUseEvidence {
  source: "skills.lifecycle" | "mcp.servers" | "addons.installed" | string;
  subjectType: "skill" | "mcp_server" | "addon" | string;
  subjectId?: string;
  lastUsedAt?: string;
  usageCount?: number;
  lastConnectedAt?: string;
  latestToolUpdatedAt?: string;
  updatedAt?: string;
  status?: string;
  runId?: string;
  approvalId?: string;
  evidenceRef?: string;
}

export interface TrustPolicySnapshot {
  generatedAt: string;
  readOnly: true;
  mutationSemantics: "none";
  enforcementSources: string[];
  sources: TrustPolicySourceStatus[];
  permissionProfiles: TrustPolicyPermissionProfile[];
  toolGrants: TrustPolicyToolGrant[];
  localOperatorOverrides: TrustPolicyLocalOperatorOverride[];
  capabilities: {
    inspectable: TrustPolicyCapability[];
    callable: TrustPolicyCapability[];
  };
  mcpServers: TrustPolicyMcpServer[];
  skills: TrustPolicySkill[];
  addons: TrustPolicyAddon[];
  lastUseEvidence: TrustPolicyLastUseEvidence[];
}

export async function fetchTrustPolicySnapshot(): Promise<TrustPolicySnapshot> {
  return request<TrustPolicySnapshot>("/api/v1/trust/policy-snapshot");
}
