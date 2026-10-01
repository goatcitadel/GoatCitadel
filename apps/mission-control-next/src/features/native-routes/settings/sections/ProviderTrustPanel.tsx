import type { LlmProviderConfig } from "@goatcitadel/contracts";
import { KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { NativeCard } from "../../NativeRoutePageLayout";
import { NativeButton } from "../../primitives";
import {
  SettingsButtonRow,
  SettingsEmptyState,
  SettingsField,
  SettingsNotice,
  type SettingsSectionProps,
} from "../SettingsShared";
import { SettingsChangeStatus } from "../use-settings-change";
import { formatProviderCredentialLabel, formatProviderProbeStateLabel } from "../helpers/provider-format";
import { ProviderConnectionDiagnostics } from "./ProviderConnectionDiagnostics";
import type { ProviderCatalog } from "./provider-section-types";
import type { useProviderCredentials } from "./use-provider-credentials";
import type { useProviderOAuthFlow } from "./use-provider-oauth-flow";

export function ProviderTrustPanel({
  selectedProviderId,
  selectedProvider,
  selectedProviderConfig,
  credentials,
  oauth,
  profileDirty,
  credentialEditorOpen,
  onToggleCredential,
  providerProbeBusyId,
  handleRefreshModels,
  openView,
  route,
  navigate,
}: Pick<SettingsSectionProps, "route" | "navigate"> & {
  selectedProviderId: string;
  selectedProvider: ProviderCatalog["providers"][number] | null;
  selectedProviderConfig?: LlmProviderConfig;
  credentials: ReturnType<typeof useProviderCredentials>;
  oauth: ReturnType<typeof useProviderOAuthFlow>;
  profileDirty: boolean;
  credentialEditorOpen: boolean;
  onToggleCredential: () => void;
  providerProbeBusyId: string | null;
  handleRefreshModels: (providerId: string) => Promise<void>;
  openView: (view: string | null) => void;
}) {
  const {
    secretEditor,
    secretValue,
    setSecretValue,
    secretState,
    secretChange,
    secretRemoval,
    setPendingDeleteSecret,
    handleSaveSecret,
  } = credentials;
  const { codexOAuthStatus, codexOAuthConnected, codexOAuthFlow, setCodexOAuthPlanDialog } = oauth;
  const selectedProviderIsCodexOAuth = selectedProvider?.providerId === "openai-codex";
  const selectedProviderIsGoogleAdc = selectedProvider?.authMode === "google-adc";
  const selectedProviderIsGoogleServiceAccount = selectedProvider?.authMode === "google-service-account";
  return (
    <NativeCard
      id="providers-trust"
      density="compact"
      className="mc-next-settings-panel mc-next-provider-detail-card"
      title="Connection"
      subtitle=""
    >
      <SettingsButtonRow>
        <NativeButton onClick={() => openView("editor")}>
          Edit connection{profileDirty ? " · Unsaved" : ""}
        </NativeButton>
        {selectedProviderIsCodexOAuth ? (
          <NativeButton variant="outline" onClick={() => openView("oauth")}>
            ChatGPT login
          </NativeButton>
        ) : null}
      </SettingsButtonRow>
      <SettingsChangeStatus
        change={secretRemoval.change}
        onRefresh={secretRemoval.refresh}
        route={route}
        navigate={navigate}
        onReview={setCodexOAuthPlanDialog}
      />
      <SettingsChangeStatus
        change={secretChange.change}
        onRefresh={secretChange.refresh}
        route={route}
        navigate={navigate}
        onReview={setCodexOAuthPlanDialog}
      />
      {secretEditor.hasRemoteChanges ? (
        <>
          <SettingsNotice
            notice={{
              tone: "warning",
              message:
                "Settings changed while this credential was being entered. Review current credential posture before retrying.",
            }}
          />
          <NativeButton variant="outline" onClick={secretEditor.rebaseToCurrent}>
            Apply credential to current settings
          </NativeButton>
        </>
      ) : null}
      {selectedProvider ? (
        <>
          <p>
            {selectedProvider.defaultModel || "Default model unavailable"} ·{" "}
            {formatProviderCredentialLabel(selectedProvider.providerId, selectedProvider.hasApiKey, codexOAuthStatus)} ·{" "}
            {formatProviderProbeStateLabel(selectedProvider.modelProbeState)}
          </p>
          <ProviderConnectionDiagnostics
            selectedProvider={selectedProvider}
            selectedProviderConfig={selectedProviderConfig}
            secretState={secretState}
            oauth={oauth}
            handleRefreshModels={handleRefreshModels}
            openView={openView}
          />
          {selectedProviderIsCodexOAuth ? (
            <>
              <SettingsNotice
                notice={{
                  tone: codexOAuthConnected ? "success" : "info",
                  message: codexOAuthConnected
                    ? `OpenAI Codex OAuth connected${codexOAuthStatus?.accountLabel ? ` as ${codexOAuthStatus.accountLabel}` : ""}.`
                    : codexOAuthFlow
                      ? "ChatGPT login is currently in progress in the setup card above."
                      : "No API key goes here. ChatGPT login is managed by the setup card above.",
                }}
              />
              <SettingsButtonRow>
                <NativeButton
                  variant="secondary"
                  onClick={() => void handleRefreshModels(selectedProvider.providerId)}
                  disabled={providerProbeBusyId === selectedProvider.providerId}
                >
                  <RefreshCw size={16} />
                  {providerProbeBusyId === selectedProvider.providerId ? "Probing..." : "Refresh models"}
                </NativeButton>
              </SettingsButtonRow>
            </>
          ) : selectedProviderIsGoogleAdc ? (
            <>
              <SettingsNotice
                notice={{
                  tone: "info",
                  message:
                    "Vertex AI uses Gateway-local Application Default Credentials. Credential files, refresh tokens, access tokens, and metadata tokens never roundtrip to Mission Control.",
                }}
              />
              <SettingsButtonRow>
                <NativeButton
                  variant="secondary"
                  onClick={() => void handleRefreshModels(selectedProvider.providerId)}
                  disabled={providerProbeBusyId === selectedProvider.providerId}
                >
                  <RefreshCw size={16} />
                  {providerProbeBusyId === selectedProvider.providerId ? "Probing..." : "Validate ADC & models"}
                </NativeButton>
              </SettingsButtonRow>
            </>
          ) : (
            <>
              <NativeButton
                variant="outline"
                aria-expanded={credentialEditorOpen}
                aria-controls="provider-credential-editor"
                onClick={onToggleCredential}
              >
                Provider credential{secretEditor.isDirty ? " · Unsaved" : ""}
              </NativeButton>
              <div id="provider-credential-editor" hidden={!credentialEditorOpen}>
                <SettingsField
                  label={selectedProviderIsGoogleServiceAccount ? "Service-account JSON" : "Provider secret"}
                >
                  <input
                    className="mc-next-settings-input"
                    type="password"
                    value={secretValue}
                    placeholder={
                      selectedProviderIsGoogleServiceAccount
                        ? "Paste service-account JSON to replace the Gateway-owned secret"
                        : "Paste a new API key to save"
                    }
                    onChange={(event) => setSecretValue(event.target.value)}
                  />
                </SettingsField>
                <details>
                  <summary>Credential storage</summary>
                  <SettingsNotice
                    notice={{
                      tone: "info",
                      message: selectedProviderIsGoogleServiceAccount
                        ? "The JSON credential is sent only to the Gateway secret owner and never returned, projected into provider config, or written into public diagnostics. This field only accepts a replacement credential."
                        : "Key on file status comes from the gateway only. Saved key values do not roundtrip back to the browser; status only reports whether a key exists and whether it is stored in OS keychain, local .env fallback, inline config, or none. This field only accepts a replacement key.",
                    }}
                  />
                </details>
                {secretState.error ? <SettingsNotice notice={{ tone: "error", message: secretState.error }} /> : null}
                <SettingsButtonRow>
                  <NativeButton
                    variant="default"
                    disabled={secretChange.hasPending || secretRemoval.hasPending || credentials.mutation.pending || Boolean(credentials.mutation.uncertain)}
                    onClick={() => void handleSaveSecret()}
                  >
                    <KeyRound size={16} />
                    Save secret
                  </NativeButton>
                  <NativeButton
                    variant="secondary"
                    onClick={() => void handleRefreshModels(selectedProvider.providerId)}
                    disabled={providerProbeBusyId === selectedProvider.providerId}
                  >
                    <RefreshCw size={16} />
                    {providerProbeBusyId === selectedProvider.providerId ? "Probing..." : "Refresh models"}
                  </NativeButton>
                  <NativeButton
                    variant="destructive"
                    disabled={credentials.mutation.pending || Boolean(credentials.mutation.uncertain)}
                    onClick={() =>
                      selectedProviderId.trim()
                        ? setPendingDeleteSecret({
                            providerId: selectedProviderId,
                            label: selectedProvider?.label ?? selectedProviderId,
                          })
                        : undefined
                    }
                  >
                    <Trash2 size={16} />
                    Delete secret
                  </NativeButton>
                </SettingsButtonRow>
              </div>
            </>
          )}
        </>
      ) : (
        <SettingsEmptyState label="Choose a provider to inspect routing and secret posture." />
      )}
    </NativeCard>
  );
}
