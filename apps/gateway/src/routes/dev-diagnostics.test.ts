import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { devDiagnosticsRoutes } from "./dev-diagnostics.js";

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
      url: "/api/v1/dev/diagnostics?category=gateway&level=info&limit=25",
    });

    expect(response.statusCode).toBe(200);
    expect(listDevDiagnostics).toHaveBeenCalledWith({
      category: "gateway",
      level: "info",
      correlationId: undefined,
      limit: 25,
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
});
