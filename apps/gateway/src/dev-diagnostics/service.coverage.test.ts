import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enterDevDiagnosticsContext,
  GatewayDevDiagnosticsService,
  getDevDiagnosticsContext,
  resolveDevDiagnosticsEnabled,
  resolveDevDiagnosticsVerbose,
  runWithDevDiagnosticsContext,
} from "./service.js";

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("gateway dev diagnostics service coverage edges", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves diagnostics enablement and verbose flags from environment aliases", () => {
    for (const value of ["true", "1", "yes", "on"]) {
      vi.stubEnv("GOATCITADEL_DEV_DIAGNOSTICS_ENABLED", value);
      expect(resolveDevDiagnosticsEnabled()).toBe(true);
      vi.stubEnv("GOATCITADEL_DEV_DIAGNOSTICS_VERBOSE", value);
      expect(resolveDevDiagnosticsVerbose()).toBe(true);
    }

    for (const value of ["false", "0", "no", "off"]) {
      vi.stubEnv("GOATCITADEL_DEV_DIAGNOSTICS_ENABLED", value);
      expect(resolveDevDiagnosticsEnabled()).toBe(false);
      vi.stubEnv("GOATCITADEL_DEV_DIAGNOSTICS_VERBOSE", value);
      expect(resolveDevDiagnosticsVerbose()).toBe(false);
    }

    vi.stubEnv("GOATCITADEL_DEV_DIAGNOSTICS_ENABLED", "maybe");
    vi.stubEnv("NODE_ENV", "production");
    expect(resolveDevDiagnosticsEnabled()).toBe(false);
    vi.stubEnv("NODE_ENV", "development");
    expect(resolveDevDiagnosticsEnabled()).toBe(true);

    vi.stubEnv("GOATCITADEL_DEV_DIAGNOSTICS_VERBOSE", "maybe");
    expect(resolveDevDiagnosticsVerbose()).toBe(false);
  });

  it("inherits and extends async diagnostics context for recorded events", () => {
    const service = new GatewayDevDiagnosticsService(true, undefined, false, 10);

    runWithDevDiagnosticsContext(
      {
        correlationId: "corr-1",
        route: "/api/test",
        sessionId: "session-1",
        chatId: "chat-1",
        turnId: "turn-1",
        runId: "run-1",
        taskId: "task-1",
        providerId: "openai",
        modelId: "gpt-test",
      },
      () => {
        enterDevDiagnosticsContext({ runId: "run-override" });
        expect(getDevDiagnosticsContext()).toMatchObject({
          correlationId: "corr-1",
          runId: "run-override",
        });

        const event = service.record({
          level: "info",
          category: "gateway",
          event: "context.event",
          message: "Context event",
        });

        expect(event).toMatchObject({
          correlationId: "corr-1",
          route: "/api/test",
          sessionId: "session-1",
          chatId: "chat-1",
          turnId: "turn-1",
          runId: "run-override",
          taskId: "task-1",
          providerId: "openai",
          modelId: "gpt-test",
        });
      },
    );
  });

  it("keeps disabled diagnostics inert and supports listener unsubscription", () => {
    const disabled = new GatewayDevDiagnosticsService(false, undefined, false, 10);
    expect(disabled.isEnabled()).toBe(false);
    expect(
      disabled.record({
        level: "info",
        category: "gateway",
        event: "disabled",
        message: "disabled",
      }),
    ).toBeUndefined();
    expect(disabled.list().items).toEqual([]);

    const enabled = new GatewayDevDiagnosticsService(true, undefined, false, 10);
    const listener = vi.fn();
    const unsubscribe = enabled.subscribe(listener);
    unsubscribe();
    enabled.record({
      level: "info",
      category: "gateway",
      event: "after.unsubscribe",
      message: "after unsubscribe",
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it("filters every diagnostics dimension on non-matching values", () => {
    const service = new GatewayDevDiagnosticsService(true, undefined, false, 10);
    service.record({
      level: "info",
      category: "gateway",
      event: "filterable",
      message: "filterable",
      correlationId: "corr-1",
      runtimeKind: "tool.invocation",
      runtimeStatus: "running",
      runId: "run-1",
      toolName: "shell.exec",
      meetingSessionId: "meet-1",
    });

    expect(service.list({ level: "warn" }).items).toEqual([]);
    expect(service.list({ category: "llm" }).items).toEqual([]);
    expect(service.list({ correlationId: "corr-2" }).items).toEqual([]);
    expect(service.list({ runtimeKind: "model.call" }).items).toEqual([]);
    expect(service.list({ runtimeStatus: "failed" }).items).toEqual([]);
    expect(service.list({ runId: "run-2" }).items).toEqual([]);
    expect(service.list({ toolName: "browser.search" }).items).toEqual([]);
    expect(service.list({ meetingSessionId: "meet-2" }).items).toEqual([]);
    expect(service.list({ limit: 0 }).items).toHaveLength(1);
  });

  it("logs async exporter rejections and skips unregistered exporters", async () => {
    const logger = createLogger();
    const service = new GatewayDevDiagnosticsService(true, logger as never, false, 10);
    const removedExporter = { export: vi.fn() };
    const unregister = service.registerExporter(removedExporter);
    unregister();
    service.registerExporter({
      export: vi.fn(() => Promise.reject(new Error("async exporter failed"))),
    });

    service.record({
      level: "info",
      category: "gateway",
      event: "async.exporter",
      message: "async exporter",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(removedExporter.export).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        diagnostics: true,
        event: "async.exporter",
        exporterError: "async exporter failed",
      }),
      "Dev diagnostics exporter rejected while handling an event",
    );
  });

  it("logs debug in verbose mode and dispatches warning and error levels", () => {
    const logger = createLogger();
    const service = new GatewayDevDiagnosticsService(true, logger as never, true, 10);

    service.record({ level: "debug", category: "gateway", event: "debug", message: "debug message" });
    service.record({ level: "warn", category: "gateway", event: "warn", message: "warn message" });
    service.record({ level: "error", category: "gateway", event: "error", message: "error message" });

    expect(logger.debug).toHaveBeenCalledWith(expect.objectContaining({ event: "debug" }), "debug message");
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "warn" }), "warn message");
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ event: "error" }), "error message");
  });

  it("classifies runtime diagnostics across known kind and status families", () => {
    const service = new GatewayDevDiagnosticsService(true, undefined, false, 20);
    const cases = [
      ["tool.invocation", "completed", "tools", "info"],
      ["meet.session", "degraded", "meet", "warn"],
      ["voice.capture", "running", "voice", "debug"],
      ["mcp.call", "blocked", "mcp", "warn"],
      ["chat.turn", "started", "chat", "info"],
      ["delegation.role", "cancelled", "orchestration", "info"],
      ["dependency.database", "failed", "dependency", "error"],
      ["custom.runtime", "completed", "runtime", "info"],
    ] as const;

    const events = cases.map(([kind, status]) =>
      service.recordRuntime({
        kind,
        status,
        message: `${kind} ${status}`,
      }),
    );

    expect(events.map((event) => [event?.runtimeKind, event?.runtimeStatus, event?.category, event?.level])).toEqual(
      cases.map(([kind, status, category, level]) => [kind, status, category, level]),
    );
  });

  it("redacts bearer strings and truncates deeply nested diagnostic context", () => {
    const service = new GatewayDevDiagnosticsService(true, undefined, false, 10);

    const event = service.record({
      level: "info",
      category: "gateway",
      event: "redaction.depth",
      message: "redaction depth",
      context: {
        arrayValue: ["plain", { nested: "visible" }],
        bearerValue: "Bearer abc123",
        safeString: "prefix Bearer abc123 suffix",
        nested: {
          a: {
            b: {
              c: {
                d: {
                  e: "too deep",
                },
              },
            },
          },
        },
      },
    });

    expect(event?.context).toMatchObject({
      arrayValue: ["plain", { nested: "visible" }],
      bearerValue: "[redacted]",
      safeString: "prefix [redacted] suffix",
      nested: {
        a: {
          b: {
            c: {
              d: "[max-depth]",
            },
          },
        },
      },
    });
  });
});
