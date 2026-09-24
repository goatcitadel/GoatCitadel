import { describe, expect, it, vi } from "vitest";
import { verifyProviderConnection, verifyTemporaryProviderCredential } from "./provider-readiness-service.js";

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
  it("requires a live catalog for OAuth and API providers", async () => {
    await expect(verifyProviderConnection(fixture({}, "configured") as never, "provider")).rejects.toThrow(
      "verifiable model catalog",
    );
    await expect(
      verifyProviderConnection(fixture({ authMode: "codex-oauth" }, "configured") as never, "provider"),
    ).rejects.toThrow("verifiable model catalog");
  });
});

describe("temporary provider credential evidence", () => {
  function fixture() {
    return { readSecret: vi.fn(() => "synthetic-credential"),
      exportConfigFile: vi.fn(() => ({ providers: [{ providerId: "provider", baseUrl: "https://provider.test/v1",
        apiStyle: "chat_completions", request: { timeoutMs: 1234 } }] })),
      previewModels: vi.fn().mockResolvedValue({ source: "live", items: [{ id: "model" }] }) };
  }
  it("uses staged credentials and the selected provider transport without including them in evidence", async () => {
    const deps = fixture();
    expect(await verifyTemporaryProviderCredential(deps as never, "provider")).toEqual(["provider:provider:temporary_credential_validated"]);
    expect(deps.previewModels).toHaveBeenCalledWith({ providerId: "provider", baseUrl: "https://provider.test/v1",
      apiStyle: "chat_completions", request: { timeoutMs: 1234 }, apiKey: "synthetic-credential" });
  });
  it("refuses absent staged custody before requesting a catalog", async () => {
    const deps = fixture(); deps.readSecret.mockReturnValue(" ");
    await expect(verifyTemporaryProviderCredential(deps as never, "provider")).rejects.toThrow("unavailable");
    expect(deps.exportConfigFile).not.toHaveBeenCalled(); expect(deps.previewModels).not.toHaveBeenCalled();
  });
  it("refuses an unknown provider without probing another provider", async () => {
    const deps = fixture();
    await expect(verifyTemporaryProviderCredential(deps as never, "missing")).rejects.toThrow();
    expect(deps.previewModels).not.toHaveBeenCalled();
  });
  it.each([{ source: "configured", items: [{ id: "model" }] }, { source: "live", items: [] }])("refuses insufficient catalog evidence: %j", async preview => {
    const deps = fixture(); deps.previewModels.mockResolvedValue(preview);
    await expect(verifyTemporaryProviderCredential(deps as never, "provider")).rejects.toThrow("live model catalog");
  });
});
