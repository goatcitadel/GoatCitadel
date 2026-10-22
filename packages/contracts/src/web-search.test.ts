import { describe, expect, it } from "vitest";
import { isChangePlanRequest } from "./change-plan.js";
import {
  isWebSearchEngineOrder,
  normalizeWebSearchEngineOrder,
  resolveWebSearchEngineCandidates,
} from "./web-search.js";

describe("web search engine order", () => {
  it("accepts one to three distinct known engines", () => {
    expect(isWebSearchEngineOrder(["bing"])).toBe(true);
    expect(isWebSearchEngineOrder(["google", "duckduckgo", "bing"])).toBe(true);
    expect(isWebSearchEngineOrder([])).toBe(false);
    expect(isWebSearchEngineOrder(["bing", "bing"])).toBe(false);
    expect(isWebSearchEngineOrder(["brave"])).toBe(false);
  });

  it("normalizes stored values and falls back to the default order", () => {
    expect(normalizeWebSearchEngineOrder([" Bing ", "google", "bing", "yahoo"])).toEqual(["bing", "google"]);
    expect(normalizeWebSearchEngineOrder(undefined)).toEqual(["duckduckgo", "bing", "google"]);
    expect(normalizeWebSearchEngineOrder(["yahoo"])).toEqual(["duckduckgo", "bing", "google"]);
  });

  it("puts an allowed requested engine first and ignores engines the operator turned off", () => {
    expect(resolveWebSearchEngineCandidates("auto", ["bing", "duckduckgo"])).toEqual(["bing", "duckduckgo"]);
    expect(resolveWebSearchEngineCandidates("duckduckgo", ["bing", "duckduckgo"])).toEqual(["duckduckgo", "bing"]);
    expect(resolveWebSearchEngineCandidates("google", ["bing", "duckduckgo"])).toEqual(["bing", "duckduckgo"]);
    expect(resolveWebSearchEngineCandidates(undefined, undefined)).toEqual(["duckduckgo", "bing", "google"]);
  });
});

describe("web search Change Plan intents", () => {
  const runtime = (change: Record<string, unknown>) => ({ kind: "runtime_configuration", change });

  it("validates the engine-order operation", () => {
    expect(
      isChangePlanRequest(runtime({ operation: "web_search_configuration", config: { engineOrder: ["bing"] } })),
    ).toBe(true);
    expect(isChangePlanRequest(runtime({ operation: "web_search_configuration", config: { engineOrder: [] } }))).toBe(
      false,
    );
    expect(
      isChangePlanRequest(
        runtime({ operation: "web_search_configuration", config: { engineOrder: ["bing"], extra: 1 } }),
      ),
    ).toBe(false);
  });

  it("validates the credential operation and never carries a key", () => {
    expect(
      isChangePlanRequest(
        runtime({ operation: "web_search_credential", targetId: "search.firecrawl", action: "replace" }),
      ),
    ).toBe(true);
    expect(
      isChangePlanRequest(
        runtime({ operation: "web_search_credential", targetId: "search.tavily", action: "replace" }),
      ),
    ).toBe(false);
    expect(
      isChangePlanRequest(
        runtime({ operation: "web_search_credential", targetId: "search.brave", action: "replace", apiKey: "k" }),
      ),
    ).toBe(false);
  });
});
