// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { LibraryMemoryWorkspace } from "./LibraryMemoryWorkspace";

const api = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./library-resources", async (original) => ({
  ...(await original<typeof import("./library-resources")>()),
  loadLibraryResources: api.load,
}));
vi.mock("./LibraryMemoryProposals", () => ({ LibraryMemoryProposals: () => <p>proposals</p> }));
vi.mock("./LibraryMemoryBatch", () => ({ LibraryMemoryBatch: () => <p>bulk actions</p> }));

let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState(null, "", "/library/memory?shell=cockpit");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
});
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <LibraryMemoryWorkspace workspaceId="one" citadelId="personal" />
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    ),
  );
}
const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label);

it("leads an empty memory directory with one empty state and no filters, bulk actions or paging (VR-02)", async () => {
  api.load.mockResolvedValue({ items: [], coverage: "0 matching records" });
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("No active memories"));
  expect(container.querySelector("h1")?.textContent).toBe("Memory");
  expect(container.querySelector('input[type="search"], input:not([type])')).toBeNull();
  expect(container.textContent).not.toContain("bulk actions");
  expect(button("Previous memory page")).toBeUndefined();
  expect(button("Apply memory filter")).toBeUndefined();
  expect(container.textContent).not.toContain("0 matching records");
  expect(button("Refresh memory directory")).toBeDefined();
  expect(container.textContent).toContain("proposals");
  await act(async () => button("Show all statuses")!.click());
  await vi.waitFor(() => expect(api.load).toHaveBeenLastCalledWith(expect.objectContaining({ status: "all" })));
  expect(button("Apply memory filter")).toBeDefined();
});
