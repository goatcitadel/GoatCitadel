// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGatewayCallerScope, setGatewayCallerScope } from "@goatcitadel/mission-control-shared/api/access-scope";
import { queryKeys } from "../../data/query-keys";
import { SystemRuntime } from "./SystemRuntime";
import { runtimeData } from "./runtime-page.test-data";

const fixture = vi.hoisted(() => ({
  search: "",
  hash: "",
  workspaceId: "workspace-a",
  citadelId: "citadel-a",
  identity: "owner-a",
  navigate: vi.fn(),
  workspaces: vi.fn(),
}));
vi.mock("../../app/use-cockpit-route", () => ({
  useCockpitRoute: () => ({ search: fixture.search, hash: fixture.hash, navigate: fixture.navigate }),
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({
    activeWorkspaceId: fixture.workspaceId,
    activeCitadelId: fixture.citadelId,
    setActiveWorkspaceId: vi.fn(),
  }),
}));
vi.mock("@goatcitadel/mission-control-shared/api/workspaces", () => ({ fetchWorkspaces: fixture.workspaces }));
vi.mock("@goatcitadel/mission-control-shared/hooks/use-current-access", () => ({
  useProjectAccess: (scope: string) => {
    const identity = fixture.identity,
      workspace = fixture.workspaceId,
      citadel = fixture.citadelId;
    return {
      identity: JSON.stringify([identity, scope]),
      current: () =>
        fixture.identity === identity && fixture.workspaceId === workspace && fixture.citadelId === citadel,
    };
  },
}));
const snapshot = vi.hoisted(() => ({ value: null as unknown, runDaemonAction: vi.fn(async () => undefined) }));
vi.mock("@goatcitadel/mission-control-shared/hooks/useOpsRuntimeSnapshot", () => ({
  useOpsRuntimeSnapshot: () => snapshot.value,
}));
vi.mock("../../data/use-operator-inbox", () => ({ useOperatorInbox: () => ({ data: undefined, isError: false }) }));
vi.mock("../../data/use-model-label", () => ({ useProviderLabelLookup: () => () => undefined }));
vi.mock("./HealthBackupAction", () => ({ HealthBackupAction: () => null }));
vi.mock("../../ui/Dialog", () => ({
  Dialog: ({ open, title, children }: { open: boolean; title: string; children: React.ReactNode }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        {children}
      </div>
    ) : null,
}));
let host: HTMLDivElement, root: Root, client: QueryClient, previousCaller: string;
function render(_section: "runtime" = "runtime") {
  root.render(
    <QueryClientProvider client={client}>
      <SystemRuntime />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  fixture.identity = "owner-a";
  fixture.workspaceId = "workspace-a";
  fixture.citadelId = "citadel-a";
  fixture.search =
    "?workspaceId=requested&citadelId=carried&sessionId=s%2F1&runId=r%2F1&keep=yes&shell=cockpit&shellScope=visit";
  fixture.hash = "#ops-runtime-backups";
  fixture.workspaces.mockResolvedValue({ items: [] });
  previousCaller = getGatewayCallerScope();
  setGatewayCallerScope("runtime-caller-a");
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.workspaces("citadel-a"), { items: [{ workspaceId: "workspace-a", name: "Aurora" }] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  client.clear();
  setGatewayCallerScope(previousCaller);
});
describe("native Runtime page", () => {
  const ready = (failed: Parameters<typeof runtimeData>[1] = []) => {
    snapshot.value = {
      data: runtimeData({}, failed),
      loading: false,
      error: null,
      notice: null,
      daemonBusy: null,
      lastFetchedAt: Date.parse("2026-10-23T08:00:00Z"),
      isStale: false,
      reload: vi.fn(async () => undefined),
      runDaemonAction: snapshot.runDaemonAction,
    };
  };
  beforeEach(() => {
    fixture.hash = "";
    ready();
  });

  it("renders no Classic page and leads with the Runtime heading", () => {
    act(() => render("runtime"));
    expect(host.querySelector(".cockpit-embedded-classic")).toBeNull();
    expect(host.textContent).not.toContain("Existing runtime control owner");
    expect(host.querySelector("h1")?.textContent).toBe("Runtime");
    expect([...host.querySelectorAll("h2")].map((node) => node.textContent)).toEqual([
      "GoatCitadel server",
      "Backups",
      "Local model runtime",
      "Integrations",
      "Runtime records and capabilities",
      "Model performance",
    ]);
  });

  it("names unavailable sources and never reads a failed server as running", () => {
    ready(["daemon", "health"]);
    act(() => render("runtime"));
    expect(host.querySelector("summary")?.textContent).toBe("2 runtime sources are unavailable");
    const server = [...host.querySelectorAll("section")].find(
      (node) => node.querySelector("h2")?.textContent === "GoatCitadel server",
    )!;
    expect(server.textContent).toContain("Unknown");
    expect(server.textContent).not.toContain("Running");
  });

  it("closes an open stop confirmation without stopping when access changes", async () => {
    act(() => render("runtime"));
    const stop = [...host.querySelectorAll("button")].find((node) => node.textContent === "Stop server")!;
    await act(async () => stop.click());
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    fixture.identity = "owner-after-access-change";
    act(() => render("runtime"));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(snapshot.runDaemonAction).not.toHaveBeenCalled();
  });

  it("gives Refresh an accessible name that starts with its visible text", () => {
    act(() => render("runtime"));
    const refresh = [...host.querySelectorAll("button")].find((node) =>
      node.textContent?.trim().startsWith("Refresh"),
    )!;
    expect(refresh.textContent?.trim()).toBe("Refresh runtime");
  });
});
