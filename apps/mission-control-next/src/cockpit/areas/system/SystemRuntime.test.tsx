// @vitest-environment happy-dom
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGatewayCallerScope, setGatewayCallerScope } from "@goatcitadel/mission-control-shared/api/access-scope";
import type { NativeRoutePagesProps } from "../../../features/native-routes/types";
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
  props: null as NativeRoutePagesProps | null,
  departed: vi.fn(),
  workspaces: vi.fn(),
  workerError: false,
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
vi.mock("../../../features/native-routes/ops/RuntimeRoutePage", () => ({
  RuntimeRoutePage: (props: NativeRoutePagesProps) => {
    fixture.props = props;
    const [expanded, setExpanded] = useState(false);
    useEffect(() => () => fixture.departed(props.activeWorkspaceId), [props.activeWorkspaceId]);
    return (
      <button type="button" onClick={() => setExpanded(true)}>
        {expanded ? "Current owner details open" : "Existing runtime control owner"}
      </button>
    );
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
vi.mock("../../../features/native-routes/ops/RemoteWorkersRoutePage", () => ({
  RemoteWorkersRoutePage: (
    props: import("../../../features/native-routes/ops/RemoteWorkersRoutePage").RemoteWorkersRoutePageProps,
  ) => {
    fixture.props = props;
    useEffect(() => () => fixture.departed(props.activeWorkspaceId), [props.activeWorkspaceId]);
    return fixture.workerError ? (
      <p role="alert">Could not load workers</p>
    ) : (
      <p>Existing worker and budget control owner</p>
    );
  },
}));
let host: HTMLDivElement, root: Root, client: QueryClient, previousCaller: string;
function render(section: "runtime" | "costs" | "workers" = "costs") {
  root.render(
    <QueryClientProvider client={client}>
      <SystemRuntime section={section} />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  fixture.props = null;
  fixture.workerError = false;
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
it.each(["costs"] as const)(
  "delegates %s to the original control owner with active authority and requested record context",
  (section) => {
    act(() => render(section));
    expect(fixture.props).toEqual(
      expect.objectContaining({
        activeWorkspaceId: "workspace-a",
        activeWorkspaceName: "Aurora",
        activeCitadelId: "citadel-a",
        route: expect.objectContaining({ area: "ops", section, sessionId: "s/1", runId: "r/1" }),
      }),
    );
    expect(host.textContent).toContain("Existing runtime control owner");
  },
);
it("preserves query and fragment while internal runtime navigation uses the shared native resolver", () => {
  act(() => render());
  fixture.props!.navigate({ area: "ops", section: "diagnostics", theme: "ops" }, { replace: true });
  const [href, options] = fixture.navigate.mock.calls[0]!,
    target = new URL(href, "http://cockpit.invalid");
  expect(target.pathname).toBe("/system/diagnostics");
  expect(target.searchParams.get("workspaceId")).toBe("workspace-a");
  expect(target.searchParams.get("citadelId")).toBe("citadel-a");
  expect(target.searchParams.get("sessionId")).toBe("s/1");
  expect(target.searchParams.get("runId")).toBe("r/1");
  expect(target.searchParams.get("keep")).toBe("yes");
  expect(target.searchParams.has("shell")).toBe(false);
  expect(target.searchParams.has("shellScope")).toBe(false);
  expect(target.hash).toBe("#ops-runtime-backups");
  expect(options).toEqual({ replace: true });
});
it("preserves the exact selected run and session when the existing owner opens native session evidence", () => {
  act(() => render());
  fixture.props!.navigate({
    area: "ops",
    section: "sessions",
    theme: "ops",
    runId: "canonical/run",
    sessionId: "canonical/session",
  });
  const target = new URL(fixture.navigate.mock.calls[0]![0], "http://cockpit.invalid");
  expect(target.pathname).toBe("/system/sessions");
  expect(target.searchParams.get("runId")).toBe("canonical/run");
  expect(target.searchParams.get("sessionId")).toBe("canonical/session");
  expect(target.searchParams.get("workspaceId")).toBe("workspace-a");
  expect(target.searchParams.get("citadelId")).toBe("citadel-a");
  expect(target.searchParams.get("keep")).toBe("yes");
  expect(target.hash).toBe("#ops-runtime-backups");
});
it("withdraws the old runtime owner on caller/access scope departure and retains current controls", () => {
  act(() => render());
  act(() => host.querySelector("button")!.click());
  expect(host.textContent).toContain("Current owner details open");
  fixture.identity = "owner-after-access-change";
  act(() => render());
  expect(fixture.departed).toHaveBeenCalledWith("workspace-a");
  expect(host.textContent).toContain("Existing runtime control owner");
  fixture.workspaceId = "workspace-b";
  fixture.identity = "owner-b";
  act(() => render());
  expect(fixture.props!.activeWorkspaceId).toBe("workspace-b");
});
it("announces an unsupported owner without switching shell or dispatching a navigation", () => {
  act(() => render());
  act(() => fixture.props!.navigate({ area: "ops", section: "unsupported", theme: "ops" } as never));
  expect(fixture.navigate).not.toHaveBeenCalled();
  expect(host.querySelector('[role="status"]')?.textContent).toContain("unavailable in Cockpit");
  expect(host.textContent).toContain("Existing runtime control owner");
});
it("rejects a departed runtime navigation callback before touching the current dirty/history owner", () => {
  act(() => render());
  const departedNavigate = fixture.props!.navigate;
  fixture.identity = "owner-after-caller-change";
  act(() => render());
  act(() => departedNavigate({ area: "ops", section: "diagnostics", theme: "ops" }));
  expect(fixture.navigate).not.toHaveBeenCalled();
  expect(host.querySelector('[role="status"]')).toBeNull();
  act(() => fixture.props!.navigate({ area: "ops", section: "diagnostics", theme: "ops" }));
  expect(fixture.navigate).toHaveBeenCalledOnce();
});
it("rejects an original caller callback even when a same-batch caller departure returns to its original name", () => {
  act(() => render());
  const departedNavigate = fixture.props!.navigate;
  act(() => {
    setGatewayCallerScope("runtime-caller-b");
    setGatewayCallerScope("runtime-caller-a");
    departedNavigate({ area: "ops", section: "diagnostics", theme: "ops" });
  });
  expect(fixture.navigate).not.toHaveBeenCalled();
  expect(host.querySelector('[role="status"]')).toBeNull();
  act(() => fixture.props!.navigate({ area: "ops", section: "diagnostics", theme: "ops" }));
  expect(fixture.navigate).toHaveBeenCalledOnce();
});
it("reuses the existing current-Citadel workspace-name cache without another directory read", () => {
  act(() => render());
  expect(fixture.props!.activeWorkspaceName).toBe("Aurora");
  expect(fixture.workspaces).not.toHaveBeenCalled();
  fixture.citadelId = "citadel-b";
  client.setQueryData(queryKeys.workspaces("citadel-b"), {
    items: [{ workspaceId: "workspace-b", name: "Other Citadel" }],
  });
  act(() => render());
  expect(fixture.props!.activeWorkspaceName).toBe("Current workspace");
  expect(fixture.props!.activeWorkspaceName).not.toBe(fixture.workspaceId);
  expect(fixture.workspaces).not.toHaveBeenCalled();
});
it("reads an uncached workspace name through the existing bounded current-Citadel directory owner", async () => {
  fixture.citadelId = "citadel-new";
  fixture.workspaces.mockResolvedValue({ items: [{ workspaceId: "workspace-a", name: "Current Citadel name" }] });
  await act(async () => render());
  await vi.waitFor(() => expect(fixture.props!.activeWorkspaceName).toBe("Current Citadel name"));
  expect(fixture.workspaces).toHaveBeenCalledExactlyOnceWith("active", 200, "citadel-new");
});

it("mounts the full worker/budget owner with exact bookmarked worker and assignment under current authority", async () => {
  fixture.search += "&workerId=worker%2Fone&assignmentId=assignment%3Aone";
  await act(async () => {
    render("workers");
    await vi.dynamicImportSettled();
  });
  await vi.waitFor(() => expect(host.textContent).toContain("Existing worker and budget control owner"));
  expect(fixture.props).toMatchObject({
    activeWorkspaceId: "workspace-a",
    activeCitadelId: "citadel-a",
    initialWorkerId: "worker/one",
    initialAssignmentId: "assignment:one",
    route: { area: "ops", section: "workers", sessionId: "s/1", runId: "r/1" },
  });
  const departedNavigate = fixture.props!.navigate;
  act(() => {
    setGatewayCallerScope("runtime-caller-b");
    setGatewayCallerScope("runtime-caller-a");
    departedNavigate({ area: "ops", section: "workers", theme: "ops" });
  });
  expect(fixture.navigate).not.toHaveBeenCalled();
  act(() => fixture.props!.navigate({ area: "ops", section: "workers", theme: "ops" }));
  const target = new URL(fixture.navigate.mock.calls[0]![0], "http://cockpit.invalid");
  expect(target.pathname).toBe("/system/runtime/workers");
  expect(target.searchParams.get("workerId")).toBe("worker/one");
  expect(target.searchParams.get("assignmentId")).toBe("assignment:one");
  expect(target.searchParams.get("workspaceId")).toBe("workspace-a");
  expect(target.searchParams.get("citadelId")).toBe("citadel-a");
  expect(target.hash).toBe("#ops-runtime-backups");
  expect(fixture.departed).toHaveBeenCalledWith("workspace-a");
});
it.each(["?workerId=", "?workerId=a&workerId=b", "?assignmentId=a", "?workerId=a&assignmentId=x&assignmentId=y"])(
  "withholds worker owner reads for ambiguous native selection %s",
  async (search) => {
    fixture.search =
      search + "&workspaceId=requested&citadelId=carried&sessionId=s%2F1&runId=r%2F1&keep=one&keep=two&shell=cockpit";
    await act(async () => {
      render("workers");
      await vi.dynamicImportSettled();
    });
    expect(fixture.props).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("does not identify one worker");
    const recovery = host.querySelector<HTMLAnchorElement>("a")!;
    expect(recovery.textContent).toBe("Open worker records");
    const target = new URL(recovery.href);
    expect(target.pathname).toBe("/system/runtime/workers");
    expect(target.searchParams.has("workerId")).toBe(false);
    expect(target.searchParams.has("assignmentId")).toBe(false);
    expect(target.searchParams.get("workspaceId")).toBe("requested");
    expect(target.searchParams.get("citadelId")).toBe("carried");
    expect(target.searchParams.get("sessionId")).toBe("s/1");
    expect(target.searchParams.get("runId")).toBe("r/1");
    expect(target.searchParams.getAll("keep")).toEqual(["one", "two"]);
    expect(target.hash).toBe("#ops-runtime-backups");
    expect(target.searchParams.get("shell")).toBe("cockpit");
    expect(fixture.workspaces).not.toHaveBeenCalled();
    expect(fixture.navigate).not.toHaveBeenCalled();
  },
);
it("renders the embedded spend details page inside the cockpit column", () => {
  act(() => render());
  const owner = [...host.querySelectorAll("button")].find((b) => b.textContent === "Existing runtime control owner");
  expect(owner?.closest(".cockpit-embedded-classic")).not.toBeNull();
});
it("keeps the column when the embedded worker page renders its load error", () => {
  fixture.search = "?workerId=w1&assignmentId=a1";
  fixture.workerError = true;
  act(() => render("workers"));
  const alert = host.querySelector("[role=alert]");
  expect(alert?.textContent).toBe("Could not load workers");
  expect(alert?.closest(".cockpit-embedded-classic")?.className).toContain("max-w-5xl");
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
