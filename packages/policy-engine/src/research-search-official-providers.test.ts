import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OFFICIAL_SEARCH_CREDENTIAL_ENV_ALIASES,
  canonicalizeResearchResultUrl,
  executeOfficialResearchSearch,
  getOfficialSearchCredentialEnvAliases,
  isOfficialResearchSearchInvocation,
  resolveOfficialSearchProviders,
} from "./research-search-official-providers.js";

describe("official research search providers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("executes Brave with fixed US/English routing and bounded compatibility output", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://api.search.brave.com/res/v1/web/search");
      expect(url.searchParams.get("country")).toBe("US");
      expect(url.searchParams.get("search_lang")).toBe("en");
      expect(url.searchParams.get("freshness")).toBe("pw");
      expect(new Headers(init?.headers).get("X-Subscription-Token")).toBe("brave-secret");
      return Response.json({
        web: {
          results: [
            {
              title: "Official docs",
              url: "https://EXAMPLE.gov:443/docs/search?utm_source=test&b=2&a=1#section",
              description: "Primary documentation",
              page_age: "2026-07-13T00:00:00Z",
            },
          ],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await executeOfficialResearchSearch(
      { query: "GoatCitadel search", engines: ["brave"], freshness: "week" },
      { env: { GOATCITADEL_SEARCH_BRAVE_API_KEY: "brave-secret" } },
    );

    expect(response.routing).toMatchObject({
      country: "US",
      searchLanguage: "en",
      requestedProviders: ["brave"],
      successfulProviders: ["brave"],
      fallbackUsed: false,
      partial: false,
    });
    expect(response.results).toEqual([
      expect.objectContaining({
        engine: "brave",
        provider: "brave",
        url: "https://example.gov/docs/search?a=1&b=2",
        confidence: 0.95,
        contributingProviders: ["brave"],
      }),
    ]);
    expect(response.providerAttempts?.[0]).toMatchObject({ status: "succeeded", resultCount: 1 });
    expect(response.execution).toMatchObject({ kind: "executed", executableTool: "browser.search" });
    expect(response.accounting).toEqual({
      scope: "response_local",
      persistence: "not_persisted",
      cost: "unknown",
      outboundRequests: [{ provider: "brave", requestCount: 1 }],
    });
    expect(response.warnings.join(" ")).toContain("usage persistence is deferred");
  });

  it("awaits the protected runtime credential resolver before environment fallback", async () => {
    const resolveCredential = vi.fn(async () => "runtime-brave-secret");
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("X-Subscription-Token")).toBe("runtime-brave-secret");
      return Response.json({ web: { results: [] } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await executeOfficialResearchSearch(
      { query: "GoatCitadel", providers: ["brave"] },
      {
        env: { GOATCITADEL_SEARCH_BRAVE_API_KEY: "environment-brave-secret" },
        resolveCredential,
      },
    );

    expect(resolveCredential).toHaveBeenCalledWith("brave");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(response)).not.toContain("runtime-brave-secret");
    expect(JSON.stringify(response)).not.toContain("environment-brave-secret");
  });

  it("falls back to exported environment aliases only when the runtime resolver has no credential", async () => {
    const resolveCredential = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-api-key")).toBe("parallel-env-secret");
      return Response.json({ results: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await executeOfficialResearchSearch(
      { query: "GoatCitadel", providers: ["parallel"] },
      { env: { PARALLEL_API_KEY: "parallel-env-secret" }, resolveCredential },
    );

    expect(resolveCredential).toHaveBeenCalledWith("parallel");
    expect(getOfficialSearchCredentialEnvAliases("parallel")).toBe(OFFICIAL_SEARCH_CREDENTIAL_ENV_ALIASES.parallel);
    expect(getOfficialSearchCredentialEnvAliases("parallel")).toEqual([
      "GOATCITADEL_SEARCH_PARALLEL_API_KEY",
      "PARALLEL_API_KEY",
    ]);
  });

  it("contains resolver failures and arbitrary credential values outside results and errors", async () => {
    const resolverSecret = "opaque-resolver-secret";
    const resolverFailure = await executeOfficialResearchSearch(
      { query: "GoatCitadel", providers: ["brave"] },
      {
        env: {},
        resolveCredential: async () => {
          throw new Error(`credential lookup failed for ${resolverSecret}`);
        },
      },
    );

    expect(resolverFailure.providerAttempts?.[0]).toMatchObject({
      status: "unavailable",
      message: "Official provider credential could not be resolved.",
    });
    expect(JSON.stringify(resolverFailure)).not.toContain(resolverSecret);

    const transportSecret = "opaque-transport-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`transport rejected ${transportSecret}`);
      }),
    );
    const transportFailure = await executeOfficialResearchSearch(
      { query: "GoatCitadel", providers: ["brave"] },
      { env: {}, resolveCredential: async () => transportSecret },
    );

    expect(JSON.stringify(transportFailure)).not.toContain(transportSecret);
  });

  it("clamps provider requests and output to 20 even when an advisory caller requests 50", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(new URL(String(input)).searchParams.get("count")).toBe("20");
      return Response.json({
        web: {
          results: Array.from({ length: 25 }, (_, index) => ({
            title: `Result ${index + 1}`,
            url: `https://example.com/${index + 1}`,
          })),
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await executeOfficialResearchSearch(
      { query: "GoatCitadel", providers: ["brave"], maxResults: 50 },
      { env: { GOATCITADEL_SEARCH_BRAVE_API_KEY: "brave-secret" } },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.results).toHaveLength(20);
  });

  it("runs research providers concurrently, deduplicates canonically, and exposes partial failure", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://api.search.brave.com/")) {
        return Response.json({
          web: {
            results: [
              { title: "Shared", url: "https://example.com/item?utm_campaign=x", description: "Brave" },
              { title: "Docs", url: "https://vendor.example/docs/api", description: "Docs" },
            ],
          },
        });
      }
      return new Response("rate limited", { status: 429, headers: { "retry-after": "3" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await executeOfficialResearchSearch(
      { query: "provider APIs", mode: "research" },
      {
        env: {
          GOATCITADEL_SEARCH_BRAVE_API_KEY: "brave-secret",
          GOATCITADEL_SEARCH_PARALLEL_API_KEY: "parallel-secret",
        },
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.routing).toMatchObject({
      requestedProviders: ["brave", "parallel"],
      successfulProviders: ["brave"],
      partial: true,
    });
    expect(response.providerAttempts).toEqual([
      expect.objectContaining({ provider: "brave", status: "succeeded" }),
      expect.objectContaining({ provider: "parallel", status: "rate_limited", httpStatus: 429, retryAfterMs: 3000 }),
    ]);
    expect(response.results[0]?.url).toBe("https://vendor.example/docs/api");
  });

  it("uses Parallel's fixed POST wire shape", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.parallel.ai/v1/search");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("x-api-key")).toBe("parallel-secret");
      expect(JSON.parse(String(init?.body))).toEqual({
        objective: "official evidence",
        search_queries: ["official evidence"],
      });
      return Response.json({
        results: [{ title: "Evidence", url: "https://example.com/evidence", excerpts: ["One", "Two"] }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await executeOfficialResearchSearch(
      { query: "official evidence", providers: ["parallel"] },
      { env: { GOATCITADEL_SEARCH_PARALLEL_API_KEY: "parallel-secret" } },
    );

    expect(response.results[0]?.snippet).toBe("One Two");
    expect(response.providerAttempts?.[0]?.status).toBe("succeeded");
  });

  it("caps each Parallel search query to 200 characters while retaining the objective", async () => {
    const query = "q".repeat(512);
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { objective: string; search_queries: string[] };
      expect(payload.objective).toBe(query);
      expect(payload.search_queries).toEqual([query.slice(0, 200)]);
      return Response.json({ results: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    await executeOfficialResearchSearch(
      { query, providers: ["parallel"] },
      { env: { GOATCITADEL_SEARCH_PARALLEL_API_KEY: "parallel-secret" } },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks secret-like and private-network queries before egress", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await executeOfficialResearchSearch(
      { query: "find api_key=super-secret-value123", mode: "research" },
      {
        env: {
          GOATCITADEL_SEARCH_BRAVE_API_KEY: "brave-secret",
          GOATCITADEL_SEARCH_PARALLEL_API_KEY: "parallel-secret",
        },
      },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.providerAttempts?.map((attempt) => attempt.status)).toEqual(["blocked", "blocked"]);
    expect(response.results).toEqual([]);
    expect(response.query).toBe("[redacted-sensitive-query]");
    expect(JSON.stringify(response)).not.toContain("super-secret-value123");
    expect(response.accounting?.outboundRequests).toEqual([]);
  });

  it.each([
    "inspect printer.local",
    "open service.internal/admin",
    "query build.lan",
    "inspect http://[::1]/admin",
    "inspect http://[fd12:3456::1]/admin",
    "inspect http://[fe80::1]/admin",
  ])("blocks and omits internal hostname query: %s", async (query) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await executeOfficialResearchSearch(
      { query, providers: ["brave"] },
      { env: { GOATCITADEL_SEARCH_BRAVE_API_KEY: "brave-secret" } },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain(query);
    expect(response.query).toBe("[redacted-sensitive-query]");
  });

  it.each([
    "Authorization: Bearer abc123def456ghi789jkl",
    "Authorization: Basic dXNlcjpwYXNz",
    "find AKIAIOSFODNN7EXAMPLE",
  ])("composes canonical secret redaction into the pre-egress block: %s", async (query) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await executeOfficialResearchSearch(
      { query, providers: ["brave"] },
      { env: { GOATCITADEL_SEARCH_BRAVE_API_KEY: "brave-secret" } },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.query).toBe("[redacted-sensitive-query]");
    expect(JSON.stringify(response)).not.toContain(query);
    expect(response.accounting?.outboundRequests).toEqual([]);
  });

  it("reports unavailable credentials without inventing cost or request evidence", async () => {
    const response = await executeOfficialResearchSearch({ query: "GoatCitadel", providers: ["brave"] }, { env: {} });
    expect(response.providerAttempts?.[0]).toMatchObject({ provider: "brave", status: "unavailable", resultCount: 0 });
    expect(response).not.toHaveProperty("usage");
    expect(response.accounting?.outboundRequests).toEqual([]);
    expect(response.warnings.join(" ")).not.toContain("usage persistence is deferred");
  });

  it.each([
    [403, "blocked"],
    [500, "upstream_error"],
  ] as const)("maps HTTP %s to %s without exposing the credential", async (httpStatus, status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("secret upstream body", { status: httpStatus })),
    );
    const response = await executeOfficialResearchSearch(
      { query: "GoatCitadel", providers: ["brave"] },
      { env: { GOATCITADEL_SEARCH_BRAVE_API_KEY: "credential-must-not-leak" } },
    );
    expect(response.providerAttempts?.[0]).toMatchObject({ status, httpStatus });
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(response)).not.toContain("credential-must-not-leak");
    expect(JSON.stringify(response)).not.toContain("secret upstream body");
  });

  it("maps malformed and oversized provider bodies to invalid_response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("not-json", { status: 200 }))
      .mockResolvedValueOnce(new Response("x".repeat(1024 * 1024 + 1), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const options = { env: { GOATCITADEL_SEARCH_BRAVE_API_KEY: "brave-secret" } };

    const malformed = await executeOfficialResearchSearch({ query: "one", providers: ["brave"] }, options);
    const oversized = await executeOfficialResearchSearch({ query: "two", providers: ["brave"] }, options);

    expect(malformed.providerAttempts?.[0]?.status).toBe("invalid_response");
    expect(oversized.providerAttempts?.[0]?.status).toBe("invalid_response");
    expect(oversized.providerAttempts?.[0]?.message).toContain("exceeded");
  });

  it("blocks every redirect because official endpoints are fixed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://example.com/redirect" } })),
    );
    const response = await executeOfficialResearchSearch(
      { query: "GoatCitadel", providers: ["brave"] },
      { env: { GOATCITADEL_SEARCH_BRAVE_API_KEY: "brave-secret" } },
    );
    expect(response.providerAttempts?.[0]?.status).toBe("blocked");
  });

  it("does not count a policy-preflight block as an outbound request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await executeOfficialResearchSearch(
      { query: "GoatCitadel", providers: ["brave"] },
      {
        env: { GOATCITADEL_SEARCH_BRAVE_API_KEY: "brave-secret" },
        additionalAllowlists: [[]],
      },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.providerAttempts?.[0]?.status).toBe("blocked");
    expect(response.accounting?.outboundRequests).toEqual([]);
  });

  it("enforces the fixed quick-provider timeout", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async (_input: string | URL | Request, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            }),
        ),
      );
      const pending = executeOfficialResearchSearch(
        { query: "GoatCitadel", providers: ["brave"] },
        { env: { GOATCITADEL_SEARCH_BRAVE_API_KEY: "brave-secret" } },
      );
      await vi.advanceTimersByTimeAsync(8_001);
      const response = await pending;
      expect(response.providerAttempts?.[0]?.status).toBe("timed_out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("canonicalizes only public HTTPS URLs and makes provider selection explicit", () => {
    expect(canonicalizeResearchResultUrl("http://example.com")).toBeUndefined();
    expect(canonicalizeResearchResultUrl("https://127.0.0.1/secret")).toBeUndefined();
    expect(canonicalizeResearchResultUrl("https://Example.COM:443/x?z=2&utm_medium=a&a=1#fragment")).toBe(
      "https://example.com/x?a=1&z=2",
    );
    expect(resolveOfficialSearchProviders({ query: "x", engines: ["google", "brave", "parallel"] })).toEqual([
      "brave",
      "parallel",
    ]);
    expect(resolveOfficialSearchProviders({ query: "x" })).toEqual(["brave"]);
    expect(resolveOfficialSearchProviders({ query: "x", engines: ["parallel"] })).toEqual(["parallel"]);
    expect(resolveOfficialSearchProviders({ query: "x", providers: ["brave"], engines: ["parallel"] })).toEqual([
      "brave",
    ]);
    expect(resolveOfficialSearchProviders({ query: "x", mode: "research" })).toEqual(["brave", "parallel"]);
    expect(resolveOfficialSearchProviders({ query: "x", mode: "research", providers: [] })).toEqual([]);
    expect(isOfficialResearchSearchInvocation({ backend: "OFFICIAL" })).toBe(true);
    expect(isOfficialResearchSearchInvocation({ engine: "PARALLEL" })).toBe(true);
    expect(isOfficialResearchSearchInvocation({ providers: [] })).toBe(true);
    expect(isOfficialResearchSearchInvocation({ backend: "native", providers: ["brave"] })).toBe(false);
    expect(isOfficialResearchSearchInvocation({ backend: "native", engine: "brave" })).toBe(false);
    expect(isOfficialResearchSearchInvocation({ backend: "firecrawl", providers: ["parallel"] })).toBe(false);
    expect(isOfficialResearchSearchInvocation({ backend: "ollama", providers: ["brave"] })).toBe(false);
    expect(isOfficialResearchSearchInvocation({ engines: ["brave"] })).toBe(false);
  });
});
