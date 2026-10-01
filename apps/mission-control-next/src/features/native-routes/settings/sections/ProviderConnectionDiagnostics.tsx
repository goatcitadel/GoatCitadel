import type { LlmProviderConfig } from "@goatcitadel/contracts";
import { NativeDisclosureCard } from "../../NativeRoutePageLayout";
import { NativeMetricGrid } from "../../primitives";
import {
  formatEffectiveConfigSourceLabel,
  SettingsActionList,
  SettingsField,
  SettingsFieldGrid,
} from "../SettingsShared";
import {
  deriveProviderSmokeEvidenceItems,
  formatProviderModelsMeta,
  formatProviderProbeSourceMeta,
  formatProviderProbeStateLabel,
  isLikelyLocalProviderBaseUrl,
  resolveProviderCredentialReady,
} from "../helpers/provider-format";
import {
  formatGoogleAdcReadinessMeta,
  formatGoogleAuthSourceLabel,
  formatSecretStatusMeta,
} from "./provider-secret-format";
import type { ProviderCatalog } from "./provider-section-types";
import type { useProviderCredentials } from "./use-provider-credentials";
import type { useProviderOAuthFlow } from "./use-provider-oauth-flow";

export function ProviderConnectionDiagnostics({
  selectedProvider,
  selectedProviderConfig,
  secretState,
  oauth,
  handleRefreshModels,
  openView,
}: {
  selectedProvider: ProviderCatalog["providers"][number];
  selectedProviderConfig?: LlmProviderConfig;
  secretState: ReturnType<typeof useProviderCredentials>["secretState"];
  oauth: Pick<ReturnType<typeof useProviderOAuthFlow>, "codexOAuthStatus" | "codexOAuthConnected">;
  handleRefreshModels: (providerId: string) => Promise<void>;
  openView: (view: string | null) => void;
}) {
  const { codexOAuthStatus, codexOAuthConnected } = oauth;
  const availableModels = selectedProvider.models ?? [];
  const selectedProviderIsLocal = isLikelyLocalProviderBaseUrl(selectedProvider?.baseUrl);
  const selectedProviderIsCodexOAuth = selectedProvider?.providerId === "openai-codex";
  const selectedProviderIsClaudeCodeOAuth = selectedProvider?.providerId === "claude-code";
  const selectedProviderIsGoogleAdc = selectedProvider?.authMode === "google-adc";
  const selectedProviderIsGoogleServiceAccount = selectedProvider?.authMode === "google-service-account";
  const selectedProviderRuntimePosture = selectedProvider
    ? selectedProviderIsLocal
      ? "Local runtime"
      : "Remote provider"
    : "Provider pending";
  const selectedProviderExecutionApiStyle = selectedProvider?.resolvedApiStyle ?? selectedProvider?.apiStyle;
  const selectedProviderCapabilities = Object.entries(selectedProvider?.capabilities ?? {})
    .filter(([, enabled]) => Boolean(enabled))
    .map(([capability]) => capability);
  const selectedProviderApiMeta =
    selectedProvider &&
    selectedProviderExecutionApiStyle &&
    selectedProviderExecutionApiStyle !== selectedProvider.apiStyle
      ? `Gateway executes ${selectedProviderExecutionApiStyle}`
      : "Matches configured API";
  const selectedProviderCredentialReady = selectedProvider
    ? resolveProviderCredentialReady({
        providerId: selectedProvider.providerId,
        authMode: selectedProvider.authMode,
        hasApiKey: selectedProvider.hasApiKey,
        hasSecret: secretState.data?.hasSecret,
        oauthConnected: codexOAuthConnected,
        localEndpoint: selectedProviderIsLocal,
      })
    : false;
  const selectedProviderCredentialMeta = selectedProvider
    ? selectedProviderIsCodexOAuth
      ? codexOAuthConnected
        ? (codexOAuthStatus?.accountLabel ?? "OAuth connected")
        : codexOAuthStatus?.requiresReauth
          ? "OAuth requires reauth"
          : "OAuth not connected"
      : selectedProviderIsLocal && !(secretState.data?.hasSecret || selectedProvider.hasApiKey)
        ? "Local endpoint, no key required"
        : selectedProviderIsGoogleAdc
          ? formatGoogleAdcReadinessMeta(selectedProvider.authReadiness)
          : formatSecretStatusMeta(
              secretState.data?.source ?? selectedProvider.apiKeySource,
              secretState.data?.hasSecret ?? selectedProvider.hasApiKey ?? false,
            )
    : "No provider selected";
  const selectedProviderSmokeEvidenceItems = selectedProvider
    ? deriveProviderSmokeEvidenceItems({
        providerId: selectedProvider.providerId,
        providerLabel: selectedProvider.label,
        credentialReady: selectedProviderCredentialReady,
        credentialMeta: selectedProviderCredentialMeta,
        localEndpoint: selectedProviderIsLocal,
        modelCount: availableModels.length,
        modelProbeState: selectedProvider.modelProbeState,
        modelProbeSource: selectedProvider.modelProbeSource,
        modelProbeCheckedAt: selectedProvider.modelProbeCheckedAt,
        modelProbeWarning: selectedProvider.modelProbeWarning,
        request: selectedProviderConfig?.request,
      })
    : [];
  return (
    <NativeDisclosureCard
      key={selectedProvider.providerId}
      id="provider-connection-diagnostics"
      title="Connection & diagnostics"
    >
      <NativeMetricGrid
        items={[
          { label: "Default model", value: selectedProvider.defaultModel, meta: "Configured fallback" },
          {
            label: "Configured API",
            value: selectedProvider.apiStyle,
            meta: "Saved provider setting",
          },
          {
            label: "Execution API",
            value: selectedProviderExecutionApiStyle ?? selectedProvider.apiStyle,
            meta: selectedProviderApiMeta,
          },
          {
            label:
              selectedProviderIsCodexOAuth || selectedProviderIsClaudeCodeOAuth
                ? "OAuth"
                : selectedProviderIsGoogleAdc
                  ? "Google ADC"
                  : selectedProviderIsGoogleServiceAccount
                    ? "Service account"
                    : "API key",
            value: selectedProviderIsCodexOAuth
              ? codexOAuthStatus?.connected
                ? "Connected"
                : codexOAuthStatus?.requiresReauth
                  ? "Reauth"
                  : "Missing"
              : selectedProviderIsGoogleAdc
                ? selectedProvider.hasApiKey
                  ? "Configured"
                  : selectedProvider.authReadiness?.status === "invalid"
                    ? "Invalid"
                    : selectedProvider.authReadiness?.status === "unavailable"
                      ? "Unavailable"
                      : selectedProvider.authReadiness?.status === "missing"
                        ? "Missing"
                        : "Unknown"
                : selectedProviderIsClaudeCodeOAuth
                  ? secretState.data?.hasSecret || selectedProvider.hasApiKey
                    ? "Configured"
                    : "Missing"
                  : secretState.data?.hasSecret || selectedProvider.hasApiKey
                    ? "Configured"
                    : "Missing",
            meta: selectedProviderIsCodexOAuth
              ? (codexOAuthStatus?.accountLabel ?? "ChatGPT/Codex plan")
              : selectedProviderIsGoogleAdc
                ? formatGoogleAdcReadinessMeta(selectedProvider.authReadiness)
                : selectedProviderIsGoogleServiceAccount
                  ? "Gateway-owned service-account JSON secret"
                  : selectedProviderIsClaudeCodeOAuth
                    ? "Claude subscription token"
                    : formatSecretStatusMeta(
                        secretState.data?.source ?? selectedProvider.apiKeySource,
                        secretState.data?.hasSecret ?? selectedProvider.hasApiKey ?? false,
                      ),
          },
          {
            label: "Secret source",
            value: selectedProviderIsGoogleAdc
              ? formatGoogleAuthSourceLabel(selectedProvider.authReadiness?.source)
              : formatEffectiveConfigSourceLabel(secretState.data?.source ?? selectedProvider.apiKeySource),
            meta: "Effective source label",
          },
          {
            label: "Probe",
            value: formatProviderProbeStateLabel(selectedProvider.modelProbeState),
            meta:
              selectedProvider.modelProbeSource === "error_fallback"
                ? "Fallback after probe error; inspect model discovery below"
                : selectedProvider.modelProbeState === "error"
                  ? "Live discovery failed; inspect model discovery below"
                  : formatProviderProbeSourceMeta(selectedProvider),
          },
          {
            label: "Provider models",
            value: String(availableModels.length),
            meta: formatProviderModelsMeta(selectedProvider, availableModels.length),
          },
          {
            label: "Runtime posture",
            value: selectedProviderRuntimePosture,
            meta: selectedProviderIsLocal ? "Local endpoint detected" : "Network endpoint detected",
          },
        ]}
      />
      <SettingsFieldGrid>
        <SettingsField label="Base URL">
          <input className="mc-next-settings-input" value={selectedProvider.baseUrl} readOnly />
        </SettingsField>
        <SettingsField label="Capabilities">
          <div className="mc-next-settings-chip-row" role="list" aria-label={`${selectedProvider.label} capabilities`}>
            {selectedProviderCapabilities.length > 0 ? (
              selectedProviderCapabilities.map((capability) => (
                <span key={capability} className="mc-next-settings-chip" role="listitem">
                  {capability}
                </span>
              ))
            ) : (
              <span className="mc-next-settings-chip" role="listitem">
                No declared capabilities
              </span>
            )}
          </div>
        </SettingsField>
      </SettingsFieldGrid>
      <SettingsActionList
        ariaLabel={`${selectedProvider.label} smoke evidence`}
        items={selectedProviderSmokeEvidenceItems.map((item) => ({
          ...item,
          onClick:
            item.id === "model-discovery" || item.id === "provider-smoke"
              ? () => void handleRefreshModels(selectedProvider.providerId)
              : item.id === "transport"
                ? () => openView("editor")
                : undefined,
        }))}
        maxHeight=""
      />
    </NativeDisclosureCard>
  );
}
