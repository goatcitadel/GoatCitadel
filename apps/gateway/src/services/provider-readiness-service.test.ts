import { describe, expect, it, vi } from "vitest";
import { verifyProviderConnection } from "./provider-readiness-service.js";

describe("provider connection evidence", () => {
  function fixture(provider: Record<string, unknown> = {}, source = "live") {
    return {
      getSettings: vi.fn().mockResolvedValue({
        llm: { providers: [{ providerId: "provider", label: "Provider", hasApiKey: true, ...provider }] },
      }),
      listModelsWithSource: vi.fn().mockResolvedValue({ source, items: ["model"] }),
    };
  }
  it("records only authentication and catalog evidence", async () => {
    expect(await verifyProviderConnection(fixture() as never, "provider")).toEqual({
      evidenceRefs: ["provider:provider:auth_ready", "provider:provider:catalog:live:1"],
    });
  });
  it("rejects stale readiness even with a stored key", async () => {
    const deps = fixture({ authReadiness: { status: "blocked" } });
    await expect(verifyProviderConnection(deps as never, "provider")).rejects.toThrow("not connected");
    expect(deps.listModelsWithSource).not.toHaveBeenCalled();
  });
  it("retains the explicit OAuth catalog exception", async () => {
    await expect(verifyProviderConnection(fixture({}, "configured") as never, "provider")).rejects.toThrow(
      "verifiable model catalog",
    );
    await expect(
      verifyProviderConnection(fixture({ authMode: "codex-oauth" }, "configured") as never, "provider"),
    ).resolves.toBeDefined();
  });
});
