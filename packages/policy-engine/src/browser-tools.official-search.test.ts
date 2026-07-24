import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";
import { executeBrowserTool } from "./browser-tools.js";

function config(networkAllowlist: string[]): ToolPolicyConfig {
  return {
    profiles: { minimal: ["browser.*"] },
    tools: { profile: "minimal", allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: ["C:\\tmp"],
      readOnlyRoots: ["C:\\tmp"],
      networkAllowlist,
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
}

describe("browser.search official provider path", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("keeps official execution behind browser.search and the configured egress allowlist", async () => {
    vi.stubEnv("GOATCITADEL_SEARCH_BRAVE_API_KEY", "brave-secret");
    const fetchMock = vi.fn(async () =>
      Response.json({
        web: {
          results: [{ title: "Specification", url: "https://example.com/spec", description: "Primary source" }],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeBrowserTool(
      "browser.search",
      { query: "current specification", backend: "official", providers: ["brave"], maxResults: 5 },
      config(["api.search.brave.com"]),
      { matchedGrantAllowedHosts: ["api.search.brave.com"] },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ action: "search", backend: "official", backendUsed: true, fallbackUsed: false });
    expect((result.routing as { successfulProviders: string[] }).successfulProviders).toEqual(["brave"]);
    expect(result.untrustedContent).toMatchObject({ source: "browser.search" });
  });

  it.each([
    ["uppercase backend", { backend: "OFFICIAL" }, "api.search.brave.com"],
    ["singular engine", { engine: "parallel" }, "api.parallel.ai"],
    ["providers-only", { providers: ["brave"] }, "api.search.brave.com"],
  ] as const)("dispatches canonical official selection from %s", async (_label, selection, allowedHost) => {
    vi.stubEnv("GOATCITADEL_SEARCH_BRAVE_API_KEY", "brave-secret");
    vi.stubEnv("GOATCITADEL_SEARCH_PARALLEL_API_KEY", "parallel-secret");
    const fetchMock = vi.fn(async () =>
      Response.json({
        web: { results: [{ title: "Evidence", url: "https://example.com/evidence" }] },
        results: [{ title: "Evidence", url: "https://example.com/evidence", excerpts: ["Primary"] }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await executeBrowserTool(
      "browser.search",
      { query: "current specification", ...selection },
      config([allowedHost]),
      { matchedGrantAllowedHosts: [allowedHost] },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ action: "search", backend: "official", backendUsed: true });
  });

  it("reports provider egress as blocked when the workspace allowlist does not grant it", async () => {
    vi.stubEnv("GOATCITADEL_SEARCH_BRAVE_API_KEY", "brave-secret");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      executeBrowserTool(
        "browser.search",
        { query: "current specification", backend: "official", providers: ["brave"] },
        config(["example.com"]),
      ),
    ).rejects.toThrow(/not yet allowlisted/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when an explicit execution grant host allowlist is empty", async () => {
    vi.stubEnv("GOATCITADEL_SEARCH_BRAVE_API_KEY", "brave-secret");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      executeBrowserTool(
        "browser.search",
        { query: "current specification", backend: "official", providers: ["brave"] },
        config(["api.search.brave.com"]),
        { matchedGrantAllowedHosts: [] },
      ),
    ).rejects.toThrow(/not yet allowlisted/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
