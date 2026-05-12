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

  it("writes warn, error, child, and debug records with sanitized context", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const previousLevel = process.env.GOATCITADEL_LOG_LEVEL;
    process.env.GOATCITADEL_LOG_LEVEL = "debug";

    logger.warn("array context", {
      values: [{ token: "secret-token" }],
      skipMe: () => "not logged",
    });
    logger.error("failed with error", new Error("boom"));
    logger.error("failed with context", { token: "context-secret", ok: true });
    logger.error("failed with primitive", "plain failure");
    logger.child("worker").debug("debugging", { ok: true });

    const stderrOutput = stderrSpy.mock.calls.map((call) => String(call[0])).join("\n");
    const stdoutOutput = stdoutSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(stderrOutput).toContain("[redacted]");
    expect(stderrOutput).not.toContain("secret-token");
    expect(stderrOutput).not.toContain("context-secret");
    expect(stderrOutput).toContain("boom");
    expect(stderrOutput).toContain("plain failure");
    expect(stderrOutput).not.toContain("skipMe");
    expect(stdoutOutput).toContain("core:worker");
    expect(stdoutOutput).toContain("debugging");

    if (previousLevel === undefined) {
      delete process.env.GOATCITADEL_LOG_LEVEL;
    } else {
      process.env.GOATCITADEL_LOG_LEVEL = previousLevel;
    }
  });

  it("suppresses debug output unless debug logging is enabled", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const previousLevel = process.env.GOATCITADEL_LOG_LEVEL;
    delete process.env.GOATCITADEL_LOG_LEVEL;

    logger.debug("hidden");

    expect(stdoutSpy).not.toHaveBeenCalled();
    if (previousLevel !== undefined) {
      process.env.GOATCITADEL_LOG_LEVEL = previousLevel;
    }
  });

  it("drops primitive, array, nested Error, and circular-array contexts safely", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const circular: unknown[] = [];
    circular.push(circular);

    logger.info("primitive context", "value" as unknown as Record<string, unknown>);
    logger.info("array context", circular as unknown as Record<string, unknown>);
    logger.info("nested error context", { error: new Error("nested boom") });

    const outputs = writeSpy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(outputs[0]).toMatchObject({ msg: "primitive context" });
    expect(outputs[0]).not.toHaveProperty("value");
    expect(outputs[1]).toMatchObject({ msg: "array context" });
    expect(outputs[1]).not.toHaveProperty("0");
    expect(outputs[2]).toMatchObject({
      msg: "nested error context",
      error: expect.objectContaining({ message: "nested boom", name: "Error" }),
    });
  });
});
