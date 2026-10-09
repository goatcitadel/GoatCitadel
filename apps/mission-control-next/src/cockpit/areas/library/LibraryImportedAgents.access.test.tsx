// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibraryImportedAgents } from "./LibraryImportedAgents";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { notifyGatewayAccessChanged } from "@goatcitadel/mission-control-shared/api/access-scope";
const api = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), patch: vi.fn(), import: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/agent-catalog", () => ({
  fetchImportedAgentCatalog: api.list,
  fetchImportedAgentCatalogEntry: api.read,
  patchImportedAgentCatalogState: api.patch,
  importAgencyAgentCatalog: api.import,
}));
const entry = {
  entryId: "entry",
  workspaceId: "one",
  state: "disabled",
  division: "QA",
  definition: {
    frontmatter: { name: "Owned agent", description: "Local fixture" },
    parseStatus: "supported",
    parseWarnings: [],
    provenance: { provider: "agency", path: "fixture.md", sha256: "hash" },
  },
};
let root: Root, host: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  __resetSessionDraftsForTests();
  window.history.replaceState({}, "", "/library/agents?view=catalog&entryId=entry");
  api.list.mockResolvedValue({ items: [entry], workspaceId: "one" });
  api.read.mockResolvedValue(entry);
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
async function render(show = true) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          {show ? <LibraryImportedAgents workspaceId="one" /> : null}
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    ),
  );
}
async function click(name: string) {
  const button = [...document.querySelectorAll("button")].find(
    (item) => !item.closest('[aria-hidden="true"]') && item.textContent === name,
  )!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
}
it("refuses lifecycle PATCH when access changes during the fresh owner read", async () => {
  await render();
  await vi.waitFor(() => expect(host.textContent).toContain("Review active"));
  await click("Review active");
  api.read.mockImplementationOnce(async () => {
    notifyGatewayAccessChanged();
    return entry;
  });
  await click("Confirm catalog request");
  expect(api.patch).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it("retains import input across unmount and governs Inspect as a dirty transition", async () => {
  await render();
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "C:/owned/catalog");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await render(false);
  await render();
  expect((host.querySelector("input") as HTMLInputElement).value).toBe("C:/owned/catalog");
  await click("Inspect Owned agent");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Unsaved");
  expect(api.import).not.toHaveBeenCalled();
});
