// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibraryImportedAgents } from "./LibraryImportedAgents";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";

const api = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), patch: vi.fn(), import: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/agent-catalog", () => ({
  fetchImportedAgentCatalog: api.list,
  fetchImportedAgentCatalogEntry: api.read,
  patchImportedAgentCatalogState: api.patch,
  importAgencyAgentCatalog: api.import,
}));
let root: Root, host: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  __resetSessionDraftsForTests();
  window.history.replaceState({}, "", "/library/agents?view=catalog");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <LibraryImportedAgents workspaceId="one" />
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    ),
  );
}
it("says the catalog is empty and hides the search box (U-LB-014)", async () => {
  api.list.mockResolvedValue({ items: [], workspaceId: "one" });
  await render();
  await vi.waitFor(() => expect(host.textContent).toContain("No imported agents"));
  expect(host.textContent).toContain("Open Import agent catalog to bring some in.");
  expect(host.textContent).not.toContain("Search imported agents");
});
it("shows the error and no empty state when the read failed (U-LB-014)", async () => {
  api.list.mockRejectedValue(new Error("boom"));
  await render();
  await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).toBeTruthy());
  expect(host.textContent).not.toContain("No imported agents");
});
