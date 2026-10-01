import { useMemo } from "react";
import { ExternalLink, KeyRound, RefreshCw, RotateCcw, Save, SlidersHorizontal, Trash2 } from "lucide-react";
import { ChatChangePlanCard } from "@goatcitadel/mission-control-shared/components/chat/ChatChangePlanCard";
import { NativeButton, NativeMetricGrid } from "../../primitives";
import {
  SettingsNotice,
  SettingsField,
  SettingsFieldGrid,
  SettingsButtonRow,
  SettingsWizardSteps,
  type SettingsSectionProps,
} from "../SettingsShared";
import { SettingsChangeStatus, type useSettingsChange } from "../use-settings-change";
import { formatOpenAICodexOAuthExpiry } from "../helpers/provider-oauth";
import type { ProviderCatalog, ProviderNoticeSetter } from "./provider-section-types";
import type { useProviderOAuthFlow } from "./use-provider-oauth-flow";

export function ProviderOAuthPanel({
  oauth,
  codexSetup,
  config,
  hasCodexOAuthProvider,
  codexRoutingModel,
  providerSaveBusy,
  handleUseCodexForChat,
  handleAddChatGptOAuthProvider,
  handleShowCodexOAuthProviderDetail,
  route,
  navigate,
}: Pick<SettingsSectionProps, "activeWorkspaceId" | "route" | "navigate"> & {
  oauth: ReturnType<typeof useProviderOAuthFlow>;
  codexSetup: Pick<ReturnType<typeof useSettingsChange>, "change" | "refresh">;
  config: ProviderCatalog["config"];
  hasCodexOAuthProvider: boolean;
  codexRoutingModel: string;
  providerSaveBusy: boolean;
  handleUseCodexForChat: () => Promise<void>;
  handleAddChatGptOAuthProvider: () => Promise<void>;
  handleShowCodexOAuthProviderDetail: () => void;
  setNotice: ProviderNoticeSetter;
}) {
  const {
    codexOAuthStatus,
    codexOAuthFlow,
    codexOAuthPlan,
    setCodexOAuthPlanDialog,
    codexOAuthBusy,
    codexOAuthConnected,
    handleStartCodexOAuth,
    handleRestartCodexOAuth,
    handlePollCodexOAuth,
    handleDisconnectCodexOAuth,
    handleOpenCodexOAuthVerification,
    handleCancelCodexOAuth,
  } = oauth;
  const locked = codexOAuthBusy || Boolean(oauth.mutation.uncertain);
  const hasCodexOAuthCredential = Boolean(codexOAuthStatus?.connected || codexOAuthStatus?.requiresReauth);
  const hasOrphanCodexOAuthCredential = !hasCodexOAuthProvider && hasCodexOAuthCredential;
  const codexOAuthFlowUserCode = codexOAuthFlow?.userCode?.trim() ?? "";
  const codexOAuthExpiryLabel = useMemo(() => formatOpenAICodexOAuthExpiry(codexOAuthFlow), [codexOAuthFlow]);
  const codexIsActiveRouting = config?.activeProviderId === "openai-codex" && Boolean(config.activeModel?.trim());
  const codexOAuthWizardSteps = useMemo(
    () => [
      {
        label: "Provider",
        description: hasCodexOAuthProvider
          ? "GoatCitadel has the OpenAI Codex provider template ready."
          : "Add the built-in OpenAI Codex provider template.",
        state: hasCodexOAuthProvider ? ("complete" as const) : ("active" as const),
      },
      {
        label: "ChatGPT login",
        description: codexOAuthConnected
          ? "A ChatGPT OAuth credential is stored securely in the OS keychain."
          : codexOAuthFlow
            ? codexOAuthFlowUserCode
              ? "Use the active device code below."
              : "Finish the OpenAI browser approval window."
            : "Start browser login and sign in with OpenAI.",
        state: codexOAuthConnected || codexOAuthFlow ? ("complete" as const) : ("active" as const),
      },
      {
        label: "OpenAI approval",
        description: codexOAuthConnected
          ? "OpenAI approved the login."
          : codexOAuthFlow
            ? codexOAuthFlowUserCode
              ? `Enter exactly ${codexOAuthFlowUserCode} on the OpenAI page.`
              : "Complete the OpenAI approval tab."
            : "The OpenAI page opens after login starts.",
        state: codexOAuthConnected
          ? ("complete" as const)
          : codexOAuthFlow
            ? ("active" as const)
            : ("pending" as const),
      },
      {
        label: "Chat routing",
        description: codexIsActiveRouting
          ? `OpenAI Codex is active for Chat with ${config?.activeModel}.`
          : codexOAuthConnected
            ? "Choose Use for Chat, or save OpenAI Codex in Active routing."
            : codexOAuthFlow
              ? "Finish the login before activating this provider for Chat."
              : "Connect ChatGPT, then activate this provider for Chat.",
        state: codexIsActiveRouting
          ? ("complete" as const)
          : codexOAuthConnected
            ? ("active" as const)
            : ("pending" as const),
      },
    ],
    [
      codexIsActiveRouting,
      codexOAuthConnected,
      codexOAuthFlow,
      codexOAuthFlowUserCode,
      config?.activeModel,
      hasCodexOAuthProvider,
    ],
  );
  return (
    <>
      <SettingsChangeStatus
        change={codexSetup.change}
        onRefresh={codexSetup.refresh}
        route={route}
        navigate={navigate}
        onReview={setCodexOAuthPlanDialog}
      />
      <NativeMetricGrid
        items={[
          { label: "Provider", value: hasCodexOAuthProvider ? "Ready" : "Missing" },
          {
            label: "Login",
            value: !codexOAuthStatus
              ? "Unavailable"
              : codexOAuthConnected
                ? "Connected"
                : codexOAuthStatus?.requiresReauth
                  ? "Reauth"
                  : codexOAuthFlow
                    ? "Waiting"
                    : "Not started",
          },
        ]}
      />
      <SettingsWizardSteps steps={codexOAuthWizardSteps} />
      {oauth.codexOAuthStatusError ? (
        <SettingsNotice
          notice={{ tone: "error", message: `OAuth status unavailable: ${oauth.codexOAuthStatusError}` }}
        />
      ) : null}
      {hasOrphanCodexOAuthCredential ? (
        <SettingsNotice
          notice={{
            tone: "warning",
            message:
              "A ChatGPT OAuth credential exists in secure storage, but the OpenAI Codex provider is missing. Add the provider to use it, or disconnect to remove the stored credential.",
          }}
        />
      ) : !hasCodexOAuthProvider ? (
        <SettingsNotice
          notice={{
            tone: "info",
            message:
              "Start here. GoatCitadel will add the built-in OpenAI Codex provider, then this card will switch to ChatGPT login.",
          }}
        />
      ) : codexOAuthConnected ? (
        <SettingsNotice
          notice={{
            tone: codexIsActiveRouting ? "success" : "warning",
            message: codexIsActiveRouting
              ? `Done. ChatGPT OAuth is connected${codexOAuthStatus?.accountLabel ? ` as ${codexOAuthStatus.accountLabel}` : ""}, and OpenAI Codex is active for Chat.`
              : `ChatGPT OAuth is connected${codexOAuthStatus?.accountLabel ? ` as ${codexOAuthStatus.accountLabel}` : ""}, but it is not active for Chat yet. Choose Use for Chat below.`,
          }}
        />
      ) : codexOAuthFlow ? (
        <div className="mc-next-settings-oauth-code-card">
          <span>{codexOAuthFlowUserCode ? "Use this exact OpenAI code" : "OpenAI browser login"}</span>
          <strong>{codexOAuthFlowUserCode || "Awaiting approval"}</strong>
          {codexOAuthFlowUserCode ? (
            <p>
              Open the OpenAI page, enter this code, approve the request, then return here. GoatCitadel checks
              automatically{codexOAuthExpiryLabel ? ` for about ${codexOAuthExpiryLabel}` : ""}.
            </p>
          ) : (
            <p>
              Complete the OpenAI browser approval, then return here. GoatCitadel checks automatically
              {codexOAuthExpiryLabel ? ` for about ${codexOAuthExpiryLabel}` : ""}.
            </p>
          )}
        </div>
      ) : (
        <SettingsNotice
          notice={{
            tone: "info",
            message: "Press Start ChatGPT login. GoatCitadel will open the OpenAI approval page.",
          }}
        />
      )}
      {codexOAuthFlow ? (
        <SettingsFieldGrid>
          <SettingsField label="OpenAI page">
            <input className="mc-next-settings-input" value={codexOAuthFlow.verificationUrl} readOnly />
          </SettingsField>
          {codexOAuthFlowUserCode ? (
            <SettingsField label="Current code">
              <input className="mc-next-settings-input" value={codexOAuthFlowUserCode} readOnly />
            </SettingsField>
          ) : null}
        </SettingsFieldGrid>
      ) : null}
      {codexOAuthPlan ? (
        <ChatChangePlanCard
          plan={codexOAuthPlan}
          pending={locked}
          onReview={(plan) => setCodexOAuthPlanDialog(plan)}
          onCancel={(plan) => void handleCancelCodexOAuth(plan)}
        />
      ) : null}
      <SettingsButtonRow>
        {codexOAuthConnected && !codexIsActiveRouting ? (
          <NativeButton
            variant="default"
            onClick={() => void handleUseCodexForChat()}
            disabled={locked || !codexRoutingModel}
          >
            <Save size={16} />
            Use for Chat
          </NativeButton>
        ) : null}
        {!hasCodexOAuthProvider ? (
          <NativeButton
            variant="default"
            onClick={() => void handleAddChatGptOAuthProvider()}
            disabled={providerSaveBusy || locked}
          >
            <KeyRound size={16} />
            Add provider and continue
          </NativeButton>
        ) : codexOAuthFlow ? (
          <NativeButton variant="default" onClick={handleOpenCodexOAuthVerification} disabled={locked}>
            <ExternalLink size={16} />
            Open OpenAI page
          </NativeButton>
        ) : (
          <NativeButton
            variant={codexOAuthConnected ? "secondary" : "default"}
            onClick={() => void handleStartCodexOAuth(true)}
            disabled={locked}
          >
            <KeyRound size={16} />
            {codexOAuthConnected ? "Reconnect ChatGPT" : "Start ChatGPT login"}
          </NativeButton>
        )}
        {codexOAuthFlow ? (
          <NativeButton variant="secondary" onClick={() => void handlePollCodexOAuth()} disabled={locked}>
            <RefreshCw size={16} />I approved, check now
          </NativeButton>
        ) : null}
        {codexOAuthFlow ? (
          <NativeButton variant="secondary" onClick={() => void handleRestartCodexOAuth()} disabled={locked}>
            <RotateCcw size={16} />
            Reopen login
          </NativeButton>
        ) : null}
        {hasCodexOAuthProvider && !codexOAuthFlow ? (
          <NativeButton variant="secondary" onClick={handleShowCodexOAuthProviderDetail}>
            <SlidersHorizontal size={16} />
            Advanced details
          </NativeButton>
        ) : null}
        {hasCodexOAuthCredential ? (
          <NativeButton variant="secondary" onClick={() => void handleDisconnectCodexOAuth()} disabled={locked}>
            <Trash2 size={16} />
            Disconnect
          </NativeButton>
        ) : null}
      </SettingsButtonRow>
    </>
  );
}
