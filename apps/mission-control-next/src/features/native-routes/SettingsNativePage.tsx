/* eslint-disable max-lines -- SettingsNativePage keeps the settings route frame, the per-section dispatcher, and the exported settings helpers that the helper test suites import; the section components themselves live in ./settings/sections/. */
import { useCallback } from "react";
import {
  providerTemplates,
  type AgenticRunListItem,
  type DemoBootstrapStateResponse,
  type EvidenceEnvelope,
  type DeviceAccessGrantRecord,
  type LlmProviderRequestConfig,
} from "@goatcitadel/contracts";
import type {
  ChannelSetupDefinition,
  IntegrationFormSchema,
  McpElicitationRequest,
  McpRemotePreviewResponse,
  McpServerModeManifestResponse,
  McpServerRecord,
  OnboardingState,
  FilesystemReadAccessMode,
  LocalOperatorOverrideScope,
  PersonalityPreset,
  PersonalityPresetCategory,
  PermissionProfileRecord,
  PermissionSurface,
  ToolApprovalMode,
  ToolProfile,
  ToolGrantRecord,
} from "@goatcitadel/contracts";
import {
  fetchDaemonStatus,
  fetchSettings,
  type OpenAICodexDeviceStartResponse,
  type OpenAICodexOAuthStatus,
} from "@goatcitadel/mission-control-shared/api/client";
import { getRouteReleaseScope, normalizeAppRoute, routeKicker, type AppRoute } from "@next/app/route-model";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import {
  describeDirtySections,
  useAnySectionDirty,
  useBeforeUnloadGuard,
  useNavigateGuard,
} from "./library/use-form-dirty";
import "./native-routes.css";
import { BudgetSection } from "./settings/sections/BudgetSection";
import { TrustPolicySection } from "./settings/sections/TrustPolicySection";
import { WorkspaceCapabilitiesSection } from "./settings/sections/WorkspaceCapabilitiesSection";
import { CitadelCapabilitiesSection } from "./settings/sections/CitadelCapabilitiesSection";
import { UnknownSettingsSection } from "./settings/sections/UnknownSettingsSection";
import { LocalAiSection } from "./settings/sections/LocalAiSection";
import { AccessSection } from "./settings/sections/AccessSection";
import { GeneralSection } from "./settings/sections/GeneralSection";
import { PersonalitiesSection } from "./settings/sections/PersonalitiesSection";
import { ChannelsSection } from "./settings/sections/ChannelsSection";
import { ToolsSection } from "./settings/sections/ToolsSection";
import { RuntimeSection } from "./settings/sections/RuntimeSection";
import { WorkspacesSection } from "./settings/sections/WorkspacesSection";
import { OnboardingSection } from "./settings/sections/OnboardingSection";
import { AddonsSection } from "./settings/sections/AddonsSection";
import { PermissionsSection } from "./settings/sections/PermissionsSection";
import { McpSection } from "./settings/sections/McpSection";
import { IntegrationsSection } from "./settings/sections/IntegrationsSection";
import { ProvidersSection } from "./settings/sections/ProvidersSection";
import {
  SettingsActionList,
  SettingsButtonRow,
  SettingsCodeBlock,
  SettingsConfigSourceLegend,
  SettingsEmptyState,
  SettingsField,
  SettingsFieldGrid,
  SettingsFilterBar,
  SettingsGrid,
  SettingsLoadWarnings,
  SettingsNotice,
  SettingsPageFrame,
  SettingsPosturePanel,
  SettingsSectionShell,
  SettingsStack,
  SettingsWizardSteps,
  descriptionForSettingsSection,
  formatEffectiveConfigSourceLabel,
  getErrorMessage,
  iconForSettingsSection,
  labelForSettingsSection,
  nativeLoad,
  nativeLoadIssues,
  useAsyncLoad,
  type LoadState,
  type NativeLoadIssue,
  type NativeLoadResult,
  type Notice,
  type SettingsNativePageProps,
  type SettingsSectionProps,
  type SettingsWizardStepState,
} from "./settings/SettingsShared";

export const TOOL_APPROVAL_MODE_OPTIONS: ToolApprovalMode[] = ["approve_all", "approve_risky", "bypass"];
export const TOOL_PROFILE_OPTIONS: ToolProfile[] = [
  "minimal",
  "standard",
  "coding",
  "ops",
  "research",
  "chat-agent",
  "danger",
];
export const BUDGET_MODE_OPTIONS: Array<OnboardingState["settings"]["budgetMode"]> = ["saver", "balanced", "power"];
const INTERNAL_APPROVAL_INBOX_URL = "goatcitadel://approval-inbox";

export type FirstRunEvidenceSnapshot = {
  recentRuns: AgenticRunListItem[];
  evidenceEnvelopes: EvidenceEnvelope[];
};

export function buildFirstRunEvidenceSnapshot(
  recentRuns: AgenticRunListItem[],
  evidenceEnvelopes: EvidenceEnvelope[],
): FirstRunEvidenceSnapshot {
  const runIds = new Set(recentRuns.map((run) => run.runId).filter((runId): runId is string => Boolean(runId)));
  return {
    recentRuns,
    evidenceEnvelopes: evidenceEnvelopes.filter((envelope) => {
      if (!envelope.runId) {
        return false;
      }
      return runIds.size === 0 || runIds.has(envelope.runId);
    }),
  };
}

export function SettingsNativePage(props: SettingsNativePageProps) {
  const section = props.route.section ? String(props.route.section) : "general";

  // Ship punchlist H-9 (data integrity) — wire unsaved-state plumbing for the
  // settings surface. The hook registry and beforeunload listener are tracked
  // in ./library/use-form-dirty.ts; sections opt in by calling `useFormDirty`.
  useBeforeUnloadGuard();
  const isSameRoute = useCallback(
    (target: AppRoute) =>
      target.area === props.route.area && (target.section ?? "general") === (props.route.section ?? "general"),
    [props.route.area, props.route.section],
  );
  const {
    navigate: guardedNavigate,
    pending,
    confirmDiscard,
    cancelDiscard,
  } = useNavigateGuard<AppRoute>(props.navigate, isSameRoute);
  const dirtyKeys = useAnySectionDirty();
  const guardedProps: SettingsNativePageProps = { ...props, navigate: guardedNavigate };

  return (
    <SettingsPageFrame
      icon={iconForSettingsSection(section)}
      kicker={routeKicker(normalizeAppRoute(props.route))}
      title={labelForSettingsSection(section)}
      description={descriptionForSettingsSection(section)}
      releaseStatus={getRouteReleaseScope(props.route).status}
    >
      {renderSettingsSection({ ...guardedProps, section })}
      <ConfirmModal
        open={pending !== null}
        title="Discard unsaved changes?"
        message={
          dirtyKeys.length > 0
            ? `You have unsaved changes in ${describeDirtySections(dirtyKeys)}.`
            : "You have unsaved changes."
        }
        confirmLabel="Discard changes"
        cancelLabel="Stay on this page"
        danger
        onConfirm={confirmDiscard}
        onCancel={cancelDiscard}
      />
    </SettingsPageFrame>
  );
}

function renderSettingsSection(props: SettingsSectionProps) {
  switch (props.section) {
    case "general":
      return <GeneralSection {...props} />;
    case "onboarding":
      return <OnboardingSection {...props} />;
    case "budget":
      return <BudgetSection {...props} />;
    case "providers":
      return <ProvidersSection {...props} />;
    case "local-ai":
      return <LocalAiSection {...props} />;
    case "personalities":
      return <PersonalitiesSection {...props} />;
    case "access":
      return <AccessSection {...props} />;
    case "permissions":
      return <PermissionsSection {...props} />;
    case "trust-policy":
      return <TrustPolicySection {...props} />;
    case "runtime":
      return <RuntimeSection {...props} />;
    case "workspaces":
      return <WorkspacesSection {...props} />;
    case "integrations":
      return <IntegrationsSection {...props} />;
    case "channels":
      return <ChannelsSection {...props} />;
    case "mcp":
      return <McpSection {...props} />;
    case "tools":
      return <ToolsSection {...props} />;
    case "addons":
      return <AddonsSection {...props} />;
    case "workspace-capabilities":
      return <WorkspaceCapabilitiesSection {...props} />;
    case "citadel-capabilities":
      return <CitadelCapabilitiesSection {...props} />;
    default:
      return <UnknownSettingsSection {...props} />;
  }
}

export type PersonalityEditorDraft = {
  id: string;
  label: string;
  category: PersonalityPresetCategory;
  description: string;
  tone: string;
  style: string;
  systemOverlay: string;
  safetyNotes: string;
};

export type ProviderEditorDraft = {
  providerId: string;
  label: string;
  baseUrl: string;
  apiStyle:
    | "openai-chat-completions"
    | "openai-responses"
    | "openai-codex-responses"
    | "anthropic-messages"
    | "bedrock-messages";
  defaultModel: string;
  apiKeyEnv: string;
};

const OPENAI_CODEX_OAUTH_FLOW_STORAGE_KEY = "goatcitadel:openai-codex:oauth-flow";
const OPENAI_CODEX_AUTH_HOST = "auth.openai.com";
export const OPENAI_CODEX_MIN_POLL_MS = 1_000;
const OPENAI_CODEX_DEFAULT_POLL_MS = 5_000;

export function createEmptyProviderEditorDraft(): ProviderEditorDraft {
  return {
    providerId: "",
    label: "",
    baseUrl: "",
    apiStyle: "openai-responses",
    defaultModel: "",
    apiKeyEnv: "",
  };
}

export function buildProviderEditorDraft(
  provider?: {
    providerId: string;
    label: string;
    baseUrl: string;
    apiStyle?:
      | "openai-chat-completions"
      | "openai-responses"
      | "openai-codex-responses"
      | "anthropic-messages"
      | "bedrock-messages";
    defaultModel: string;
    apiKeySource?: string;
    apiKeyRef?: string;
  } | null,
): ProviderEditorDraft {
  return {
    providerId: provider?.providerId ?? "",
    label: provider?.label ?? "",
    baseUrl: provider?.baseUrl ?? "",
    apiStyle: provider?.apiStyle ?? "openai-responses",
    defaultModel: provider?.defaultModel ?? "",
    apiKeyEnv: provider?.apiKeySource === "env" ? (provider.apiKeyRef ?? "") : "",
  };
}

export function buildChatGptOAuthProviderDraft(): ProviderEditorDraft {
  const template = providerTemplates.find((item) => item.providerId === "openai-codex");
  return {
    providerId: template?.providerId ?? "openai-codex",
    label: template?.label ?? "OpenAI Codex (ChatGPT OAuth)",
    baseUrl: template?.baseUrl ?? "https://chatgpt.com/backend-api/codex",
    apiStyle: template?.apiStyle === "openai-codex-responses" ? template.apiStyle : "openai-codex-responses",
    defaultModel: template?.defaultModel ?? "gpt-5.5",
    apiKeyEnv: "",
  };
}

export function isTrustedOpenAICodexVerificationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === OPENAI_CODEX_AUTH_HOST;
  } catch {
    return false;
  }
}

export function normalizeOpenAICodexPollDelayMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(value, OPENAI_CODEX_MIN_POLL_MS)
    : OPENAI_CODEX_DEFAULT_POLL_MS;
}

export function isStoredOpenAICodexOAuthFlow(value: unknown): value is OpenAICodexDeviceStartResponse {
  const candidate = value as OpenAICodexDeviceStartResponse;
  const expiresAt = Date.parse(candidate?.expiresAt);
  const userCode = candidate?.userCode;
  return (
    candidate?.providerId === "openai-codex" &&
    typeof candidate.flowId === "string" &&
    candidate.flowId.trim().length > 0 &&
    typeof candidate.verificationUrl === "string" &&
    isTrustedOpenAICodexVerificationUrl(candidate.verificationUrl) &&
    (userCode === undefined || (typeof userCode === "string" && userCode.trim().length > 0)) &&
    typeof candidate.expiresAt === "string" &&
    Number.isFinite(expiresAt) &&
    expiresAt > Date.now() &&
    typeof candidate.pollAfterMs === "number" &&
    Number.isFinite(candidate.pollAfterMs) &&
    candidate.pollAfterMs > 0
  );
}

export function removeStoredOpenAICodexOAuthFlow(storage: Storage | undefined): void {
  try {
    storage?.removeItem(OPENAI_CODEX_OAUTH_FLOW_STORAGE_KEY);
  } catch {
    // Ignore unavailable browser storage.
  }
}

function getBrowserStorage(kind: "localStorage" | "sessionStorage"): Storage | undefined {
  try {
    return globalThis[kind];
  } catch {
    return undefined;
  }
}

export function readStoredOpenAICodexOAuthFlowFrom(
  storage: Storage | undefined,
): OpenAICodexDeviceStartResponse | null {
  try {
    const raw = storage?.getItem(OPENAI_CODEX_OAUTH_FLOW_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isStoredOpenAICodexOAuthFlow(parsed)) {
      removeStoredOpenAICodexOAuthFlow(storage);
      return null;
    }
    return parsed;
  } catch {
    removeStoredOpenAICodexOAuthFlow(storage);
    return null;
  }
}

export function readStoredOpenAICodexOAuthFlow(): OpenAICodexDeviceStartResponse | null {
  const sessionFlow = readStoredOpenAICodexOAuthFlowFrom(getBrowserStorage("sessionStorage"));
  const localFlow = readStoredOpenAICodexOAuthFlowFrom(getBrowserStorage("localStorage"));
  return sessionFlow ?? localFlow;
}

export function writeStoredOpenAICodexOAuthFlow(flow: OpenAICodexDeviceStartResponse): void {
  try {
    getBrowserStorage("localStorage")?.setItem(OPENAI_CODEX_OAUTH_FLOW_STORAGE_KEY, JSON.stringify(flow));
    getBrowserStorage("sessionStorage")?.setItem(OPENAI_CODEX_OAUTH_FLOW_STORAGE_KEY, JSON.stringify(flow));
  } catch {
    // Browser storage is a convenience for refresh recovery; pairing still works without it.
  }
}

export function clearStoredOpenAICodexOAuthFlow(): void {
  removeStoredOpenAICodexOAuthFlow(getBrowserStorage("localStorage"));
  removeStoredOpenAICodexOAuthFlow(getBrowserStorage("sessionStorage"));
}

export function formatOpenAICodexOAuthExpiry(flow: OpenAICodexDeviceStartResponse | null): string | null {
  if (!flow) {
    return null;
  }
  const expiresAt = Date.parse(flow.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    return null;
  }
  const minutes = Math.max(1, Math.ceil((expiresAt - Date.now()) / 60_000));
  if (minutes > 240) {
    return null;
  }
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function isLikelyLocalProviderBaseUrl(baseUrl: string | undefined): boolean {
  const normalized = (baseUrl ?? "").trim().toLowerCase();
  return /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(normalized);
}

export function formatProviderProbeStateLabel(
  value?: "not_checked" | "ready" | "fallback" | "empty" | "error",
): string {
  switch (value) {
    case "ready":
      return "Verified";
    case "fallback":
      return "Suggested";
    case "empty":
      return "No models";
    case "error":
      return "Unreachable";
    default:
      return "Not checked";
  }
}

export function formatProviderProbeSourceMeta(provider?: {
  modelProbeState?: "not_checked" | "ready" | "fallback" | "empty" | "error";
  modelProbeSource?: "live" | "template_fallback" | "error_fallback";
  modelProbeCheckedAt?: string;
  modelProbeWarning?: string;
}): string {
  if (!provider) {
    return "Not checked yet";
  }
  if (provider.modelProbeSource === "error_fallback") {
    return provider.modelProbeWarning
      ? `Fallback after probe error: ${provider.modelProbeWarning}`
      : "Fallback after probe error";
  }
  if (provider.modelProbeState === "error") {
    return provider.modelProbeWarning
      ? `Live discovery failed: ${provider.modelProbeWarning}`
      : "Live discovery failed";
  }
  if (provider.modelProbeSource === "template_fallback" || provider.modelProbeState === "fallback") {
    return "Template suggestions; not account-verified";
  }
  return formatCheckedAtLabel(provider.modelProbeCheckedAt);
}

export function formatProviderModelsMeta(
  provider:
    | {
        modelProbeState?: "not_checked" | "ready" | "fallback" | "empty" | "error";
        modelProbeSource?: "live" | "template_fallback" | "error_fallback";
      }
    | undefined,
  modelCount: number,
): string {
  if (!provider || !provider.modelProbeState || provider.modelProbeState === "not_checked") {
    return "Not probed";
  }
  if (provider.modelProbeSource === "template_fallback" || provider.modelProbeState === "fallback") {
    return "Suggested, not account-verified";
  }
  if (provider.modelProbeSource === "error_fallback" || provider.modelProbeState === "error") {
    return "Probe failed";
  }
  if (provider.modelProbeState === "empty") {
    return "No verified model list";
  }
  if (provider.modelProbeState === "ready" && provider.modelProbeSource === "live") {
    return modelCount > 0 ? "Live verified" : "No verified model list";
  }
  return modelCount > 0 ? "Suggested, not account-verified" : "No verified model list";
}

export function formatCheckedAtLabel(value?: string): string {
  if (!value) {
    return "Not checked yet";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "Last check unavailable";
  }
  return `Checked ${parsed.toLocaleString()}`;
}

export function formatProviderCredentialLabel(
  providerId: string,
  hasApiKey: boolean | undefined,
  codexOAuthStatus: OpenAICodexOAuthStatus | null,
): string {
  if (providerId === "claude-code") {
    return hasApiKey ? "OAuth token ready" : "OAuth token missing";
  }
  if (providerId === "openai-codex") {
    if (codexOAuthStatus?.connected) {
      return "OAuth connected";
    }
    if (codexOAuthStatus?.requiresReauth) {
      return "OAuth reauth";
    }
    return "OAuth missing";
  }
  return hasApiKey ? "secret ready" : "secret missing";
}

type ProviderSmokeEvidenceInput = {
  providerId: string;
  providerLabel: string;
  credentialReady: boolean;
  credentialMeta: string;
  localEndpoint: boolean;
  modelCount: number;
  modelProbeState?: "not_checked" | "ready" | "fallback" | "empty" | "error";
  modelProbeSource?: "live" | "template_fallback" | "error_fallback";
  modelProbeCheckedAt?: string;
  modelProbeWarning?: string;
  request?: LlmProviderRequestConfig;
};

export function describeProviderRequestOverrides(request?: LlmProviderRequestConfig): string {
  if (!request) {
    return "Default gateway transport";
  }
  const parts: string[] = [];
  if (request.auth) {
    parts.push(`${request.auth.type} auth`);
  }
  const headerCount = Object.keys(request.headers ?? {}).length;
  if (headerCount > 0) {
    parts.push(`${headerCount} header${headerCount === 1 ? "" : "s"}`);
  }
  if (request.proxy?.url) {
    parts.push("proxy");
  }
  if (request.tls) {
    const tlsParts = [
      request.tls.caCertPath ? "CA cert" : "",
      request.tls.clientCertPath ? "client cert" : "",
      request.tls.serverName ? "server name" : "",
      request.tls.insecureSkipVerify ? "skip verify" : "",
    ].filter(Boolean);
    parts.push(tlsParts.length ? `TLS ${tlsParts.join("/")}` : "TLS override");
  }
  return parts.length ? parts.join(", ") : "Default gateway transport";
}

export function deriveProviderSmokeEvidenceItems(input: ProviderSmokeEvidenceInput): Array<{
  id: string;
  label: string;
  description: string;
  meta: string;
  actionLabel: string;
}> {
  const providerLabel = input.providerLabel || input.providerId;
  const probeDescriptor = formatProviderProbeSourceMeta(input);
  const modelMeta = formatProviderModelsMeta(input, input.modelCount);
  const discoveryFailed = input.modelProbeState === "error" || input.modelProbeSource === "error_fallback";
  const liveDiscoveryReady = input.modelProbeState === "ready" && input.modelProbeSource === "live";
  const transportDescription = describeProviderRequestOverrides(input.request);

  return [
    {
      id: "credential",
      label: "Credential or local endpoint",
      description: input.credentialReady
        ? `${providerLabel} has a configured provider key, OAuth credential, or reachable local endpoint.`
        : `${providerLabel} is not configured for sends yet; add a key, finish OAuth, or point it at a local endpoint.`,
      meta: input.credentialMeta,
      actionLabel: input.credentialReady ? "Ready" : "Needed",
    },
    {
      id: "model-discovery",
      label: "Model discovery",
      description: liveDiscoveryReady
        ? `Live discovery returned ${input.modelCount} account-visible model${input.modelCount === 1 ? "" : "s"}.`
        : discoveryFailed
          ? probeDescriptor
          : "Refresh models after provider keys, proxy, and TLS settings are saved.",
      meta: modelMeta,
      actionLabel: liveDiscoveryReady ? "Refresh" : "Check",
    },
    {
      id: "provider-smoke",
      label: "Provider smoke evidence",
      description: !input.credentialReady
        ? "Blocked until the provider has a credential or local endpoint."
        : discoveryFailed
          ? "Blocked by model discovery failure; fix auth, proxy, TLS, or provider URL before making setup claims."
          : liveDiscoveryReady
            ? "Ready for the first configured-provider smoke send; keep pass/fail evidence with the setup record."
            : "Needs a live model discovery or smoke check before public readiness claims.",
      meta: input.credentialReady && liveDiscoveryReady ? "Smoke next" : "Proof required",
      actionLabel: input.credentialReady ? "Probe" : "Blocked",
    },
    {
      id: "transport",
      label: "Auth/proxy/TLS path",
      description:
        transportDescription === "Default gateway transport"
          ? "Using the default gateway transport; model errors will appear in the probe notice and cached evidence."
          : `Custom request path: ${transportDescription}. Save errors and model probe errors are shown as readable operator notices.`,
      meta: transportDescription,
      actionLabel: "Inspect",
    },
  ];
}

type AccessSettingsSnapshot = Awaited<ReturnType<typeof fetchSettings>>;
type DaemonStatusSnapshot = Awaited<ReturnType<typeof fetchDaemonStatus>>;

type DesktopMobileContinuityItem = {
  id: string;
  label: string;
  description: string;
  meta: string;
  actionLabel: string;
};

export function deriveDesktopMobileContinuityItems(input: {
  settings: AccessSettingsSnapshot;
  grants: DeviceAccessGrantRecord[];
  daemon: DaemonStatusSnapshot | null;
}): DesktopMobileContinuityItem[] {
  const activeGrants = input.grants.filter((grant) => !grant.revokedAt);
  const mobileGrants = activeGrants.filter((grant) => ["mobile", "tablet"].includes(grant.deviceType));
  const desktopGrants = activeGrants.filter((grant) => grant.deviceType === "desktop");
  const authConfigured =
    (input.settings.auth?.mode === "token" && input.settings.auth?.tokenConfigured) ||
    (input.settings.auth?.mode === "basic" && input.settings.auth?.basicConfigured);
  return [
    {
      id: "desktop-runtime",
      label: "Desktop runtime anchor",
      description: input.daemon
        ? `Gateway daemon is ${input.daemon.state}; host ${input.daemon.host || "unknown"} owns the local runtime boundary.`
        : "Gateway daemon status could not be loaded, so companion devices cannot inspect desktop runtime truth here.",
      meta: input.daemon?.running ? "Desktop ready" : "Needs desktop proof",
      actionLabel: input.daemon?.running ? "Ready" : "Check runtime",
    },
    {
      id: "mobile-trust",
      label: "Mobile approval path",
      description: mobileGrants.length
        ? `${mobileGrants.length} active mobile/tablet device grant(s) can reach the gateway under this auth posture.`
        : "No active mobile/tablet grants are visible; approve a companion device before claiming mobile approvals.",
      meta: mobileGrants.length ? "Access-gated" : "No mobile grant",
      actionLabel: mobileGrants.length ? "Ready" : "Needs grant",
    },
    {
      id: "desktop-device-trust",
      label: "Desktop handoff trust",
      description: desktopGrants.length
        ? `${desktopGrants.length} active desktop device grant(s) are visible for browser or shell handoff.`
        : "Desktop continuity currently relies on the local session and daemon, not an additional device grant.",
      meta: desktopGrants.length ? "Device trust" : "Local session",
      actionLabel: desktopGrants.length ? "Granted" : "Local only",
    },
    {
      id: "install-token",
      label: "Install token lane",
      description: authConfigured
        ? "Auth posture is configured enough to pair companion clients through the install-token/device-request flow."
        : "Auth is open; generate and protect an install token before exposing companion access.",
      meta: input.settings.auth?.mode ?? "unknown",
      actionLabel: authConfigured ? "Pairable" : "Open local",
    },
    {
      id: "share-session-handoff",
      label: "Share/session handoff",
      description:
        "Mobile share intake and Work result handoff must land through gateway-owned sessions, projects, artifacts, and approvals.",
      meta: "Gateway-owned",
      actionLabel: "Boundary",
    },
  ];
}

export type PermissionProfileEditorDraft = {
  label: string;
  description: string;
  approvalMode: ToolApprovalMode;
  toolPatterns: string;
  allow: string;
  deny: string;
  readAccessMode: FilesystemReadAccessMode | "";
  defaultForSurfaces: PermissionSurface[];
};

export function collectDefinitionFieldHints(definition: ChannelSetupDefinition) {
  const fields = definition.wizard.steps.flatMap((step) => step.fields ?? []);
  return fields.slice(0, 10).map((field) => ({
    label: field.label,
    explanation: field.explanation,
    type: field.type,
  }));
}

export function matchesToolGrant(grant: ToolGrantRecord, toolName: string) {
  const pattern = grant.toolPattern.trim();
  if (!pattern) {
    return false;
  }
  if (pattern === "*") {
    return true;
  }
  if (!pattern.includes("*")) {
    return pattern === toolName;
  }
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(toolName);
}

export function isToolGrantAvailable(grant: ToolGrantRecord, nowMs = Date.now()) {
  if (grant.revokedAt) {
    return false;
  }
  if (grant.expiresAt) {
    const expiry = Date.parse(grant.expiresAt);
    if (Number.isFinite(expiry) && expiry <= nowMs) {
      return false;
    }
  }
  if (grant.grantType === "one_time") {
    return (grant.usesRemaining ?? 0) > 0;
  }
  return true;
}

export function describeToolGrantAvailability(grant: ToolGrantRecord, nowMs = Date.now()) {
  if (grant.revokedAt) {
    return `revoked ${formatDateTime(grant.revokedAt)}`;
  }
  if (grant.expiresAt) {
    const expiry = Date.parse(grant.expiresAt);
    if (Number.isFinite(expiry) && expiry <= nowMs) {
      return `expired ${formatDateTime(grant.expiresAt)}`;
    }
  }
  if (grant.grantType === "one_time" && (grant.usesRemaining ?? 0) <= 0) {
    return "exhausted";
  }
  return "available";
}

export function defaultToolGrantExpiry(nowMs = Date.now()) {
  return new Date(nowMs + 60 * 60 * 1000).toISOString();
}

export function parseJsonObject(value: string, fallback: Record<string, unknown> = {}) {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = JSON.parse(trimmed);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Value must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export function splitCommaList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function splitLineList(value: string) {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function splitLineOrCommaList(value: string) {
  return value
    .split(/\r?\n|,/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function createEmptyPermissionProfileDraft(): PermissionProfileEditorDraft {
  return {
    label: "",
    description: "",
    approvalMode: "approve_all",
    toolPatterns: "session.status\nmemory.read",
    allow: "",
    deny: "",
    readAccessMode: "",
    defaultForSurfaces: [],
  };
}

export function createPermissionProfileDraftFromRecord(profile: PermissionProfileRecord): PermissionProfileEditorDraft {
  return {
    label: profile.label,
    description: profile.description ?? "",
    approvalMode: profile.approvalMode,
    toolPatterns: profile.toolPatterns.join("\n"),
    allow: (profile.allow ?? []).join("\n"),
    deny: (profile.deny ?? []).join("\n"),
    readAccessMode: profile.readAccessMode ?? "",
    defaultForSurfaces: profile.defaultForSurfaces ?? [],
  };
}

export function permissionProfileDraftToMutation(draft: PermissionProfileEditorDraft) {
  const description = draft.description.trim();
  return {
    label: draft.label.trim(),
    description: description || undefined,
    approvalMode: draft.approvalMode,
    toolPatterns: splitLineOrCommaList(draft.toolPatterns),
    allow: splitLineOrCommaList(draft.allow),
    deny: splitLineOrCommaList(draft.deny),
    readAccessMode: draft.readAccessMode || undefined,
    defaultForSurfaces: draft.defaultForSurfaces,
  };
}

export function togglePermissionProfileSurface(
  current: PermissionSurface[],
  surface: PermissionSurface,
  checked: boolean,
): PermissionSurface[] {
  if (checked) {
    return current.includes(surface) ? current : [...current, surface];
  }
  return current.filter((item) => item !== surface);
}

export function deriveSetupCenterItems(onboarding: OnboardingState): Array<{
  label: string;
  description: string;
  state: SettingsWizardStepState;
}> {
  const checklistById = new Map((onboarding.checklist ?? []).map((item) => [item.id, item]));
  const providersWithKeys = (onboarding.settings?.llm?.providers ?? []).filter((provider) => provider.hasApiKey).length;
  const authMode = onboarding.settings?.auth?.mode ?? "none";
  return [
    {
      label: "Provider smoke",
      description:
        providersWithKeys > 0
          ? `${providersWithKeys} provider credential source available. Active model: ${
              onboarding.settings?.llm?.activeModel || "unset"
            }.`
          : "No provider credentials required for demo/local paths; add one before cloud sends.",
      state: wizardStateForChecklist(checklistById.get("llm")?.status),
    },
    {
      label: "Local runtime",
      description: checklistById.get("runtime")?.detail ?? "Gateway and bundled runtime health are checked locally.",
      state: wizardStateForChecklist(checklistById.get("runtime")?.status),
    },
    {
      label: "Access and auth",
      description:
        authMode === "none"
          ? "Local access is open; add gateway auth before exposing the app."
          : `${authMode} gateway auth configured.`,
      state: wizardStateForChecklist(checklistById.get("auth")?.status),
    },
    {
      label: "Channels and MCP",
      description: "Optional connectors stay off until explicitly configured and checked.",
      state: "pending",
    },
    {
      label: "Share readiness",
      description: "Unsigned builds need checksums, install checks, screenshots, and notes before sharing.",
      state: "pending",
    },
  ];
}

type FirstOutcomePathItem = {
  id: string;
  label: string;
  description: string;
  actionDescription: string;
  state: SettingsWizardStepState;
  meta: string;
  actionLabel: string;
  route: AppRoute;
};

export type FirstRunGovernedJobState =
  | "provider-ready"
  | "provider-missing"
  | "demo/local"
  | "first-task-pending"
  | "proof-complete";

type OnboardingProviderSmokeEvidenceItem = {
  id: string;
  label: string;
  description: string;
  state: SettingsWizardStepState;
  meta: string;
};

type EcosystemProofLaneItem = {
  id: string;
  label: string;
  description: string;
  meta: string;
  actionLabel: string;
  route: AppRoute;
};

export function deriveEcosystemProofLaneItems(): EcosystemProofLaneItem[] {
  return [
    {
      id: "voice",
      label: "Voice Wake / Talk Mode",
      description:
        "Select/install a local voice runtime and keep wake/talk proof before claiming voice parity beyond local runtime support.",
      meta: "First follow-on lane",
      actionLabel: "Runtime",
      route: { area: "settings", section: "runtime" },
    },
    {
      id: "browser-control",
      label: "Browser control",
      description:
        "Use governed tools/MCP visibility for browser control. Remote browser automation claims need fresh proof.",
      meta: "Tool-governed",
      actionLabel: "MCP",
      route: { area: "settings", section: "mcp" },
    },
    {
      id: "extension-sdk",
      label: "Extension / plugin SDK breadth",
      description:
        "Keep extension claims aligned with installed plugin trust metadata, diagnostics, and @goatcitadel/extensions-sdk evidence.",
      meta: "Catalog-gated",
      actionLabel: "Integrations",
      route: { area: "settings", section: "integrations" },
    },
    {
      id: "packaging-remote",
      label: "Packaging and remote deployment parity",
      description:
        "Windows packaging is the shipped lane; remote, macOS, and Linux claims stay blocked until their named packaging proof passes.",
      meta: "Proof-lane required",
      actionLabel: "Ops",
      route: { area: "ops", section: "diagnostics" },
    },
    {
      id: "mobile-companion",
      label: "Mobile companion/device surfaces",
      description:
        "Use signed device grants and companion-session auth; mobile companion surfaces are not an ungoverned backend shortcut.",
      meta: "Access-gated",
      actionLabel: "Access",
      route: { area: "settings", section: "access" },
    },
    {
      id: "canvas-a2ui",
      label: "Canvas / A2UI parity",
      description:
        "Canvas/A2UI parity needs Mission Control proof and companion runtime evidence before platform-level claims are visible.",
      meta: "Last follow-on lane",
      actionLabel: "Capabilities",
      route: { area: "library", section: "capabilities" },
    },
  ];
}

export function deriveFirstOutcomePathItems(
  onboarding: OnboardingState,
  demoState: DemoBootstrapStateResponse | null,
  firstRunEvidence: FirstRunEvidenceSnapshot = EMPTY_FIRST_RUN_EVIDENCE,
): FirstOutcomePathItem[] {
  const llmSettings = onboarding.settings?.llm;
  const activeProvider = (llmSettings?.providers ?? []).find(
    (provider) => provider.providerId === llmSettings?.activeProviderId,
  );
  const activeModel = (llmSettings?.activeModel ?? "").trim();
  const localEndpointReady = Boolean(activeProvider && isLikelyLocalProviderBaseUrl(activeProvider.baseUrl));
  const cloudProviderReady = Boolean(activeProvider?.hasApiKey);
  const providerCredentialReady = Boolean(activeProvider && (cloudProviderReady || localEndpointReady));
  const providerConnected = Boolean(activeProvider && activeModel && providerCredentialReady);
  const demoSessions = demoState?.sessions ?? [];
  const demoTasks = demoState?.tasks ?? [];
  const demoReady = demoState?.status === "ready";
  const hasChatStart = demoSessions.some((session) => session.mode === "chat");
  const hasCoworkStart = demoSessions.some((session) => session.mode === "cowork");
  const hasCodeStart = demoSessions.some((session) => session.mode === "code");
  const hasSeededStartContext = Boolean(demoTasks.length > 0 || hasChatStart || hasCoworkStart || hasCodeStart);
  const hasProjectCreation = Boolean(demoState?.project?.projectId || demoState?.project?.workspacePath);
  const providerFailure = describeProviderReadinessFailure(onboarding);
  const latestProof = firstRunEvidence.evidenceEnvelopes[0];
  const proofRun = findRunForEvidence(firstRunEvidence.recentRuns, latestProof);
  const proofRoute = routeForFirstRunEvidence(proofRun, latestProof);
  const firstTaskRun = findFirstRunTaskCandidate(firstRunEvidence.recentRuns, demoSessions, demoTasks);
  const firstTaskSession = pickFirstRunDemoSession(demoSessions);
  const firstTaskRoute = routeForFirstTask(firstTaskRun, firstTaskSession);
  const firstTaskActionLabel = firstTaskRun?.runId
    ? "Open Run Detail"
    : firstTaskSession
      ? `Open ${surfaceLabel(firstTaskSession.mode)}`
      : "Open Plan";

  return [
    {
      id: "provider-ready",
      label: "Provider-ready path",
      description: providerConnected
        ? `${activeProvider?.label ?? llmSettings?.activeProviderId} is selected with ${activeModel}; risky actions still stay approval-governed.`
        : providerFailure,
      actionDescription: "Open Providers & Models to choose a provider, model, secret source, or local endpoint.",
      state: providerCredentialReady ? "complete" : "active",
      meta: providerConnected ? "provider-ready" : "provider-missing",
      actionLabel: "Configure",
      route: { area: "settings", section: "providers" },
    },
    {
      id: "provider-missing",
      label: "Provider missing fallback",
      description:
        providerCredentialReady || demoReady
          ? "The fallback remains available for local inspection without provider credentials."
          : "No provider or local endpoint is configured. Use the safe demo/local path before cloud-backed sends.",
      actionDescription:
        "Start or reopen the safe local demo path; it seeds inspectable data and does not send work to a cloud provider.",
      state: providerCredentialReady ? "pending" : demoReady ? "complete" : "active",
      meta: providerCredentialReady ? "provider-ready" : "provider-missing",
      actionLabel: "Start demo/local",
      route: { area: "settings", section: "onboarding" },
    },
    {
      id: "demo-local",
      label: "Demo/local path",
      description:
        demoReady || localEndpointReady
          ? "A demo workspace or local endpoint is available for truthful first-run inspection."
          : "Start the safe demo or configure a local OpenAI-compatible endpoint when no provider key is available.",
      actionDescription: "Open the local-first path for sample Work, memory, and project context.",
      state: demoReady || localEndpointReady ? "complete" : providerCredentialReady ? "pending" : "active",
      meta: "demo/local",
      actionLabel: demoReady ? "Open demo" : "Start demo",
      route: { area: "settings", section: "onboarding" },
    },
    {
      id: "first-task-pending",
      label: "First Work task",
      description: firstTaskRun
        ? `A recent durable ${surfaceLabel(firstTaskRun.surface).toLowerCase()} exists; inspect Run Detail before treating proof as complete.`
        : firstTaskSession
          ? `A safe demo ${surfaceLabel(firstTaskSession.mode)} thread exists; open it and run the first supervised task from seeded context.`
          : hasSeededStartContext
            ? "Starter context exists; run a governed Work task before treating this step as complete."
            : "Create the first low-risk Work task after provider/local readiness is explicit.",
      actionDescription: firstTaskRun
        ? "Open the durable run detail projection for timeline, approvals, tools, artifacts, and remaining proof gaps."
        : firstTaskSession
          ? "Open the seeded demo thread; it is local/sample context and does not count as proof until a run records evidence."
          : "Open Work for the first supervised task, then choose Conversation, Plan, or Build posture.",
      state: firstTaskRun ? "complete" : providerConnected || demoReady || localEndpointReady ? "active" : "pending",
      meta: firstTaskRun ? "recent-run-found" : hasSeededStartContext ? "starter-ready" : "first-task-pending",
      actionLabel: firstTaskActionLabel,
      route: firstTaskRoute,
    },
    {
      id: "proof-complete",
      label: "Proof artifact or trace",
      description: latestProof
        ? `Evidence envelope ${shortEvidenceId(latestProof.envelopeId)} records ${latestProof.eventKind}${
            latestProof.runId ? ` for run ${shortEvidenceId(latestProof.runId)}` : ""
          }.`
        : "No proof artifact or trace is recorded yet. A first-run task is not complete until evidence exists.",
      actionDescription: latestProof
        ? "Open the linked run surface and use Run details or artifacts to inspect retained evidence."
        : "Open generated artifacts or the Work proof panel after a governed task records evidence.",
      state: latestProof ? "complete" : firstTaskRun || hasProjectCreation ? "active" : "pending",
      meta: latestProof ? "proof-complete" : "proof-needed",
      actionLabel: latestProof ? "Open Run Detail" : "Inspect proof",
      route: latestProof ? proofRoute : { area: "library", section: "artifacts" },
    },
  ];
}

const EMPTY_FIRST_RUN_EVIDENCE: FirstRunEvidenceSnapshot = {
  recentRuns: [],
  evidenceEnvelopes: [],
};

export function deriveFirstRunGovernedJobState(
  onboarding: OnboardingState,
  demoState: DemoBootstrapStateResponse | null,
  firstRunEvidence: FirstRunEvidenceSnapshot = EMPTY_FIRST_RUN_EVIDENCE,
): FirstRunGovernedJobState {
  if (firstRunEvidence.evidenceEnvelopes.length > 0) {
    return "proof-complete";
  }
  const llmSettings = onboarding.settings?.llm;
  const activeProvider = (llmSettings?.providers ?? []).find(
    (provider) => provider.providerId === llmSettings?.activeProviderId,
  );
  const activeModel = (llmSettings?.activeModel ?? "").trim();
  const providerReady = Boolean(
    activeProvider && activeModel && (activeProvider.hasApiKey || isLikelyLocalProviderBaseUrl(activeProvider.baseUrl)),
  );
  const demoReady = demoState?.status === "ready";
  const taskStarted = firstRunEvidence.recentRuns.length > 0;
  if (taskStarted && (providerReady || demoReady)) {
    return "first-task-pending";
  }
  if (activeProvider && activeModel && isLikelyLocalProviderBaseUrl(activeProvider.baseUrl)) {
    return "demo/local";
  }
  if (providerReady) {
    return "provider-ready";
  }
  return demoReady ? "demo/local" : "provider-missing";
}

function findRunForEvidence(runs: AgenticRunListItem[], evidence: EvidenceEnvelope | undefined) {
  if (!evidence?.runId) {
    return undefined;
  }
  return runs.find((run) => run.runId === evidence.runId);
}

function findFirstRunTaskCandidate(
  runs: AgenticRunListItem[],
  sessions: DemoBootstrapStateResponse["sessions"][number][],
  tasks: DemoBootstrapStateResponse["tasks"],
) {
  const sessionIds = new Set(sessions.map((session) => session.sessionId).filter(Boolean));
  const taskIds = new Set(tasks.map((task) => task.taskId).filter(Boolean));
  return (
    runs.find((run) => run.parentSessionId && sessionIds.has(run.parentSessionId)) ??
    runs.find((run) => run.taskId && taskIds.has(run.taskId)) ??
    runs[0]
  );
}

function pickFirstRunDemoSession(sessions: DemoBootstrapStateResponse["sessions"][number][]) {
  return (
    sessions.find((session) => session.mode === "cowork") ??
    sessions.find((session) => session.mode === "code") ??
    sessions.find((session) => session.mode === "chat")
  );
}

function routeForFirstTask(
  run: AgenticRunListItem | undefined,
  session: DemoBootstrapStateResponse["sessions"][number] | undefined,
): AppRoute {
  if (run?.runId) {
    const route: AppRoute = { area: "ops", section: "sessions", view: "run-detail", runId: run.runId };
    if (run.parentSessionId) {
      route.sessionId = run.parentSessionId;
    }
    return route;
  }
  if (session) {
    const area =
      session.mode === "chat" || session.mode === "code" || session.mode === "cowork" ? session.mode : "cowork";
    return {
      area,
      sessionId: session.sessionId,
      ...(session.projectId ? { projectId: session.projectId } : {}),
    };
  }
  return { area: "cowork" };
}

function routeForFirstRunEvidence(
  run: AgenticRunListItem | undefined,
  evidence: EvidenceEnvelope | undefined,
): AppRoute {
  const runId = evidence?.runId ?? run?.runId;
  if (runId) {
    const route: AppRoute = { area: "ops", section: "sessions", view: "run-detail", runId };
    if (run?.parentSessionId) {
      route.sessionId = run.parentSessionId;
    }
    return route;
  }
  return { area: "ops", section: "sessions" };
}

function shortEvidenceId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}...` : value;
}

function surfaceLabel(
  surface: AgenticRunListItem["surface"] | DemoBootstrapStateResponse["sessions"][number]["mode"] | undefined,
) {
  switch (surface) {
    case "chat":
      return "Conversation";
    case "code":
      return "Build";
    case "cowork":
      return "Plan";
    default:
      return "run";
  }
}

export function deriveOnboardingProviderSmokeEvidenceItems(
  onboarding: OnboardingState,
): OnboardingProviderSmokeEvidenceItem[] {
  const llmSettings = onboarding.settings?.llm;
  const activeProvider = (llmSettings?.providers ?? []).find(
    (provider) => provider.providerId === llmSettings?.activeProviderId,
  );
  const activeProviderLabel = activeProvider?.label ?? ((llmSettings?.activeProviderId ?? "").trim() || "No provider");
  const activeModel = (llmSettings?.activeModel ?? "").trim();
  const providerCredentialReady = Boolean(
    activeProvider && (activeProvider.hasApiKey || isLikelyLocalProviderBaseUrl(activeProvider.baseUrl)),
  );
  const smokeReady = Boolean(activeProvider && activeModel && providerCredentialReady);

  return [
    {
      id: "configured",
      label: "Provider configured",
      description: providerCredentialReady
        ? `${activeProviderLabel} has a credential source or reachable local endpoint configured.`
        : describeProviderReadinessFailure(onboarding),
      state: providerCredentialReady ? "complete" : "active",
      meta: providerCredentialReady ? "Configured" : "Needs setup",
    },
    {
      id: "smoke-ready",
      label: "Smoke ready",
      description: smokeReady
        ? `${activeProviderLabel} can be smoke-checked with selected model ${activeModel}.`
        : "Choose a provider, model, and credential or local endpoint before running provider smoke.",
      state: smokeReady ? "complete" : providerCredentialReady ? "active" : "pending",
      meta: smokeReady ? "Ready to run" : "Blocked",
    },
    {
      id: "passed-evidence",
      label: "Passed with evidence",
      description: smokeReady
        ? "No live provider smoke evidence is implied here; run the live install lane with real credentials to record pass/fail proof."
        : "Live provider proof is blocked until the provider is configured and smoke-ready.",
      state: smokeReady ? "active" : "pending",
      meta: "GOATCITADEL_VERIFY_INSTALL_LIVE_PROVIDER=1",
    },
  ];
}

export function describeProviderReadinessFailure(onboarding: OnboardingState): string {
  const llmSettings = onboarding.settings?.llm;
  const activeProviderId = (llmSettings?.activeProviderId ?? "").trim();
  const activeModel = (llmSettings?.activeModel ?? "").trim();
  if (!activeProviderId) {
    return "Choose an active provider before sending cloud-backed work.";
  }
  const activeProvider = (llmSettings?.providers ?? []).find((provider) => provider.providerId === activeProviderId);
  if (!activeProvider) {
    return `Provider ${activeProviderId} is selected but is not present in the provider catalog.`;
  }
  if (!activeModel) {
    return `Provider ${activeProvider.label} is selected, but no model is active.`;
  }
  if (!activeProvider.hasApiKey && !isLikelyLocalProviderBaseUrl(activeProvider.baseUrl)) {
    return `Provider ${activeProvider.label} needs an API key or a reachable local endpoint before smoke checks can run.`;
  }
  return `Provider ${activeProvider.label} needs a model smoke check before release claims.`;
}

export function wizardStateForChecklist(
  status?: OnboardingState["checklist"][number]["status"],
): SettingsWizardStepState {
  if (status === "complete") {
    return "complete";
  }
  return status === "needs_input" ? "active" : "pending";
}

export function setupMeta(status?: OnboardingState["checklist"][number]["status"]): string {
  if (status === "complete") {
    return "Pass";
  }
  if (status === "needs_input") {
    return "Needs repair";
  }
  return "Optional";
}

export function normalizeToolApprovalMode(value: string | undefined): ToolApprovalMode {
  return TOOL_APPROVAL_MODE_OPTIONS.includes(value as ToolApprovalMode) ? (value as ToolApprovalMode) : "approve_risky";
}

export function normalizeToolProfile(value: string | undefined): ToolProfile {
  return TOOL_PROFILE_OPTIONS.includes(value as ToolProfile) ? (value as ToolProfile) : "standard";
}

export function describeToolApprovalMode(value: ToolApprovalMode): string {
  if (value === "approve_all") {
    return "Ask every time";
  }
  if (value === "bypass") {
    return "Skip normal prompts";
  }
  return "Ask for risky work";
}

export function describeToolApprovalModeHelp(value: ToolApprovalMode): string {
  if (value === "approve_all") {
    return "Every otherwise-allowed tool call asks first; useful for audits and first-run learning.";
  }
  if (value === "bypass") {
    return "Allowed tools run without normal prompts in local profiles except nuclear-risk, risky-shell, and read work outside the active read posture. Remote Hardened rejects this mode; hard policy blocks still apply.";
  }
  return "Low-risk allowed tools can run, but caution, danger, and nuclear-risk work asks first.";
}

export function describePermissionProfile(profile: PermissionProfileRecord): string {
  if (profile.description?.trim()) {
    return profile.description.trim();
  }
  const posture = describeToolApprovalMode(profile.approvalMode);
  const scope = profile.scope === "global" ? "global" : `${profile.scope} scoped`;
  return `${posture}; ${scope}; ${profile.toolPatterns.length} tool pattern${
    profile.toolPatterns.length === 1 ? "" : "s"
  }.`;
}

export function labelForPermissionProfile(profileId: string, profiles: PermissionProfileRecord[] = []): string {
  return profiles.find((profile) => profile.profileId === profileId)?.label ?? profileId;
}

export function labelForLocalOperatorOverrideScope(scope: LocalOperatorOverrideScope): string {
  switch (scope) {
    case "operator":
      return "This operator";
    case "session":
      return "Specific session";
    case "run":
      return "Specific run";
    default:
      return "Current workspace";
  }
}

export function resolveLocalOperatorOverrideScopeRef(
  scope: LocalOperatorOverrideScope,
  draftScopeRef: string | undefined,
  activeWorkspaceId: string,
): string | undefined {
  if (scope === "operator") {
    return undefined;
  }
  if (scope === "workspace") {
    return activeWorkspaceId;
  }
  const trimmed = draftScopeRef?.trim();
  return trimmed ? trimmed : undefined;
}

export function resetLocalOperatorOverrideScopeRefForScope(
  scope: LocalOperatorOverrideScope,
  activeWorkspaceId: string,
): string {
  return scope === "workspace" ? activeWorkspaceId : "";
}

export function describeToolProfile(value: ToolProfile): string {
  switch (value) {
    case "minimal":
      return "Smallest tool set for basic chat and status checks.";
    case "coding":
      return "Adds repo, filesystem, terminal, and validation tools for implementation work.";
    case "ops":
      return "Prioritizes runtime, diagnostics, deployment, and repair tooling.";
    case "research":
      return "Prioritizes retrieval, browsing, citations, and synthesis tools.";
    case "chat-agent":
      return "Chat-friendly tools without turning the surface into a full coding workstation.";
    case "danger":
      return "Broadest local tool access profile for fully trusted machines; prompt behavior still comes from the approval mode and hard blocks stay enforced.";
    default:
      return "Balanced default for normal local work without opening the broadest tool set.";
  }
}

export function describeToolProfileLabel(value: ToolProfile): string {
  switch (value) {
    case "chat-agent":
      return "Chat Agent";
    case "danger":
      return "Trusted Local Power";
    default:
      return value
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
  }
}

export function normalizeBudgetMode(value: string | undefined): OnboardingState["settings"]["budgetMode"] {
  return BUDGET_MODE_OPTIONS.includes(value as OnboardingState["settings"]["budgetMode"])
    ? (value as OnboardingState["settings"]["budgetMode"])
    : "balanced";
}

export function describeBudgetMode(value: OnboardingState["settings"]["budgetMode"]): string {
  if (value === "saver") {
    return "Store a lower-cost budget preference for cost evidence and operator review.";
  }
  if (value === "power") {
    return "Store a quality-first budget preference for cost evidence and operator review.";
  }
  return "Store a balanced budget preference for everyday cost evidence.";
}

export function labelForBudgetMode(value: OnboardingState["settings"]["budgetMode"]): string {
  if (value === "saver") {
    return "Saver";
  }
  if (value === "power") {
    return "Power";
  }
  return "Balanced";
}

export function getProviderApiStyleWarning(provider: {
  providerId?: string;
  apiStyle?: ProviderEditorDraft["apiStyle"];
}): string | null {
  if (provider.apiStyle === "openai-codex-responses" && provider.providerId !== "openai-codex") {
    return "Codex Responses is only executed for the built-in OpenAI Codex OAuth provider; other providers resolve to their supported execution API.";
  }
  return null;
}

export function applyIntegrationDefaults(
  schema: IntegrationFormSchema,
  current: Record<string, unknown>,
): Record<string, unknown> {
  return schema.fields.reduce<Record<string, unknown>>(
    (next, field) => {
      if (next[field.key] === undefined && field.defaultValue !== undefined) {
        next[field.key] = field.defaultValue;
      }
      return next;
    },
    { ...current },
  );
}

export function isRuntimeInvokableMcpServer(server: {
  transport: string;
  url?: string;
  trustTier?: string;
  authType?: string;
  oauth?: McpServerRecord["oauth"];
  authState?: McpServerRecord["authState"];
  policy?: { allowedEnvKeys?: string[] };
}) {
  const authSupported =
    !server.authType ||
    server.authType === "none" ||
    (server.authType === "token" && (server.policy?.allowedEnvKeys ?? []).some((item) => item.trim())) ||
    (server.authType === "oauth2" &&
      Boolean(server.oauth?.authorizationUrl?.trim() && server.oauth.tokenUrl?.trim()) &&
      server.authState?.readiness === "ready");
  return (
    server.trustTier !== "quarantined" &&
    (server.transport === "stdio" ||
      server.url?.trim().toLowerCase() === INTERNAL_APPROVAL_INBOX_URL ||
      ((server.transport === "http" || server.transport === "sse") && Boolean(server.url?.trim()) && authSupported))
  );
}

export function createEmptyMcpRemotePreview(): McpRemotePreviewResponse {
  return {
    generatedAt: new Date(0).toISOString(),
    readOnly: true,
    mutationSemantics: "none",
    experimentalRemoteRecordsAllowed: false,
    runtimeSupport: "internal_approval_inbox_only",
    summary: {
      remoteServers: 0,
      remoteTemplates: 0,
      runtimeSupported: 0,
      blocked: 0,
      configuredOnly: 0,
      notCallable: 0,
      experimentalRecords: 0,
      quarantined: 0,
      needsAuth: 0,
    },
    items: [],
  };
}

export function createEmptyMcpServerModeManifest(): McpServerModeManifestResponse {
  return {
    generatedAt: new Date(0).toISOString(),
    readOnly: true,
    mutationSemantics: "none",
    status: "preview",
    protocol: "mcp",
    runtimeSupport: "not_available",
    server: {
      name: "goatcitadel",
      label: "GoatCitadel governed capability export",
      version: "1.0.0",
      transport: "stdio",
    },
    launch: {
      supported: true,
      command: "goatcitadel",
      args: ["mcp-server"],
      reason: "MCP server-mode manifest is unavailable.",
    },
    runtime: {
      callPreview: {
        supported: false,
        endpoint: "/api/v1/mcp/server-mode/call",
        requiresGatewayAuth: true,
        readOnlyOnly: true,
        requiredCallContext: ["agentId", "sessionId"],
        reason: "MCP server-mode manifest is unavailable.",
      },
      stdio: {
        supported: true,
        command: "goatcitadel",
        args: ["mcp-server"],
        requiresGatewayAuth: true,
        gatewayEndpoint: "/api/v1/mcp/server-mode/manifest",
        reason: "The stdio proxy command is available, but the manifest could not be loaded.",
      },
    },
    summary: {
      inspectableCapabilities: 0,
      gatewayCallableCapabilities: 0,
      exportedToolDescriptors: 0,
      blockedDescriptors: 0,
    },
    tools: [],
    governance: [],
    limitations: ["MCP server-mode manifest is unavailable."],
    evidence: {
      catalogScope: "callable",
      catalogSnapshot: [],
    },
  };
}

export function formatMcpRemotePreviewItem(item: McpRemotePreviewResponse["items"][number]): string {
  const blocker = item.blockers[0] ?? "No runtime blocker recorded.";
  const governance = item.governance[0] ?? "No governance note recorded.";
  const authReadiness = item.authReadiness?.replaceAll("_", " ") ?? "unknown";
  return `${item.posture.replaceAll("_", " ")} · auth ${authReadiness} · ${item.operatorNextAction} · ${blocker} · ${governance}`;
}

export function formatMcpElicitationMeta(item: McpElicitationRequest): string {
  const source = [
    item.source.serverId ? `server ${item.source.serverId}` : item.source.sourceType.replaceAll("_", " "),
    item.source.toolName ? `tool ${item.source.toolName}` : undefined,
    item.source.transport ? `transport ${item.source.transport}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const owner = [
    item.owner.workspaceId ? `workspace ${item.owner.workspaceId}` : undefined,
    item.owner.sessionId ? `session ${item.owner.sessionId}` : undefined,
    item.owner.runId ? `run ${item.owner.runId}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const redaction =
    item.prompt.redactedSecretCount + item.requestedSchema.redactedSecretCount > 0
      ? ` · ${item.prompt.redactedSecretCount + item.requestedSchema.redactedSecretCount} redacted`
      : "";
  return `${source || "gateway"} · ${owner || "operator"} · updated ${formatDateTime(item.updatedAt)}${redaction}`;
}

export function parseMcpElicitationDraft(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value || "{}") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MCP elicitation accept response must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export function readDraftString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function readConnectionConfigString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function preferredChannelDefinition(definitions: ChannelSetupDefinition[]): ChannelSetupDefinition | undefined {
  return (
    definitions.find((item) => item.catalog.catalogId === "channel.slack") ??
    definitions.find((item) => item.catalog.catalogId === "channel.telegram") ??
    definitions[0]
  );
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function formatJson(value: Record<string, unknown>) {
  return JSON.stringify(value, null, 2);
}

export function formatCapabilities(
  capabilities:
    | {
        vision?: boolean;
        audio?: boolean;
        video?: boolean;
        toolCalling?: boolean;
        jsonMode?: boolean;
        webSearch?: boolean;
        reasoning?: boolean;
        voiceInput?: boolean;
        voiceOutput?: boolean;
        imageGenerate?: boolean;
        imageEdit?: boolean;
        artifacts?: boolean;
      }
    | undefined,
) {
  if (!capabilities) {
    return "No capability metadata";
  }
  const enabled = Object.entries(capabilities)
    .filter((entry) => entry[1])
    .map((entry) => entry[0]);
  return enabled.length ? enabled.join(", ") : "No advertised capabilities";
}

export function deriveLlamaCppAlias(input: string) {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }
  const filename = trimmed.split(/[\\/]/).pop() ?? trimmed;
  return filename.replace(/\.(gguf|bin)$/i, "") || trimmed;
}

export function createEmptyPersonalityEditorDraft(): PersonalityEditorDraft {
  return {
    id: "",
    label: "",
    category: "core",
    description: "",
    tone: "",
    style: "",
    systemOverlay: "",
    safetyNotes: "Personality overlays never override safety, privacy, approval, tool, memory, or skill policies.",
  };
}

export function createPersonalityEditorDraft(personality: PersonalityPreset | null): PersonalityEditorDraft {
  if (!personality) {
    return createEmptyPersonalityEditorDraft();
  }
  return {
    id: personality.id,
    label: personality.label,
    category: personality.category,
    description: personality.description,
    tone: personality.tone,
    style: personality.style,
    systemOverlay: personality.systemOverlay,
    safetyNotes: personality.safetyNotes.join("\n"),
  };
}

export function personalityDraftToMutationInput(draft: PersonalityEditorDraft) {
  return {
    id: draft.id.trim() || undefined,
    label: draft.label.trim(),
    category: draft.category,
    description: draft.description.trim(),
    tone: draft.tone.trim(),
    style: draft.style.trim(),
    systemOverlay: draft.systemOverlay.trim(),
    safetyNotes: splitLineList(draft.safetyNotes),
  };
}

export function arePersonalityDraftsEqual(a: PersonalityEditorDraft, b: PersonalityEditorDraft): boolean {
  return (
    a.id === b.id &&
    a.label === b.label &&
    a.category === b.category &&
    a.description === b.description &&
    a.tone === b.tone &&
    a.style === b.style &&
    a.systemOverlay === b.systemOverlay &&
    a.safetyNotes === b.safetyNotes
  );
}

export function formatPersonalityStatus(personality: PersonalityPreset, defaultPersonalityId: string): string {
  const tags = [personality.builtin ? "Built-in" : "Custom"];
  if (personality.modified) {
    tags.push("Modified");
  }
  if (personality.id === defaultPersonalityId) {
    tags.push("Work default");
  }
  if (personality.editable === false) {
    tags.push("Locked");
  }
  return tags.join(" · ");
}

export function formatPersonalityCategoryLabel(category: PersonalityPresetCategory): string {
  return category
    .split("_")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function normalizePersonalityEditorId(input: string | undefined): string {
  return (
    input
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "default"
  );
}

export function formatDateTime(value?: string | null) {
  if (!value) {
    return "Unknown";
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return "Unknown";
  }
  return new Date(parsed).toLocaleString();
}

export {
  SettingsActionList,
  SettingsButtonRow,
  SettingsCodeBlock,
  SettingsConfigSourceLegend,
  SettingsEmptyState,
  SettingsField,
  SettingsFieldGrid,
  SettingsFilterBar,
  SettingsGrid,
  SettingsLoadWarnings,
  SettingsNotice,
  SettingsPageFrame,
  SettingsPosturePanel,
  SettingsSectionShell,
  SettingsStack,
  SettingsWizardSteps,
  descriptionForSettingsSection,
  formatEffectiveConfigSourceLabel,
  getErrorMessage,
  iconForSettingsSection,
  labelForSettingsSection,
  nativeLoad,
  nativeLoadIssues,
  useAsyncLoad,
};
export type {
  LoadState,
  NativeLoadIssue,
  NativeLoadResult,
  Notice,
  SettingsNativePageProps,
  SettingsSectionProps,
  SettingsWizardStepState,
};
