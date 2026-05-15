import { create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import {
  createEmptyLlmTransportDraft,
  draftFromRequestConfig,
  LlmTransportFields,
  requestConfigFromDraft,
  type LlmTransportDraft,
} from "./LlmTransportFields";

function event(value: string) {
  return { target: { value } };
}

function checkboxEvent(checked: boolean) {
  return { target: { checked } };
}

function richDraft(): LlmTransportDraft {
  return {
    headersJson: JSON.stringify({ "X-Test": "yes" }),
    auth: {
      mode: "header",
      headerName: "X-Api-Key",
      token: "",
      tokenEnv: "",
      value: "secret",
      valueEnv: "",
      scheme: "Token",
      queryParam: "",
      prefix: "",
    },
    proxyUrl: "http://proxy.internal:8080",
    proxyBypassHostsText: "localhost\n127.0.0.1,*.internal",
    proxyAuth: {
      mode: "bearer",
      headerName: "Proxy-Authorization",
      token: "",
      tokenEnv: "PROXY_TOKEN",
      value: "",
      valueEnv: "",
      scheme: "",
    },
    tls: {
      insecureSkipVerify: false,
      caCertPath: "/ca.pem",
      clientCertPath: "/client.crt",
      clientKeyPath: "/client.key",
      serverName: "api.internal",
    },
    proxyTls: {
      insecureSkipVerify: true,
      caCertPath: "",
      clientCertPath: "",
      clientKeyPath: "",
      serverName: "proxy.internal",
    },
  };
}

describe("LlmTransportFields", () => {
  it("round-trips empty and rich request transport drafts", () => {
    expect(requestConfigFromDraft(createEmptyLlmTransportDraft())).toBeUndefined();

    const config = requestConfigFromDraft(richDraft());
    expect(config).toEqual({
      headers: { "X-Test": "yes" },
      auth: {
        type: "header",
        headerName: "X-Api-Key",
        value: "secret",
        scheme: "Token",
      },
      proxy: {
        url: "http://proxy.internal:8080",
        bypassHosts: ["localhost", "127.0.0.1", "*.internal"],
        auth: {
          type: "bearer",
          tokenEnv: "PROXY_TOKEN",
          headerName: "Proxy-Authorization",
        },
        tls: {
          insecureSkipVerify: true,
          serverName: "proxy.internal",
        },
      },
      tls: {
        caCertPath: "/ca.pem",
        clientCertPath: "/client.crt",
        clientKeyPath: "/client.key",
        serverName: "api.internal",
      },
    });

    expect(draftFromRequestConfig(config)).toMatchObject({
      headersJson: expect.stringContaining("X-Test"),
      auth: { mode: "header", headerName: "X-Api-Key", value: "secret", scheme: "Token" },
      proxyUrl: "http://proxy.internal:8080",
      proxyAuth: { mode: "bearer", tokenEnv: "PROXY_TOKEN" },
      tls: { caCertPath: "/ca.pem", clientCertPath: "/client.crt", clientKeyPath: "/client.key" },
    });
  });

  it("builds all supported auth modes and rejects malformed drafts", () => {
    expect(
      requestConfigFromDraft({
        ...createEmptyLlmTransportDraft(),
        auth: { ...createEmptyLlmTransportDraft().auth, mode: "bearer", token: "token", headerName: "Auth" },
      }),
    ).toEqual({ auth: { type: "bearer", token: "token", headerName: "Auth" } });

    expect(
      requestConfigFromDraft({
        ...createEmptyLlmTransportDraft(),
        auth: {
          ...createEmptyLlmTransportDraft().auth,
          mode: "query",
          queryParam: "api_key",
          valueEnv: "API_KEY",
          prefix: "Bearer ",
        },
      }),
    ).toEqual({ auth: { type: "query", queryParam: "api_key", valueEnv: "API_KEY", prefix: "Bearer " } });

    expect(
      requestConfigFromDraft({
        ...createEmptyLlmTransportDraft(),
        proxyUrl: "http://proxy.internal",
        proxyAuth: {
          ...createEmptyLlmTransportDraft().proxyAuth,
          mode: "header",
          headerName: "X-Proxy",
          value: "proxy-secret",
          scheme: "Token",
        },
      }),
    ).toEqual({
      proxy: {
        url: "http://proxy.internal",
        auth: { type: "header", headerName: "X-Proxy", value: "proxy-secret", scheme: "Token" },
      },
    });

    expect(() => requestConfigFromDraft({ ...createEmptyLlmTransportDraft(), headersJson: "not json" })).toThrow(
      "valid JSON",
    );
    expect(() => requestConfigFromDraft({ ...createEmptyLlmTransportDraft(), headersJson: "[]" })).toThrow(
      "JSON object",
    );
    expect(() => requestConfigFromDraft({ ...createEmptyLlmTransportDraft(), headersJson: '{"x": 1}' })).toThrow(
      "values must be strings",
    );
    expect(() =>
      requestConfigFromDraft({
        ...createEmptyLlmTransportDraft(),
        auth: { ...createEmptyLlmTransportDraft().auth, mode: "bearer" },
      }),
    ).toThrow("Bearer auth requires");
    expect(() =>
      requestConfigFromDraft({
        ...createEmptyLlmTransportDraft(),
        auth: { ...createEmptyLlmTransportDraft().auth, mode: "header", value: "x" },
      }),
    ).toThrow("Header auth requires a header name");
    expect(() =>
      requestConfigFromDraft({
        ...createEmptyLlmTransportDraft(),
        auth: { ...createEmptyLlmTransportDraft().auth, mode: "header", headerName: "X" },
      }),
    ).toThrow("Header auth requires either a value");
    expect(() =>
      requestConfigFromDraft({
        ...createEmptyLlmTransportDraft(),
        auth: { ...createEmptyLlmTransportDraft().auth, mode: "query", value: "x" },
      }),
    ).toThrow("Query auth requires a query param name");
    expect(() =>
      requestConfigFromDraft({
        ...createEmptyLlmTransportDraft(),
        auth: { ...createEmptyLlmTransportDraft().auth, mode: "query", queryParam: "api_key" },
      }),
    ).toThrow("Query auth requires either a value");
    expect(() =>
      requestConfigFromDraft({
        ...createEmptyLlmTransportDraft(),
        proxyBypassHostsText: "localhost",
      }),
    ).toThrow("proxy URL");
    expect(() =>
      requestConfigFromDraft({
        ...createEmptyLlmTransportDraft(),
        proxyUrl: "http://proxy.internal",
        proxyAuth: { ...createEmptyLlmTransportDraft().proxyAuth, mode: "bearer" },
      }),
    ).toThrow("Proxy bearer auth requires");
    expect(() =>
      requestConfigFromDraft({
        ...createEmptyLlmTransportDraft(),
        proxyUrl: "http://proxy.internal",
        proxyAuth: { ...createEmptyLlmTransportDraft().proxyAuth, mode: "header", value: "x" },
      }),
    ).toThrow("Proxy header auth requires a header name");
    expect(() =>
      requestConfigFromDraft({
        ...createEmptyLlmTransportDraft(),
        proxyUrl: "http://proxy.internal",
        proxyAuth: { ...createEmptyLlmTransportDraft().proxyAuth, mode: "header", headerName: "X-Proxy" },
      }),
    ).toThrow("Proxy header auth requires either a value");
    expect(() =>
      requestConfigFromDraft({
        ...createEmptyLlmTransportDraft(),
        tls: { ...createEmptyLlmTransportDraft().tls, clientCertPath: "/client.crt" },
      }),
    ).toThrow("client cert and client key");
    expect(() =>
      requestConfigFromDraft({
        ...createEmptyLlmTransportDraft(),
        tls: { ...createEmptyLlmTransportDraft().tls, insecureSkipVerify: true, caCertPath: "/ca.pem" },
      }),
    ).toThrow("cannot combine");
  });

  it("hydrates empty, bearer, query, and proxy-header request configs into drafts", () => {
    expect(draftFromRequestConfig()).toEqual(createEmptyLlmTransportDraft());

    expect(
      draftFromRequestConfig({
        auth: {
          type: "bearer",
          token: "token",
          tokenEnv: "TOKEN_ENV",
          headerName: "Authorization",
        },
      }),
    ).toMatchObject({
      auth: {
        mode: "bearer",
        token: "token",
        tokenEnv: "TOKEN_ENV",
        headerName: "Authorization",
      },
    });

    expect(
      draftFromRequestConfig({
        auth: {
          type: "query",
          queryParam: "api_key",
          value: "inline",
          valueEnv: "API_KEY",
          prefix: "Bearer ",
        },
      }),
    ).toMatchObject({
      auth: {
        mode: "query",
        queryParam: "api_key",
        value: "inline",
        valueEnv: "API_KEY",
        prefix: "Bearer ",
      },
    });

    expect(
      draftFromRequestConfig({
        proxy: {
          url: "http://proxy.internal",
          auth: {
            type: "header",
            headerName: "X-Proxy",
            value: "proxy",
            valueEnv: "PROXY_VALUE",
            scheme: "Token",
          },
        },
      }),
    ).toMatchObject({
      proxyUrl: "http://proxy.internal",
      proxyAuth: {
        mode: "header",
        headerName: "X-Proxy",
        value: "proxy",
        valueEnv: "PROXY_VALUE",
        scheme: "Token",
      },
    });
  });

  it("renders every conditional field group and patches nested draft state", () => {
    const onChange = vi.fn();
    const renderer = create(
      <LlmTransportFields draft={richDraft()} idPrefix="llm" onChange={onChange} error="Invalid transport" />,
    );

    renderer.root.findByProps({ id: "llm-request-headers" }).props.onChange(event('{"X":"Y"}'));
    renderer.root.findByProps({ id: "llm-request-auth-mode" }).props.onChange(event("query"));
    renderer.root.findByProps({ id: "llm-request-header-name" }).props.onChange(event("X-Updated"));
    renderer.root.findByProps({ id: "llm-request-header-value" }).props.onChange(event("updated"));
    renderer.root.findByProps({ id: "llm-request-header-value-env" }).props.onChange(event("UPDATED_ENV"));
    renderer.root.findByProps({ id: "llm-request-header-scheme" }).props.onChange(event("Bearer"));
    renderer.root.findByProps({ id: "llm-proxy-url" }).props.onChange(event("http://proxy-2"));
    renderer.root.findByProps({ id: "llm-proxy-bypass-hosts" }).props.onChange(event("example.test"));
    renderer.root.findByProps({ id: "llm-proxy-auth-mode" }).props.onChange(event("header"));
    renderer.root.findByProps({ id: "llm-proxy-bearer-token" }).props.onChange(event("proxy-token"));
    renderer.root.findByProps({ id: "llm-proxy-bearer-token-env" }).props.onChange(event("PROXY_ENV"));
    renderer.root.findByProps({ id: "llm-proxy-bearer-header" }).props.onChange(event("Proxy-Auth"));
    renderer.root.findByProps({ id: "llm-request-tls-skip-verify" }).props.onChange(checkboxEvent(true));
    renderer.root.findByProps({ id: "llm-request-tls-ca-cert" }).props.onChange(event("/next-ca.pem"));
    renderer.root.findByProps({ id: "llm-request-tls-client-cert" }).props.onChange(event("/next-client.crt"));
    renderer.root.findByProps({ id: "llm-request-tls-client-key" }).props.onChange(event("/next-client.key"));
    renderer.root.findByProps({ id: "llm-request-tls-servername" }).props.onChange(event("next.internal"));
    renderer.root.findByProps({ id: "llm-proxy-tls-skip-verify" }).props.onChange(checkboxEvent(false));
    renderer.root.findByProps({ id: "llm-proxy-tls-ca-cert" }).props.onChange(event("/proxy-ca.pem"));
    renderer.root.findByProps({ id: "llm-proxy-tls-client-cert" }).props.onChange(event("/proxy-client.crt"));
    renderer.root.findByProps({ id: "llm-proxy-tls-client-key" }).props.onChange(event("/proxy-client.key"));
    renderer.root.findByProps({ id: "llm-proxy-tls-servername" }).props.onChange(event("proxy-next.internal"));

    expect(onChange).toHaveBeenCalled();
    expect(renderer.toJSON()).toBeTruthy();
  });

  it("renders bearer, query, and proxy-header field variants", () => {
    const onChange = vi.fn();
    const bearer = createEmptyLlmTransportDraft();
    bearer.auth.mode = "bearer";
    bearer.proxyAuth.mode = "header";
    const bearerRenderer = create(<LlmTransportFields draft={bearer} idPrefix="bearer" onChange={onChange} />);
    bearerRenderer.root.findByProps({ id: "bearer-request-bearer-token" }).props.onChange(event("token"));
    bearerRenderer.root.findByProps({ id: "bearer-request-bearer-token-env" }).props.onChange(event("TOKEN_ENV"));
    bearerRenderer.root.findByProps({ id: "bearer-request-bearer-header" }).props.onChange(event("Authorization"));
    bearerRenderer.root.findByProps({ id: "bearer-proxy-header-name" }).props.onChange(event("X-Proxy"));
    bearerRenderer.root.findByProps({ id: "bearer-proxy-header-value" }).props.onChange(event("proxy"));
    bearerRenderer.root.findByProps({ id: "bearer-proxy-header-value-env" }).props.onChange(event("PROXY_VALUE"));
    bearerRenderer.root.findByProps({ id: "bearer-proxy-header-scheme" }).props.onChange(event("Token"));

    const query = createEmptyLlmTransportDraft();
    query.auth.mode = "query";
    const queryRenderer = create(<LlmTransportFields draft={query} idPrefix="query" onChange={onChange} />);
    queryRenderer.root.findByProps({ id: "query-request-query-param" }).props.onChange(event("api_key"));
    queryRenderer.root.findByProps({ id: "query-request-query-value" }).props.onChange(event("value"));
    queryRenderer.root.findByProps({ id: "query-request-query-value-env" }).props.onChange(event("VALUE_ENV"));
    queryRenderer.root.findByProps({ id: "query-request-query-prefix" }).props.onChange(event("Bearer "));

    expect(onChange).toHaveBeenCalled();
  });
});
