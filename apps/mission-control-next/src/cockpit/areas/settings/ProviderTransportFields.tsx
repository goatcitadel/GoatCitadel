import { useId } from "react";
import type { LlmTransportDraft } from "@goatcitadel/mission-control-shared/components/LlmTransportFields";

const fieldClass =
  "mt-1 block min-h-11 w-full rounded-md border border-line bg-canvas px-2 py-1 text-sm text-fg disabled:opacity-60";
export function ProviderTransportFields({
  draft,
  onChange,
  disabled,
}: {
  draft: LlmTransportDraft;
  onChange: (draft: LlmTransportDraft) => void;
  disabled: boolean;
}) {
  const id = useId();
  const field = (name: string, label: string, value: string, update: (value: string) => void) => (
    <label key={name} className="block text-sm text-fg-secondary">
      <span id={`${id}-${name}`}>{label}</span>
      <input
        aria-labelledby={`${id}-${name}`}
        className={fieldClass}
        value={value}
        disabled={disabled}
        onChange={(event) => update(event.target.value)}
      />
    </label>
  );
  return (
    <details className="rounded-md border border-line-subtle p-3">
      <summary className="cursor-pointer text-sm font-medium text-fg">Advanced request transport</summary>
      <p className="my-3 text-xs text-fg-muted">
        These settings use the dedicated Gateway settings owner and its revision check. Transport auth accepts
        environment references; inline tokens and credentials are rejected. File paths refer to the Gateway host.
      </p>
      <p className="my-3 text-xs text-fg-muted">
        Header values are write-only: the Gateway acknowledges accepted names and keeps saved values hidden.
        Save public profile edits first, then review transport separately. The owner merges transport fields; clearing
        an existing field is not a supported removal.
      </p>
      <div className="space-y-3">
        <label className="block text-sm text-fg-secondary">
          <span id={`${id}-headers`}>Extra request headers</span>
          <textarea
            aria-labelledby={`${id}-headers`}
            className={`${fieldClass} font-mono`}
            rows={3}
            disabled={disabled}
            placeholder='{"X-Client": "GoatCitadel"}'
            value={draft.headersJson}
            onChange={(event) => onChange({ ...draft, headersJson: event.target.value })}
          />
        </label>
        <p className="text-xs text-fg-muted">
          Header configuration uses a JSON object. Do not enter credential values here; use the environment reference
          fields below.
        </p>
        {(["auth", "proxyAuth"] as const).map((key) => {
          const auth = draft[key];
          const label = key === "auth" ? "Request" : "Proxy";
          const patch = (value: Partial<LlmTransportDraft[typeof key]>) =>
            onChange({ ...draft, [key]: { ...auth, ...value, token: "", value: "" } });
          return (
            <fieldset key={key} className="space-y-2 border-t border-line-subtle pt-3">
              <legend className="text-sm font-medium text-fg">{label} authentication</legend>
              <label className="text-sm text-fg-secondary">
                <span id={`${id}-${key}-mode`}>{label} auth mode</span>
                <select
                  aria-labelledby={`${id}-${key}-mode`}
                  className={fieldClass}
                  value={auth.mode}
                  disabled={disabled}
                  onChange={(event) => patch({ mode: event.target.value as typeof auth.mode })}
                >
                  <option value="none">None</option>
                  <option value="bearer">Bearer environment token</option>
                  <option value="header">Header environment value</option>
                  {key === "auth" ? <option value="query">Query environment value</option> : null}
                </select>
              </label>
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
        {field("proxy-url", "Proxy URL", draft.proxyUrl, (proxyUrl) => onChange({ ...draft, proxyUrl }))}
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
      </div>
    </details>
  );
}
