import type {
  ChatMemoryMode,
  ChatMode,
  ChatRetrievalMode,
  ChatSpeedMode,
  ChatSubagentPolicy,
  ChatThinkingLevel,
  ChatWebMode,
} from "./chat.js";
import type { ToolGrantConstraints, ToolGrantDecision, ToolGrantScope, ToolGrantType } from "./tool-grants.js";
import type { ToolApprovalMode } from "./policy.js";
import type { CapabilityCategory, SkillLifecycleState } from "./capabilities.js";
import type { McpRequesterResolutionBinding } from "./mcp.js";

export const CHAT_TURN_CAPABILITY_PROFILE_VERSION = "chat.turn.capability-profile.v1" as const;

export type ChatTurnCapabilityProfileAvailability = "available" | "legacy_missing" | "invalid";

export interface ChatTurnCapabilityProfileIdentity {
  turnId: string;
  sessionId: string;
  workspaceId: string;
  citadelId: string;
  durableRunId?: string;
  operatorId?: string;
  authActorId?: string;
  authActorSource?: "none" | "token" | "basic" | "loopback" | "sse" | "device" | "companion" | "a2a_peer";
}

export interface ChatTurnCapabilityProfileSourceScope {
  channel: string;
  account: string;
  peer?: string;
  room?: string;
  threadId?: string;
  transport?: string;
  connectionId?: string;
  /** Hash of an external binding target; the target itself may contain sensitive channel identifiers. */
  bindingTargetHash?: string;
}

export interface ChatTurnCapabilityProfileCatalog {
  snapshotId: string;
  inspectableHash: string;
  callableHash: string;
  inspectableCount: number;
  callableCount: number;
  /**
   * Hash of enabled workspace-local runtime interposition that can execute
   * before a selected tool (currently `tool.call.before` webhooks).
   */
  runtimeInterpositionHash?: string;
  toolCallBeforeHookCount?: number;
}

export interface ChatTurnCapabilityToolDefinition {
  canonicalName: string;
  modelName: string;
  definitionHash: string;
  /** Exact bounded definition sent to the provider. */
  providerDefinition: Record<string, unknown>;
  /** Frozen planning-time recovery upper bound for this exact tool binding. */
  effectPotential?: import("./tool-effect-truth.js").ToolEffectPotentialRecord;
  /** Immutable runtime owner admitted for this exact tool definition. */
  runtimeOwner?: ChatTurnCapabilityToolRuntimeOwnerBinding;
  /**
   * Secret-free immutable binding for requester-scoped MCP. Static MCP and
   * non-MCP tools omit this field; legacy omission can never imply scoped mode.
   */
  mcpRequesterResolution?: McpRequesterResolutionBinding;
}

export interface ChatTurnCapabilityToolRuntimeOwnerBinding {
  kind: "builtin" | "plugin";
  /** Secret-safe digest of the exact runtime owner generation. */
  bindingHash: string;
}

export interface ChatTurnCapabilityModelNameBinding {
  modelName: string;
  canonicalName: string;
}

export interface ChatTurnCapabilityTrustedSkill {
  capabilityId: string;
  skillId: string;
  category: CapabilityCategory;
  lifecycleState: Extract<SkillLifecycleState, "approved" | "trusted">;
  trustLabel: string;
  source: string;
  sourceRef?: string;
  sourceProvider?: string;
  commitSha?: string;
  contentIntegrityManifestVersion?: "goatcitadel.skill-tree.v1";
  treeSha256?: string;
  contentFileCount?: number;
  contentBytes?: number;
}

export interface ChatTurnCapabilityRouteTarget {
  providerId: string;
  model: string;
}

export interface ChatTurnCapabilityMemoryScope {
  mode: ChatMemoryMode;
  retrievalMode: ChatRetrievalMode;
  workspaceId: string;
  sessionId: string;
  contextManifestRef: string;
  writeApprovalRequired: boolean;
}

export interface ChatTurnCapabilityProfileSelection {
  contentHash: string;
  requestedProviderId?: string;
  requestedModel?: string;
  effectiveProviderId?: string;
  effectiveModel?: string;
  allowedFallbacks: ChatTurnCapabilityRouteTarget[];
  mode: ChatMode;
  webMode: ChatWebMode;
  memory: ChatTurnCapabilityMemoryScope;
  thinkingLevel: ChatThinkingLevel;
  speedMode: ChatSpeedMode;
  subagentPolicy: ChatSubagentPolicy;
  toolAutonomy: "safe_auto" | "manual";
  tools: ChatTurnCapabilityToolDefinition[];
  modelNameAllowMap: ChatTurnCapabilityModelNameBinding[];
  trustedSkills: ChatTurnCapabilityTrustedSkill[];
}

export interface ChatTurnCapabilityGrantSnapshot {
  grantId: string;
  toolPattern: string;
  decision: ToolGrantDecision;
  scope: ToolGrantScope;
  scopeRef: string;
  grantType: ToolGrantType;
  constraints?: ToolGrantConstraints;
  expiresAt?: string;
  usesRemaining?: number;
}

export interface ChatTurnCapabilityPolicyDecision {
  toolName: string;
  allowed: boolean;
  requiresApproval: boolean;
  reasonCodes: string[];
  matchedGrantId?: string;
}

export interface ChatTurnCapabilityPermissionSnapshot {
  profileId: string;
  approvalMode: ToolApprovalMode;
  profileHash: string;
  localOperatorOverrideId?: string;
  localOperatorOverrideExpiresAt?: string;
}

export interface ChatTurnCapabilityAuthReadiness {
  kind: "provider" | "tool" | "skill" | "channel" | "mcp";
  ref: string;
  status: "ready" | "missing" | "blocked" | "unknown";
  reasonCodes: string[];
}

export interface ChatTurnCapabilityApprovalPosture {
  mode: ToolApprovalMode;
  selectedToolCount: number;
  toolsRequiringApproval: string[];
  approvalGranted: false;
}

export interface ChatTurnCapabilityProfileGovernance {
  activeGrants: ChatTurnCapabilityGrantSnapshot[];
  permission: ChatTurnCapabilityPermissionSnapshot;
  policyDecisions: ChatTurnCapabilityPolicyDecision[];
  authReadiness: ChatTurnCapabilityAuthReadiness[];
  approval: ChatTurnCapabilityApprovalPosture;
}

export interface ChatTurnCapabilityProfileHashes {
  identityHash: string;
  sourceHash: string;
  catalogHash: string;
  selectionHash: string;
  governanceHash: string;
  profileHash: string;
}

export interface ChatTurnCapabilityProfileRecord {
  profileId: string;
  schemaVersion: typeof CHAT_TURN_CAPABILITY_PROFILE_VERSION;
  identity: ChatTurnCapabilityProfileIdentity;
  source: ChatTurnCapabilityProfileSourceScope;
  catalog: ChatTurnCapabilityProfileCatalog;
  selection: ChatTurnCapabilityProfileSelection;
  governance: ChatTurnCapabilityProfileGovernance;
  hashes: ChatTurnCapabilityProfileHashes;
  /** Stable admission fingerprint shared by preflight and final resolution. */
  preflightFingerprint: string;
  createdAt: string;
}

export type ChatTurnCapabilityProfileDraft = Omit<ChatTurnCapabilityProfileRecord, "hashes">;

export interface ChatTurnCapabilityProfilePreview {
  schemaVersion: typeof CHAT_TURN_CAPABILITY_PROFILE_VERSION;
  fingerprint: string;
  contentHash: string;
  providerId?: string;
  model?: string;
  fallbackCount: number;
  selectedTools: Array<{ canonicalName: string; modelName: string; requiresApproval: boolean }>;
  trustedSkills: Array<{ skillId: string; trustLabel?: string }>;
  memory: ChatTurnCapabilityMemoryScope;
  approval: ChatTurnCapabilityApprovalPosture;
  authReadiness: ChatTurnCapabilityAuthReadiness[];
  blockedReasons: string[];
  /** Stable provider/model/capability-selection dimension used for history compaction. */
  compactionDimensionHash?: string;
}

export interface ChatTurnCapabilityProfileEnvelope {
  state: ChatTurnCapabilityProfileAvailability;
  profile?: ChatTurnCapabilityProfileRecord;
  /** Sibling immutable context evidence; excluded from capability-profile.v1 hashes. */
  routedContext?: import("./routed-context.js").ChatRoutedContextInspection;
  error?: string;
}
