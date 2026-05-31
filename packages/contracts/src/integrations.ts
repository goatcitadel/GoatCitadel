import type { IntegrationFormSchema } from "./ui-forms.js";
import type { EvidenceEnvelopeSignatureStatus } from "./evidence.js";

export type AuthMode = "none" | "token" | "basic";
export type DeploymentProfile = "local_dev" | "trusted_local" | "remote_hardened";

export type GatewayAuthCredentialSource = "none" | "env" | "inline" | "runtime";

export interface GatewayAuthCredentialPlanEntry {
  configured: boolean;
  source: GatewayAuthCredentialSource;
  warning?: string;
}

export interface GatewayAuthCredentialPlan {
  mode: AuthMode;
  warnings: string[];
  token: GatewayAuthCredentialPlanEntry;
  basicUsername: GatewayAuthCredentialPlanEntry;
  basicPassword: GatewayAuthCredentialPlanEntry;
}

export type GatewayInstallTokenSource = "none" | "explicit" | "env" | "inline" | "runtime" | "generated";

export interface GatewayInstallTokenResolution {
  token?: string;
  source: GatewayInstallTokenSource;
  persistedToEnv: boolean;
  envPath?: string;
  warnings: string[];
  unavailableReason?: string;
}

export interface AuthRuntimeSettings {
  mode: AuthMode;
  allowLoopbackBypass: boolean;
  tokenConfigured: boolean;
  basicConfigured: boolean;
  plan: GatewayAuthCredentialPlan;
}

export interface AuthSettingsUpdateInput {
  mode?: AuthMode;
  allowLoopbackBypass?: boolean;
  token?: string;
  basicUsername?: string;
  basicPassword?: string;
}

export type IntegrationKind = "channel" | "model_provider" | "productivity" | "automation" | "platform";

export type IntegrationMaturity = "native" | "plugin" | "disabled" | "beta" | "planned";
export type IntegrationRuntimeAvailability = "runnable" | "blocked";
export type IntegrationConnectionStatus = "connected" | "disconnected" | "error" | "paused";

export interface IntegrationCatalogEntry {
  catalogId: string;
  kind: IntegrationKind;
  key: string;
  label: string;
  description: string;
  maturity: IntegrationMaturity;
  runtimeAvailability?: IntegrationRuntimeAvailability;
  authMethods: string[];
  capabilities: string[];
  docsUrl?: string;
  formSchema?: IntegrationFormSchema;
  pluginId?: string;
  operatorActions?: IntegrationOperatorAction[];
}

export interface IntegrationOperatorAction {
  actionId: string;
  label: string;
  description: string;
  capability: string;
  formSchema?: IntegrationFormSchema;
}

export interface IntegrationConnection {
  connectionId: string;
  catalogId: string;
  kind: IntegrationKind;
  key: string;
  label: string;
  enabled: boolean;
  status: IntegrationConnectionStatus;
  config: Record<string, unknown>;
  pluginId?: string;
  pluginVersion?: string;
  pluginEnabled?: boolean;
  createdAt: string;
  updatedAt: string;
  lastSyncAt?: string;
  lastError?: string;
}

export interface IntegrationConnectionCreateInput {
  catalogId: string;
  label?: string;
  enabled?: boolean;
  status?: IntegrationConnectionStatus;
  config?: Record<string, unknown>;
  pluginId?: string;
  pluginVersion?: string;
  pluginEnabled?: boolean;
}

export interface IntegrationConnectionUpdateInput {
  label?: string;
  enabled?: boolean;
  status?: IntegrationConnectionStatus;
  config?: Record<string, unknown>;
  pluginId?: string;
  pluginVersion?: string;
  pluginEnabled?: boolean;
  lastSyncAt?: string;
  lastError?: string | null;
}

export interface IntegrationActionInvokeInput {
  input?: Record<string, unknown>;
  idempotencyKey?: string;
}

export type IntegrationActionInvokeStatus = "executed" | "blocked" | "failed";
export type IntegrationExternalWritebackEnvelopeStatus = "recorded" | "unavailable" | "failed";
export type IntegrationExternalWritebackReplayPolicy = "audit_only" | "idempotent_external";
export type IntegrationExternalWritebackReplayOutcome =
  | "claimed"
  | "duplicate"
  | "in_progress"
  | "payload_mismatch"
  | "idempotency_unavailable";
export type IntegrationExternalWritebackResumeState =
  | "not_resumable"
  | "completed"
  | "manual_retry_after_recorded_failure"
  | "in_progress"
  | "payload_mismatch"
  | "idempotency_unavailable";

export interface IntegrationExternalWritebackEnvelope {
  status: IntegrationExternalWritebackEnvelopeStatus;
  intentId?: string;
  idempotencyKey?: string;
  replayPolicy: IntegrationExternalWritebackReplayPolicy;
  replayOutcome?: IntegrationExternalWritebackReplayOutcome;
  payloadHash?: string;
  resumable: boolean;
  resumeState?: IntegrationExternalWritebackResumeState;
  checkedAt: string;
  envelopeId?: string;
  contentHash?: string;
  signatureStatus?: EvidenceEnvelopeSignatureStatus;
  recordedAt?: string;
  reason?: string;
}

export interface IntegrationActionInvokeResult {
  connectionId: string;
  catalogId: string;
  actionId: string;
  status: IntegrationActionInvokeStatus;
  message: string;
  blockedReason?: string;
  output?: Record<string, unknown>;
  durableWriteback?: IntegrationExternalWritebackEnvelope;
  checkedAt: string;
}

export type DiscordRuntimeMode = "bridge" | "gateway";
export type DiscordInboundDmPolicy = "pairing" | "open" | "disabled";
export type DiscordGuildPolicy = "off" | "allowlist";

export interface DiscordGuildAccessRule {
  requireMention: boolean;
  users?: string[];
  roles?: string[];
  channels?: string[];
}

export interface DiscordIntegrationConfig {
  runtimeMode?: DiscordRuntimeMode;
  botToken?: string;
  botTokenEnv?: string;
  webhookUrl?: string;
  defaultChannelId?: string;
  defaultGuildId?: string;
  inboundDmPolicy?: DiscordInboundDmPolicy;
  guildPolicy?: DiscordGuildPolicy;
  guilds?: Record<string, DiscordGuildAccessRule>;
}

export type DiscordPairingStatus = "pending" | "approved" | "revoked";

export interface DiscordPairingRecord {
  pairingId: string;
  connectionId: string;
  userId: string;
  displayName?: string;
  code: string;
  status: DiscordPairingStatus;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  revokedAt?: string;
  lastInboundAt?: string;
}

export interface DiscordRuntimeStatus {
  connectionId: string;
  runtimeMode: DiscordRuntimeMode;
  enabled: boolean;
  ready: boolean;
  connectedBotId?: string;
  connectedBotTag?: string;
  guildIds: string[];
  lastReadyAt?: string;
  lastInboundAt?: string;
  lastReconnectAt?: string;
  lastError?: string;
}

export interface ChannelInboundMessageInput {
  eventId?: string;
  account: string;
  peer?: string;
  room?: string;
  threadId?: string;
  actorId: string;
  actorType?: "user" | "agent" | "system";
  role?: "user" | "assistant";
  content: string;
  displayName?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    costUsd?: number;
    providerId?: string;
    model?: string;
  };
  metadata?: Record<string, unknown>;
}

export type ObsidianIntegrationMode = "read_append" | "read_only";

export interface ObsidianIntegrationConfig {
  enabled: boolean;
  vaultPath: string;
  mode: ObsidianIntegrationMode;
  allowedSubpaths: string[];
}

export interface ObsidianIntegrationStatus extends ObsidianIntegrationConfig {
  vaultReachable: boolean;
  lastOperationAt?: string;
  lastError?: string;
  checkedAt: string;
}
