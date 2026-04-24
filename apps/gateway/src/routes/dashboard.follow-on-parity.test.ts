import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { dashboardRoutes } from "./dashboard.js";

describe("dashboard parity route removal", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  async function createApp(): Promise<FastifyInstance> {
    const next = Fastify();
    next.decorate("services", {
      dashboard: {
        getDashboardState: vi.fn(() => ({ ok: true })),
        getSystemVitals: vi.fn(() => ({
          hostname: "goat-box",
          platform: "win32",
          release: "11",
          uptimeSeconds: 1,
          loadAverage: [0, 0, 0],
          cpuCount: 8,
          memoryTotalBytes: 16,
          memoryFreeBytes: 8,
          memoryUsedBytes: 8,
          processRssBytes: 4,
          processHeapUsedBytes: 2,
        })),
      },
    } as never);
    await next.register(dashboardRoutes);
    return next;
  }

  it("keeps the system vitals route mounted", async () => {
    app = await createApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/vitals",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      hostname: "goat-box",
      platform: "win32",
    });
  });

  it("returns 404 for removed parity and proof-lane endpoints", async () => {
    app = await createApp();

    const removedEndpoints = [
      { method: "GET", url: "/api/v1/system/follow-on-parity" },
      { method: "GET", url: "/api/v1/system/openclaw-parity" },
      { method: "GET", url: "/api/v1/system/follow-on-parity/browser-proof-lane" },
      { method: "POST", url: "/api/v1/system/follow-on-parity/browser-proof-lane/export" },
      { method: "GET", url: "/api/v1/system/follow-on-parity/packaging-proof-lane" },
      { method: "POST", url: "/api/v1/system/follow-on-parity/packaging-proof-lane/export" },
      { method: "GET", url: "/api/v1/system/follow-on-parity/a2ui-proof-lane" },
      { method: "POST", url: "/api/v1/system/follow-on-parity/a2ui-proof-lane/export" },
      { method: "GET", url: "/api/v1/system/follow-on-parity/voice-proof-lane" },
      { method: "POST", url: "/api/v1/system/follow-on-parity/voice-proof-lane/export" },
      { method: "GET", url: "/api/v1/system/follow-on-parity/companion-bootstrap-brief" },
      { method: "POST", url: "/api/v1/system/follow-on-parity/companion-bootstrap-brief/export" },
      { method: "GET", url: "/api/v1/system/follow-on-parity/extension-sdk-brief" },
      { method: "POST", url: "/api/v1/system/follow-on-parity/extension-sdk-brief/export" },
      { method: "GET", url: "/api/v1/system/follow-on-parity/extension-starter-pack" },
      { method: "POST", url: "/api/v1/system/follow-on-parity/extension-starter-pack/export" },
    ] as const;

    for (const endpoint of removedEndpoints) {
      const response = await app.inject({
        method: endpoint.method,
        url: endpoint.url,
      });

      expect(response.statusCode, `${endpoint.method} ${endpoint.url}`).toBe(404);
    }
  });
});
