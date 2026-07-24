import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { researchSearchRoutes } from "./research-search.js";
import { ResearchSearchBrokerService } from "../services/research-search-broker-service.js";

describe("research search routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("awaits official search and forwards additive routing inputs", async () => {
    const search = vi.fn(async () => ({
      query: "GoatCitadel updates",
      generatedAt: "2026-07-14T00:00:00.000Z",
      mode: "research",
      routing: {
        country: "US",
        searchLanguage: "en",
        requestedProviders: ["brave", "parallel"],
        attemptedProviders: ["brave", "parallel"],
        successfulProviders: ["brave"],
        fallbackUsed: false,
        partial: false,
      },
      providerAttempts: [],
      execution: {
        kind: "advisory_only",
        executableTool: "browser.search",
        requiredBackend: "official",
        guidance: "Invoke browser.search with backend=official.",
      },
      accounting: { scope: "response_local", persistence: "not_persisted", cost: "unknown", outboundRequests: [] },
      results: [],
      engineStatuses: [],
      warnings: ["External search request usage persistence is deferred; no cost value was recorded."],
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
        mode: "research",
        providers: ["brave", "parallel"],
        engines: ["google"],
        maxResults: 10,
        freshness: "week",
        workspaceId: "default",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(search).toHaveBeenCalledWith({
      query: "GoatCitadel updates",
      mode: "research",
      providers: ["brave", "parallel"],
      engines: ["google"],
      maxResults: 10,
      freshness: "week",
      workspaceId: "default",
    });
    expect(response.json()).toMatchObject({
      mode: "research",
      execution: { kind: "advisory_only", executableTool: "browser.search" },
      accounting: { persistence: "not_persisted" },
    });
  });

  it("rejects oversized queries and result limits above the contract cap", async () => {
    const search = vi.fn();
    app = Fastify();
    app.decorate("services", { researchSearch: { search } } as never);
    app.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
    await app.register(researchSearchRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/research/search",
      payload: { query: "x".repeat(513), maxResults: 51 },
    });

    expect(response.statusCode).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });

  it("accepts advisory maxResults up to 50 and omits sensitive query content", async () => {
    const broker = new ResearchSearchBrokerService();
    const search = vi.fn((input) => broker.search(input));
    app = Fastify();
    app.decorate("services", { researchSearch: { search } } as never);
    app.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
    await app.register(researchSearchRoutes);
    const sensitiveQuery = "find password=do-not-echo-secret123 on service.internal";

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/research/search",
      payload: { query: sensitiveQuery, providers: ["brave"], maxResults: 50 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(sensitiveQuery);
    expect(response.json()).toMatchObject({
      query: "[redacted-sensitive-query]",
      results: [],
      execution: { kind: "advisory_only" },
      routing: { attemptedProviders: [] },
    });
  });
});
