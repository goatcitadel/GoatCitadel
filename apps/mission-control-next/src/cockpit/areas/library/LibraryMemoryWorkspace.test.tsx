// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
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
vi.mock("./LibraryMemoryEditor", () => ({
  LibraryMemoryEditor: ({ itemId }: { itemId: string }) => <p>editor {itemId}</p>,
}));
vi.mock("../../ui/Sheet", () => ({
  Sheet: ({
    open,
    title,
    closeLabel,
    onOpenChange,
    children,
  }: {
    open: boolean;
    title: string;
    closeLabel: string;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
  }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        <button type="button" onClick={() => onOpenChange(false)}>
          {closeLabel}
        </button>
        {children}
      </div>
    ) : null,
}));

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

it("filters status and namespace on the server and opens an item in a closable sheet (LB-12)", async () => {
  const memory = (itemId: string, namespace: string) => ({
    kind: "memory",
    item: {
      itemId,
      title: `Memory ${itemId}`,
      namespace,
      workspaceId: "one",
      metadata: {},
      lifecycleState: "active",
      status: "active",
    },
  });
  api.load.mockResolvedValue({ items: [memory("a", "facts"), memory("b", "custom_ns")], coverage: "2 records" });
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("Memory a"));
  expect(container.textContent).not.toContain("on this page");
  const labelled = (label: string) =>
    document.getElementById(
      [...container.querySelectorAll("label")].find((item) => item.textContent === label)!.htmlFor,
    ) as HTMLSelectElement;
  const namespace = labelled("Memory namespace");
  expect([...namespace.options].map((option) => option.value)).toEqual(
    expect.arrayContaining(["", "facts", "custom_ns"]),
  );
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(namespace, "facts");
    namespace.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await vi.waitFor(() =>
    expect(api.load).toHaveBeenLastCalledWith(expect.objectContaining({ namespace: "facts", status: "active" })),
  );
  await vi.waitFor(() => expect(button("Open Memory a")).toBeDefined());
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => button("Open Memory a")!.click());
  await vi.waitFor(() => expect(container.querySelector('[role="dialog"]')?.textContent).toContain("editor a"));
  expect(window.location.search).toContain("itemId=a");
  await act(async () => button("Close memory item")!.click());
  await vi.waitFor(() => expect(container.querySelector('[role="dialog"]')).toBeNull());
  expect(window.location.search).not.toContain("itemId");
});
