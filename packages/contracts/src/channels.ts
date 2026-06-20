import type { ChannelActivityEffectResult, ChannelActivityPhase } from "./comms.js";

export type IntegrationPluginInstallSourceType = "local" | "npm" | "git" | "url" | "manual" | "unknown";
export type IntegrationPluginIntegrityStatus =
  | "verified"
  | "missing"
  | "mismatch"
  | "unknown"
  | "not_applicable"
  | "quarantined";
export type IntegrationPluginTrustWarningSeverity = "info" | "warning" | "critical";

export interface IntegrationPluginSourceMetadata {
  type: IntegrationPluginInstallSourceType;
  display: string;
  packageName?: string;
  packageVersion?: string;
  integrityStatus: IntegrationPluginIntegrityStatus;
  expectedIntegrity?: string;
}

export interface IntegrationPluginTrustWarning {
  code: string;
  severity: IntegrationPluginTrustWarningSeverity;
  message: string;
}

export interface IntegrationPluginThemeMetadata {
  accentColor?: string;
  icon?: string;
  dashboardVariant?: "default" | "compact" | "high_contrast";
}

export type PluginDescriptorHealthStatus = "healthy" | "warning" | "quarantined";

export interface PluginDescriptorHealthIssue {
  code: string;
  severity: IntegrationPluginTrustWarningSeverity;
  message: string;
  action?: string;
}

export interface PluginDescriptorHealth {
  status: PluginDescriptorHealthStatus;
  checkedAt: string;
  source: string;
  manifestPath?: string;
  summary: string;
  issues: PluginDescriptorHealthIssue[];
  evidence: {
    owner: "gateway";
    source: "integration_plugin_descriptor";
    timestamp: string;
    status: PluginDescriptorHealthStatus;
    descriptorHash?: string;
  };
}

export interface IntegrationPluginRecord {
  pluginId: string;
  label: string;
  version: string;
  description?: string;
  source?: string;
  sourceMetadata?: IntegrationPluginSourceMetadata;
  integrityStatus?: IntegrationPluginIntegrityStatus;
  trustWarnings?: IntegrationPluginTrustWarning[];
  descriptorHealth?: PluginDescriptorHealth;
  theme?: IntegrationPluginThemeMetadata;
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
  capabilities: string[];
  toolOverrides?: IntegrationPluginToolOverride[];
}

export interface IntegrationPluginInstallInput {
  source: string;
  pluginId?: string;
  sourceType?: IntegrationPluginInstallSourceType;
  expectedIntegrity?: string;
}

export interface IntegrationPluginAuthorManifest {
  pluginId: string;
  label: string;
  version: string;
  description?: string;
  capabilities: string[];
  packageName?: string;
  integrity?: {
    expected?: string;
  };
  theme?: IntegrationPluginThemeMetadata;
  toolOverrides?: IntegrationPluginToolOverrideManifestEntry[];
}

export type IntegrationPluginToolOverrideStatus = "pending_owner_approval" | "approved" | "revoked";

export interface IntegrationPluginToolOverride {
  toolName: string;
  override: boolean;
  status: IntegrationPluginToolOverrideStatus;
  approvedAt?: string;
  approvedBy?: string;
  revokedAt?: string;
}

export interface IntegrationPluginToolOverrideManifestEntry {
  toolName: string;
  override: boolean;
}

export type ChannelActionName =
  | "channel.send"
  | "channel.reply"
  | "channel.react"
  | "channel.unsend"
  | "channel.typing"
  | "channel.activity"
  | "channel.presence";

export type ChannelAttachmentSource = "url" | "inline";

export type ChannelInboundMode = "none" | "webhook" | "gateway" | "poll" | "local_bridge";

export type ChannelChunkingMode = "unsupported" | "fallback" | "native";
export type ChannelOutboundTransport = "webhook" | "api";
export type ChannelRuntimeLifecycle = "stateless" | "persistent";
export type ChannelInboundReadiness = "ready" | "unsupported";

export interface ChannelThreadCapabilities {
  rooms: boolean;
  threads: boolean;
  replies: boolean;
  direct: boolean;
  groups: boolean;
}

export interface ChannelRuntimePolicy {
  pairing: boolean;
  allowlist: boolean;
  mentionGating: boolean;
  typing: boolean;
  activity: boolean;
  presence: boolean;
}

export interface ChannelActivityCapabilities {
  supported: boolean;
  phases: ChannelActivityPhase[];
  nativeEffects: ChannelActivityEffectResult["effect"][];
  clearOnTerminal: boolean;
  activityEmoji: Partial<Record<ChannelActivityPhase, string>>;
}

export interface ChannelRuntimePosture {
  outboundTransport: ChannelOutboundTransport;
  inboundTransport?: Exclude<ChannelInboundMode, "none">;
  lifecycle: ChannelRuntimeLifecycle;
  inboundReadiness: ChannelInboundReadiness;
  operatorSummary: string;
}

export interface ChannelCapabilities {
  channelKey: string;
  supportedActions: ChannelActionName[];
  // Legacy alias consumed by existing Mission Control helpers/tests.
  supportedDeliveryActions: ChannelActionName[];
  supportedAttachmentSources: ChannelAttachmentSource[];
  inboundModes: ChannelInboundMode[];
  threadCapabilities: ChannelThreadCapabilities;
  runtimePolicy: ChannelRuntimePolicy;
  activityCapabilities: ChannelActivityCapabilities;
  runtimePosture: ChannelRuntimePosture;
  chunkingMode: ChannelChunkingMode;
  supportsStreaming: boolean;
  supportNotes: string[];
  setupDiagnostics: string[];
  setupReady: boolean;
}

export type ChannelPairingStatus = "pending" | "approved" | "revoked";

export interface ChannelPairingRecord {
  pairingId: string;
  connectionId: string;
  channelKey: string;
  peerId: string;
  displayName?: string;
  code: string;
  status: ChannelPairingStatus;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  revokedAt?: string;
  lastInboundAt?: string;
}

export interface ChannelRuntimeStatus {
  connectionId: string;
  channelKey: string;
  enabled: boolean;
  ready: boolean;
  inboundModes: ChannelInboundMode[];
  runtimePolicy: ChannelRuntimePolicy;
  runtimePosture?: ChannelRuntimePosture;
  lastReadyAt?: string;
  lastInboundAt?: string;
  lastReconnectAt?: string;
  lastError?: string;
  metadata?: Record<string, unknown>;
}

export type ChannelTargetKind = "private" | "group" | "supergroup" | "channel" | "thread" | "unknown";
export type ChannelTargetDirectorySource = "platform_api" | "recent_update" | "connection_config" | "session_fallback";

export interface ChannelTargetDirectoryEntry {
  targetId: string;
  platform: string;
  kind: ChannelTargetKind;
  displayLabel: string;
  canonicalName: string;
  source: ChannelTargetDirectorySource;
  lastSeenAt: string;
  metadata?: Record<string, unknown>;
}

export interface ChannelTargetDirectory {
  connectionId: string;
  platform: string;
  refreshedAt: string;
  entries: ChannelTargetDirectoryEntry[];
}

export type ChannelTargetResolution =
  | {
      status: "resolved";
      entry: ChannelTargetDirectoryEntry;
    }
  | {
      status: "ambiguous";
      query: string;
      matches: ChannelTargetDirectoryEntry[];
      message: string;
    }
  | {
      status: "not_found";
      query: string;
      message: string;
    };

export type PersonalityPresetVisibility = "builtin" | "workspace" | "channel" | "custom";
export type PersonalityPresetCategory = "core" | "critical" | "execution" | "social" | "thinking" | "flavor" | "chaos";

export interface PersonalityPreset {
  id: string;
  label: string;
  category: PersonalityPresetCategory;
  description: string;
  tone: string;
  style: string;
  systemOverlay: string;
  soulFile: string;
  safetyNotes: string[];
  visibility: PersonalityPresetVisibility;
  builtin: boolean;
  modified?: boolean;
  editable?: boolean;
  updatedAt?: string;
}

export interface PersonalityCatalogResponse {
  items: PersonalityPreset[];
  defaultPersonalityId: string;
}

export interface PersonalityPresetMutationInput {
  id?: string;
  label?: string;
  category?: PersonalityPresetCategory;
  description?: string;
  tone?: string;
  style?: string;
  systemOverlay?: string;
  safetyNotes?: string[];
}

export interface ChannelPersonalitySelection {
  scope: "connection" | "target" | "session";
  connectionId: string;
  targetId?: string;
  personalityId: string;
  label: string;
  updatedAt: string;
}

export interface ChannelSkillBinding {
  bindingId: string;
  connectionId: string;
  targetId?: string;
  skillId: string;
  alias: string;
  enabled: boolean;
  visibility: "operator_visible";
  createdAt: string;
  updatedAt: string;
}

export interface ChannelCommandDefinition {
  name: string;
  aliases: string[];
  description: string;
  argsHint?: string;
  platforms: string[];
  requiresAuthorization: boolean;
  bypassesActiveRunGuard: boolean;
}

export interface ChannelCommandRenderHint {
  format: "plain_text" | "telegram_send_message" | "discord_reply" | "slack_ephemeral";
  compact: boolean;
}

export type ChannelToolsetFamily =
  | "conversation"
  | "skills"
  | "web"
  | "terminal"
  | "filesystem"
  | "browser"
  | "cron"
  | "messaging";

export interface ChannelToolsetPosture {
  family: ChannelToolsetFamily;
  label: string;
  enabled: boolean;
  approval: "not_required" | "policy_gated" | "always_required" | "unavailable";
  riskSummary: string;
}

export interface ChannelApprovalRenderEnvelope {
  approvalId: string;
  remoteTokenId?: string;
  platform: string;
  targetId: string;
  requestedBy: string;
  kind: string;
  riskLevel: string;
  toolName?: string;
  workspaceId?: string;
  riskSummary?: string;
  rollbackNotes?: string;
  expiresAt?: string;
}

export type CurationTargetKind = "skill" | "memory" | "prompt" | "hook";
export type CurationProposalAction = "prune" | "merge" | "rewrite" | "promote" | "memory_update" | "no_action";
export type CurationTrustState = "bundled" | "user_installed" | "workspace_local" | "generated" | "untrusted";

export interface CurationReviewProposal {
  proposalId: string;
  targetKind: CurationTargetKind;
  targetRef: string;
  action: CurationProposalAction;
  summary: string;
  reason: string;
  confidence: number;
  trustState: CurationTrustState;
  provenance: string[];
  affectedSurfaces: string[];
  rollback: {
    available: boolean;
    summary: string;
    restoreRef?: string;
  };
  requiresApproval: boolean;
}

export interface CurationReviewReport {
  reportId: string;
  createdAt: string;
  summary: string;
  proposals: CurationReviewProposal[];
  mutated: false;
}
