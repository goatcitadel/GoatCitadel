import { describe, expect, it } from "vitest";
import { ResearchSearchBrokerService } from "./research-search-broker-service.js";

describe("ResearchSearchBrokerService", () => {
  it("is advisory-only and points execution to governed browser.search", async () => {
    const result = await new ResearchSearchBrokerService().search({
      query: "latest GoatCitadel skill updates",
      providers: ["brave", "parallel"],
      maxResults: 50,
    });

    expect(result).toMatchObject({
      query: "latest GoatCitadel skill updates",
      results: [],
      providerAttempts: [],
      execution: {
        kind: "advisory_only",
        executableTool: "browser.search",
        requiredBackend: "official",
      },
      accounting: {
        scope: "response_local",
        persistence: "not_persisted",
        cost: "unknown",
        outboundRequests: [],
      },
      routing: { attemptedProviders: [], successfulProviders: [] },
    });
    expect(result.warnings.join(" ")).toContain("did not execute");
  });

  it("retains exclusions and compatibility status without scraping", async () => {
    const result = await new ResearchSearchBrokerService().search({
      query: "latest GoatCitadel skill updates",
      engines: ["google", "brave", "baidu", "bing_cn", "sogou"] as never,
    });

    expect(result.engineStatuses).toContainEqual(
      expect.objectContaining({
        engine: "google",
        status: "unavailable",
        message: expect.stringContaining("no scraping"),
      }),
    );
    expect(result.warnings.join(" ")).toContain("Baidu is excluded");
    expect(result.warnings.join(" ")).toContain("Bing CN is excluded");
    expect(result.warnings.join(" ")).toContain("Sogou is excluded");
  });

  it.each([
    "find api_key=super-secret-value123",
    "Authorization: Bearer abc123def456ghi789jkl",
    "Authorization: Basic dXNlcjpwYXNz",
    "find AKIAIOSFODNN7EXAMPLE",
    "inspect http://service.internal/admin",
    "search my-printer.local credentials",
    "inspect http://[::1]/admin",
    "inspect http://[fd12:3456::1]/admin",
    "inspect http://[fe80::1]/admin",
  ])("never echoes blocked sensitive query content: %s", async (query) => {
    const serialized = JSON.stringify(await new ResearchSearchBrokerService().search({ query, providers: ["brave"] }));
    expect(serialized).not.toContain(query);
    expect(serialized).toContain("[redacted-sensitive-query]");
    expect(serialized).toContain("no external search was attempted");
  });
});
