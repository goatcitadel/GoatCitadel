// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchObserveRunTrace } from "@goatcitadel/mission-control-shared/api/durable";
import { WorkArea } from "./WorkArea";

vi.mock("./WorkWaitingDecisions", () => ({ WorkWaitingDecisions: () => null }));
vi.mock("@goatcitadel/mission-control-shared/api/durable", () => ({
  fetchObserveRunTrace: vi.fn(), fetchDurableRunHistory: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "workspace-a" }),
}));
vi.mock("../../app/use-cockpit-route", () => ({
  useCockpitRoute: () => ({ rest: ["runs", "foreign-run"], navigate: vi.fn() }),
}));

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.clearAllMocks();
});

describe("Work run detail scope", () => {
  it("withholds a foreign run and its title from a direct link", async () => {
    vi.mocked(fetchObserveRunTrace).mockResolvedValue({
      run: { runId: "foreign-run", payload: { workspaceId: "workspace-b" }, metadata: { objective: "PRIVATE FOREIGN OBJECTIVE" } },
    } as never);
    await act(async () => root.render(<QueryClientProvider client={client}><WorkArea /></QueryClientProvider>));
    await vi.waitFor(() => expect(container.textContent).toContain("Run outside this workspace"));
    expect(container.textContent).not.toContain("PRIVATE FOREIGN OBJECTIVE");
    expect(container.textContent).not.toContain("Run controls");
  });
});
