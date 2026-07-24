import { describe, expect, expectTypeOf, it } from "vitest";
import type { ResearchSearchRequest, ResearchSearchResponse } from "./research-search.js";

describe("research search contracts", () => {
  it("preserves legacy engine-only requests", () => {
    const request: ResearchSearchRequest = { query: "GoatCitadel", engines: ["brave"] };
    expect(request.engines).toEqual(["brave"]);
  });

  it("exposes additive official-provider routing evidence", () => {
    const response: ResearchSearchResponse = {
      query: "GoatCitadel",
      generatedAt: "2026-07-14T00:00:00.000Z",
      mode: "quick",
      routing: {
        country: "US",
        searchLanguage: "en",
        requestedProviders: ["brave"],
        attemptedProviders: ["brave"],
        successfulProviders: ["brave"],
        fallbackUsed: false,
        partial: false,
      },
      providerAttempts: [
        {
          provider: "brave",
          status: "succeeded",
          startedAt: "2026-07-14T00:00:00.000Z",
          completedAt: "2026-07-14T00:00:00.010Z",
          latencyMs: 10,
          resultCount: 1,
        },
      ],
      execution: {
        kind: "executed",
        executableTool: "browser.search",
        requiredBackend: "official",
        guidance: "Official provider execution occurred through browser.search.",
      },
      accounting: {
        scope: "response_local",
        persistence: "not_persisted",
        cost: "unknown",
        outboundRequests: [{ provider: "brave", requestCount: 1 }],
      },
      results: [],
      engineStatuses: [{ engine: "brave", status: "ready" }],
      warnings: [],
    };

    expect(response.routing?.country).toBe("US");
    expect(response.accounting?.persistence).toBe("not_persisted");
    expectTypeOf(response.providerAttempts?.[0]?.status).toMatchTypeOf<
      | "succeeded"
      | "unavailable"
      | "blocked"
      | "rate_limited"
      | "timed_out"
      | "invalid_response"
      | "upstream_error"
      | undefined
    >();
  });
});
