// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { LibraryMemoryWorkspace } from "./LibraryMemoryWorkspace";

const api = vi.hoisted(() => ({ load: vi.fn(), workspaces: vi.fn() }));
vi.mock("./library-resources", async (original) => ({
  ...(await original<typeof import("./library-resources")>()),
  loadLibraryResources: api.load,
}));
vi.mock("@goatcitadel/mission-control-shared/api/workspaces", async (original) => ({
  ...(await original<object>()),
  fetchWorkspaces: api.workspaces,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", async (original) => {
  const actual = await original<typeof import("@goatcitadel/mission-control-shared/state/ui-preferences")>();
  return { ...actual, useUiPreferences: () => ({ ...actual.useUiPreferences(), showTechnicalDetails: true }) };
});
vi.mock("./LibraryMemoryProposals", () => ({
  LibraryMemoryProposals: (props: { hideWhenEmpty?: boolean }) => (
    <p>{props.hideWhenEmpty ? "proposals hidden when empty" : "proposals always"}</p>
  ),
}));
vi.mock("./LibraryMemoryBatch", () => ({ LibraryMemoryBatch: () => <p>bulk actions</p> }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({
  ...(await original<object>()),
  fetchSettings: async () => ({ features: {} }),
}));

let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  api.workspaces.mockResolvedValue({ items: [{ workspaceId: "one", name: "Studio" }] });
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
const memory = (itemId: string, workspaceId?: string) => ({
  kind: "memory",
  item: {
    itemId,
    title: `Memory ${itemId}`,
    namespace: "facts",
    workspaceId,
    metadata: {},
    lifecycleState: "active",
    status: "active",
  },
});

it("names the workspace a memory belongs to in plain words", async () => {
  api.load.mockResolvedValue({
    items: [memory("a", "one"), memory("b"), memory("c", "global")],
    coverage: "3 records",
  });
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("Belongs to Studio"));
  const lines = [...container.querySelectorAll("li p.text-sm")].map((item) => item.textContent);
  expect(lines[1]).toContain("Shared across workspaces");
  expect(lines[2]).toContain("Shared across workspaces");
  const details = [...container.querySelectorAll("details")];
  expect(details[0]!.textContent).toContain("Owner: one");
  expect(container.querySelector("li p.text-sm")!.textContent).not.toContain("one");
});

it("keeps one quiet way to diagnostics inside the empty state and asks the proposals to hide", async () => {
  api.load.mockResolvedValue({ items: [], coverage: "0 matching records" });
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("No active memories"));
  const openers = [...container.querySelectorAll("button")].filter(
    (item) => item.textContent === "Open memory diagnostics and maintenance",
  );
  expect(openers).toHaveLength(1);
  expect(openers[0]!.closest("section")?.querySelector("h2")?.textContent).toBe("No active memories");
  expect(container.textContent).not.toContain("promote a proposal below");
  expect(container.textContent).toContain("proposals hidden when empty");
});

it("keeps diagnostics and the proposals section while the list is loading", async () => {
  api.load.mockReturnValue(new Promise(() => {}));
  await render();
  expect(container.textContent).toContain("Open memory diagnostics and maintenance");
  expect(container.textContent).toContain("proposals always");
});

it("keeps diagnostics and the proposals section after a failed read", async () => {
  api.load.mockRejectedValue(new Error("Gateway exploded"));
  await render();
  await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
  expect(container.textContent).toContain("Open memory diagnostics and maintenance");
  expect(container.textContent).toContain("proposals always");
});

it("keeps diagnostics when there is a memory", async () => {
  api.load.mockResolvedValue({ items: [memory("a", "one")], coverage: "1 record" });
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("Memory a"));
  expect(container.textContent).toContain("Open memory diagnostics and maintenance");
  expect(container.textContent).toContain("proposals always");
});

it("keeps diagnostics when a filtered list has no results", async () => {
  api.load.mockResolvedValue({ items: [], coverage: "0 matching records" });
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("No active memories"));
  await act(async () =>
    [...container.querySelectorAll("button")].find((item) => item.textContent === "Show all statuses")!.click(),
  );
  await vi.waitFor(() => expect(container.querySelector("form")).not.toBeNull());
  expect(container.textContent).not.toContain("No active memories");
  const openers = [...container.querySelectorAll("button")].filter(
    (item) => item.textContent === "Open memory diagnostics and maintenance",
  );
  expect(openers).toHaveLength(1);
  expect(container.textContent).toContain("proposals always");
});
