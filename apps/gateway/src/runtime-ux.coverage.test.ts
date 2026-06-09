import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayLogger } from "./runtime-ux.js";

describe("runtime logger coverage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sanitizes circular metadata without crashing in verbose mode", () => {
    const logger = createGatewayLogger(true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const circular: Record<string, unknown> = {
      authMode: "token",
      queryParam: "access_token",
    };
    circular.self = circular;
    circular.list = [circular];

    expect(() => {
      logger.warn(
        circular,
        "assistant.auth.token.queryParam is deprecated for normal gateway requests; only SSE bridge tokens still use query parameters.",
      );
    }).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("summarizes verbose Fastify request metadata instead of dumping socket internals", () => {
    const logger = createGatewayLogger(true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const req = {
      id: "req-1",
      method: "GET",
      url: "/health",
      routeOptions: { url: "/health" },
      correlationId: "corr-1",
      authActorSource: "none",
      raw: {
        method: "GET",
        url: "/health",
        socket: {
          parser: {
            incoming: "[Circular]",
          },
        },
      },
    };

    logger.info({ req }, "incoming request");

    const output = String(logSpy.mock.calls.at(-1)?.[0] ?? "");
    expect(output).toContain("incoming request");
    expect(output).toContain('"method":"GET"');
    expect(output).toContain('"url":"/health"');
    expect(output).toContain('"route":"/health"');
    expect(output).toContain('"correlationId":"corr-1"');
    expect(output).not.toContain("socket");
    expect(output).not.toContain("parser");
  });

  it("redacts sensitive log metadata keys", () => {
    const logger = createGatewayLogger(true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    logger.warn(
      {
        provider_api_key: "sk-test",
        connector_secret_value: "secret-value",
        nested: {
          refreshToken: "refresh-token",
        },
      },
      "sensitive metadata",
    );

    const output = String(warnSpy.mock.calls.at(-1)?.[0] ?? "");
    expect(output).toContain("[redacted]");
    expect(output).not.toContain("sk-test");
    expect(output).not.toContain("secret-value");
    expect(output).not.toContain("refresh-token");
  });

  it("redacts sensitive contains-key and high-confidence embedded secrets in strings", () => {
    const logger = createGatewayLogger(true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    logger.warn(
      {
        apiKeyHash: "some-api-key-hash",
        passwordHint: "my-password-hint",
        secretValue_v2: "some-secret-value-v2",
        message: "auth failed with Bearer sk-LIVE1234567890abcdefABCDEF token in the header",
        error: new Error("connection to sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 failed"),
      },
      "sensitive info",
    );

    const output = String(warnSpy.mock.calls.at(-1)?.[0] ?? "");
    expect(output).toContain("[redacted]");
    expect(output).not.toContain("some-api-key-hash");
    expect(output).not.toContain("my-password-hint");
    expect(output).not.toContain("some-secret-value-v2");
    expect(output).not.toContain("sk-LIVE1234567890abcdefABCDEF");
    expect(output).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
  });
});
