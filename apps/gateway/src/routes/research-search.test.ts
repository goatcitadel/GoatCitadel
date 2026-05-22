import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { researchSearchRoutes } from "./research-search.js";

describe("research search routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("routes advisory search requests through the broker service", async () => {
    const search = vi.fn(() => ({
      query: "GoatCitadel updates",
      generatedAt: "2026-05-22T00:00:00.000Z",
      results: [],
      engineStatuses: [{ engine: "google", status: "unavailable", message: "No configured official API provider." }],
      warnings: ["No scraping fallback was attempted."],
    }));
    app = Fastify();
    app.decorate("services", { researchSearch: { search } } as never);
    app.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
    await app.register(researchSearchRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/research/search",
      payload: {
        query: "GoatCitadel updates",
        engines: ["google", "baidu"],
        maxResults: 5,
        freshness: "week",
        workspaceId: "default",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(search).toHaveBeenCalledWith({
      query: "GoatCitadel updates",
      engines: ["google", "baidu"],
      maxResults: 5,
      freshness: "week",
      workspaceId: "default",
    });
    expect(response.json()).toMatchObject({
      results: [],
      warnings: ["No scraping fallback was attempted."],
    });
  });
});
