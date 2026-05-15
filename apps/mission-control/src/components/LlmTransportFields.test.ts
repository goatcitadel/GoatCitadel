import { describe, expect, it } from "vitest";
import { createEmptyLlmTransportDraft, draftFromRequestConfig, requestConfigFromDraft } from "./LlmTransportFields";

describe("LlmTransportFields helpers", () => {
  it("returns undefined for an empty transport draft", () => {
    expect(requestConfigFromDraft(createEmptyLlmTransportDraft())).toBeUndefined();
  });

  it("round-trips nested request, proxy auth, and TLS settings", () => {
    const draft = draftFromRequestConfig({
      headers: {
        "X-Trace": "1",
      },
      auth: {
        type: "header",
        headerName: "X-API-Key",
        valueEnv: "OPENAI_API_KEY",
        scheme: "Bearer",
      },
      proxy: {
        url: "http://proxy.internal:8080",
        bypassHosts: ["localhost", "*.internal"],
        auth: {
          type: "bearer",
          tokenEnv: "PROXY_TOKEN",
          headerName: "Proxy-Authorization",
        },
        tls: {
          serverName: "proxy.internal",
        },
      },
      tls: {
        clientCertPath: "/certs/client.crt",
        clientKeyPath: "/certs/client.key",
        serverName: "api.internal",
      },
    });

    expect(requestConfigFromDraft(draft)).toEqual({
      headers: {
        "X-Trace": "1",
      },
      auth: {
        type: "header",
        headerName: "X-API-Key",
        valueEnv: "OPENAI_API_KEY",
        scheme: "Bearer",
      },
      proxy: {
        url: "http://proxy.internal:8080",
        bypassHosts: ["localhost", "*.internal"],
        auth: {
          type: "bearer",
          tokenEnv: "PROXY_TOKEN",
          headerName: "Proxy-Authorization",
        },
        tls: {
          serverName: "proxy.internal",
        },
      },
      tls: {
        clientCertPath: "/certs/client.crt",
        clientKeyPath: "/certs/client.key",
        serverName: "api.internal",
      },
    });
  });

  it("hydrates absent, bearer, query, proxy-header, and empty TLS request config branches", () => {
    expect(draftFromRequestConfig()).toEqual(createEmptyLlmTransportDraft());

    const bearerDraft = draftFromRequestConfig({
      auth: {
        type: "bearer",
        token: "secret-token",
        headerName: "X-Provider-Auth",
      },
      tls: {},
    });
    expect(bearerDraft.auth).toMatchObject({
      mode: "bearer",
      token: "secret-token",
      tokenEnv: "",
      headerName: "X-Provider-Auth",
    });
    expect(requestConfigFromDraft(bearerDraft)).toEqual({
      auth: {
        type: "bearer",
        token: "secret-token",
        headerName: "X-Provider-Auth",
      },
    });

    const queryDraft = draftFromRequestConfig({
      auth: {
        type: "query",
        queryParam: "api_key",
        value: "query-secret",
        prefix: "token:",
      },
      proxy: {
        url: "http://proxy.internal:8080",
        auth: {
          type: "header",
          headerName: "Proxy-Authorization",
          value: "proxy-secret",
        },
      },
    });
    expect(queryDraft.auth).toMatchObject({
      mode: "query",
      queryParam: "api_key",
      value: "query-secret",
      prefix: "token:",
    });
    expect(queryDraft.proxyAuth).toMatchObject({
      mode: "header",
      headerName: "Proxy-Authorization",
      value: "proxy-secret",
    });
    expect(requestConfigFromDraft(queryDraft)).toMatchObject({
      auth: {
        type: "query",
        queryParam: "api_key",
        value: "query-secret",
        prefix: "token:",
      },
      proxy: {
        auth: {
          type: "header",
          headerName: "Proxy-Authorization",
          value: "proxy-secret",
        },
      },
    });
  });

  it("rejects invalid custom header JSON", () => {
    const draft = createEmptyLlmTransportDraft();
    draft.headersJson = "{not-json}";

    expect(() => requestConfigFromDraft(draft)).toThrow("Custom headers must be valid JSON.");
  });

  it("rejects custom headers that are not string maps", () => {
    const draft = createEmptyLlmTransportDraft();
    draft.headersJson = "[]";
    expect(() => requestConfigFromDraft(draft)).toThrow("Custom headers must be a JSON object.");

    draft.headersJson = '{"X-Trace": 123}';
    expect(() => requestConfigFromDraft(draft)).toThrow("Custom header values must be strings.");
  });

  it("builds every request auth mode and trims optional fields", () => {
    const bearer = createEmptyLlmTransportDraft();
    bearer.auth.mode = "bearer";
    bearer.auth.token = " token ";
    expect(requestConfigFromDraft(bearer)).toMatchObject({
      auth: {
        type: "bearer",
        token: "token",
      },
    });

    const header = createEmptyLlmTransportDraft();
    header.auth.mode = "header";
    header.auth.headerName = " X-API-Key ";
    header.auth.valueEnv = " API_KEY ";
    header.auth.scheme = " Bearer ";
    expect(requestConfigFromDraft(header)).toMatchObject({
      auth: {
        type: "header",
        headerName: "X-API-Key",
        valueEnv: "API_KEY",
        scheme: "Bearer",
      },
    });

    const query = createEmptyLlmTransportDraft();
    query.auth.mode = "query";
    query.auth.queryParam = " key ";
    query.auth.value = " secret ";
    query.auth.prefix = "token:";
    expect(requestConfigFromDraft(query)).toMatchObject({
      auth: {
        type: "query",
        queryParam: "key",
        value: "secret",
        prefix: "token:",
      },
    });
  });

  it("rejects incomplete request auth drafts", () => {
    const bearer = createEmptyLlmTransportDraft();
    bearer.auth.mode = "bearer";
    expect(() => requestConfigFromDraft(bearer)).toThrow("Bearer auth requires either a token or token env var.");

    const header = createEmptyLlmTransportDraft();
    header.auth.mode = "header";
    expect(() => requestConfigFromDraft(header)).toThrow("Header auth requires a header name.");
    header.auth.headerName = "X-API-Key";
    expect(() => requestConfigFromDraft(header)).toThrow("Header auth requires either a value or value env var.");

    const query = createEmptyLlmTransportDraft();
    query.auth.mode = "query";
    expect(() => requestConfigFromDraft(query)).toThrow("Query auth requires a query param name.");
    query.auth.queryParam = "key";
    expect(() => requestConfigFromDraft(query)).toThrow("Query auth requires either a value or value env var.");
  });

  it("rejects proxy auth without a proxy URL", () => {
    const draft = createEmptyLlmTransportDraft();
    draft.proxyAuth.mode = "bearer";
    draft.proxyAuth.tokenEnv = "PROXY_TOKEN";

    expect(() => requestConfigFromDraft(draft)).toThrow("Proxy settings require a proxy URL.");
  });

  it("builds proxy auth modes and validates incomplete proxy auth", () => {
    const bearer = createEmptyLlmTransportDraft();
    bearer.proxyUrl = " http://proxy.internal:8080 ";
    bearer.proxyAuth.mode = "bearer";
    bearer.proxyAuth.token = " token ";
    expect(requestConfigFromDraft(bearer)).toMatchObject({
      proxy: {
        url: "http://proxy.internal:8080",
        auth: {
          type: "bearer",
          token: "token",
        },
      },
    });

    const header = createEmptyLlmTransportDraft();
    header.proxyUrl = "http://proxy.internal:8080";
    header.proxyAuth.mode = "header";
    expect(() => requestConfigFromDraft(header)).toThrow("Proxy header auth requires a header name.");
    header.proxyAuth.headerName = "Proxy-Authorization";
    expect(() => requestConfigFromDraft(header)).toThrow("Proxy header auth requires either a value or value env var.");
    header.proxyAuth.valueEnv = "PROXY_TOKEN";
    header.proxyAuth.scheme = "Bearer";
    expect(requestConfigFromDraft(header)).toMatchObject({
      proxy: {
        auth: {
          type: "header",
          headerName: "Proxy-Authorization",
          valueEnv: "PROXY_TOKEN",
          scheme: "Bearer",
        },
      },
    });

    const incompleteBearer = createEmptyLlmTransportDraft();
    incompleteBearer.proxyUrl = "http://proxy.internal:8080";
    incompleteBearer.proxyAuth.mode = "bearer";
    expect(() => requestConfigFromDraft(incompleteBearer)).toThrow(
      "Proxy bearer auth requires either a token or token env var.",
    );
  });

  it("rejects incomplete request TLS client auth settings", () => {
    const draft = createEmptyLlmTransportDraft();
    draft.tls.clientCertPath = "/certs/client.crt";

    expect(() => requestConfigFromDraft(draft)).toThrow(
      "Request TLS requires client cert and client key paths together.",
    );
  });

  it("validates request and proxy TLS combinations", () => {
    const requestTls = createEmptyLlmTransportDraft();
    requestTls.tls.insecureSkipVerify = true;
    requestTls.tls.caCertPath = "/certs/ca.crt";
    expect(() => requestConfigFromDraft(requestTls)).toThrow(
      "Request TLS cannot combine a CA cert path with skip verification.",
    );

    const proxyTls = createEmptyLlmTransportDraft();
    proxyTls.proxyUrl = "http://proxy.internal:8080";
    proxyTls.proxyTls.clientKeyPath = "/certs/proxy.key";
    expect(() => requestConfigFromDraft(proxyTls)).toThrow(
      "Proxy TLS requires client cert and client key paths together.",
    );

    proxyTls.proxyTls.clientCertPath = "/certs/proxy.crt";
    expect(requestConfigFromDraft(proxyTls)).toMatchObject({
      proxy: {
        tls: {
          clientCertPath: "/certs/proxy.crt",
          clientKeyPath: "/certs/proxy.key",
        },
      },
    });
  });
});
