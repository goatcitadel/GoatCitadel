import { useId } from "react";
import type { ProviderProfileFieldsProps } from "../../../features/native-routes/settings/sections/ProviderProfileFields";
import {
  getProviderApiStyleWarning,
  type ProviderEditorDraft,
} from "../../../features/native-routes/settings/helpers/provider-drafts";
import { ProviderTransportFields } from "./ProviderTransportFields";

export const providerFieldClass =
  "mt-1 block min-h-11 w-full rounded-md border border-line bg-canvas px-2 py-1 text-sm text-fg disabled:opacity-60";
export function ProviderProfileFields(
  props: ProviderProfileFieldsProps & {
    disabled: boolean;
    existing: boolean;
    credentialStorage?: "keychain" | "env";
    onCredentialStorage?: (value: "keychain" | "env") => void;
  },
) {
  const id = useId();
  const draft = props.providerDraft;
  const codex = draft.providerId.trim().toLowerCase() === "openai-codex" || draft.authMode === "codex-oauth";
  const google = draft.authMode === "google-adc" || draft.authMode === "google-service-account";
  const patch = <K extends keyof ProviderEditorDraft>(key: K, value: ProviderEditorDraft[K]) =>
    props.setProviderDraft((current) => ({ ...current, [key]: value }));
  const field = (key: keyof ProviderEditorDraft, label: string, disabled = false) => (
    <label key={key} className="block text-sm text-fg-secondary">
      <span id={`${id}-${key}`}>{label}</span>
      <input
        aria-labelledby={`${id}-${key}`}
        className={providerFieldClass}
        value={draft[key]}
        disabled={props.disabled || disabled}
        onChange={(event) => patch(key, event.target.value as ProviderEditorDraft[typeof key])}
      />
    </label>
  );
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {field("providerId", "Provider ID", props.existing)}
        {field("label", "Provider label")}
        {field("baseUrl", "Provider base URL")}
        {field("defaultModel", "Profile default model")}
        <label className="text-sm text-fg-secondary">
          <span id={`${id}-api-style`}>Provider API style</span>
          <select
            aria-labelledby={`${id}-api-style`}
            className={providerFieldClass}
            value={draft.apiStyle}
            disabled={props.disabled}
            onChange={(event) => patch("apiStyle", event.target.value as ProviderEditorDraft["apiStyle"])}
          >
            {[
              "openai-responses",
              "openai-codex-responses",
              "anthropic-messages",
              "openai-chat-completions",
              "bedrock-messages",
            ].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="text-sm text-fg-secondary">
          <span id={`${id}-auth-mode`}>Credential mode</span>
          <select
            aria-labelledby={`${id}-auth-mode`}
            className={providerFieldClass}
            value={codex ? "codex-oauth" : draft.authMode}
            disabled={props.disabled || codex}
            onChange={(event) => patch("authMode", event.target.value as ProviderEditorDraft["authMode"])}
          >
            <option value="">Provider default</option>
            <option value="api-key">API key</option>
            <option value="google-adc">Google ADC</option>
            <option value="google-service-account">Google service account</option>
            <option value="claude-code-oauth">Claude Code OAuth token</option>
            <option value="codex-oauth">ChatGPT/Codex OAuth</option>
          </select>
        </label>
        {!codex && draft.authMode !== "google-adc"
          ? field(
              "apiKeyEnv",
              draft.authMode === "google-service-account"
                ? "Service-account JSON environment variable"
                : "API key environment variable",
            )
          : null}
        {google ? (
          <>
            {field("googleProjectId", "Google Cloud project")}
            {field("googleProjectIdEnv", "Google project environment variable")}
            {field("googleLocation", "Google Cloud location")}
            {field("googleLocationEnv", "Google location environment variable")}
            {field("googleEndpointId", "Google endpoint ID")}
          </>
        ) : null}
      </div>
      {!props.existing && !codex && draft.authMode !== "google-adc" ? (
        <div className="space-y-2">
          <label className="block text-sm text-fg-secondary">
            <span id={`${id}-custody`}>New credential storage</span>
            <select
              aria-labelledby={`${id}-custody`}
              className={providerFieldClass}
              disabled={props.disabled}
              value={props.credentialStorage ?? "keychain"}
              onChange={(event) => props.onCredentialStorage?.(event.target.value as "keychain" | "env")}
            >
              <option value="keychain">OS keychain</option>
              <option value="env">Installation environment file (plaintext)</option>
            </select>
          </label>
          {props.credentialStorage === "env" ? (
            <p role="note" className="text-sm text-status-waiting">
              The credential will be stored as plaintext in this installation's environment file at{" "}
              {draft.apiKeyEnv || "the reviewed environment variable"}. Anyone who can read that file can read it. This
              is an explicit choice; keychain failures never fall back here.
            </p>
          ) : null}
        </div>
      ) : null}
      {getProviderApiStyleWarning(draft) ? (
        <p role="status" className="text-sm text-status-waiting">
          {getProviderApiStyleWarning(draft)}
        </p>
      ) : null}
      <p className="text-xs text-fg-muted">
        A profile default is separate from installation routing. Credentials are entered only in the Gateway's secure
        credential action.
      </p>
      <ProviderTransportFields
        draft={props.providerTransportDraft}
        onChange={props.setProviderTransportDraft}
        disabled={props.disabled}
      />
      {props.providerRequestValidation.error ? (
        <p role="alert" className="text-sm text-status-failed">
          {props.providerRequestValidation.error}
        </p>
      ) : null}
    </div>
  );
}
