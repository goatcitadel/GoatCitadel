import type { ChannelActivityEffectResult, ChannelActivityPhase } from "./comms.js";

export type IntegrationPluginTrustWarningSeverity = "info" | "warning" | "critical";

export interface IntegrationPluginThemeMetadata {
  accentColor?: string;
  icon?: string;
  dashboardVariant?: "default" | "compact" | "high_contrast";
}

export type ExtensionConfigurationField = {
  key: string;
  label: string;
  help?: string;
  required?: boolean;
} & (
  | { kind: "text" | "url"; defaultValue?: string }
  | { kind: "number"; defaultValue?: number }
  | { kind: "boolean"; defaultValue?: boolean }
  | { kind: "choice"; choices: Array<{ value: string; label: string }>; defaultValue?: string }
  | { kind: "secret_ref"; referenceKind: "environment" | "credential" }
);

/** Author metadata only: no secret values, installation commands or activation authority. */
export interface ExtensionConfigurationForm {
  version: "goatcitadel.extension-configuration.v1";
  fields: ExtensionConfigurationField[];
  prerequisites?: string[];
  sampleTask?: { prompt: string; expectedOutcome: string };
}

export interface PluginDescriptorHealthIssue {
  code: string;
  severity: IntegrationPluginTrustWarningSeverity;
  message: string;
  action?: string;
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
  configurationForm?: ExtensionConfigurationForm;
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

/**
 * Actions the platform itself cannot perform for a channel, with the
 * operator-facing reason. This is a platform truth, distinct from an action
 * the adapter merely has not wired or the connection has not configured.
 * Shared by channel capability reporting and the outbound executor so both
 * give the same reason.
 */
export const CHANNEL_PLATFORM_UNSUPPORTED_ACTIONS: Readonly<
  Record<string, Readonly<Partial<Record<ChannelActionName, string>>>>
> = {
  whatsapp: {
    "channel.unsend": "WhatsApp Cloud API has no endpoint for deleting a sent message.",
  },
  slack: {
    "channel.typing":
      "Slack has no typing indicator for bot messages in channels (only assistant-thread status and the legacy RTM API).",
  },
  "nextcloud-talk": {
    "channel.unsend": "Nextcloud Talk bots cannot delete messages through the bot API.",
    "channel.typing": "Nextcloud Talk bots have no typing-indicator endpoint.",
  },
  "google-chat": {
    "channel.react": "Google Chat reactions require user authentication; a Chat app cannot react as itself.",
    "channel.typing": "Google Chat has no typing-indicator API.",
  },
  ntfy: {
    "channel.react": "ntfy has no message reactions.",
    "channel.typing": "ntfy has no typing indicator.",
  },
  qqbot: {
    "channel.typing": "QQBot has no typing indicator API for bot messages.",
  },
  wecom: {
    "channel.typing": "WeCom has no typing indicator API for app messages.",
  },
  teams: {
    "channel.react": "Teams incoming webhooks can only post new messages.",
    "channel.unsend": "Teams incoming webhooks can only post new messages.",
    "channel.typing": "Teams incoming webhooks can only post new messages.",
  },
};

export const CHANNEL_PLATFORM_UNSUPPORTED_PREFIX = "Platform does not support this: ";

/** Returns the prefixed operator reason when the platform cannot do this action, else undefined. */
export function describeChannelPlatformUnsupported(
  channelKey: string,
  action: ChannelActionName,
  resolved?: Partial<Record<ChannelActionName, string>>,
): string | undefined {
  const reason = (resolved ?? CHANNEL_PLATFORM_UNSUPPORTED_ACTIONS[channelKey])?.[action];
  return reason ? `${CHANNEL_PLATFORM_UNSUPPORTED_PREFIX}${reason}` : undefined;
}

/**
 * Channels GoatCitadel no longer supports, with the operator-facing reason.
 * A saved connection for one of these stays readable so the operator can
 * review and delete it, but nothing sends through it. Shared by channel
 * capability reporting, diagnostics and the outbound executor so all of them
 * give the same reason.
 */
export const RETIRED_CHANNEL_REASONS: ReadonlyMap<string, string> = new Map([
  [
    "zalouser",
    "Zalo Personal is not supported anymore: it used an unofficial personal-account client that can get the account banned. Delete this connection and use Zalo OA (Official Account) instead.",
  ],
  [
    "signal",
    "Signal is not supported anymore: it used signal-cli, an unofficial client that can get the account banned. Delete this connection.",
  ],
  [
    "imessage",
    "iMessage is not supported anymore: it used BlueBubbles, an unofficial bridge that can get the account banned. Delete this connection.",
  ],
]);

/** Returns the operator reason when the channel is retired, else undefined. */
export function describeRetiredChannel(channelKey: string): string | undefined {
  return RETIRED_CHANNEL_REASONS.get(channelKey);
}

/**
 * Tag the ntfy outbound publisher stamps on every message it sends. The ntfy
 * inbound stream adapter drops messages carrying this tag so outbound
 * notifications are never echoed back in as inbound turns.
 */
export const NTFY_OUTBOUND_MARKER_TAG = "goatcitadel-outbound";

export type ChannelInboundMode = "none" | "webhook" | "gateway" | "poll" | "local_bridge" | "stream";

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
  /** Actions the platform itself cannot do, with the operator-facing reason. */
  platformUnsupportedActions: Partial<Record<ChannelActionName, string>>;
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
  /** Opaque revision of the complete saved catalog and shipped presets. */
  revision: string;
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

export interface PersonalityCatalogMutationInput extends PersonalityPresetMutationInput {
  expectedRevision: string;
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
