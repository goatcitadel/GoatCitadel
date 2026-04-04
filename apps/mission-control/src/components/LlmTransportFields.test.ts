import { describe, expect, it } from "vitest";
import {
  createEmptyLlmTransportDraft,
  draftFromRequestConfig,
  requestConfigFromDraft,
} from "./LlmTransportFields";

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

  it("rejects invalid custom header JSON", () => {
    const draft = createEmptyLlmTransportDraft();
    draft.headersJson = "{not-json}";

    expect(() => requestConfigFromDraft(draft)).toThrow("Custom headers must be valid JSON.");
  });

  it("rejects proxy auth without a proxy URL", () => {
    const draft = createEmptyLlmTransportDraft();
    draft.proxyAuth.mode = "bearer";
    draft.proxyAuth.tokenEnv = "PROXY_TOKEN";

    expect(() => requestConfigFromDraft(draft)).toThrow("Proxy settings require a proxy URL.");
  });

  it("rejects incomplete request TLS client auth settings", () => {
    const draft = createEmptyLlmTransportDraft();
    draft.tls.clientCertPath = "/certs/client.crt";

    expect(() => requestConfigFromDraft(draft)).toThrow("Request TLS requires client cert and client key paths together.");
  });
});
