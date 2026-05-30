import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { costsRoutes } from "./costs.js";

describe("costs routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  async function createApp(services: Record<string, unknown>): Promise<FastifyInstance> {
    const next = Fastify();
    next.decorate("services", services as never);
    await next.register(costsRoutes);
    return next;
  }

  it("returns provider daily series alongside aggregate cost summary", async () => {
    const services = {
      costs: {
        costSummary: vi.fn(() => [
          {
            key: "2026-02-23",
            tokenInput: 20,
            tokenOutput: 10,
            tokenCachedInput: 0,
            tokenTotal: 30,
            costUsd: 4,
          },
        ]),
        costDailySeries: vi.fn(() => [
          {
            isoDate: "2026-02-23",
            shortLabel: "02-23",
            costUsd: 4,
            tokenInput: 20,
            tokenOutput: 10,
            tokenCachedInput: 0,
            tokenTotal: 30,
            segments: [
              {
                providerKey: "openai",
                label: "Openai",
                tokenInput: 20,
                tokenOutput: 10,
                tokenCachedInput: 0,
                tokenTotal: 30,
                costUsd: 4,
                models: ["gpt-5"],
              },
            ],
          },
        ]),
        costUsageAvailability: vi.fn(() => ({ trackedEvents: 1, unknownEvents: 0, totalAgentEvents: 1 })),
      },
    };
    app = await createApp(services);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/costs/summary?scope=day&from=2026-02-20T00:00:00.000Z&to=2026-02-26T23:59:59.999Z",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      scope: "day",
      dailySeries: [
        {
          isoDate: "2026-02-23",
          segments: [{ providerKey: "openai", costUsd: 4, models: ["gpt-5"] }],
        },
      ],
      usageAvailability: { trackedEvents: 1, unknownEvents: 0, totalAgentEvents: 1 },
    });
    expect(services.costs.costSummary).toHaveBeenCalledWith(
      "day",
      "2026-02-20T00:00:00.000Z",
      "2026-02-26T23:59:59.999Z",
    );
    expect(services.costs.costDailySeries).toHaveBeenCalledWith("2026-02-20T00:00:00.000Z", "2026-02-26T23:59:59.999Z");
  });

  it("rejects invalid cost summary scope before touching services", async () => {
    const services = {
      costs: {
        costSummary: vi.fn(),
        costDailySeries: vi.fn(),
        costUsageAvailability: vi.fn(),
      },
    };
    app = await createApp(services);

    const response = await app.inject({ method: "GET", url: "/api/v1/costs/summary?scope=month" });

    expect(response.statusCode).toBe(400);
    expect(services.costs.costSummary).not.toHaveBeenCalled();
    expect(services.costs.costDailySeries).not.toHaveBeenCalled();
  });
});
