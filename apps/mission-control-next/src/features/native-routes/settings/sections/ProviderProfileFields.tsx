import type { SetStateAction } from "react";
import {
  LlmTransportFields,
  type LlmTransportDraft,
} from "@goatcitadel/mission-control-shared/components/LlmTransportFields";
import { SettingsField, SettingsFieldGrid, SettingsNotice } from "../SettingsShared";
import { getProviderApiStyleWarning, type ProviderEditorDraft } from "../helpers/provider-drafts";

const PROVIDER_API_STYLE_OPTIONS: ProviderEditorDraft["apiStyle"][] = [
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "openai-chat-completions",
  "bedrock-messages",
];

export interface ProviderProfileFieldsProps {
  providerDraft: ProviderEditorDraft;
  setProviderDraft: (update: SetStateAction<ProviderEditorDraft>) => void;
  providerTransportDraft: LlmTransportDraft;
  setProviderTransportDraft: (update: SetStateAction<LlmTransportDraft>) => void;
  providerRequestValidation: { error: string | null };
}

/** Controlled public profile fields; draft and save authority remain with the caller. */
export function ProviderProfileFields({
  providerDraft,
  setProviderDraft,
  providerTransportDraft,
  setProviderTransportDraft,
  providerRequestValidation,
}: ProviderProfileFieldsProps) {
  const draftIsCodexOAuth =
    providerDraft.providerId.trim().toLowerCase() === "openai-codex" || providerDraft.authMode === "codex-oauth";
  const draftUsesGoogleAuth =
    providerDraft.authMode === "google-adc" || providerDraft.authMode === "google-service-account";
  const providerApiStyleWarning = getProviderApiStyleWarning(providerDraft);
  return (
    <>
      <SettingsFieldGrid>
        <SettingsField label="Provider id">
          <input
            className="mc-next-settings-input"
            value={providerDraft.providerId}
            placeholder="openai-compatible"
            onChange={(event) =>
              setProviderDraft((current) => ({
                ...current,
                providerId: event.target.value,
              }))
            }
          />
        </SettingsField>
        <SettingsField label="Label">
          <input
            className="mc-next-settings-input"
            value={providerDraft.label}
            placeholder="OpenAI-compatible"
            onChange={(event) =>
              setProviderDraft((current) => ({
                ...current,
                label: event.target.value,
              }))
            }
          />
        </SettingsField>
        <SettingsField label="Base URL">
          <input
            className="mc-next-settings-input"
            value={providerDraft.baseUrl}
            placeholder="https://llm.example.test/v1"
            onChange={(event) =>
              setProviderDraft((current) => ({
                ...current,
                baseUrl: event.target.value,
              }))
            }
          />
        </SettingsField>
        <SettingsField label="Provider API style">
          <select
            className="mc-next-settings-input"
            value={providerDraft.apiStyle}
            onChange={(event) =>
              setProviderDraft((current) => ({
                ...current,
                apiStyle: event.target.value as ProviderEditorDraft["apiStyle"],
              }))
            }
          >
            {PROVIDER_API_STYLE_OPTIONS.map((style) => (
              <option key={style} value={style}>
                {formatProviderApiStyleLabel(style)}
              </option>
            ))}
          </select>
          <p className="mc-next-settings-field-note">{describeProviderApiStyle(providerDraft.apiStyle)}</p>
          {providerApiStyleWarning ? <p className="mc-next-settings-field-note">{providerApiStyleWarning}</p> : null}
        </SettingsField>
        <SettingsField label="Credential mode">
          <select
            className="mc-next-settings-input"
            value={draftIsCodexOAuth ? "codex-oauth" : providerDraft.authMode}
            disabled={draftIsCodexOAuth}
            onChange={(event) =>
              setProviderDraft((current) => ({
                ...current,
                authMode: event.target.value as ProviderEditorDraft["authMode"],
              }))
            }
          >
            <option value="">Provider default</option>
            <option value="api-key">API key</option>
            <option value="google-adc">Google ADC</option>
            <option value="google-service-account">Google service account</option>
            <option value="claude-code-oauth">Claude Code OAuth token</option>
            <option value="codex-oauth">ChatGPT/Codex OAuth</option>
          </select>
          <p className="mc-next-settings-field-note">
            Google credential contents remain Gateway-local; this field stores only the auth posture.
          </p>
        </SettingsField>
        <SettingsField label="Default model">
          <input
            className="mc-next-settings-input"
            value={providerDraft.defaultModel}
            placeholder="gpt-5.4-mini"
            onChange={(event) =>
              setProviderDraft((current) => ({
                ...current,
                defaultModel: event.target.value,
              }))
            }
          />
        </SettingsField>
        {draftIsCodexOAuth || providerDraft.authMode === "google-adc" ? null : (
          <SettingsField
            label={providerDraft.authMode === "google-service-account" ? "Service-account JSON env" : "API key env"}
          >
            <input
              className="mc-next-settings-input"
              value={providerDraft.apiKeyEnv}
              placeholder="OPENAI_API_KEY"
              onChange={(event) =>
                setProviderDraft((current) => ({
                  ...current,
                  apiKeyEnv: event.target.value,
                }))
              }
            />
          </SettingsField>
        )}
        {draftUsesGoogleAuth ? (
          <>
            <SettingsField label="Google Cloud project">
              <input
                className="mc-next-settings-input"
                value={providerDraft.googleProjectId}
                placeholder="my-project"
                onChange={(event) =>
                  setProviderDraft((current) => ({ ...current, googleProjectId: event.target.value }))
                }
              />
            </SettingsField>
            <SettingsField label="Project env name">
              <input
                className="mc-next-settings-input"
                value={providerDraft.googleProjectIdEnv}
                placeholder="GOOGLE_CLOUD_PROJECT"
                onChange={(event) =>
                  setProviderDraft((current) => ({ ...current, googleProjectIdEnv: event.target.value }))
                }
              />
            </SettingsField>
            <SettingsField label="Vertex location">
              <input
                className="mc-next-settings-input"
                value={providerDraft.googleLocation}
                placeholder="us-central1"
                onChange={(event) =>
                  setProviderDraft((current) => ({ ...current, googleLocation: event.target.value }))
                }
              />
            </SettingsField>
            <SettingsField label="Location env name">
              <input
                className="mc-next-settings-input"
                value={providerDraft.googleLocationEnv}
                placeholder="GOOGLE_CLOUD_LOCATION"
                onChange={(event) =>
                  setProviderDraft((current) => ({ ...current, googleLocationEnv: event.target.value }))
                }
              />
            </SettingsField>
            <SettingsField label="Vertex endpoint id">
              <input
                className="mc-next-settings-input"
                value={providerDraft.googleEndpointId}
                placeholder="openapi"
                onChange={(event) =>
                  setProviderDraft((current) => ({ ...current, googleEndpointId: event.target.value }))
                }
              />
            </SettingsField>
          </>
        ) : null}
      </SettingsFieldGrid>
      {providerRequestValidation.error ? (
        <SettingsNotice notice={{ tone: "error", message: providerRequestValidation.error }} />
      ) : null}
      <LlmTransportFields
        draft={providerTransportDraft}
        idPrefix={`provider-editor-${providerDraft.providerId || "draft"}`}
        onChange={setProviderTransportDraft}
        error={providerRequestValidation.error}
      />
    </>
  );
}

function formatProviderApiStyleLabel(value: ProviderEditorDraft["apiStyle"]): string {
  if (value === "openai-responses") {
    return "OpenAI Responses";
  }
  if (value === "openai-codex-responses") {
    return "OpenAI Codex Responses";
  }
  if (value === "anthropic-messages") {
    return "Anthropic Messages";
  }
  return "OpenAI Chat Completions";
}

function describeProviderApiStyle(value: ProviderEditorDraft["apiStyle"]): string {
  if (value === "openai-responses") {
    return "Use for modern OpenAI-compatible Responses endpoints with tool and reasoning support.";
  }
  if (value === "openai-codex-responses") {
    return "Use only for the built-in ChatGPT/Codex OAuth provider.";
  }
  if (value === "anthropic-messages") {
    return "Use for Anthropic Claude providers that speak the Messages API.";
  }
  return "Use for older OpenAI-compatible chat-completions endpoints such as many proxy or local servers.";
}
