// @vitest-environment happy-dom
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProviderModelCatalog, type ProviderModelCatalogOption } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import { ProviderCatalogSettings } from "./ProviderCatalogSettings";

vi.mock("@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog", () => ({ useProviderModelCatalog: vi.fn() }));

const provider: ProviderModelCatalogOption = {
  providerId: "provider-a", label: "Provider A", baseUrl: "https://example.test/v1?token=not-for-display",
  sanitizedEndpointIdentity: "https://example.test", apiStyle: "openai-responses", defaultModel: "saved-model",
  models: ["saved-model", "available-model"], modelProbeSource: "live", modelProbeState: "ready",
  modelRefreshStatus: "fresh", modelProbeCheckedAt: "2026-09-30T12:00:00.000Z", hasApiKey: true,
};
let catalog: ReturnType<typeof useProviderModelCatalog>;
let root: Root;
let container: HTMLDivElement;
const render = () => act(async () => root.render(<CockpitNavigationProvider><ProviderCatalogSettings /></CockpitNavigationProvider>));
const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;

beforeEach(() => {
  catalog = {
    config: { activeProviderId: "provider-a", activeModel: "saved-model", revision: 4, providers: [] } as unknown as NonNullable<ReturnType<typeof useProviderModelCatalog>["config"]>,
    providers: [{ ...provider }], loading: false, error: null, reload: vi.fn().mockResolvedValue(undefined),
    loadModelsForProvider: vi.fn().mockResolvedValue(provider.models), getCachedModels: vi.fn(), getCachedModelProbe: vi.fn(),
  };
  vi.mocked(useProviderModelCatalog).mockImplementation(() => catalog);
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.clearAllMocks(); });

describe("cockpit provider catalog", () => {
  it("opens native provider management without reloading the document", async () => {
    window.history.replaceState(null, "", "/settings/models?shell=cockpit#provider-catalog");
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    await render();
    const link = [...container.querySelectorAll("a")].find((item) => item.textContent === "Manage provider credentials and endpoints")!;
    expect(link.getAttribute("href")).toBe("/settings/models?shell=cockpit#providers");
    await act(async () => { link.click(); });
    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/settings/models?shell=cockpit#providers");
    expect(assign).not.toHaveBeenCalled();
    expect(catalog.loadModelsForProvider).not.toHaveBeenCalled();
    assign.mockRestore();
  });
  it("offers read-only connection details for the inspected provider without reading credentials up front", async () => {
    await render();
    const details = container.querySelector("details")!;
    expect(details.querySelector("summary")?.textContent).toBe("Connection details");
    expect(details.open).toBe(false);
  });
  it("keeps the saved model visible when a fresh catalog no longer lists it", async () => {
    catalog.providers = [{ ...provider, models: ["available-model"] }];
    await render();
    expect(container.textContent).toContain("Saved Chat default: Provider A / saved-model");
    expect(container.textContent).toContain("Saved model: saved-model");
    expect(container.textContent).toContain("absent from the live catalog");
    expect(container.textContent).toContain("available-model");
    expect(container.textContent).not.toContain("not-for-display");
    expect(container.querySelector("select")?.value).toBe("provider-a");
    expect(catalog.loadModelsForProvider).not.toHaveBeenCalled();
  });

  it("labels a retained catalog as unverified and preserves a missing saved model", async () => {
    catalog.providers = [{ ...provider, models: ["available-model"], modelProbeState: "fallback", modelRefreshStatus: "stale", modelProbeWarning: "Provider is offline" }];
    await render();
    expect(container.textContent).toContain("Last known catalog");
    expect(container.textContent).toContain("not been verified by a current request");
    expect(container.textContent).toContain("Provider is offline");
    expect(container.textContent).toContain("Saved model: saved-model");
    expect(container.textContent).not.toContain("absent from the live catalog");
  });

  it("refreshes only the selected provider and keeps the saved route unchanged", async () => {
    catalog.providers.push({ ...provider, providerId: "provider-b", label: "Provider B", models: ["other-model"] });
    await render();
    await act(async () => {
      const select = container.querySelector("select")!;
      select.value = "provider-b"; select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button("Refresh models").click());
    expect(catalog.loadModelsForProvider).toHaveBeenCalledExactlyOnceWith("provider-b", { force: true });
    expect(container.textContent).toContain("Saved Chat default: Provider A / saved-model");
    expect(container.textContent).toContain("other-model");
  });

  it("does not treat a refresh that returns fallback data as a successful live check", async () => {
    vi.mocked(catalog.loadModelsForProvider).mockImplementation(async () => {
      catalog.providers = [{ ...provider, modelProbeState: "fallback", modelProbeSource: "error_fallback", modelRefreshStatus: "fresh", modelProbeWarning: "Live discovery failed" }];
      return ["saved-model"];
    });
    await render();
    await act(async () => button("Refresh models").click());
    expect(container.textContent).toContain("Suggested models");
    expect(container.textContent).toContain("Live discovery failed");
    expect(container.textContent).not.toContain("Live catalog");
  });

  it("blocks overlapping model checks and exposes a request rejection", async () => {
    let reject!: (reason: Error) => void;
    vi.mocked(catalog.loadModelsForProvider).mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    await render();
    await act(async () => { button("Refresh models").click(); button("Refresh models").click(); });
    expect(catalog.loadModelsForProvider).toHaveBeenCalledTimes(1);
    expect(button("Refresh models").disabled).toBe(true);
    expect(container.querySelector("select")?.disabled).toBe(true);
    await act(async () => reject(new Error("Gateway unavailable")));
    expect(container.textContent).toContain("Refresh could not complete");
    expect(button("Refresh models").disabled).toBe(false);
  });

  it("withholds cached provider controls when the owner refresh fails", async () => {
    catalog.error = "Owner request failed";
    await render();
    expect(container.textContent).toContain("Provider settings unavailable");
    expect(container.textContent).not.toContain("Saved Chat default");
    expect(container.querySelector("select")).toBeNull();
    await act(async () => button("Refresh providers").click());
    expect(catalog.reload).toHaveBeenCalledTimes(1);
  });

  it("bounds large catalogs and searches across every page", async () => {
    catalog.providers = [{ ...provider, models: Array.from({ length: 85 }, (_, index) => `model-${String(index).padStart(2, "0")}`) }];
    await render();
    expect(container.querySelectorAll('ul[aria-label="Discovered models"] li')).toHaveLength(40);
    expect(container.textContent).toContain("1–40 of 85 model names");
    await act(async () => button("Next models").click());
    expect(container.textContent).toContain("41–80 of 85 model names");
    await act(async () => {
      const input = container.querySelector("input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "model-84");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelectorAll('ul[aria-label="Discovered models"] li')).toHaveLength(1);
    expect(container.textContent).toContain("1–1 of 1 model names");
    expect(container.textContent).toContain("model-84");
  });

  it("distinguishes an empty live catalog from an unchecked catalog", async () => {
    catalog.providers = [{ ...provider, models: [], modelProbeState: "empty" }];
    await render();
    expect(container.textContent).toContain("The live catalog returned no models");
    catalog.providers = [{ ...provider, models: [], modelProbeState: "not_checked", modelProbeSource: undefined, modelRefreshStatus: "not_checked" }];
    await render();
    expect(container.textContent).toContain("Catalog not checked");
    expect(container.textContent).not.toContain("The live catalog returned no models");
  });
});
