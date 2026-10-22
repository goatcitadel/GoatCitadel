// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpendObservedModels } from "./SpendObservedModels";

const api = vi.hoisted(() => ({ fetchLlmModels: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/platform", () => ({ fetchLlmModels: api.fetchLlmModels }));

let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  vi.resetAllMocks();
});
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <SpendObservedModels providerKey="alpha" models={["model-a", "model-b"]} />
      </QueryClientProvider>,
    ),
  );
}

describe("Spend observed models (VR-04)", () => {
  it("names models from the catalog and calls an unlabelled one Unnamed model", async () => {
    api.fetchLlmModels.mockResolvedValue({ items: [{ id: "model-a", label: "Model A" }, { id: "model-b" }] });
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Models observed: Model A, Unnamed model"));
  });

  it("says names are loading instead of calling every model unnamed while the catalog loads", async () => {
    api.fetchLlmModels.mockReturnValue(new Promise(() => undefined));
    await render();
    expect(container.textContent).toContain("Models observed: 2 models, names loading");
    expect(container.textContent).not.toContain("Unnamed model");
  });

  it("says names are unavailable when the catalog can't be read", async () => {
    api.fetchLlmModels.mockRejectedValue(new Error("offline"));
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Models observed: 2 models, names unavailable"));
    expect(container.textContent).not.toContain("Unnamed model");
  });
});
