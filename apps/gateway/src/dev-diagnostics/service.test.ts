import { describe, expect, it, vi } from "vitest";
import { GatewayDevDiagnosticsService, resolveDevDiagnosticsBufferSize } from "./service.js";

describe("gateway dev diagnostics service", () => {
  it("keeps a bounded ring buffer and redacts sensitive keys", () => {
    const service = new GatewayDevDiagnosticsService(true, undefined, false, 2);
    service.record({
      level: "info",
      category: "gateway",
      event: "first",
      message: "first event",
      context: {
        apiKey: "secret-value",
        nested: {
          authorization: "Bearer abc123",
        },
      },
    });
    service.record({
      level: "warn",
      category: "gateway",
      event: "second",
      message: "second event",
    });
    service.record({
      level: "error",
      category: "gateway",
      event: "third",
      message: "third event",
    });

    const items = service.list({ limit: 10 }).items;
    expect(items).toHaveLength(2);
    expect(items[0]?.event).toBe("third");
    expect(items[1]?.event).toBe("second");
    expect(service.list({ limit: 10 }).items.some((item) => item.event === "first")).toBe(false);
  });

  it("uses canonical structured redaction while preserving diagnostic caps, argv handling, and safe refs", () => {
    const service = new GatewayDevDiagnosticsService(true, undefined, false, 10);
    const source = {
      webhookUrl: "https://hooks.example.test/services/team/path-secret?token=query-secret",
      authorization: "Bearer short",
      DATABASE_PASSWORD: "tiny-secret",
      tokenEnv: "DIAGNOSTICS_TOKEN",
      secretRef: "keychain:diagnostics-token",
      tokenBudget: 1_024,
      tokenId: "diagnostics-token-id",
      argv: ["node", "script.mjs", "--password", "hunter2", "--token=query-secret", "--verbose"],
      deep: { one: { two: { three: { four: { visible: "beyond-cap" } } } } },
    };

    const event = service.record({
      level: "info",
      category: "gateway",
      event: "structured_redaction",
      message: "structured redaction failed with Bearer short",
      context: source,
    });

    expect(event?.message).toBe("structured redaction failed with [redacted]");
    expect(event?.context).toEqual({
      webhookUrl: "[redacted]",
      authorization: "[redacted]",
      DATABASE_PASSWORD: "[redacted]",
      tokenEnv: "DIAGNOSTICS_TOKEN",
      secretRef: "keychain:diagnostics-token",
      tokenBudget: 1_024,
      tokenId: "diagnostics-token-id",
      argv: ["node", "script.mjs", "--password", "[redacted]", "--token=[redacted]", "--verbose"],
      deep: { one: { two: { three: { four: "[max-depth]" } } } },
    });
    expect(source.webhookUrl).toContain("path-secret");
    expect(source.authorization).toBe("Bearer short");
    expect(source.argv[3]).toBe("hunter2");
    expect(source.deep.one.two.three.four.visible).toBe("beyond-cap");
  });

  it("logs structured diagnostics to the attached logger when verbose or non-debug", () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const service = new GatewayDevDiagnosticsService(true, logger as never, false, 10);
    service.record({
      level: "debug",
      category: "gateway",
      event: "debug_event",
      message: "debug event",
    });
    service.record({
      level: "info",
      category: "gateway",
      event: "info_event",
      message: "info event",
    });

    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("normalizes runtime lifecycle events into the shared diagnostics stream", () => {
    const service = new GatewayDevDiagnosticsService(true, undefined, false, 10);

    const event = service.recordRuntime({
      kind: "model.call",
      status: "failed",
      message: "Model call failed",
      linkage: {
        sessionId: "session-1",
        turnId: "turn-1",
        runId: "run-1",
      },
      providerId: "openai",
      modelId: "gpt-5.4",
      durationMs: 1234,
      error: {
        message: "Bearer secret-token was rejected",
        code: "unauthorized",
        retryable: false,
      },
      metadata: {
        authorization: "Bearer abc123",
      },
    });

    expect(event).toMatchObject({
      category: "model",
      level: "error",
      event: "model.call",
      runtimeKind: "model.call",
      runtimeStatus: "failed",
      sessionId: "session-1",
      turnId: "turn-1",
      runId: "run-1",
      providerId: "openai",
      modelId: "gpt-5.4",
      durationMs: 1234,
    });
    expect(event?.context?.authorization).toBe("[redacted]");
    expect((event?.context?.error as { message?: string }).message).toBe("[redacted] was rejected");
  });

  it("filters diagnostics by runtime lifecycle fields", () => {
    const service = new GatewayDevDiagnosticsService(true, undefined, false, 10);
    service.recordRuntime({
      kind: "tool.invocation",
      status: "completed",
      message: "Tool completed",
      linkage: {
        runId: "run-1",
      },
      toolName: "browser.search",
    });
    service.recordRuntime({
      kind: "meet.session",
      status: "blocked",
      message: "Meet blocked",
      linkage: {
        meetingSessionId: "meet-1",
      },
    });

    expect(service.list({ runtimeKind: "tool.invocation" }).items).toHaveLength(1);
    expect(service.list({ runtimeStatus: "blocked" }).items[0]?.runtimeKind).toBe("meet.session");
    expect(service.list({ runId: "run-1" }).items[0]?.toolName).toBe("browser.search");
    expect(service.list({ toolName: "browser.search" }).items[0]?.runId).toBe("run-1");
    expect(service.list({ meetingSessionId: "meet-1" }).items[0]?.runtimeStatus).toBe("blocked");
  });

  it("keeps recording when a diagnostics listener throws", () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const service = new GatewayDevDiagnosticsService(true, logger as never, false, 10);
    const healthyListener = vi.fn();
    service.subscribe(() => {
      throw new Error("listener failed");
    });
    service.subscribe(healthyListener);

    service.record({
      level: "info",
      category: "gateway",
      event: "listener_safety",
      message: "listener safety",
    });

    expect(healthyListener).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        diagnostics: true,
        event: "listener_safety",
        listenerError: "listener failed",
      }),
      "Dev diagnostics listener threw while handling an event",
    );
  });

  it("supports a lightweight exporter boundary without blocking local diagnostics", () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const service = new GatewayDevDiagnosticsService(true, logger as never, false, 10);
    const healthyExporter = { export: vi.fn() };
    service.registerExporter({
      export: () => {
        throw new Error("export failed");
      },
    });
    service.registerExporter(healthyExporter);

    const event = service.record({
      level: "info",
      category: "gateway",
      event: "exporter_safety",
      message: "exporter safety",
    });

    expect(event).toBeDefined();
    expect(healthyExporter.export).toHaveBeenCalledWith(expect.objectContaining({ event: "exporter_safety" }));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        diagnostics: true,
        event: "exporter_safety",
        exporterError: "export failed",
      }),
      "Dev diagnostics exporter threw while handling an event",
    );
  });

  it("clamps the configured buffer size", () => {
    expect(resolveDevDiagnosticsBufferSize(undefined, 300)).toBe(300);
    expect(resolveDevDiagnosticsBufferSize("5", 300)).toBe(5);
    expect(resolveDevDiagnosticsBufferSize("9000", 300)).toBe(5000);
    expect(resolveDevDiagnosticsBufferSize("-1", 300)).toBe(300);
  });
});
