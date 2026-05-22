import { afterEach, describe, expect, it, vi } from "vitest";
import { ResearchSearchBrokerService } from "./research-search-broker-service.js";

describe("ResearchSearchBrokerService", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("excludes Chinese domestic search engines and refuses scraping fallback", () => {
    vi.stubEnv("GOATCITADEL_SEARCH_GOOGLE_API_KEY", "");
    vi.stubEnv("GOATCITADEL_SEARCH_BING_API_KEY", "");
    const service = new ResearchSearchBrokerService();

    const response = service.search({
      query: "latest GoatCitadel skill updates",
      engines: ["google", "baidu", "bing_cn", "sogou"] as never,
      maxResults: 10,
    });

    expect(response.results).toEqual([]);
    expect(response.engineStatuses).toEqual([
      expect.objectContaining({
        engine: "google",
        status: "unavailable",
        message: expect.stringContaining("will not scrape"),
      }),
    ]);
    expect(response.warnings.join(" ")).toContain("Baidu is excluded");
    expect(response.warnings.join(" ")).toContain("Bing CN is excluded");
    expect(response.warnings.join(" ")).toContain("No scraping fallback");
  });

  it("reports degraded status when an official provider key exists but live execution is disabled", () => {
    vi.stubEnv("GOATCITADEL_SEARCH_BRAVE_API_KEY", "configured");
    const service = new ResearchSearchBrokerService();

    const response = service.search({
      query: "provider pricing",
      engines: ["brave"],
    });

    expect(response.engineStatuses).toEqual([
      expect.objectContaining({
        engine: "brave",
        status: "degraded",
        message: expect.stringContaining("Official API credentials are configured"),
      }),
    ]);
    expect(response.results).toEqual([]);
  });
});
