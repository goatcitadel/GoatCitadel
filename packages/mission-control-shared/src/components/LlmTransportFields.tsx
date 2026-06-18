import type { ReactNode } from "react";
import type {
  LlmProviderRequestAuthConfig,
  LlmProviderRequestConfig,
  LlmProviderRequestProxyAuthConfig,
  LlmProviderRequestTlsConfig,
} from "@goatcitadel/contracts";

type RequestAuthMode = "none" | "bearer" | "header" | "query";
type ProxyAuthMode = "none" | "bearer" | "header";

interface RequestAuthDraft {
  mode: RequestAuthMode;
  headerName: string;
  token: string;
  tokenEnv: string;
  value: string;
  valueEnv: string;
  scheme: string;
  queryParam: string;
  prefix: string;
}

interface ProxyAuthDraft {
  mode: ProxyAuthMode;
  headerName: string;
  token: string;
  tokenEnv: string;
  value: string;
  valueEnv: string;
  scheme: string;
}

interface TlsDraft {
  insecureSkipVerify: boolean;
  caCertPath: string;
  clientCertPath: string;
  clientKeyPath: string;
  serverName: string;
}

export interface LlmTransportDraft {
  headersJson: string;
  auth: RequestAuthDraft;
  proxyUrl: string;
  proxyBypassHostsText: string;
  proxyAuth: ProxyAuthDraft;
  tls: TlsDraft;
  proxyTls: TlsDraft;
}

export interface LlmTransportFieldsProps {
  draft: LlmTransportDraft;
  idPrefix: string;
  onChange: (next: LlmTransportDraft) => void;
  error?: string | null;
}

const EMPTY_TLS_DRAFT: TlsDraft = {
  insecureSkipVerify: false,
  caCertPath: "",
  clientCertPath: "",
  clientKeyPath: "",
  serverName: "",
};

const EMPTY_REQUEST_AUTH_DRAFT: RequestAuthDraft = {
  mode: "none",
  headerName: "",
  token: "",
  tokenEnv: "",
  value: "",
  valueEnv: "",
  scheme: "",
  queryParam: "",
  prefix: "",
};

const EMPTY_PROXY_AUTH_DRAFT: ProxyAuthDraft = {
  mode: "none",
  headerName: "",
  token: "",
  tokenEnv: "",
  value: "",
  valueEnv: "",
  scheme: "",
};

export function createEmptyLlmTransportDraft(): LlmTransportDraft {
  return {
    headersJson: "",
    auth: { ...EMPTY_REQUEST_AUTH_DRAFT },
    proxyUrl: "",
    proxyBypassHostsText: "",
    proxyAuth: { ...EMPTY_PROXY_AUTH_DRAFT },
    tls: { ...EMPTY_TLS_DRAFT },
    proxyTls: { ...EMPTY_TLS_DRAFT },
  };
}

export function draftFromRequestConfig(request?: LlmProviderRequestConfig): LlmTransportDraft {
  return {
    headersJson: request?.headers ? JSON.stringify(request.headers, null, 2) : "",
    auth: draftAuthFromConfig(request?.auth),
    proxyUrl: request?.proxy?.url ?? "",
    proxyBypassHostsText: (request?.proxy?.bypassHosts ?? []).join("\n"),
    proxyAuth: draftProxyAuthFromConfig(request?.proxy?.auth),
    tls: draftTlsFromConfig(request?.tls),
    proxyTls: draftTlsFromConfig(request?.proxy?.tls),
  };
}

export function requestConfigFromDraft(draft: LlmTransportDraft): LlmProviderRequestConfig | undefined {
  const headers = parseHeadersJson(draft.headersJson);
  const auth = buildRequestAuthConfig(draft.auth);
  const tls = buildTlsConfig(draft.tls, "Request TLS");
  const proxy = buildProxyConfig(draft);
  const request: LlmProviderRequestConfig = {
    headers,
    auth,
    proxy,
    tls,
  };
  if (!request.headers && !request.auth && !request.proxy && !request.tls) {
    return undefined;
  }
  return request;
}

function Field({ htmlFor, label, children }: { htmlFor: string; label: string; children: ReactNode }) {
  return (
    <label className="mc-next-settings-field" htmlFor={htmlFor}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function LlmTransportFields({ draft, idPrefix, onChange, error }: LlmTransportFieldsProps) {
  const patchDraft = (patch: Partial<LlmTransportDraft>) => {
    onChange({
      ...draft,
      ...patch,
    });
  };

  const patchAuth = (patch: Partial<RequestAuthDraft>) => {
    patchDraft({
      auth: {
        ...draft.auth,
        ...patch,
      },
    });
  };

  const patchProxyAuth = (patch: Partial<ProxyAuthDraft>) => {
    patchDraft({
      proxyAuth: {
        ...draft.proxyAuth,
        ...patch,
      },
    });
  };

  const patchTls = (key: "tls" | "proxyTls", patch: Partial<TlsDraft>) => {
    patchDraft({
      [key]: {
        ...draft[key],
        ...patch,
      },
    } as Pick<LlmTransportDraft, "tls" | "proxyTls">);
  };

  return (
    <details className="mc-next-disclosure">
      <summary>Advanced transport</summary>
      <p className="mc-next-settings-field-note">
        Optional overrides for compatibility gateways, reverse proxies, custom auth headers, and mTLS.
      </p>
      {error ? <p className="mc-next-settings-field-error">{error}</p> : null}

      <section className="mc-next-settings-field-group">
        <h4>Request overrides</h4>
        <label className="mc-next-settings-field" htmlFor={`${idPrefix}-request-headers`}>
          <span>Custom headers (JSON object)</span>
          <textarea
            id={`${idPrefix}-request-headers`}
            className="mc-next-settings-textarea"
            value={draft.headersJson}
            onChange={(event) => patchDraft({ headersJson: event.target.value })}
            rows={4}
            placeholder={`{\n  "X-Trace": "1"\n}`}
          />
        </label>
        <Field htmlFor={`${idPrefix}-request-auth-mode`} label="Request auth mode">
          <select
            id={`${idPrefix}-request-auth-mode`}
            className="mc-next-settings-input"
            value={draft.auth.mode}
            onChange={(event) => patchAuth({ mode: event.target.value as RequestAuthMode })}
          >
            <option value="none">none</option>
            <option value="bearer">bearer</option>
            <option value="header">header</option>
            <option value="query">query</option>
          </select>
        </Field>
        {draft.auth.mode === "bearer" ? (
          <>
            <Field htmlFor={`${idPrefix}-request-bearer-token`} label="Bearer token">
              <input
                id={`${idPrefix}-request-bearer-token`}
                className="mc-next-settings-input"
                type="password"
                value={draft.auth.token}
                onChange={(event) => patchAuth({ token: event.target.value })}
              />
            </Field>
            <Field htmlFor={`${idPrefix}-request-bearer-token-env`} label="Bearer token env var">
              <input
                id={`${idPrefix}-request-bearer-token-env`}
                className="mc-next-settings-input"
                value={draft.auth.tokenEnv}
                onChange={(event) => patchAuth({ tokenEnv: event.target.value })}
              />
            </Field>
            <Field htmlFor={`${idPrefix}-request-bearer-header`} label="Header name override">
              <input
                id={`${idPrefix}-request-bearer-header`}
                className="mc-next-settings-input"
                value={draft.auth.headerName}
                onChange={(event) => patchAuth({ headerName: event.target.value })}
                placeholder="Authorization"
              />
            </Field>
          </>
        ) : null}
        {draft.auth.mode === "header" ? (
          <>
            <Field htmlFor={`${idPrefix}-request-header-name`} label="Header name">
              <input
                id={`${idPrefix}-request-header-name`}
                className="mc-next-settings-input"
                value={draft.auth.headerName}
                onChange={(event) => patchAuth({ headerName: event.target.value })}
              />
            </Field>
            <Field htmlFor={`${idPrefix}-request-header-value`} label="Header value">
              <input
                id={`${idPrefix}-request-header-value`}
                className="mc-next-settings-input"
                type="password"
                value={draft.auth.value}
                onChange={(event) => patchAuth({ value: event.target.value })}
              />
            </Field>
            <Field htmlFor={`${idPrefix}-request-header-value-env`} label="Header value env var">
              <input
                id={`${idPrefix}-request-header-value-env`}
                className="mc-next-settings-input"
                value={draft.auth.valueEnv}
                onChange={(event) => patchAuth({ valueEnv: event.target.value })}
              />
            </Field>
            <Field htmlFor={`${idPrefix}-request-header-scheme`} label="Optional scheme prefix">
              <input
                id={`${idPrefix}-request-header-scheme`}
                className="mc-next-settings-input"
                value={draft.auth.scheme}
                onChange={(event) => patchAuth({ scheme: event.target.value })}
                placeholder="Bearer"
              />
            </Field>
          </>
        ) : null}
        {draft.auth.mode === "query" ? (
          <>
            <Field htmlFor={`${idPrefix}-request-query-param`} label="Query param name">
              <input
                id={`${idPrefix}-request-query-param`}
                className="mc-next-settings-input"
                value={draft.auth.queryParam}
                onChange={(event) => patchAuth({ queryParam: event.target.value })}
              />
            </Field>
            <Field htmlFor={`${idPrefix}-request-query-value`} label="Query param value">
              <input
                id={`${idPrefix}-request-query-value`}
                className="mc-next-settings-input"
                type="password"
                value={draft.auth.value}
                onChange={(event) => patchAuth({ value: event.target.value })}
              />
            </Field>
            <Field htmlFor={`${idPrefix}-request-query-value-env`} label="Query param value env var">
              <input
                id={`${idPrefix}-request-query-value-env`}
                className="mc-next-settings-input"
                value={draft.auth.valueEnv}
                onChange={(event) => patchAuth({ valueEnv: event.target.value })}
              />
            </Field>
            <Field htmlFor={`${idPrefix}-request-query-prefix`} label="Optional value prefix">
              <input
                id={`${idPrefix}-request-query-prefix`}
                className="mc-next-settings-input"
                value={draft.auth.prefix}
                onChange={(event) => patchAuth({ prefix: event.target.value })}
                placeholder="Bearer "
              />
            </Field>
          </>
        ) : null}
      </section>

      <section className="mc-next-settings-field-group">
        <h4>Proxy routing</h4>
        <Field htmlFor={`${idPrefix}-proxy-url`} label="Proxy URL">
          <input
            id={`${idPrefix}-proxy-url`}
            className="mc-next-settings-input"
            value={draft.proxyUrl}
            onChange={(event) => patchDraft({ proxyUrl: event.target.value })}
            placeholder="http://proxy.internal:8080"
          />
        </Field>
        <label className="mc-next-settings-field" htmlFor={`${idPrefix}-proxy-bypass-hosts`}>
          <span>Bypass hosts</span>
          <textarea
            id={`${idPrefix}-proxy-bypass-hosts`}
            className="mc-next-settings-textarea"
            value={draft.proxyBypassHostsText}
            onChange={(event) => patchDraft({ proxyBypassHostsText: event.target.value })}
            rows={3}
            placeholder={"localhost\n127.0.0.1\n*.internal"}
          />
        </label>
        <Field htmlFor={`${idPrefix}-proxy-auth-mode`} label="Proxy auth mode">
          <select
            id={`${idPrefix}-proxy-auth-mode`}
            className="mc-next-settings-input"
            value={draft.proxyAuth.mode}
            onChange={(event) => patchProxyAuth({ mode: event.target.value as ProxyAuthMode })}
          >
            <option value="none">none</option>
            <option value="bearer">bearer</option>
            <option value="header">header</option>
          </select>
        </Field>
        {draft.proxyAuth.mode === "bearer" ? (
          <>
            <Field htmlFor={`${idPrefix}-proxy-bearer-token`} label="Proxy token">
              <input
                id={`${idPrefix}-proxy-bearer-token`}
                className="mc-next-settings-input"
                type="password"
                value={draft.proxyAuth.token}
                onChange={(event) => patchProxyAuth({ token: event.target.value })}
              />
            </Field>
            <Field htmlFor={`${idPrefix}-proxy-bearer-token-env`} label="Proxy token env var">
              <input
                id={`${idPrefix}-proxy-bearer-token-env`}
                className="mc-next-settings-input"
                value={draft.proxyAuth.tokenEnv}
                onChange={(event) => patchProxyAuth({ tokenEnv: event.target.value })}
              />
            </Field>
            <Field htmlFor={`${idPrefix}-proxy-bearer-header`} label="Proxy auth header name override">
              <input
                id={`${idPrefix}-proxy-bearer-header`}
                className="mc-next-settings-input"
                value={draft.proxyAuth.headerName}
                onChange={(event) => patchProxyAuth({ headerName: event.target.value })}
                placeholder="Proxy-Authorization"
              />
            </Field>
          </>
        ) : null}
        {draft.proxyAuth.mode === "header" ? (
          <>
            <Field htmlFor={`${idPrefix}-proxy-header-name`} label="Proxy header name">
              <input
                id={`${idPrefix}-proxy-header-name`}
                className="mc-next-settings-input"
                value={draft.proxyAuth.headerName}
                onChange={(event) => patchProxyAuth({ headerName: event.target.value })}
              />
            </Field>
            <Field htmlFor={`${idPrefix}-proxy-header-value`} label="Proxy header value">
              <input
                id={`${idPrefix}-proxy-header-value`}
                className="mc-next-settings-input"
                type="password"
                value={draft.proxyAuth.value}
                onChange={(event) => patchProxyAuth({ value: event.target.value })}
              />
            </Field>
            <Field htmlFor={`${idPrefix}-proxy-header-value-env`} label="Proxy header value env var">
              <input
                id={`${idPrefix}-proxy-header-value-env`}
                className="mc-next-settings-input"
                value={draft.proxyAuth.valueEnv}
                onChange={(event) => patchProxyAuth({ valueEnv: event.target.value })}
              />
            </Field>
            <Field htmlFor={`${idPrefix}-proxy-header-scheme`} label="Optional proxy scheme prefix">
              <input
                id={`${idPrefix}-proxy-header-scheme`}
                className="mc-next-settings-input"
                value={draft.proxyAuth.scheme}
                onChange={(event) => patchProxyAuth({ scheme: event.target.value })}
                placeholder="Bearer"
              />
            </Field>
          </>
        ) : null}
      </section>

      <TlsFields
        idPrefix={`${idPrefix}-request-tls`}
        title="Request TLS"
        subtitle="Applied when GoatCitadel connects to the provider endpoint directly."
        draft={draft.tls}
        onChange={(patch) => patchTls("tls", patch)}
      />
      <TlsFields
        idPrefix={`${idPrefix}-proxy-tls`}
        title="Proxy TLS"
        subtitle="Applied when GoatCitadel connects to the configured proxy itself."
        draft={draft.proxyTls}
        onChange={(patch) => patchTls("proxyTls", patch)}
      />
    </details>
  );
}

function TlsFields(input: {
  idPrefix: string;
  title: string;
  subtitle: string;
  draft: TlsDraft;
  onChange: (patch: Partial<TlsDraft>) => void;
}) {
  return (
    <section className="mc-next-settings-field-group">
      <h4>{input.title}</h4>
      <p className="mc-next-settings-field-note">{input.subtitle}</p>
      <label className="mc-next-settings-check" htmlFor={`${input.idPrefix}-skip-verify`}>
        <input
          id={`${input.idPrefix}-skip-verify`}
          type="checkbox"
          checked={input.draft.insecureSkipVerify}
          onChange={(event) => input.onChange({ insecureSkipVerify: event.target.checked })}
        />
        <span>Skip certificate verification</span>
      </label>
      <Field htmlFor={`${input.idPrefix}-ca-cert`} label="CA cert path">
        <input
          id={`${input.idPrefix}-ca-cert`}
          className="mc-next-settings-input"
          value={input.draft.caCertPath}
          onChange={(event) => input.onChange({ caCertPath: event.target.value })}
          placeholder="/path/to/ca.pem"
        />
      </Field>
      <Field htmlFor={`${input.idPrefix}-client-cert`} label="Client cert path">
        <input
          id={`${input.idPrefix}-client-cert`}
          className="mc-next-settings-input"
          value={input.draft.clientCertPath}
          onChange={(event) => input.onChange({ clientCertPath: event.target.value })}
          placeholder="/path/to/client.crt"
        />
      </Field>
      <Field htmlFor={`${input.idPrefix}-client-key`} label="Client key path">
        <input
          id={`${input.idPrefix}-client-key`}
          className="mc-next-settings-input"
          value={input.draft.clientKeyPath}
          onChange={(event) => input.onChange({ clientKeyPath: event.target.value })}
          placeholder="/path/to/client.key"
        />
      </Field>
      <Field htmlFor={`${input.idPrefix}-servername`} label="Server name override">
        <input
          id={`${input.idPrefix}-servername`}
          className="mc-next-settings-input"
          value={input.draft.serverName}
          onChange={(event) => input.onChange({ serverName: event.target.value })}
          placeholder="api.internal"
        />
      </Field>
    </section>
  );
}

function draftAuthFromConfig(auth: LlmProviderRequestAuthConfig | undefined): RequestAuthDraft {
  if (!auth) {
    return { ...EMPTY_REQUEST_AUTH_DRAFT };
  }
  if (auth.type === "bearer") {
    return {
      ...EMPTY_REQUEST_AUTH_DRAFT,
      mode: "bearer",
      token: auth.token ?? "",
      tokenEnv: auth.tokenEnv ?? "",
      headerName: auth.headerName ?? "",
    };
  }
  if (auth.type === "header") {
    return {
      ...EMPTY_REQUEST_AUTH_DRAFT,
      mode: "header",
      headerName: auth.headerName,
      value: auth.value ?? "",
      valueEnv: auth.valueEnv ?? "",
      scheme: auth.scheme ?? "",
    };
  }
  return {
    ...EMPTY_REQUEST_AUTH_DRAFT,
    mode: "query",
    queryParam: auth.queryParam,
    value: auth.value ?? "",
    valueEnv: auth.valueEnv ?? "",
    prefix: auth.prefix ?? "",
  };
}

function draftProxyAuthFromConfig(auth: LlmProviderRequestProxyAuthConfig | undefined): ProxyAuthDraft {
  if (!auth) {
    return { ...EMPTY_PROXY_AUTH_DRAFT };
  }
  if (auth.type === "bearer") {
    return {
      ...EMPTY_PROXY_AUTH_DRAFT,
      mode: "bearer",
      token: auth.token ?? "",
      tokenEnv: auth.tokenEnv ?? "",
      headerName: auth.headerName ?? "",
    };
  }
  return {
    ...EMPTY_PROXY_AUTH_DRAFT,
    mode: "header",
    headerName: auth.headerName,
    value: auth.value ?? "",
    valueEnv: auth.valueEnv ?? "",
    scheme: auth.scheme ?? "",
  };
}

function draftTlsFromConfig(tls: LlmProviderRequestTlsConfig | undefined): TlsDraft {
  return {
    insecureSkipVerify: tls?.insecureSkipVerify ?? false,
    caCertPath: tls?.caCertPath ?? "",
    clientCertPath: tls?.clientCertPath ?? "",
    clientKeyPath: tls?.clientKeyPath ?? "",
    serverName: tls?.serverName ?? "",
  };
}

function parseHeadersJson(text: string): Record<string, string> | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Custom headers must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Custom headers must be a JSON object.");
  }
  const entries = Object.entries(parsed);
  const headers = Object.fromEntries(
    entries.map(([key, value]) => {
      if (typeof value !== "string") {
        throw new Error("Custom header values must be strings.");
      }
      return [key, value];
    }),
  );
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function buildRequestAuthConfig(draft: RequestAuthDraft): LlmProviderRequestAuthConfig | undefined {
  switch (draft.mode) {
    case "none":
      return undefined;
    case "bearer": {
      const token = draft.token.trim();
      const tokenEnv = draft.tokenEnv.trim();
      const headerName = draft.headerName.trim();
      if (!token && !tokenEnv) {
        throw new Error("Bearer auth requires either a token or token env var.");
      }
      return {
        type: "bearer",
        token: token || undefined,
        tokenEnv: tokenEnv || undefined,
        headerName: headerName || undefined,
      };
    }
    case "header": {
      const headerName = draft.headerName.trim();
      const value = draft.value.trim();
      const valueEnv = draft.valueEnv.trim();
      const scheme = draft.scheme.trim();
      if (!headerName) {
        throw new Error("Header auth requires a header name.");
      }
      if (!value && !valueEnv) {
        throw new Error("Header auth requires either a value or value env var.");
      }
      return {
        type: "header",
        headerName,
        value: value || undefined,
        valueEnv: valueEnv || undefined,
        scheme: scheme || undefined,
      };
    }
    case "query": {
      const queryParam = draft.queryParam.trim();
      const value = draft.value.trim();
      const valueEnv = draft.valueEnv.trim();
      const prefix = draft.prefix;
      if (!queryParam) {
        throw new Error("Query auth requires a query param name.");
      }
      if (!value && !valueEnv) {
        throw new Error("Query auth requires either a value or value env var.");
      }
      return {
        type: "query",
        queryParam,
        value: value || undefined,
        valueEnv: valueEnv || undefined,
        prefix: prefix || undefined,
      };
    }
  }
}

function buildProxyAuthConfig(draft: ProxyAuthDraft): LlmProviderRequestProxyAuthConfig | undefined {
  switch (draft.mode) {
    case "none":
      return undefined;
    case "bearer": {
      const token = draft.token.trim();
      const tokenEnv = draft.tokenEnv.trim();
      const headerName = draft.headerName.trim();
      if (!token && !tokenEnv) {
        throw new Error("Proxy bearer auth requires either a token or token env var.");
      }
      return {
        type: "bearer",
        token: token || undefined,
        tokenEnv: tokenEnv || undefined,
        headerName: headerName || undefined,
      };
    }
    case "header": {
      const headerName = draft.headerName.trim();
      const value = draft.value.trim();
      const valueEnv = draft.valueEnv.trim();
      const scheme = draft.scheme.trim();
      if (!headerName) {
        throw new Error("Proxy header auth requires a header name.");
      }
      if (!value && !valueEnv) {
        throw new Error("Proxy header auth requires either a value or value env var.");
      }
      return {
        type: "header",
        headerName,
        value: value || undefined,
        valueEnv: valueEnv || undefined,
        scheme: scheme || undefined,
      };
    }
  }
}

function buildTlsConfig(draft: TlsDraft, label: string): LlmProviderRequestTlsConfig | undefined {
  const caCertPath = draft.caCertPath.trim();
  const clientCertPath = draft.clientCertPath.trim();
  const clientKeyPath = draft.clientKeyPath.trim();
  const serverName = draft.serverName.trim();
  const tls: LlmProviderRequestTlsConfig = {
    insecureSkipVerify: draft.insecureSkipVerify || undefined,
    caCertPath: caCertPath || undefined,
    clientCertPath: clientCertPath || undefined,
    clientKeyPath: clientKeyPath || undefined,
    serverName: serverName || undefined,
  };
  if (!tls.insecureSkipVerify && !tls.caCertPath && !tls.clientCertPath && !tls.clientKeyPath && !tls.serverName) {
    return undefined;
  }
  if (Boolean(tls.clientCertPath) !== Boolean(tls.clientKeyPath)) {
    throw new Error(`${label} requires client cert and client key paths together.`);
  }
  if (tls.insecureSkipVerify && tls.caCertPath) {
    throw new Error(`${label} cannot combine a CA cert path with skip verification.`);
  }
  return tls;
}

function buildProxyConfig(draft: LlmTransportDraft): LlmProviderRequestConfig["proxy"] | undefined {
  const url = draft.proxyUrl.trim();
  const bypassHosts = splitByNewlineOrComma(draft.proxyBypassHostsText);
  const auth = buildProxyAuthConfig(draft.proxyAuth);
  const tls = buildTlsConfig(draft.proxyTls, "Proxy TLS");
  if (!url && bypassHosts.length === 0 && !auth && !tls) {
    return undefined;
  }
  if (!url) {
    throw new Error("Proxy settings require a proxy URL.");
  }
  return {
    url,
    bypassHosts: bypassHosts.length > 0 ? bypassHosts : undefined,
    auth,
    tls,
  };
}

function splitByNewlineOrComma(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean);
}
