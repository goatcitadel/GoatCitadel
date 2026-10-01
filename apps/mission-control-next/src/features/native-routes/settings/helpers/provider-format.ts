import type { DeviceAccessGrantRecord, LlmProviderConfig, LlmProviderRequestConfig } from "@goatcitadel/contracts";
import { fetchDaemonStatus, fetchSettings, type OpenAICodexOAuthStatus } from "@goatcitadel/mission-control-shared/api/client";

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
  if (providerId === "llamacpp") return "Keyless · check endpoint";
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

export function resolveProviderCredentialReady(input: {
  providerId: string;
  authMode?: LlmProviderConfig["authMode"];
  hasApiKey?: boolean;
  hasSecret?: boolean;
  oauthConnected?: boolean;
  localEndpoint?: boolean;
}): boolean {
  if (input.providerId === "openai-codex") return input.oauthConnected === true;
  if (input.authMode === "google-adc") return input.hasApiKey === true;
  return input.hasSecret === true || input.hasApiKey === true || input.localEndpoint === true;
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
