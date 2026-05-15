import { describe, expect, it } from "vitest";
import { createEmptyLlmTransportDraft, draftFromRequestConfig, requestConfigFromDraft } from "./LlmTransportFields";

describe("LlmTransportFields package tail coverage", () => {
  it("hydrates sparse auth configs with empty draft fields", () => {
    expect(
      draftFromRequestConfig({
        auth: { type: "bearer" } as never,
        proxy: { url: "http://proxy.internal", auth: { type: "bearer" } as never },
      }),
    ).toMatchObject({
      auth: {
        mode: "bearer",
        token: "",
        tokenEnv: "",
        headerName: "",
      },
      proxyAuth: {
        mode: "bearer",
        token: "",
        tokenEnv: "",
        headerName: "",
      },
    });

    expect(
      draftFromRequestConfig({
        auth: { type: "header", headerName: "X-Auth" } as never,
        proxy: { url: "http://proxy.internal", auth: { type: "header", headerName: "X-Proxy" } as never },
      }),
    ).toMatchObject({
      auth: {
        mode: "header",
        headerName: "X-Auth",
        value: "",
        valueEnv: "",
        scheme: "",
      },
      proxyAuth: {
        mode: "header",
        headerName: "X-Proxy",
        value: "",
        valueEnv: "",
        scheme: "",
      },
    });

    expect(draftFromRequestConfig({ auth: { type: "query", queryParam: "key" } as never })).toMatchObject({
      auth: {
        mode: "query",
        queryParam: "key",
        value: "",
        valueEnv: "",
        prefix: "",
      },
    });
  });

  it("omits empty optional auth fields when building sparse configs", () => {
    expect(requestConfigFromDraft({ ...createEmptyLlmTransportDraft(), headersJson: "{}" })).toBeUndefined();

    expect(
      requestConfigFromDraft({
        ...createEmptyLlmTransportDraft(),
        auth: { ...createEmptyLlmTransportDraft().auth, mode: "bearer", tokenEnv: "TOKEN_ENV" },
      }),
    ).toEqual({ auth: { type: "bearer", tokenEnv: "TOKEN_ENV" } });

    expect(
      requestConfigFromDraft({
        ...createEmptyLlmTransportDraft(),
        auth: {
          ...createEmptyLlmTransportDraft().auth,
          mode: "header",
          headerName: "X-Auth",
          valueEnv: "AUTH_ENV",
        },
      }),
    ).toEqual({ auth: { type: "header", headerName: "X-Auth", valueEnv: "AUTH_ENV" } });

    expect(
      requestConfigFromDraft({
        ...createEmptyLlmTransportDraft(),
        auth: {
          ...createEmptyLlmTransportDraft().auth,
          mode: "query",
          queryParam: "api_key",
          value: "inline",
        },
        proxyUrl: "http://proxy.internal",
        proxyAuth: { ...createEmptyLlmTransportDraft().proxyAuth, mode: "bearer", token: "proxy-token" },
      }),
    ).toEqual({
      auth: { type: "query", queryParam: "api_key", value: "inline" },
      proxy: { url: "http://proxy.internal", auth: { type: "bearer", token: "proxy-token" } },
    });

    expect(
      requestConfigFromDraft({
        ...createEmptyLlmTransportDraft(),
        proxyUrl: "http://proxy.internal",
        proxyAuth: {
          ...createEmptyLlmTransportDraft().proxyAuth,
          mode: "header",
          headerName: "X-Proxy",
          valueEnv: "PROXY_ENV",
        },
      }),
    ).toEqual({
      proxy: { url: "http://proxy.internal", auth: { type: "header", headerName: "X-Proxy", valueEnv: "PROXY_ENV" } },
    });
  });
});
