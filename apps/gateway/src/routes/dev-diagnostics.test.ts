import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { DevDiagnosticsEvent } from "@goatcitadel/contracts";
import { devDiagnosticsRoutes, matchesDevDiagnosticsRouteFilter } from "./dev-diagnostics.js";

describe("dev diagnostics routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("returns 404 when dev diagnostics are disabled", async () => {
    app = Fastify();
    app.decorate("services", {
      devDiagnostics: { isDevDiagnosticsEnabled: () => false },
    } as never);
    await app.register(devDiagnosticsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/dev/diagnostics",
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns 404 when the dev diagnostics stream is disabled", async () => {
    app = Fastify();
    app.decorate("services", {
      devDiagnostics: { isDevDiagnosticsEnabled: () => false },
    } as never);
    await app.register(devDiagnosticsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/dev/diagnostics/stream",
    });

    expect(response.statusCode).toBe(404);
  });

  it("rejects malformed diagnostic list and stream filters", async () => {
    app = Fastify();
    app.decorate("services", {
      devDiagnostics: { isDevDiagnosticsEnabled: () => true },
    } as never);
    await app.register(devDiagnosticsRoutes);

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/v1/dev/diagnostics?limit=0",
    });
    const streamResponse = await app.inject({
      method: "GET",
      url: "/api/v1/dev/diagnostics/stream?replay=0",
    });

    expect(listResponse.statusCode).toBe(400);
    expect(streamResponse.statusCode).toBe(400);
  });

  it("lists diagnostics with forwarded filters", async () => {
    const listDevDiagnostics = vi.fn(() => ({
      items: [
        {
          id: "evt-1",
          timestamp: "2026-03-08T00:00:00.000Z",
          level: "info",
          category: "gateway",
          event: "request.start",
          message: "request started",
          source: "gateway",
        },
      ],
    }));
    app = Fastify();
    app.decorate("services", {
      devDiagnostics: { isDevDiagnosticsEnabled: () => true, listDevDiagnostics },
    } as never);
    await app.register(devDiagnosticsRoutes);

    const response = await app.inject({
      method: "GET",
      url: [
        "/api/v1/dev/diagnostics",
        "?category=gateway&level=info&correlationId=corr-1&runtimeKind=tool",
        "&runtimeStatus=running&runId=run-1&toolName=shell.exec&meetingSessionId=meeting-1&limit=25",
      ].join(""),
    });

    expect(response.statusCode).toBe(200);
    expect(listDevDiagnostics).toHaveBeenCalledWith({
      category: "gateway",
      correlationId: "corr-1",
      level: "info",
      meetingSessionId: "meeting-1",
      limit: 25,
      runId: "run-1",
      runtimeKind: "tool",
      runtimeStatus: "running",
      toolName: "shell.exec",
    });
    expect(response.json()).toEqual({
      items: [
        {
          id: "evt-1",
          timestamp: "2026-03-08T00:00:00.000Z",
          level: "info",
          category: "gateway",
          event: "request.start",
          message: "request started",
          source: "gateway",
        },
      ],
    });
  });

  it("matches streamed diagnostics only when all requested filters match", () => {
    const event: DevDiagnosticsEvent = {
      id: "evt-1",
      timestamp: "2026-03-08T00:00:00.000Z",
      level: "info",
      category: "gateway",
      event: "request.start",
      message: "request started",
      source: "gateway",
      correlationId: "corr-1",
      runtimeKind: "tool",
      runtimeStatus: "running",
      runId: "run-1",
      toolName: "shell.exec",
      meetingSessionId: "meeting-1",
    };

    expect(matchesDevDiagnosticsRouteFilter(event, {})).toBe(true);
    expect(
      matchesDevDiagnosticsRouteFilter(event, {
        category: "gateway",
        correlationId: "corr-1",
        level: "info",
        meetingSessionId: "meeting-1",
        runId: "run-1",
        runtimeKind: "tool",
        runtimeStatus: "running",
        toolName: "shell.exec",
      }),
    ).toBe(true);
    expect(matchesDevDiagnosticsRouteFilter(event, { level: "error" })).toBe(false);
    expect(matchesDevDiagnosticsRouteFilter(event, { category: "llm" })).toBe(false);
    expect(matchesDevDiagnosticsRouteFilter(event, { correlationId: "corr-2" })).toBe(false);
    expect(matchesDevDiagnosticsRouteFilter(event, { runtimeKind: "chat" })).toBe(false);
    expect(matchesDevDiagnosticsRouteFilter(event, { runtimeStatus: "failed" })).toBe(false);
    expect(matchesDevDiagnosticsRouteFilter(event, { runId: "run-2" })).toBe(false);
    expect(matchesDevDiagnosticsRouteFilter(event, { toolName: "browser.search" })).toBe(false);
    expect(matchesDevDiagnosticsRouteFilter(event, { meetingSessionId: "meeting-2" })).toBe(false);
  });
});
