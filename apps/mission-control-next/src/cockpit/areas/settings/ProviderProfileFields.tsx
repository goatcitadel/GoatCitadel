import type { ProviderProfileFieldsProps } from "../../../features/native-routes/settings/sections/ProviderProfileFields";
import {
  getProviderApiStyleWarning,
  type ProviderEditorDraft,
} from "../../../features/native-routes/settings/helpers/provider-drafts";
import { Field } from "../../ui/Field";
import { cockpitInputClass } from "../../ui/input-class";
import { ProviderTransportFields } from "./ProviderTransportFields";
import { urlFieldError, useBlurValidation } from "./field-validation";
import {
  AWS_SIGV4_ENV_REFERENCE_HELP,
  AWS_SIGV4_ENV_REFERENCE_LABEL,
  BEDROCK_CREDENTIAL_MODE_OPTIONS,
  isBedrockCredentialMode,
  LLM_API_STYLE_LABELS,
  LLM_API_STYLES,
} from "./settings-vocabulary";

type TextKey = {
  [K in keyof ProviderEditorDraft]: ProviderEditorDraft[K] extends string ? K : never;
}[keyof ProviderEditorDraft];
type BlurCheck = ReturnType<typeof useBlurValidation>;

export function ProviderProfileFields(
  props: ProviderProfileFieldsProps & {
    disabled: boolean;
    existing: boolean;
    credentialStorage?: "keychain" | "env";
    onCredentialStorage?: (value: "keychain" | "env") => void;
    /** Opens the request transport group, for the provider page's Transport entry point. */
    transportOpen?: boolean;
  },
) {
  const draft = props.providerDraft;
  const codex = draft.providerId.trim().toLowerCase() === "openai-codex" || draft.authMode === "codex-oauth";
  const google = draft.authMode === "google-adc" || draft.authMode === "google-service-account";
  const bedrock = draft.apiStyle === "bedrock-messages" || isBedrockCredentialMode(draft.authMode);
  // The local Claude Code CLI provider holds no secret; its only credential mode is the operator's own login.
  const claudeCli =
    draft.providerId.trim().toLowerCase() === "claude-code-cli" ||
    draft.apiStyle === "claude-code-cli" ||
    draft.authMode === "claude-code-cli-login";
  const providerIdCheck = useBlurValidation((value) => (value.trim() ? undefined : "Enter a provider ID."));
  const baseUrlCheck = useBlurValidation((value) => urlFieldError(value, { required: true }));
  const patch = <K extends keyof ProviderEditorDraft>(key: K, value: ProviderEditorDraft[K]) =>
    props.setProviderDraft((current) => ({ ...current, [key]: value }));
  const text = (
    key: TextKey,
    label: string,
    options: { disabled?: boolean; required?: boolean; help?: string; type?: "url"; check?: BlurCheck } = {},
  ) => (
    <Field key={key} label={label} required={options.required} help={options.help} error={options.check?.error}>
      {(fieldProps) => (
        <input
          {...fieldProps}
          // A required label also shows a marker; the name stays the plain label text.
          aria-label={options.required ? label : undefined}
          type={options.type ?? "text"}
          autoComplete="off"
          spellCheck={false}
          className={cockpitInputClass}
          value={draft[key]}
          disabled={props.disabled || options.disabled}
          onBlur={(event) => options.check?.onBlur(event.target.value)}
          onChange={(event) => {
            patch(key, event.target.value);
            options.check?.onChange(event.target.value);
          }}
        />
      )}
    </Field>
  );
  const apiStyleWarning = getProviderApiStyleWarning(draft);
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {text("providerId", "Provider ID", {
          disabled: props.existing,
          required: !props.existing,
          check: props.existing ? undefined : providerIdCheck,
        })}
        {text("label", "Provider label")}
        {props.existing
          ? null
          : text("baseUrl", "Provider base URL", { required: true, type: "url", check: baseUrlCheck })}
        {text("defaultModel", "Provider's suggested model")}
        <Field label="Provider API style">
          {(fieldProps) => (
            <select
              {...fieldProps}
              className={cockpitInputClass}
              value={draft.apiStyle}
              disabled={props.disabled}
              onChange={(event) => patch("apiStyle", event.target.value as ProviderEditorDraft["apiStyle"])}
            >
              {LLM_API_STYLES.map((value) => (
                <option key={value} value={value}>
                  {LLM_API_STYLE_LABELS[value]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Credential mode">
          {(fieldProps) => (
            <select
              {...fieldProps}
              className={cockpitInputClass}
              value={codex ? "codex-oauth" : claudeCli ? "claude-code-cli-login" : draft.authMode}
              disabled={props.disabled || codex || claudeCli}
              onChange={(event) => patch("authMode", event.target.value as ProviderEditorDraft["authMode"])}
            >
              <option value="">Provider default</option>
              <option value="api-key">API key</option>
              <option value="google-adc">Google ADC</option>
              <option value="google-service-account">Google service account</option>
              <option value="claude-code-oauth">Claude Code OAuth token</option>
              <option value="codex-oauth">ChatGPT/Codex OAuth</option>
              {claudeCli ? <option value="claude-code-cli-login">Local Claude Code login</option> : null}
              {bedrock
                ? BEDROCK_CREDENTIAL_MODE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))
                : null}
            </select>
          )}
        </Field>
        {!codex && !claudeCli && draft.authMode !== "google-adc"
          ? text(
              "apiKeyEnv",
              draft.authMode === "google-service-account"
                ? "Service-account JSON environment variable"
                : draft.authMode === "aws-sigv4"
                  ? AWS_SIGV4_ENV_REFERENCE_LABEL
                  : "API key environment variable",
              { help: draft.authMode === "aws-sigv4" ? AWS_SIGV4_ENV_REFERENCE_HELP : undefined },
            )
          : null}
        {google ? (
          <>
            {text("googleProjectId", "Google Cloud project")}
            {text("googleProjectIdEnv", "Google project environment variable")}
            {text("googleLocation", "Google Cloud location")}
            {text("googleLocationEnv", "Google location environment variable")}
            {text("googleEndpointId", "Google endpoint ID")}
          </>
        ) : null}
      </div>
      {props.existing ? (
        <p className="text-xs text-fg-muted">
          Change this provider's endpoint and saved credential under Provider connection on the provider page.
        </p>
      ) : null}
      {!props.existing && !codex && !claudeCli && draft.authMode !== "google-adc" ? (
        <div className="space-y-2">
          <Field label="New credential storage">
            {(fieldProps) => (
              <select
                {...fieldProps}
                className={cockpitInputClass}
                disabled={props.disabled}
                value={props.credentialStorage ?? "keychain"}
                onChange={(event) => props.onCredentialStorage?.(event.target.value as "keychain" | "env")}
              >
                <option value="keychain">OS keychain</option>
                <option value="env">Installation environment file (plaintext)</option>
              </select>
            )}
          </Field>
          {props.credentialStorage === "env" ? (
            <p role="note" className="text-sm text-status-waiting">
              The credential will be stored as plaintext in this installation's environment file at{" "}
              {draft.apiKeyEnv || "the reviewed environment variable"}. Anyone who can read that file can read it. This
              is an explicit choice; keychain failures never fall back here.
            </p>
          ) : null}
        </div>
      ) : null}
      {apiStyleWarning ? (
        <p role="status" className="text-sm text-status-waiting">
          {apiStyleWarning}
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
        error={props.providerRequestValidation.error}
        defaultOpen={props.transportOpen}
      />
    </div>
  );
}
