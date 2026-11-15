// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibraryAgentsWorkspace } from "./LibraryAgentsWorkspace";

const route = vi.hoisted(() => ({
  search: "",
  requestTransition: undefined as unknown as (run: (review: unknown) => void) => void,
}));
let rerender: () => Promise<void>;
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => route }));
vi.mock("../../../features/native-routes/projects/use-project-access", () => ({
  useProjectAccess: () => ({ identity: "one" }),
}));
vi.mock("@goatcitadel/mission-control-shared/api/operators-agents-files", () => ({
  fetchAgents: async () => ({
    items: [
      {
        agentId: "builtin-qa",
        name: "QA Goat",
        title: "QA",
        roleId: "qa",
        summary: "",
        lifecycleStatus: "active",
        isBuiltin: true,
        sessionCount: 0,
      },
    ],
  }),
}));
vi.mock("./LibraryAgentEditor", () => ({
  LibraryAgentEditor: ({ agentId }: { agentId?: string }) => (
    <section aria-label="Agent profile editor">
      <h2 tabIndex={-1}>{agentId}</h2>
    </section>
  ),
}));
vi.mock("./LibraryImportedAgents", () => ({ LibraryImportedAgents: () => null }));

let root: Root, host: HTMLDivElement, client: QueryClient, scroll: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scroll = vi.fn();
  HTMLElement.prototype.scrollIntoView = scroll as unknown as typeof HTMLElement.prototype.scrollIntoView;
  route.search = "";
  route.requestTransition = (run) =>
    run({
      isCurrent: () => true,
      navigate: (href: string) => {
        route.search = new URL(href, "http://x").search;
        void rerender();
      },
    });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  rerender = async () =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <LibraryAgentsWorkspace workspaceId="one" />
        </QueryClientProvider>,
      ),
    );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});

it("focuses the opened profile's heading after an Open click", async () => {
  await rerender();
  const open = await vi.waitFor(() => {
    const found = [...host.querySelectorAll("button")].find((button) => button.textContent === "Open QA Goat");
    if (!found) throw new Error("not loaded");
    return found;
  });
  await act(async () => open.click());
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("builtin-qa"));
  expect(scroll).toHaveBeenCalled();
});

it("leaves focus alone when the profile arrives by address", async () => {
  route.search = "?agentId=builtin-qa";
  await rerender();
  await vi.waitFor(() =>
    expect(host.querySelector('[aria-label="Agent profile editor"] h2')?.textContent).toBe("builtin-qa"),
  );
  expect(document.activeElement?.textContent).not.toBe("builtin-qa");
  expect(scroll).not.toHaveBeenCalled();
});
