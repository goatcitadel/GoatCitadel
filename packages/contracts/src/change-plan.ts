import type { ChatThinkingLevel } from "./chat.js";
import type { LlmApiStyle, LlmProviderAuthMode, LlmProviderCapabilities, LlmProviderGoogleCloudConfig } from "./llm.js";

/**
 * Public Change Plan contract for the Gateway-owned Evolution Control Plane.
 *
 * Every request is intentionally bounded and secret-free. A plan may point at
 * an existing owner record, but it can never carry a credential, OAuth token,
 * filesystem path, shell command, source patch, or arbitrary settings object.
 */
export const CHANGE_PLAN_SCHEMA_VERSION = 1 as const;

export const CHANGE_PLAN_KINDS = [
  "session_model",
  "installation_default_model",
  "provider_connection",
  "runtime_configuration",
  "channel_connection",
  "runtime_remediation",
  "capability_candidate",
  "improvement_candidate",
  "managed_source_registration",
  "product_source_update",
] as const;

export type ChangePlanKind = (typeof CHANGE_PLAN_KINDS)[number];

export const CHANGE_PLAN_STATUSES = [
  "draft",
  "awaiting_input",
  "awaiting_confirmation",
  "staging",
  "awaiting_approval",
  "applying",
  "verifying",
  "monitoring",
  "completed",
  /** One-release compatibility state for the original Chat Change Plan ledger. */
  "applied",
  "manual_required",
  "failed",
  "cancelled",
  "rolling_back",
  "rolled_back",
  "rollback_failed",
] as const;

export type ChangePlanStatus = (typeof CHANGE_PLAN_STATUSES)[number];

export const CHANGE_PLAN_PHASES = [
  "planning",
  "input",
  "confirmation",
  "staging",
  "authorization",
  "mutation",
  "validation",
  "monitoring",
  "recovery",
  "terminal",
] as const;

export type ChangePlanPhase = (typeof CHANGE_PLAN_PHASES)[number];
export type ChangePlanRisk = "safe" | "caution" | "danger";
export type ChangePlanOriginSurface = "chat" | "settings" | "system";

export type ChangePlanScope =
  | "current_chat"
  | "installation"
  | "provider"
  | "runtime"
  | "channel"
  | "remediation"
  | "capability"
  | "improvement"
  | "product_source";

export interface ChangePlanOrigin {
  readonly surface: ChangePlanOriginSurface;
  readonly workspaceId: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly actorId?: string;
  /** Gateway-issued request identity used for exactly-once plan creation. */
  readonly requestId?: string;
}

export interface ChangePlanAdapterRef {
  readonly adapterId: string;
  readonly version: number;
}

export interface ChangePlanTargetRef {
  readonly ownerId: string;
  readonly resourceId: string;
  readonly expectedRevision?: number;
  readonly expectedHash?: string;
}

export interface ChangePlanSessionModelRequest {
  readonly kind: "session_model";
  readonly providerId?: string;
  readonly model?: string;
  readonly thinkingLevel?: ChatThinkingLevel;
}

export interface ChangePlanInstallationDefaultModelRequest {
  readonly kind: "installation_default_model";
  readonly providerId: string;
  readonly model: string;
  /** Applies only to sessions created after this plan completes. */
  readonly thinkingLevel?: ChatThinkingLevel;
}

export interface ChangePlanProviderConnectionRequest {
  readonly kind: "provider_connection";
  readonly providerId: string;
  /** Optional credential lifecycle intent; the credential value is always captured by a dedicated owner. */
  readonly credentialAction?: "replace_api_key" | "replace_oauth" | "remove_api_key" | "remove_oauth";
  readonly credentialStorage?: "keychain" | "env";
  readonly credentialEnvVar?: string;
  readonly credentialDeleteScope?: "all" | "keychain" | "env" | "inline";
  /** Secret-free provider metadata. Credentials and transport auth never enter the plan. */
  readonly profile?: {
    readonly label?: string;
    readonly baseUrl?: string;
    readonly apiStyle?: LlmApiStyle;
    readonly authMode?: LlmProviderAuthMode;
    readonly defaultModel?: string;
    readonly apiKeyEnv?: string;
    readonly googleCloud?: LlmProviderGoogleCloudConfig;
    readonly capabilities?: Partial<LlmProviderCapabilities>;
  };
}

export const CHANGE_PLAN_RUNTIME_FEATURE_FLAGS = [
  "durableKernelV1Enabled",
  "replayOverridesV1Enabled",
  "memoryLifecycleAdminV1Enabled",
  "memoryLifecycleAutoForgetEnabled",
  "memoryMaintenanceV1Enabled",
  "connectorDiagnosticsV1Enabled",
  "computerUseGuardrailsV1Enabled",
  "cronReviewQueueV1Enabled",
  "replayRegressionV1Enabled",
  "codeModeV1Enabled",
  "improvementLedgerV1Enabled",
  "improvementActivationV1Enabled",
  "promptRetuneCampaignV1Enabled",
  "structuredReviewV2Enabled",
  "delegationScopeExpansionV1Enabled",
  "engineeringLearningsV1Enabled",
  "coworkRuntimeQualityV1Disabled",
  "orchestrationFinalStreamingV1Disabled",
  "autonomyV1Disabled",
  "plannerFastPathV1Disabled",
  "parallelToolExecutionV1Disabled",
  "streamIdleWatchdogV1Disabled",
  "plannerFanoutV1Disabled",
  "subagentFanoutV1Disabled",
  "durableChatFanoutV1Enabled",
  "evolutionControlPlaneV1Enabled",
  "improvementLocalObservationV1Enabled",
  "improvementModelEvaluationV1Enabled",
  "productSourceEvolutionV1Enabled",
  "chatTurnInterruptionRecoveryV1Disabled",
  "chatThinkingStreamV1Enabled",
  "unifiedComposerPaletteV1Enabled",
  "attachedContextToolsV1Enabled",
  "chatSessionStatusV1Enabled",
  "conversationForksV1Enabled",
  "notificationRoutingV1Enabled",
  "chatTimersV1Enabled",
  "typedRunVariablesV1Enabled",
  "documentEditingV1Enabled",
  "utilityModelRoutingV1Enabled",
  "cronEvidenceV1Enabled",
  "memoryConsolidationV1Enabled",
  "signalInboundV1Enabled",
  "channelVoiceInboundV1Enabled",
  "channelVoiceReplyV1Enabled",
  "externalSideEffectReplayJobsV1Disabled",
] as const;

export type ChangePlanRuntimeFeatureFlag = (typeof CHANGE_PLAN_RUNTIME_FEATURE_FLAGS)[number];

export interface ChangePlanMemoryConfiguration {
  readonly enabled?: boolean;
  readonly qmdEnabled?: boolean;
  readonly qmdApplyToChat?: boolean;
  readonly qmdApplyToOrchestration?: boolean;
  readonly qmdMaxContextTokens?: number;
  readonly qmdMinPromptChars?: number;
  readonly qmdCacheTtlSeconds?: number;
  readonly qmdDistillerProviderId?: string;
  readonly qmdDistillerModel?: string;
}

export interface ChangePlanFirecrawlConfiguration {
  readonly enabled?: boolean;
  readonly baseUrl?: string;
  readonly apiKeyEnv?: string;
  readonly timeoutMs?: number;
  readonly defaultReadBackend?: "native" | "firecrawl";
  readonly fallbackToNative?: boolean;
}

export interface ChangePlanMeshConfiguration {
  readonly enabled?: boolean;
  readonly mode?: "lan" | "wan" | "tailnet";
  readonly nodeId?: string;
  readonly mdns?: boolean;
  readonly staticPeers?: readonly string[];
  readonly requireMtls?: boolean;
  readonly tailnetEnabled?: boolean;
}

export interface ChangePlanNpuConfiguration {
  readonly enabled?: boolean;
  readonly autoStart?: boolean;
  readonly sidecarUrl?: string;
}

/** Deliberately excludes executable commands, arguments, and native paths. */
export interface ChangePlanLlamaCppConfiguration {
  readonly enabled?: boolean;
  readonly autoStart?: boolean;
  readonly baseUrl?: string;
  readonly alias?: string;
  readonly ctxSize?: number | null;
  readonly threads?: number | null;
  readonly gpuLayers?: number | null;
  readonly parallel?: number | null;
  readonly batchSize?: number | null;
  readonly ubatchSize?: number | null;
  readonly flashAttention?: boolean | null;
}

export type ChangePlanRuntimeConfigurationOperation =
  | { readonly operation: "tool_approval_mode"; readonly mode: "approve_all" | "approve_risky" | "bypass" }
  | { readonly operation: "budget_mode"; readonly mode: "saver" | "balanced" | "power" }
  | { readonly operation: "default_tool_profile"; readonly profileId: string }
  | { readonly operation: "deployment_profile"; readonly profile: "local_dev" | "trusted_local" | "remote_hardened" }
  | { readonly operation: "read_access_policy"; readonly mode: "roots_only" | "approval_required" | "full_disk" }
  | { readonly operation: "network_allowlist"; readonly entries: readonly string[] }
  | { readonly operation: "utility_model"; readonly providerId: string; readonly model: string }
  | {
      readonly operation: "gateway_auth_configuration";
      readonly mode: "none" | "token" | "basic";
      readonly allowLoopbackBypass: boolean;
      readonly basicUsername?: string;
      readonly replaceCredential?: boolean;
    }
  | { readonly operation: "memory_configuration"; readonly config: ChangePlanMemoryConfiguration }
  | { readonly operation: "web_firecrawl_configuration"; readonly config: ChangePlanFirecrawlConfiguration }
  | { readonly operation: "mesh_configuration"; readonly config: ChangePlanMeshConfiguration }
  | { readonly operation: "npu_configuration"; readonly config: ChangePlanNpuConfiguration }
  | { readonly operation: "llama_cpp_configuration"; readonly config: ChangePlanLlamaCppConfiguration }
  | {
      readonly operation: "feature_flag";
      readonly flag: ChangePlanRuntimeFeatureFlag;
      readonly enabled: boolean;
    };

export interface ChangePlanRuntimeConfigurationRequest {
  readonly kind: "runtime_configuration";
  readonly change: ChangePlanRuntimeConfigurationOperation;
}

/** Secrets and OAuth values stay in the channel owner's dedicated flows. */
export interface ChangePlanChannelConnectionRequest {
  readonly kind: "channel_connection";
  readonly channelKind: string;
  readonly draftId?: string;
}

export interface ChangePlanRuntimeRemediationRequest {
  readonly kind: "runtime_remediation";
  readonly remediationId: string;
}

/** A generated candidate remains inspectable-only until canonical activation. */
export interface ChangePlanCapabilityCandidateRequest {
  readonly kind: "capability_candidate";
  readonly proposalId: string;
  readonly action?: "activate" | "revoke" | "rollback";
  readonly versionId?: string;
}

export interface ChangePlanImprovementCandidateRequest {
  readonly kind: "improvement_candidate";
  readonly candidateId: string;
}

/** The native picker result is submitted through a dedicated private route. */
export interface ChangePlanManagedSourceRegistrationRequest {
  readonly kind: "managed_source_registration";
}

/** Identifies a previously registered install, never a path or patch. */
export interface ChangePlanProductSourceUpdateRequest {
  readonly kind: "product_source_update";
  readonly sourceInstallId: string;
  /** Sanitized operator goal. It is never a path, command, patch, or credential. */
  readonly changeSummary: string;
  /** Completed Code Mode run whose verified worktree is the staging source. */
  readonly codeModeRunId: string;
}

export type ChangePlanRequest =
  | ChangePlanSessionModelRequest
  | ChangePlanInstallationDefaultModelRequest
  | ChangePlanProviderConnectionRequest
  | ChangePlanRuntimeConfigurationRequest
  | ChangePlanChannelConnectionRequest
  | ChangePlanRuntimeRemediationRequest
  | ChangePlanCapabilityCandidateRequest
  | ChangePlanImprovementCandidateRequest
  | ChangePlanManagedSourceRegistrationRequest
  | ChangePlanProductSourceUpdateRequest;

export interface ChangePlanFormOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface ChangePlanPublicFormField {
  readonly fieldId: string;
  readonly label: string;
  readonly type: "text" | "number" | "boolean" | "select" | "url";
  readonly required?: boolean;
  readonly description?: string;
  readonly options?: readonly ChangePlanFormOption[];
  readonly initialValue?: string | number | boolean;
  /** Explicitly allows an env-var name in a secret-adjacent field such as botTokenEnv. */
  readonly valueSemantic?: "plain" | "environment_reference";
}

export interface ChangePlanSecureInputField {
  readonly fieldId: string;
  readonly label: string;
  readonly required?: boolean;
  readonly description?: string;
}

export type ChangePlanRequiredAction =
  | {
      readonly kind: "public_form";
      readonly actionId: string;
      readonly actionNonce: string;
      readonly title: string;
      readonly fields: readonly ChangePlanPublicFormField[];
      readonly submitLabel?: string;
    }
  | {
      readonly kind: "secure_input";
      readonly actionId: string;
      readonly actionNonce: string;
      readonly targetId: string;
      readonly title: string;
      readonly expiresAt: string;
      /** Labels only. Values use the dedicated no-store owner route. */
      readonly fields?: readonly ChangePlanSecureInputField[];
    }
  | {
      readonly kind: "oauth";
      readonly actionId: string;
      readonly actionNonce: string;
      readonly targetId: string;
      readonly title: string;
    }
  | {
      readonly kind: "native_path_picker";
      readonly actionId: string;
      readonly actionNonce: string;
      readonly purpose: "managed_source_registration";
      readonly title: string;
    }
  | {
      readonly kind: "confirmation";
      readonly actionId: string;
      readonly actionNonce: string;
      readonly title: string;
      readonly confirmationText: string;
      readonly purpose?: "apply" | "rollback";
    }
  | {
      readonly kind: "approval";
      readonly actionId: string;
      readonly actionNonce: string;
      readonly title: string;
      readonly risk: Extract<ChangePlanRisk, "caution" | "danger">;
      readonly approvalId?: string;
    }
  | {
      readonly kind: "artifact_review";
      readonly actionId: string;
      readonly actionNonce: string;
      readonly title: string;
      readonly artifactRefs: readonly string[];
    };

export interface ChangePlanResult {
  readonly summary: string;
  readonly appliedRevision?: number;
  readonly evidenceRefs?: readonly string[];
  readonly rollbackRef?: string;
  readonly failureCode?: string;
}

export interface ChangePlanRecord {
  readonly schemaVersion: typeof CHANGE_PLAN_SCHEMA_VERSION;
  readonly planId: string;
  readonly origin: ChangePlanOrigin;
  readonly adapter: ChangePlanAdapterRef;
  readonly kind: ChangePlanKind;
  readonly scope: ChangePlanScope;
  readonly status: ChangePlanStatus;
  readonly phase: ChangePlanPhase;
  /** Positive compare-and-swap revision for the aggregate. */
  readonly revision: number;
  /** Sanitized intent retained as `request` for Chat API compatibility. */
  readonly request: ChangePlanRequest;
  readonly intentHash: string;
  readonly target: ChangePlanTargetRef;
  readonly title: string;
  readonly summary: string;
  readonly impact: string;
  readonly risk: ChangePlanRisk;
  readonly requiredAction?: ChangePlanRequiredAction;
  readonly actionSnapshotHash?: string;
  readonly approvalRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly rollbackRefs: readonly string[];
  readonly result?: ChangePlanResult;
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly appliedAt?: string;
  /** Compatibility projections used by the original Chat-scoped API. */
  readonly sessionId?: string;
  readonly requesterActorId?: string;
  readonly expectedTargetRevision?: number;
}

export interface ChangePlanCreateInput {
  readonly origin: ChangePlanOrigin;
  readonly request: ChangePlanRequest;
  readonly idempotencyKey?: string;
}

export interface ChangePlanConfirmInput {
  readonly expectedRevision: number;
  readonly actionNonce: string;
}

export interface ChangePlanCancelInput {
  readonly expectedRevision: number;
  readonly actionNonce: string;
}

export interface ChangePlanResponseInput {
  readonly expectedRevision: number;
  readonly actionId: string;
  readonly actionNonce: string;
  /** Public, non-secret form values only. */
  readonly values: Readonly<Record<string, string | number | boolean>>;
}

export interface ChangePlanRollbackRequestInput {
  readonly expectedRevision: number;
}

/** Model-safe projection returned by the first-party `change.request` tool. */
export interface ChangePlanModelToolResult {
  readonly planId: string;
  readonly status: ChangePlanStatus;
  readonly requiredAction?: ChangePlanRequiredAction["kind"];
}

export function changePlanScopeForKind(kind: ChangePlanKind): ChangePlanScope {
  switch (kind) {
    case "session_model":
      return "current_chat";
    case "installation_default_model":
      return "installation";
    case "provider_connection":
      return "provider";
    case "runtime_configuration":
      return "runtime";
    case "channel_connection":
      return "channel";
    case "runtime_remediation":
      return "remediation";
    case "capability_candidate":
      return "capability";
    case "improvement_candidate":
      return "improvement";
    case "managed_source_registration":
    case "product_source_update":
      return "product_source";
  }
}

export function changePlanPhaseForStatus(status: ChangePlanStatus): ChangePlanPhase {
  switch (status) {
    case "draft":
      return "planning";
    case "awaiting_input":
      return "input";
    case "awaiting_confirmation":
      return "confirmation";
    case "staging":
      return "staging";
    case "awaiting_approval":
      return "authorization";
    case "applying":
      return "mutation";
    case "verifying":
      return "validation";
    case "monitoring":
      return "monitoring";
    case "rolling_back":
      return "recovery";
    case "completed":
    case "applied":
    case "manual_required":
    case "failed":
    case "cancelled":
    case "rolled_back":
    case "rollback_failed":
      return "terminal";
  }
}

export function isChangePlanStatus(value: unknown): value is ChangePlanStatus {
  return typeof value === "string" && (CHANGE_PLAN_STATUSES as readonly string[]).includes(value);
}

export function isChangePlanKind(value: unknown): value is ChangePlanKind {
  return typeof value === "string" && (CHANGE_PLAN_KINDS as readonly string[]).includes(value);
}

export function isChangePlanRequest(value: unknown): value is ChangePlanRequest {
  if (!isPlainObject(value) || !isChangePlanKind(value.kind)) return false;
  switch (value.kind) {
    case "session_model":
      return (
        hasOnlyKeys(value, ["kind", "providerId", "model", "thinkingLevel"]) &&
        isOptionalIdentifier(value.providerId) &&
        isOptionalIdentifier(value.model) &&
        (value.thinkingLevel === undefined || isChatThinkingLevel(value.thinkingLevel))
      );
    case "installation_default_model":
      return (
        hasOnlyKeys(value, ["kind", "providerId", "model", "thinkingLevel"]) &&
        isIdentifier(value.providerId) &&
        isIdentifier(value.model) &&
        (value.thinkingLevel === undefined || isChatThinkingLevel(value.thinkingLevel))
      );
    case "provider_connection":
      return (
        hasOnlyKeys(value, [
          "kind",
          "providerId",
          "profile",
          "credentialAction",
          "credentialStorage",
          "credentialEnvVar",
          "credentialDeleteScope",
        ]) &&
        isIdentifier(value.providerId) &&
        (value.profile === undefined || isProviderProfile(value.profile)) &&
        (value.credentialAction === undefined ||
          ["replace_api_key", "replace_oauth", "remove_api_key", "remove_oauth"].includes(
            String(value.credentialAction),
          )) &&
        (value.credentialStorage === undefined || ["keychain", "env"].includes(String(value.credentialStorage))) &&
        (value.credentialEnvVar === undefined || isEnvironmentReference(value.credentialEnvVar)) &&
        (value.credentialDeleteScope === undefined ||
          ["all", "keychain", "env", "inline"].includes(String(value.credentialDeleteScope))) &&
        !(
          ["remove_api_key", "remove_oauth"].includes(String(value.credentialAction)) &&
          (value.profile !== undefined || value.credentialStorage !== undefined || value.credentialEnvVar !== undefined)
        ) &&
        !(
          value.credentialAction === "replace_oauth" &&
          (value.profile !== undefined || value.credentialStorage !== undefined || value.credentialEnvVar !== undefined)
        ) &&
        !(value.credentialAction !== "remove_api_key" && value.credentialDeleteScope !== undefined)
      );
    case "runtime_configuration":
      return hasOnlyKeys(value, ["kind", "change"]) && isRuntimeConfigurationOperation(value.change);
    case "channel_connection":
      return (
        hasOnlyKeys(value, ["kind", "channelKind", "draftId"]) &&
        isIdentifier(value.channelKind) &&
        isOptionalIdentifier(value.draftId)
      );
    case "runtime_remediation":
      return hasOnlyKeys(value, ["kind", "remediationId"]) && isIdentifier(value.remediationId);
    case "capability_candidate":
      return (
        hasOnlyKeys(value, ["kind", "proposalId", "action", "versionId"]) &&
        isIdentifier(value.proposalId) &&
        (value.action === undefined || ["activate", "revoke", "rollback"].includes(String(value.action))) &&
        isOptionalIdentifier(value.versionId) &&
        !(["revoke", "rollback"].includes(String(value.action)) && value.versionId === undefined)
      );
    case "improvement_candidate":
      return hasOnlyKeys(value, ["kind", "candidateId"]) && isIdentifier(value.candidateId);
    case "managed_source_registration":
      return hasOnlyKeys(value, ["kind"]);
    case "product_source_update":
      return (
        hasOnlyKeys(value, ["kind", "sourceInstallId", "changeSummary", "codeModeRunId"]) &&
        isIdentifier(value.sourceInstallId) &&
        isIdentifier(value.codeModeRunId) &&
        isSanitizedEvolutionSummary(value.changeSummary)
      );
  }
}

export function isChangePlanResult(value: unknown): value is ChangePlanResult {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["summary", "appliedRevision", "evidenceRefs", "rollbackRef", "failureCode"])
  ) {
    return false;
  }
  return (
    isBoundedText(value.summary, 2_000) &&
    (value.appliedRevision === undefined || isPositiveInteger(value.appliedRevision)) &&
    (value.evidenceRefs === undefined || isReferenceList(value.evidenceRefs)) &&
    isOptionalBoundedText(value.rollbackRef, 512) &&
    isOptionalBoundedText(value.failureCode, 128)
  );
}

function isRuntimeConfigurationOperation(value: unknown): value is ChangePlanRuntimeConfigurationOperation {
  if (!isPlainObject(value) || typeof value.operation !== "string") return false;
  switch (value.operation) {
    case "tool_approval_mode":
      return (
        hasOnlyKeys(value, ["operation", "mode"]) &&
        ["approve_all", "approve_risky", "bypass"].includes(String(value.mode))
      );
    case "budget_mode":
      return hasOnlyKeys(value, ["operation", "mode"]) && ["saver", "balanced", "power"].includes(String(value.mode));
    case "default_tool_profile":
      return hasOnlyKeys(value, ["operation", "profileId"]) && isIdentifier(value.profileId);
    case "deployment_profile":
      return (
        hasOnlyKeys(value, ["operation", "profile"]) &&
        ["local_dev", "trusted_local", "remote_hardened"].includes(String(value.profile))
      );
    case "read_access_policy":
      return (
        hasOnlyKeys(value, ["operation", "mode"]) &&
        ["roots_only", "approval_required", "full_disk"].includes(String(value.mode))
      );
    case "network_allowlist":
      return hasOnlyKeys(value, ["operation", "entries"]) && isBoundedStringList(value.entries, 256, 512);
    case "utility_model":
      return (
        hasOnlyKeys(value, ["operation", "providerId", "model"]) &&
        isIdentifier(value.providerId) &&
        isIdentifier(value.model)
      );
    case "gateway_auth_configuration":
      return (
        hasOnlyKeys(value, ["operation", "mode", "allowLoopbackBypass", "basicUsername", "replaceCredential"]) &&
        ["none", "token", "basic"].includes(String(value.mode)) &&
        typeof value.allowLoopbackBypass === "boolean" &&
        (value.basicUsername === undefined || isBoundedText(value.basicUsername, 256)) &&
        (value.replaceCredential === undefined || typeof value.replaceCredential === "boolean") &&
        !(value.mode === "none" && (value.basicUsername !== undefined || value.replaceCredential === true)) &&
        !(value.mode === "token" && value.basicUsername !== undefined)
      );
    case "memory_configuration":
      return hasOnlyKeys(value, ["operation", "config"]) && isMemoryConfiguration(value.config);
    case "web_firecrawl_configuration":
      return hasOnlyKeys(value, ["operation", "config"]) && isFirecrawlConfiguration(value.config);
    case "mesh_configuration":
      return hasOnlyKeys(value, ["operation", "config"]) && isMeshConfiguration(value.config);
    case "npu_configuration":
      return hasOnlyKeys(value, ["operation", "config"]) && isNpuConfiguration(value.config);
    case "llama_cpp_configuration":
      return hasOnlyKeys(value, ["operation", "config"]) && isLlamaCppConfiguration(value.config);
    case "feature_flag":
      return (
        hasOnlyKeys(value, ["operation", "flag", "enabled"]) &&
        (CHANGE_PLAN_RUNTIME_FEATURE_FLAGS as readonly string[]).includes(String(value.flag)) &&
        typeof value.enabled === "boolean"
      );
    default:
      return false;
  }
}

function isMemoryConfiguration(value: unknown): boolean {
  if (
    !isNonEmptyPlainObject(value) ||
    !hasOnlyKeys(value, [
      "enabled",
      "qmdEnabled",
      "qmdApplyToChat",
      "qmdApplyToOrchestration",
      "qmdMaxContextTokens",
      "qmdMinPromptChars",
      "qmdCacheTtlSeconds",
      "qmdDistillerProviderId",
      "qmdDistillerModel",
    ])
  )
    return false;
  if (
    [value.enabled, value.qmdEnabled, value.qmdApplyToChat, value.qmdApplyToOrchestration].some(
      (item) => item !== undefined && typeof item !== "boolean",
    )
  )
    return false;
  if (value.qmdMaxContextTokens !== undefined && !isBoundedInteger(value.qmdMaxContextTokens, 1, 2_000_000))
    return false;
  if (value.qmdMinPromptChars !== undefined && !isBoundedInteger(value.qmdMinPromptChars, 0, 2_000_000)) return false;
  if (value.qmdCacheTtlSeconds !== undefined && !isBoundedInteger(value.qmdCacheTtlSeconds, 1, 31_536_000))
    return false;
  return isOptionalIdentifier(value.qmdDistillerProviderId) && isOptionalIdentifier(value.qmdDistillerModel);
}

function isFirecrawlConfiguration(value: unknown): boolean {
  if (
    !isNonEmptyPlainObject(value) ||
    !hasOnlyKeys(value, ["enabled", "baseUrl", "apiKeyEnv", "timeoutMs", "defaultReadBackend", "fallbackToNative"])
  )
    return false;
  if ([value.enabled, value.fallbackToNative].some((item) => item !== undefined && typeof item !== "boolean"))
    return false;
  if (value.baseUrl !== undefined && !isSafeProviderBaseUrl(value.baseUrl)) return false;
  if (value.apiKeyEnv !== undefined && !isEnvironmentReference(value.apiKeyEnv)) return false;
  if (value.timeoutMs !== undefined && !isBoundedInteger(value.timeoutMs, 100, 300_000)) return false;
  return value.defaultReadBackend === undefined || ["native", "firecrawl"].includes(String(value.defaultReadBackend));
}

function isMeshConfiguration(value: unknown): boolean {
  if (
    !isNonEmptyPlainObject(value) ||
    !hasOnlyKeys(value, ["enabled", "mode", "nodeId", "mdns", "staticPeers", "requireMtls", "tailnetEnabled"])
  )
    return false;
  if (
    [value.enabled, value.mdns, value.requireMtls, value.tailnetEnabled].some(
      (item) => item !== undefined && typeof item !== "boolean",
    )
  )
    return false;
  if (value.mode !== undefined && !["lan", "wan", "tailnet"].includes(String(value.mode))) return false;
  if (value.nodeId !== undefined && !isIdentifier(value.nodeId)) return false;
  return value.staticPeers === undefined || isBoundedStringList(value.staticPeers, 64, 2_048);
}

function isNpuConfiguration(value: unknown): boolean {
  if (!isNonEmptyPlainObject(value) || !hasOnlyKeys(value, ["enabled", "autoStart", "sidecarUrl"])) return false;
  if ([value.enabled, value.autoStart].some((item) => item !== undefined && typeof item !== "boolean")) return false;
  return value.sidecarUrl === undefined || isSafeProviderBaseUrl(value.sidecarUrl);
}

function isLlamaCppConfiguration(value: unknown): boolean {
  if (
    !isNonEmptyPlainObject(value) ||
    !hasOnlyKeys(value, [
      "enabled",
      "autoStart",
      "baseUrl",
      "alias",
      "ctxSize",
      "threads",
      "gpuLayers",
      "parallel",
      "batchSize",
      "ubatchSize",
      "flashAttention",
    ])
  )
    return false;
  if ([value.enabled, value.autoStart].some((item) => item !== undefined && typeof item !== "boolean")) return false;
  if (value.baseUrl !== undefined && !isSafeProviderBaseUrl(value.baseUrl)) return false;
  if (value.alias !== undefined && !isIdentifier(value.alias)) return false;
  if (value.flashAttention !== undefined && value.flashAttention !== null && typeof value.flashAttention !== "boolean")
    return false;
  for (const [key, min] of [
    ["ctxSize", 1],
    ["threads", 1],
    ["gpuLayers", 0],
    ["parallel", 1],
    ["batchSize", 1],
    ["ubatchSize", 1],
  ] as const) {
    const item = value[key];
    if (item !== undefined && item !== null && !isBoundedInteger(item, min, 2_000_000)) return false;
  }
  return true;
}

function isProviderProfile(value: unknown): boolean {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, [
      "label",
      "baseUrl",
      "apiStyle",
      "authMode",
      "defaultModel",
      "apiKeyEnv",
      "googleCloud",
      "capabilities",
    ])
  )
    return false;
  if (value.label !== undefined && !isBoundedText(value.label, 256)) return false;
  if (value.defaultModel !== undefined && !isIdentifier(value.defaultModel)) return false;
  if (value.apiKeyEnv !== undefined && !isEnvironmentReference(value.apiKeyEnv)) return false;
  if (value.baseUrl !== undefined && !isSafeProviderBaseUrl(value.baseUrl)) return false;
  if (
    value.apiStyle !== undefined &&
    ![
      "openai-chat-completions",
      "openai-responses",
      "openai-codex-responses",
      "anthropic-messages",
      "bedrock-messages",
    ].includes(String(value.apiStyle))
  )
    return false;
  if (
    value.authMode !== undefined &&
    !["api-key", "codex-oauth", "claude-code-oauth", "google-service-account", "google-adc"].includes(
      String(value.authMode),
    )
  )
    return false;
  if (value.googleCloud !== undefined && !isProviderGoogleCloud(value.googleCloud)) return false;
  return value.capabilities === undefined || isProviderCapabilities(value.capabilities);
}

function isProviderGoogleCloud(value: unknown): boolean {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["projectId", "projectIdEnv", "location", "locationEnv", "endpointId"])
  ) {
    return false;
  }
  return (
    [value.projectId, value.location, value.endpointId].every((item) => item === undefined || isIdentifier(item)) &&
    [value.projectIdEnv, value.locationEnv].every((item) => item === undefined || isEnvironmentReference(item))
  );
}

function isProviderCapabilities(value: unknown): boolean {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, [
      "vision",
      "audio",
      "video",
      "toolCalling",
      "jsonMode",
      "webSearch",
      "reasoning",
      "reasoningEfforts",
    ])
  )
    return false;
  const booleans = [
    value.vision,
    value.audio,
    value.video,
    value.toolCalling,
    value.jsonMode,
    value.webSearch,
    value.reasoning,
  ];
  if (booleans.some((item) => item !== undefined && typeof item !== "boolean")) return false;
  return (
    value.reasoningEfforts === undefined ||
    (Array.isArray(value.reasoningEfforts) &&
      value.reasoningEfforts.length > 0 &&
      value.reasoningEfforts.length <= 7 &&
      value.reasoningEfforts.every((item) =>
        ["none", "low", "medium", "high", "xhigh", "max", "ultra"].includes(String(item)),
      ))
  );
}

function isEnvironmentReference(value: unknown): boolean {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(value);
}

function isSafeProviderBaseUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyPlainObject(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && Object.keys(value).length > 0;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(value) &&
    !value.includes("..") &&
    !/^[A-Za-z]:[\\/]/u.test(value)
  );
}

function isOptionalIdentifier(value: unknown): value is string | undefined {
  return value === undefined || isIdentifier(value);
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\0]/u.test(value);
}

function isOptionalBoundedText(value: unknown, max: number): value is string | undefined {
  return value === undefined || isBoundedText(value, max);
}

function isSanitizedEvolutionSummary(value: unknown): value is string {
  if (!isBoundedText(value, 2_000)) return false;
  const text = value.trim();
  if (/diff --git|^@@|^---\s+[ab]\//imu.test(text)) return false;
  if (/(?:^|\s)(?:[A-Za-z]:[\\/]|\\\\[^\\]|\/(?:Users|home|etc|var|opt|tmp)\/)/u.test(text)) return false;
  if (/(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._~-]{16,})/iu.test(text)) return false;
  if (/^(?:\$|>|cmd(?:\.exe)?\s+\/c|powershell(?:\.exe)?\b|bash\s+-c|sh\s+-c|git\s+|pnpm\s+|npm\s+)/imu.test(text))
    return false;
  return true;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isBoundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function isBoundedStringList(value: unknown, maxItems: number, maxItemLength: number): value is readonly string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => isBoundedText(item, maxItemLength));
}

function isReferenceList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 64 && value.every((item) => isBoundedText(item, 512));
}

function isChatThinkingLevel(value: unknown): value is ChatThinkingLevel {
  return (
    typeof value === "string" && ["off", "minimal", "standard", "extended", "deep", "max", "ultra"].includes(value)
  );
}

/** Compatibility aliases for the original Chat-scoped vertical. */
export const CHAT_CHANGE_PLAN_KINDS = CHANGE_PLAN_KINDS;
export const CHAT_CHANGE_PLAN_STATUSES = CHANGE_PLAN_STATUSES;
export type ChatChangePlanKind = ChangePlanKind;
export type ChatChangePlanStatus = ChangePlanStatus;
export type ChatChangePlanScope = ChangePlanScope;
export type ChatChangePlanRequest = ChangePlanRequest;
export type ChatChangePlanResult = ChangePlanResult;
export type ChatChangePlanSessionModelRequest = ChangePlanSessionModelRequest;
export type ChatChangePlanInstallationDefaultModelRequest = ChangePlanInstallationDefaultModelRequest;
export type ChatChangePlanChannelConnectionRequest = ChangePlanChannelConnectionRequest;
export type ChatChangePlanCapabilityCandidateRequest = ChangePlanCapabilityCandidateRequest;
export type ChatChangePlanProductSourceUpdateRequest = ChangePlanProductSourceUpdateRequest;
export type ChatChangePlanRecord = ChangePlanRecord & {
  readonly sessionId: string;
  /** The compatibility API always issued expiring plans. */
  readonly expiresAt: string;
};
export interface ChatChangePlanCreateInput {
  readonly sessionId: string;
  readonly requesterActorId?: string;
  readonly request: ChatChangePlanRequest;
}
export type ChatChangePlanConfirmInput = ChangePlanConfirmInput;
export type ChatChangePlanCancelInput = ChangePlanCancelInput;
export const chatChangePlanScopeForKind = changePlanScopeForKind;
export const isChatChangePlanStatus = isChangePlanStatus;
export const isChatChangePlanKind = isChangePlanKind;
export const isChatChangePlanRequest = isChangePlanRequest;
export const isChatChangePlanResult = isChangePlanResult;
