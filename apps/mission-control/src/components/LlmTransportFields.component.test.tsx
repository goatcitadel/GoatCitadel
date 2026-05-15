import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { createEmptyLlmTransportDraft, LlmTransportFields, type LlmTransportDraft } from "./LlmTransportFields";

function renderTransport(draft: LlmTransportDraft, onChange = vi.fn()) {
  const renderer = create(
    <LlmTransportFields idPrefix="provider" draft={draft} onChange={onChange} error="Bad JSON" />,
  );
  return { renderer, onChange };
}

function byId(renderer: ReactTestRenderer, id: string) {
  return renderer.root.findByProps({ id });
}

describe("LlmTransportFields component", () => {
  it("renders request, proxy, and TLS fields and patches top-level draft values", () => {
    const draft = createEmptyLlmTransportDraft();
    const { renderer, onChange } = renderTransport(draft);

    expect(JSON.stringify(renderer.toJSON())).toContain("Bad JSON");

    act(() => {
      byId(renderer, "provider-request-headers").props.onChange({ target: { value: '{"X-Trace":"1"}' } });
      byId(renderer, "provider-proxy-url").props.onChange({ target: { value: "http://proxy.internal:8080" } });
      byId(renderer, "provider-proxy-bypass-hosts").props.onChange({ target: { value: "localhost\n*.internal" } });
      byId(renderer, "provider-request-tls-skip-verify").props.onChange({ target: { checked: true } });
      byId(renderer, "provider-request-tls-ca-cert").props.onChange({ target: { value: "/certs/ca.pem" } });
      byId(renderer, "provider-request-tls-client-cert").props.onChange({ target: { value: "/certs/client.crt" } });
      byId(renderer, "provider-request-tls-client-key").props.onChange({ target: { value: "/certs/client.key" } });
      byId(renderer, "provider-request-tls-servername").props.onChange({ target: { value: "api.internal" } });
      byId(renderer, "provider-proxy-tls-servername").props.onChange({ target: { value: "proxy.internal" } });
    });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ headersJson: '{"X-Trace":"1"}' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ proxyUrl: "http://proxy.internal:8080" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ proxyBypassHostsText: "localhost\n*.internal" }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ tls: expect.objectContaining({ insecureSkipVerify: true }) }),
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ tls: expect.objectContaining({ caCertPath: "/certs/ca.pem" }) }),
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ tls: expect.objectContaining({ clientCertPath: "/certs/client.crt" }) }),
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ tls: expect.objectContaining({ clientKeyPath: "/certs/client.key" }) }),
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ tls: expect.objectContaining({ serverName: "api.internal" }) }),
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ proxyTls: expect.objectContaining({ serverName: "proxy.internal" }) }),
    );
  });

  it("renders bearer request auth and proxy bearer auth controls", () => {
    const draft = createEmptyLlmTransportDraft();
    draft.auth.mode = "bearer";
    draft.proxyAuth.mode = "bearer";
    const { renderer, onChange } = renderTransport(draft);

    act(() => {
      byId(renderer, "provider-request-auth-mode").props.onChange({ target: { value: "header" } });
      byId(renderer, "provider-request-bearer-token").props.onChange({ target: { value: "token" } });
      byId(renderer, "provider-request-bearer-token-env").props.onChange({ target: { value: "TOKEN_ENV" } });
      byId(renderer, "provider-request-bearer-header").props.onChange({ target: { value: "X-Auth" } });
      byId(renderer, "provider-proxy-auth-mode").props.onChange({ target: { value: "header" } });
      byId(renderer, "provider-proxy-bearer-token").props.onChange({ target: { value: "proxy-token" } });
      byId(renderer, "provider-proxy-bearer-token-env").props.onChange({ target: { value: "PROXY_ENV" } });
      byId(renderer, "provider-proxy-bearer-header").props.onChange({ target: { value: "Proxy-Auth" } });
    });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ auth: expect.objectContaining({ mode: "header" }) }),
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ auth: expect.objectContaining({ token: "token" }) }),
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ auth: expect.objectContaining({ tokenEnv: "TOKEN_ENV" }) }),
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ auth: expect.objectContaining({ headerName: "X-Auth" }) }),
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ proxyAuth: expect.objectContaining({ mode: "header" }) }),
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ proxyAuth: expect.objectContaining({ token: "proxy-token" }) }),
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ proxyAuth: expect.objectContaining({ tokenEnv: "PROXY_ENV" }) }),
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ proxyAuth: expect.objectContaining({ headerName: "Proxy-Auth" }) }),
    );
  });

  it("renders header and query auth conditional controls", () => {
    const headerDraft = createEmptyLlmTransportDraft();
    headerDraft.auth.mode = "header";
    headerDraft.proxyAuth.mode = "header";
    const header = renderTransport(headerDraft);

    act(() => {
      byId(header.renderer, "provider-request-header-name").props.onChange({ target: { value: "X-API-Key" } });
      byId(header.renderer, "provider-request-header-value").props.onChange({ target: { value: "secret" } });
      byId(header.renderer, "provider-request-header-value-env").props.onChange({ target: { value: "KEY_ENV" } });
      byId(header.renderer, "provider-request-header-scheme").props.onChange({ target: { value: "Bearer" } });
      byId(header.renderer, "provider-proxy-header-name").props.onChange({ target: { value: "Proxy-Authorization" } });
      byId(header.renderer, "provider-proxy-header-value").props.onChange({ target: { value: "proxy-secret" } });
      byId(header.renderer, "provider-proxy-header-value-env").props.onChange({ target: { value: "PROXY_KEY" } });
      byId(header.renderer, "provider-proxy-header-scheme").props.onChange({ target: { value: "Bearer" } });
    });

    expect(header.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ auth: expect.objectContaining({ headerName: "X-API-Key" }) }),
    );
    expect(header.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ auth: expect.objectContaining({ value: "secret" }) }),
    );
    expect(header.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ auth: expect.objectContaining({ valueEnv: "KEY_ENV" }) }),
    );
    expect(header.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ auth: expect.objectContaining({ scheme: "Bearer" }) }),
    );
    expect(header.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ proxyAuth: expect.objectContaining({ headerName: "Proxy-Authorization" }) }),
    );
    expect(header.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ proxyAuth: expect.objectContaining({ value: "proxy-secret" }) }),
    );
    expect(header.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ proxyAuth: expect.objectContaining({ valueEnv: "PROXY_KEY" }) }),
    );
    expect(header.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ proxyAuth: expect.objectContaining({ scheme: "Bearer" }) }),
    );

    const queryDraft = createEmptyLlmTransportDraft();
    queryDraft.auth.mode = "query";
    const query = renderTransport(queryDraft);

    act(() => {
      byId(query.renderer, "provider-request-query-param").props.onChange({ target: { value: "api_key" } });
      byId(query.renderer, "provider-request-query-value").props.onChange({ target: { value: "secret" } });
      byId(query.renderer, "provider-request-query-value-env").props.onChange({ target: { value: "QUERY_KEY" } });
      byId(query.renderer, "provider-request-query-prefix").props.onChange({ target: { value: "token:" } });
    });

    expect(query.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ auth: expect.objectContaining({ queryParam: "api_key" }) }),
    );
    expect(query.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ auth: expect.objectContaining({ value: "secret" }) }),
    );
    expect(query.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ auth: expect.objectContaining({ valueEnv: "QUERY_KEY" }) }),
    );
    expect(query.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ auth: expect.objectContaining({ prefix: "token:" }) }),
    );
  });
});
