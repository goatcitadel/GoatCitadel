export type IntegrationPluginInstallSourceType = "local" | "npm" | "git" | "url" | "manual" | "unknown";
export type IntegrationPluginIntegrityStatus = "verified" | "missing" | "mismatch" | "unknown" | "not_applicable";
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

export interface IntegrationPluginRecord {
  pluginId: string;
  label: string;
  version: string;
  description?: string;
  source?: string;
  sourceMetadata?: IntegrationPluginSourceMetadata;
  integrityStatus?: IntegrationPluginIntegrityStatus;
  trustWarnings?: IntegrationPluginTrustWarning[];
  theme?: IntegrationPluginThemeMetadata;
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
  capabilities: string[];
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
}

export type ChannelActionName =
  | "channel.send"
  | "channel.reply"
  | "channel.react"
  | "channel.unsend"
  | "channel.typing"
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
  presence: boolean;
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
