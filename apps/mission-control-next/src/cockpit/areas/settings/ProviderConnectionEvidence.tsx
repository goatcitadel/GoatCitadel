import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LlmProviderConfig } from "@goatcitadel/contracts";
import { fetchOpenAICodexOAuthStatus, fetchProviderSecretStatus } from "@goatcitadel/mission-control-shared/api/client";
import type { ProviderModelCatalogOption } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import {
  deriveProviderSmokeEvidenceItems,
  isLikelyLocalProviderBaseUrl,
  resolveProviderCredentialReady,
} from "../../../features/native-routes/settings/helpers/provider-format";
import {
  formatGoogleAdcReadinessMeta,
  formatSecretStatusMeta,
} from "../../../features/native-routes/settings/sections/provider-secret-format";

const CODEX_PROVIDER_ID = "openai-codex";
/** `known`: the owner answered, or a key or local endpoint already proves readiness. `failed`: its read failed. */
type Credential = { known: boolean; failed: boolean; ready: boolean; meta: string };

/** Credential evidence comes only from its owner: the ChatGPT login for Codex, the secure secret owner otherwise. */
function useCredential(provider: ProviderModelCatalogOption, open: boolean): Credential {
  const codex = provider.providerId === CODEX_PROVIDER_ID;
  const local = isLikelyLocalProviderBaseUrl(provider.baseUrl);
  const oauth = useQuery({
    queryKey: ["settings", "provider-evidence", "codex-oauth"],
    queryFn: () => fetchOpenAICodexOAuthStatus(),
    enabled: open && codex,
  });
  const secret = useQuery({
    queryKey: ["settings", "provider-evidence", "secret", provider.providerId],
    queryFn: ({ signal }) => fetchProviderSecretStatus(provider.providerId, { signal }),
    enabled: open && !codex,
  });
  if (codex) {
    const status = oauth.isError ? undefined : oauth.data;
    if (!status)
      return {
        known: false,
        failed: oauth.isError,
        ready: false,
        meta: oauth.isError ? "Login status unavailable" : "Checking login",
      };
    return {
      known: true,
      failed: false,
      ready: resolveProviderCredentialReady({ providerId: provider.providerId, oauthConnected: status.connected }),
      meta: status.connected
        ? (status.accountLabel ?? "ChatGPT login connected")
        : status.requiresReauth
          ? "ChatGPT login needs reauthorization"
          : "ChatGPT login not connected",
    };
  }
  const hasSecret = secret.isError ? undefined : secret.data?.hasSecret;
  const ready = resolveProviderCredentialReady({
    providerId: provider.providerId,
    authMode: provider.authMode,
    hasApiKey: provider.hasApiKey,
    hasSecret,
    localEndpoint: local,
  });
  const known = ready || provider.authMode === "google-adc" || hasSecret !== undefined;
  const meta =
    local && !(hasSecret || provider.hasApiKey)
      ? "Local endpoint, no key required"
      : provider.authMode === "google-adc"
        ? formatGoogleAdcReadinessMeta(provider.authReadiness)
        : formatSecretStatusMeta(
            secret.data?.source ?? provider.apiKeySource,
            hasSecret ?? provider.hasApiKey ?? false,
          );
  return { known, failed: secret.isError, ready, meta };
}

function Body({ provider, request }: { provider: ProviderModelCatalogOption; request?: LlmProviderConfig["request"] }) {
  const credential = useCredential(provider, true);
  const local = isLikelyLocalProviderBaseUrl(provider.baseUrl);
  const executed = provider.resolvedApiStyle ?? provider.apiStyle;
  const capabilities = Object.entries(provider.capabilities ?? {})
    .filter(([, enabled]) => Boolean(enabled))
    .map(([capability]) => capability);
  const checklist = credential.known
    ? deriveProviderSmokeEvidenceItems({
        providerId: provider.providerId,
        providerLabel: provider.label,
        credentialReady: credential.ready,
        credentialMeta: credential.meta,
        localEndpoint: local,
        modelCount: provider.models.length,
        modelProbeState: provider.modelProbeState,
        modelProbeSource: provider.modelProbeSource,
        modelProbeCheckedAt: provider.modelProbeCheckedAt,
        modelProbeWarning: provider.modelProbeWarning,
        request,
      })
    : [];
  return (
    <div className="mt-3 space-y-3 text-sm text-fg-secondary">
      <ul className="space-y-1">
        <li>Configured API: {provider.apiStyle}</li>
        <li>
          Gateway executes: {executed}
          {executed !== provider.apiStyle ? " (differs from the configured API)" : ""}
        </li>
        <li>
          Runtime posture: {local ? "Local runtime" : "Remote provider"} ·{" "}
          {local ? "Local endpoint detected" : "Network endpoint detected"}
        </li>
        <li>Credential: {credential.meta}</li>
        <li>Default model: {provider.defaultModel || "Not set"}</li>
      </ul>
      <div>
        <p className="font-medium text-fg">Capabilities</p>
        <ul aria-label={`${provider.label} capabilities`} className="mt-1 flex flex-wrap gap-2">
          {capabilities.length ? (
            capabilities.map((capability) => (
              <li key={capability} className="rounded-md border border-line px-2 py-1 text-xs">
                {capability}
              </li>
            ))
          ) : (
            <li className="text-xs text-fg-muted">No declared capabilities</li>
          )}
        </ul>
      </div>
      {credential.known ? (
        <ul aria-label={`${provider.label} readiness checklist`} className="divide-y divide-line-subtle">
          {checklist.map((item) => (
            <li key={item.id} className="py-2">
              <p className="font-medium text-fg">
                {item.label} · {item.actionLabel}
              </p>
              <p>{item.description}</p>
              <p className="text-xs text-fg-muted">{item.meta}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p role="status" className="text-sm text-fg-muted">
          {credential.failed
            ? "The readiness checklist needs the credential status, which could not be read."
            : "Reading the credential status…"}
        </p>
      )}
    </div>
  );
}

/**
 * Read-only connection evidence for one provider: configured versus executed API, posture, capabilities and a
 * readiness checklist. Credential status is read only when the details are opened. Actions stay with their owners.
 */
export function ProviderConnectionEvidence({
  provider,
  request,
}: {
  provider: ProviderModelCatalogOption;
  request?: LlmProviderConfig["request"];
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="mt-3 rounded-md border border-line bg-raised p-3"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="min-h-11 cursor-pointer text-sm font-semibold text-fg">Connection details</summary>
      {open ? <Body provider={provider} request={request} /> : null}
    </details>
  );
}
