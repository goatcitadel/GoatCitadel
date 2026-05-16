import { describe, expect, it } from "vitest";
import { normalizeFirecrawlApiKeyEnvName, normalizeSafeEnvKeyName, normalizeSafeEnvKeyNames } from "./safe-env-name.js";

describe("safe env-name normalization", () => {
  it("accepts bounded uppercase env names and drops unsafe input", () => {
    expect(normalizeSafeEnvKeyName(" OPENAI_API_KEY ")).toBe("OPENAI_API_KEY");
    expect(normalizeSafeEnvKeyName("Path")).toBeUndefined();
    expect(normalizeSafeEnvKeyName("1TOKEN")).toBeUndefined();
    expect(normalizeSafeEnvKeyName("TOKEN=value")).toBeUndefined();
    expect(normalizeSafeEnvKeyName("__proto__")).toBeUndefined();
  });

  it("dedupes explicit allowlists after sanitization", () => {
    expect(normalizeSafeEnvKeyNames(["OPENAI_API_KEY", " OPENAI_API_KEY ", "bad-key", "MCP_TOKEN"])).toEqual([
      "OPENAI_API_KEY",
      "MCP_TOKEN",
    ]);
  });

  it("restricts Firecrawl env-name input to Firecrawl-specific keys", () => {
    expect(normalizeFirecrawlApiKeyEnvName("FIRECRAWL_API_KEY")).toBe("FIRECRAWL_API_KEY");
    expect(normalizeFirecrawlApiKeyEnvName("FIRECRAWL_KEY")).toBe("FIRECRAWL_KEY");
    expect(normalizeFirecrawlApiKeyEnvName("OPENAI_API_KEY")).toBeUndefined();
  });
});
