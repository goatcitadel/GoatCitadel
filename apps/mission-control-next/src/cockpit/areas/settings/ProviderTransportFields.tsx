import { useEffect, useRef } from "react";
import type { LlmTransportDraft } from "@goatcitadel/mission-control-shared/components/LlmTransportFields";
import { Field } from "../../ui/Field";
import { cockpitInputClass } from "../../ui/input-class";
import { jsonObjectFieldError, urlFieldError, useBlurValidation } from "./field-validation";

/** Which field a transport validation message belongs to, so it is shown on that field. */
export function transportErrorField(error: string | null | undefined): "headers" | "proxy-url" | "other" | null {
  if (!error) return null;
  if (/^Custom header/i.test(error)) return "headers";
  if (/proxy URL/i.test(error)) return "proxy-url";
  return "other";
}

export function ProviderTransportFields({
  draft,
  onChange,
  disabled,
  error,
  defaultOpen = false,
}: {
  draft: LlmTransportDraft;
  onChange: (draft: LlmTransportDraft) => void;
  disabled: boolean;
  /** The Gateway-side request validation message for the whole transport draft. */
  error?: string | null;
  defaultOpen?: boolean;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const headersCheck = useBlurValidation(jsonObjectFieldError);
  const proxyCheck = useBlurValidation((value) => urlFieldError(value));
  const errorField = transportErrorField(error);
  // A message hidden in a closed group can't be acted on: open the group when one appears.
  useEffect(() => {
    if (errorField && details.current) details.current.open = true;
  }, [errorField]);
  const field = (name: string, label: string, value: string, update: (value: string) => void) => (
    <Field key={name} label={label}>
      {(fieldProps) => (
        <input
          {...fieldProps}
          autoComplete="off"
          spellCheck={false}
          className={cockpitInputClass}
          value={value}
          disabled={disabled}
          onChange={(event) => update(event.target.value)}
        />
      )}
    </Field>
  );
  return (
    <details ref={details} open={defaultOpen || undefined} className="rounded-md border border-line-subtle p-3">
      <summary className="cursor-pointer text-sm font-medium text-fg">Advanced request transport</summary>
      <p className="my-3 text-xs text-fg-muted">
        Transport sign-in accepts environment variable names only; inline tokens and credentials are rejected. File
        paths refer to the machine running GoatCitadel. Saving stops if someone else changed these settings since you
        opened them.
      </p>
      <p className="my-3 text-xs text-fg-muted">
        Header values are write-only: after saving you see header names, never their values. Save profile edits first,
        then review transport separately. Saving adds or updates fields; clearing an existing field does not remove it.
      </p>
      <div className="space-y-3">
        <Field
          label="Extra request headers"
          help="A JSON object. Do not enter credential values here; use the environment reference fields below."
          error={headersCheck.error ?? (errorField === "headers" ? (error ?? undefined) : undefined)}
        >
          {(fieldProps) => (
            <textarea
              {...fieldProps}
              className={`${cockpitInputClass} font-mono`}
              rows={3}
              disabled={disabled}
              spellCheck={false}
              placeholder='{"X-Client": "GoatCitadel"}'
              value={draft.headersJson}
              onBlur={(event) => headersCheck.onBlur(event.target.value)}
              onChange={(event) => {
                onChange({ ...draft, headersJson: event.target.value });
                headersCheck.onChange(event.target.value);
              }}
            />
          )}
        </Field>
        {(["auth", "proxyAuth"] as const).map((key) => {
          const auth = draft[key];
          const label = key === "auth" ? "Request" : "Proxy";
          const patch = (value: Partial<LlmTransportDraft[typeof key]>) =>
            onChange({ ...draft, [key]: { ...auth, ...value, token: "", value: "" } });
          return (
            <fieldset key={key} className="space-y-2 border-t border-line-subtle pt-3">
              <legend className="text-sm font-medium text-fg">{label} authentication</legend>
              <Field label={`${label} auth mode`}>
                {(fieldProps) => (
                  <select
                    {...fieldProps}
                    className={cockpitInputClass}
                    value={auth.mode}
                    disabled={disabled}
                    onChange={(event) => patch({ mode: event.target.value as typeof auth.mode })}
                  >
                    <option value="none">None</option>
                    <option value="bearer">Bearer environment token</option>
                    <option value="header">Header environment value</option>
                    {key === "auth" ? <option value="query">Query environment value</option> : null}
                  </select>
                )}
              </Field>
              {auth.mode === "bearer" ? (
                <>
                  {field(`${key}-token-env`, `${label} token environment variable`, auth.tokenEnv, (tokenEnv) =>
                    patch({ tokenEnv }),
                  )}
                  {field(`${key}-header-name`, `${label} bearer header name`, auth.headerName, (headerName) =>
                    patch({ headerName }),
                  )}
                </>
              ) : null}
              {auth.mode === "header" ? (
                <>
                  {field(`${key}-header-name`, `${label} auth header name`, auth.headerName, (headerName) =>
                    patch({ headerName }),
                  )}
                  {field(`${key}-value-env`, `${label} header environment variable`, auth.valueEnv, (valueEnv) =>
                    patch({ valueEnv }),
                  )}
                  {field(`${key}-scheme`, `${label} authorization scheme`, auth.scheme, (scheme) => patch({ scheme }))}
                </>
              ) : null}
              {key === "auth" && draft.auth.mode === "query" ? (
                <>
                  {field("query-param", "Request query parameter", draft.auth.queryParam, (queryParam) =>
                    onChange({ ...draft, auth: { ...draft.auth, queryParam, token: "", value: "" } }),
                  )}
                  {field("query-env", "Request query environment variable", draft.auth.valueEnv, (valueEnv) =>
                    onChange({ ...draft, auth: { ...draft.auth, valueEnv, token: "", value: "" } }),
                  )}
                  {field("query-prefix", "Request query prefix", draft.auth.prefix, (prefix) =>
                    onChange({ ...draft, auth: { ...draft.auth, prefix, token: "", value: "" } }),
                  )}
                </>
              ) : null}
            </fieldset>
          );
        })}
        <Field
          label="Proxy URL"
          error={proxyCheck.error ?? (errorField === "proxy-url" ? (error ?? undefined) : undefined)}
        >
          {(fieldProps) => (
            <input
              {...fieldProps}
              type="url"
              autoComplete="off"
              spellCheck={false}
              className={cockpitInputClass}
              value={draft.proxyUrl}
              disabled={disabled}
              onBlur={(event) => proxyCheck.onBlur(event.target.value)}
              onChange={(event) => {
                onChange({ ...draft, proxyUrl: event.target.value });
                proxyCheck.onChange(event.target.value);
              }}
            />
          )}
        </Field>
        {field("proxy-bypass", "Proxy bypass hosts", draft.proxyBypassHostsText, (proxyBypassHostsText) =>
          onChange({ ...draft, proxyBypassHostsText }),
        )}
        {(["tls", "proxyTls"] as const).map((key) => (
          <fieldset key={key} className="space-y-2 border-t border-line-subtle pt-3">
            <legend className="text-sm font-medium text-fg">{key === "tls" ? "Request TLS" : "Proxy TLS"}</legend>
            {(["caCertPath", "clientCertPath", "clientKeyPath", "serverName"] as const).map((fieldKey) =>
              field(
                `${key}-${fieldKey}`,
                `${key === "tls" ? "Request" : "Proxy"} ${{ caCertPath: "CA certificate path", clientCertPath: "client certificate path", clientKeyPath: "client key path", serverName: "TLS server name" }[fieldKey]}`,
                draft[key][fieldKey],
                (value) => onChange({ ...draft, [key]: { ...draft[key], [fieldKey]: value } }),
              ),
            )}
            <label className="flex items-start gap-2 text-sm text-fg-secondary">
              <input
                type="checkbox"
                disabled={disabled}
                checked={draft[key].insecureSkipVerify}
                onChange={(event) =>
                  onChange({ ...draft, [key]: { ...draft[key], insecureSkipVerify: event.target.checked } })
                }
              />
              Skip {key === "tls" ? "request" : "proxy"} certificate verification (unsafe)
            </label>
          </fieldset>
        ))}
        {errorField === "other" ? (
          <p role="alert" className="text-sm text-status-failed">
            {error}
          </p>
        ) : null}
      </div>
    </details>
  );
}
