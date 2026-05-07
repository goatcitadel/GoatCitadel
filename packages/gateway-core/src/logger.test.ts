import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "./logger.js";

describe("gateway-core logger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("redacts sensitive metadata keys before writing structured logs", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    logger.info("provider configured", {
      provider_api_key: "sk-test",
      connectorSecretValue: "connector-secret",
      nested: {
        refreshToken: "refresh-token",
      },
    });

    const output = String(writeSpy.mock.calls.at(-1)?.[0] ?? "");
    expect(output).toContain("[redacted]");
    expect(output).not.toContain("sk-test");
    expect(output).not.toContain("connector-secret");
    expect(output).not.toContain("refresh-token");
  });

  it("does not throw on circular metadata", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const circular: Record<string, unknown> = {
      requestSecret: "secret",
    };
    circular.self = circular;

    expect(() => logger.info("circular metadata", circular)).not.toThrow();

    const output = String(writeSpy.mock.calls.at(-1)?.[0] ?? "");
    expect(output).toContain("[Circular]");
    expect(output).not.toContain("secret");
  });
});
