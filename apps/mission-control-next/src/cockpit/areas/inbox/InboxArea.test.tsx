// @vitest-environment happy-dom
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { act } from "react";
import { VirtuosoMockContext } from "react-virtuoso";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApprovalRequest, OperatorInboxItem, OperatorInboxResponse } from "@goatcitadel/contracts";
import { UiPreferencesProvider, useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InspectorPanel, InspectorProvider } from "../../app/inspector";
import { InboxArea } from "./InboxArea";
import { __resetInboxViewedUpdatesForTests, isInboxUpdateViewed } from "./inbox-viewed-updates";

const apiMocks = vi.hoisted(() => ({ fetchApproval: vi.fn(), fetchApprovals: vi.fn(), resolveApproval: vi.fn() }));
const switchShellMock = vi.hoisted(() => vi.fn<typeof import("../../../shell-preference").switchShell>());
vi.mock("../../../shell-preference", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shell-preference")>()),
  switchShell: switchShellMock,
}));
const inboxMock = vi.hoisted(() => ({ result: null as unknown, installation: "http://localhost:8787" }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => apiMocks);
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ fetchApproval: apiMocks.fetchApproval }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/client-core")>()),
  getGatewayApiBaseUrl: () => inboxMock.installation,
}));

const approval: ApprovalRequest = {
  approvalId: "test",
  kind: "file.write",
  riskLevel: "danger",
  status: "pending",
  payload: {},
  preview: { targets: ["workspace/file.ts"], commands: ["pnpm test"] },
  createdAt: "2026-09-28T00:00:00Z",
  explanationStatus: "completed",
  explanation: {
    summary: "Review the file write.",
    riskExplanation: "Changes a workspace file.",
    generatedAt: "2026-09-28T00:00:00Z",
  },
  rollbackNote: "Restore the prior version.",
};

const projection: OperatorInboxResponse = {
  authority: "derived_projection",
  workspaceId: "default",
  generatedAt: "2026-09-28T00:00:00Z",
  items: [
    {
      id: "approval:test",
      kind: "approval",
      group: "needs_decision",
      title: "Review file write",
      summary: "An operator decision is required.",
      createdAt: "2026-09-28T00:00:00Z",
      riskLevel: "danger",
      source: { workspaceId: "default", approvalId: "test" },
      href: "/ops/approvals?approvalId=test&shell=classic",
    },
  ],
  coverage: [
    { source: "approvals", state: "current" },
    {
      source: "runtime_health",
      state: "unavailable",
      detail: "Backup checks are not projected yet.",
    },
  ],
  counts: {
    needs_decision: { known: 1, complete: true },
    proposals: { known: 0, complete: true },
    needs_attention: { known: 0, complete: false },
    updates: { known: 0, complete: false },
  },
};

vi.mock("../../data/use-operator-inbox", () => ({
  useOperatorInbox: () => inboxMock.result,
  useCachedInboxItem: () => ({ projection: (inboxMock.result as { data?: unknown })?.data, fingerprint: "cached" }),
}));

let scopePreferences: ReturnType<typeof useUiPreferences>;
function WorkspaceProbe() {
  scopePreferences = useUiPreferences();
  return null;
}
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  // These existing list/keyboard tests exercise the docked desktop layout.
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  switchShellMock.mockReset().mockResolvedValue("cancelled");
  __resetInboxViewedUpdatesForTests();
  inboxMock.installation = "http://localhost:8787";
  window.history.replaceState(null, "", "/inbox");
  inboxMock.result = { data: projection, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };
  apiMocks.fetchApproval.mockReset();
  apiMocks.fetchApprovals.mockReset();
  apiMocks.resolveApproval.mockReset();
  apiMocks.fetchApproval.mockResolvedValue(approval);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

const update: OperatorInboxItem = {
  id: "task_deliverable:delivery-a",
  kind: "task_deliverable",
  group: "updates",
  title: "Viewed report",
  summary: "A file deliverable was recorded.",
  createdAt: "2026-09-28T00:00:00Z",
  source: { workspaceId: "default", taskId: "task-a", deliverableId: "delivery-a" },
  href: "/ops/kanban?shell=classic&taskId=task-a",
};

function updateProjection(item = update): OperatorInboxResponse {
  const data = {
    ...projection,
    items: [item],
    counts: {
      ...projection.counts,
      needs_decision: { known: 0, complete: true },
      updates: { known: 4, complete: false },
    },
  };
  inboxMock.result = { data, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };
  return data;
}

async function renderUpdates(client: QueryClient, panel = true, area = true) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <UiPreferencesProvider>
          <WorkspaceProbe />
          <CockpitNavigationProvider>
            <InspectorProvider>
              <VirtuosoMockContext.Provider value={{ viewportHeight: 350, itemHeight: 140 }}>
                {area ? <InboxArea /> : null}
              </VirtuosoMockContext.Provider>
              {panel ? <InspectorPanel /> : null}
            </InspectorProvider>
          </CockpitNavigationProvider>
        </UiPreferencesProvider>
      </QueryClientProvider>,
    );
  });
}

async function clickButton(label: string) {
  const button = [...container.querySelectorAll("button")].find((entry) => entry.textContent === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => button.click());
}

describe("viewed Updates presentation", () => {
  it("uses the exact guarded owner link for the E shortcut without a decision or reload", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    const client = new QueryClient();
    await renderUpdates(client);
    const link = container.querySelector<HTMLAnchorElement>("a[data-inbox-owner]")!;
    expect(link.getAttribute("href")).toBe(`${projection.items[0]!.href}&shellScope=visit`);
    expect(link.getAttribute("aria-label")).toBe("Open in classic Approvals");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true })));
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true })));
    expect(document.activeElement).toBe(link);
    expect(switchShellMock).not.toHaveBeenCalled();
    await act(async () => {
      link.click();
    });
    expect(switchShellMock).toHaveBeenCalledExactlyOnceWith(
      "classic",
      expect.objectContaining({
        href: `${projection.items[0]!.href}&shellScope=visit`,
        isCurrent: expect.any(Function),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(switchShellMock.mock.calls[0]![1].isCurrent()).toBe(true);
    expect(apiMocks.resolveApproval).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    assign.mockRestore();
    client.clear();
  });
  it("marks only opened Details, preserves Gateway counts, and reversibly shows viewed rows", async () => {
    const data = updateProjection();
    const original = structuredClone(data);
    const client = new QueryClient();
    await renderUpdates(client);
    const persistedBefore = JSON.stringify({ ...window.localStorage });
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true })));
    expect(isInboxUpdateViewed(inboxMock.installation, "default", update)).toBe(false);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true })));
    expect(isInboxUpdateViewed(inboxMock.installation, "default", update)).toBe(false);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "o", bubbles: true })));
    expect(container.querySelector('[aria-label="Inspector: Viewed report"]')).not.toBeNull();
    expect(container.querySelectorAll("[data-inbox-item]")).toHaveLength(0);
    expect(container.querySelector('[aria-label="Updates Gateway count"]')?.textContent).toBe("4+");
    expect(container.textContent).toContain("4 known items; more may be outside this view.");
    expect(container.textContent).toContain("0 unviewed · 1 viewed here from this response");
    await clickButton("Show viewed updates (1)");
    expect(container.querySelectorAll("[data-inbox-item]")).toHaveLength(1);
    await clickButton("Hide viewed updates");
    expect(container.querySelectorAll("[data-inbox-item]")).toHaveLength(0);
    expect(data).toEqual(original);
    expect(JSON.stringify({ ...window.localStorage })).toBe(persistedBefore);
    expect(apiMocks.fetchApproval).not.toHaveBeenCalled();
    expect(apiMocks.resolveApproval).not.toHaveBeenCalled();
  });

  it("does not mark an automatically opened deep link", async () => {
    updateProjection();
    window.history.replaceState(null, "", `/inbox?workspaceId=default&item=${encodeURIComponent(update.id)}`);
    await renderUpdates(new QueryClient());
    expect(container.querySelector('[aria-label="Inspector: Viewed report"]')).not.toBeNull();
    expect(container.querySelectorAll("[data-inbox-item]")).toHaveLength(1);
    expect(isInboxUpdateViewed(inboxMock.installation, "default", update)).toBe(false);
  });

  it("requires the Details body to mount before marking", async () => {
    updateProjection();
    const client = new QueryClient();
    await renderUpdates(client, false);
    await clickButton("Details");
    expect(isInboxUpdateViewed(inboxMock.installation, "default", update)).toBe(false);
    await renderUpdates(client);
    expect(isInboxUpdateViewed(inboxMock.installation, "default", update)).toBe(true);
  });

  it.each(["new version", "refresh", "owner error", "foreign workspace", "installation", "unmount"])(
    "withholds the viewed marker after %s changes before Details mounts",
    async (change) => {
      updateProjection();
      const client = new QueryClient();
      await renderUpdates(client, false);
      await clickButton("Details");
      if (change === "new version") updateProjection({ ...update, summary: "New evidence" });
      if (change === "foreign workspace")
        updateProjection({ ...update, source: { ...update.source, workspaceId: "other" } });
      if (change === "refresh") inboxMock.result = { data: updateProjection(), isFetching: true };
      if (change === "owner error")
        inboxMock.result = { data: updateProjection(), isError: true, error: new Error("Offline") };
      if (change === "installation") inboxMock.installation = "http://localhost:9999";
      await renderUpdates(client, true, change !== "unmount");
      expect(isInboxUpdateViewed("http://localhost:8787", "default", update)).toBe(false);
      expect(isInboxUpdateViewed(inboxMock.installation, "default", update)).toBe(false);
    },
  );

  it("retains the same viewed version across remount but shows changed evidence", async () => {
    updateProjection();
    const client = new QueryClient();
    await renderUpdates(client);
    await clickButton("Details");
    await act(async () => root.render(null));
    await renderUpdates(client);
    expect(container.querySelectorAll("[data-inbox-item]")).toHaveLength(0);
    updateProjection({ ...update, summary: "New evidence", updatedAt: "2026-09-30T00:00:00Z" });
    await renderUpdates(client);
    expect(container.querySelectorAll("[data-inbox-item]")).toHaveLength(1);
    expect(container.textContent).toContain("1 unviewed · 0 viewed here from this response");
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("InboxArea", () => {
  it("shows a calm known-zero state when only defined scope limits and disabled sources remain", async () => {
    inboxMock.result = {
      data: {
        ...projection,
        items: [],
        coverage: [
          { source: "runtime_health", state: "limited", detail: "Other checks remain in System." },
          { source: "memory_proposals", state: "not_enabled", detail: "Memory proposals are turned off in Settings." },
        ],
        counts: {
          needs_decision: { known: 0, complete: true },
          proposals: { known: 0, complete: true },
          needs_attention: { known: 0, complete: false },
          updates: { known: 0, complete: false },
        },
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <UiPreferencesProvider>
            <CockpitNavigationProvider>
              <InspectorProvider>
                <InboxArea />
              </InspectorProvider>
            </CockpitNavigationProvider>
          </UiPreferencesProvider>
        </QueryClientProvider>,
      ),
    );
    expect(container.textContent).toContain("Nothing needs your attention in the checked sources.");
    expect(container.textContent).toContain("What this Inbox covers");
    expect(container.textContent).not.toContain("Coverage is incomplete");
    expect(container.textContent).not.toContain("Count unknown");
    // A declared scope is not a read gap, so the per-group counts read exactly.
    expect(container.querySelector('[aria-label="Needs attention Gateway count"]')?.textContent).toBe("0");
    expect(container.textContent).not.toContain("No known items returned in this group.");
  });

  it("says when sources could not be read instead of claiming an all-clear", async () => {
    inboxMock.result = {
      data: {
        ...projection,
        items: [],
        coverage: [{ source: "dead_letters", state: "unavailable", detail: "Stopped runs could not be read." }],
        counts: {
          needs_decision: { known: 0, complete: true },
          proposals: { known: 0, complete: true },
          needs_attention: { known: 0, complete: false },
          updates: { known: 0, complete: true },
        },
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <UiPreferencesProvider>
            <CockpitNavigationProvider>
              <InspectorProvider>
                <InboxArea />
              </InspectorProvider>
            </CockpitNavigationProvider>
          </UiPreferencesProvider>
        </QueryClientProvider>,
      ),
    );
    expect(container.textContent).toContain("No known items, but some sources could not be read completely.");
    expect(container.textContent).not.toContain("Nothing needs your attention");
    expect(container.textContent).toContain("Coverage is incomplete for 1 source");
    expect(container.querySelector('[aria-label="Needs attention Gateway count"]')?.textContent).toBe("0 known");
  });

  it("opens the exact scoped deep link without deciding or reopening a dismissed inspector", async () => {
    window.history.replaceState(null, "", "/inbox?workspaceId=default&item=approval%3Atest");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <UiPreferencesProvider>
            <CockpitNavigationProvider>
              <InspectorProvider>
                <InboxArea />
                <InspectorPanel />
              </InspectorProvider>
            </CockpitNavigationProvider>
          </UiPreferencesProvider>
        </QueryClientProvider>,
      ),
    );
    expect(container.querySelector('[aria-label="Inspector: Review file write"]')).not.toBeNull();
    expect(apiMocks.resolveApproval).not.toHaveBeenCalled();
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close inspector"]');
    expect(close).not.toBeNull();
    await act(async () => close!.click());
    expect(container.querySelector('[aria-label="Inspector: Review file write"]')).toBeNull();
  });

  it("does not open foreign or unresolved Inbox links", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    window.history.replaceState(null, "", "/inbox?workspaceId=other&item=approval%3Atest");
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <UiPreferencesProvider>
            <CockpitNavigationProvider>
              <InspectorProvider>
                <InboxArea />
                <InspectorPanel />
              </InspectorProvider>
            </CockpitNavigationProvider>
          </UiPreferencesProvider>
        </QueryClientProvider>,
      ),
    );
    expect(container.textContent).toContain("belongs to another workspace");
    expect(apiMocks.fetchApproval).not.toHaveBeenCalled();
    await act(async () => {
      window.history.replaceState(null, "", "/inbox?workspaceId=default&item=missing");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(container.textContent).toContain("no longer in the current Inbox");
    expect(apiMocks.fetchApproval).not.toHaveBeenCalled();
  });

  it("withholds items and counts from a foreign projection", async () => {
    inboxMock.result = {
      data: {
        ...projection,
        items: [{ ...projection.items[0], source: { workspaceId: "other", approvalId: "test" } }],
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <UiPreferencesProvider>
            <CockpitNavigationProvider>
              <InspectorProvider>
                <InboxArea />
              </InspectorProvider>
            </CockpitNavigationProvider>
          </UiPreferencesProvider>
        </QueryClientProvider>,
      ),
    );
    expect(container.textContent).toContain("Inbox scope mismatch");
    expect(container.textContent).not.toContain("Review file write");
    expect(container.textContent).not.toContain("1 known item");
  });

  it("withholds cached items after a failed owner refresh", async () => {
    inboxMock.result = {
      data: projection,
      isLoading: false,
      isError: true,
      error: new Error("Offline"),
      isFetching: false,
      refetch: vi.fn(),
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <UiPreferencesProvider>
            <CockpitNavigationProvider>
              <InspectorProvider>
                <InboxArea />
              </InspectorProvider>
            </CockpitNavigationProvider>
          </UiPreferencesProvider>
        </QueryClientProvider>,
      ),
    );
    expect(container.textContent).toContain("Inbox unavailable");
    expect(container.textContent).not.toContain("Review file write");
  });

  it("shows owner-backed items and incomplete coverage without a false zero", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <UiPreferencesProvider>
            <CockpitNavigationProvider>
              <InspectorProvider>
                <InboxArea />
                <InspectorPanel />
              </InspectorProvider>
            </CockpitNavigationProvider>
          </UiPreferencesProvider>
        </QueryClientProvider>,
      ),
    );
    expect(container.textContent).toContain("1 known item; more may be outside this view");
    expect(container.textContent).toContain("Coverage is incomplete for 1 source");
    expect(container.textContent).toContain("Review file write");
    expect(container.textContent).toContain("No known items returned in this group.");
    const link = container.querySelector('a[href="/ops/approvals?approvalId=test&shell=classic&shellScope=visit"]');
    expect(link?.textContent).toContain("Open in classic Approvals");
    const details = [...container.querySelectorAll("button")].find((button) => button.textContent === "Details");
    if (!details) throw new Error("Missing details control");
    const input = document.createElement("input");
    container.appendChild(input);
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true })));
    expect(document.activeElement).not.toBe(details);
    input.remove();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true })));
    expect(document.activeElement).toBe(details);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "o", bubbles: true })));
    expect(apiMocks.fetchApproval).toHaveBeenCalledWith("test", {
      workspaceId: "default",
      signal: expect.any(AbortSignal),
    });
    expect(apiMocks.fetchApprovals).not.toHaveBeenCalled();
    await act(async () => {
      await apiMocks.fetchApproval.mock.results[0]?.value;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const inspector = container.querySelector('[aria-label="Inspector: Review file write"]');
    expect(inspector?.textContent).toContain("Review the file write.");
    expect(inspector?.textContent).toContain("workspace/file.ts");
    expect(inspector?.textContent).toContain("pnpm test");
    expect(inspector?.textContent).toContain("Restore the prior version.");
  });

  it("focuses guarded approval actions and the owner link without submitting a decision", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <UiPreferencesProvider>
            <CockpitNavigationProvider>
              <InspectorProvider>
                <InboxArea />
                <InspectorPanel />
              </InspectorProvider>
            </CockpitNavigationProvider>
          </UiPreferencesProvider>
        </QueryClientProvider>,
      ),
    );
    const input = document.createElement("input");
    container.appendChild(input);
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true })));
    expect(apiMocks.fetchApproval).not.toHaveBeenCalled();
    input.remove();

    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true })));
    await act(async () => {
      await apiMocks.fetchApproval.mock.results[0]?.value;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement?.textContent).toBe("Review approval");
    expect(apiMocks.resolveApproval).not.toHaveBeenCalled();

    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true })));
    expect(document.activeElement?.textContent).toBe("Deny");
    expect(apiMocks.resolveApproval).not.toHaveBeenCalled();

    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true })));
    expect(document.activeElement?.getAttribute("href")).toBe(
      "/ops/approvals?approvalId=test&shell=classic&shellScope=visit",
    );
  });

  it("renders a task deliverable update as read-only owner evidence", async () => {
    inboxMock.result = {
      data: {
        ...projection,
        items: [
          {
            id: "task_deliverable:delivery-a",
            kind: "task_deliverable",
            group: "updates",
            title: "Report",
            summary: "A file deliverable was recorded for Write report.",
            createdAt: "2026-09-28T00:00:00Z",
            source: { workspaceId: "default", taskId: "task-a", deliverableId: "delivery-a" },
            href: "/ops/kanban?shell=classic&taskId=task-a",
          },
        ],
        counts: {
          ...projection.counts,
          needs_decision: { known: 0, complete: true },
          updates: { known: 1, complete: false },
        },
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <UiPreferencesProvider>
            <CockpitNavigationProvider>
              <InspectorProvider>
                <InboxArea />
                <InspectorPanel />
              </InspectorProvider>
            </CockpitNavigationProvider>
          </UiPreferencesProvider>
        </QueryClientProvider>,
      ),
    );
    expect(container.textContent).toContain("Task deliverable");
    expect(container.textContent).toContain("Report");
    expect(
      container.querySelector('a[href="/ops/kanban?shell=classic&taskId=task-a&shellScope=visit"]')?.textContent,
    ).toContain("Open in classic Ops");
    const details = [...container.querySelectorAll("button")].find((button) => button.textContent === "Details");
    if (!details) throw new Error("Missing details control");
    await act(async () => details.click());
    expect(container.querySelector('[aria-label="Inspector: Report"]')?.textContent).toContain("read-only summary");
    expect(apiMocks.resolveApproval).not.toHaveBeenCalled();
  });

  it("renders a completed background run with an exact owner link and no decision action", async () => {
    inboxMock.result = {
      data: {
        ...projection,
        items: [
          {
            id: "completed_background_run:watcher-a",
            kind: "completed_background_run",
            group: "updates",
            title: "Background run completed",
            summary: "A watched Chat child run reached completed status.",
            createdAt: "2026-09-28T00:00:00Z",
            source: { workspaceId: "default", runId: "child-run-a" },
            href: "/ops/runtime?runId=child-run-a&shell=classic",
          },
        ],
        counts: {
          ...projection.counts,
          needs_decision: { known: 0, complete: true },
          updates: { known: 1, complete: false },
        },
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <UiPreferencesProvider>
            <CockpitNavigationProvider>
              <InspectorProvider>
                <InboxArea />
                <InspectorPanel />
              </InspectorProvider>
            </CockpitNavigationProvider>
          </UiPreferencesProvider>
        </QueryClientProvider>,
      ),
    );
    expect(container.textContent).toContain("Background run completed");
    expect(
      container.querySelector('a[href="/ops/runtime?runId=child-run-a&shell=classic&shellScope=visit"]')?.textContent,
    ).toContain("Open in classic Ops");
    const details = [...container.querySelectorAll("button")].find((button) => button.textContent === "Details");
    if (!details) throw new Error("Missing details control");
    await act(async () => details.click());
    expect(container.querySelector('[aria-label="Inspector: Background run completed"]')?.textContent).toContain(
      "read-only summary",
    );
    expect(apiMocks.resolveApproval).not.toHaveBeenCalled();
  });
});

it("keeps triage selection and owner focus beyond the window without resolving an approval", async () => {
  const items = Array.from(
    { length: 125 },
    (_, i): OperatorInboxItem => ({
      ...projection.items[0]!,
      id: "approval:row-" + i,
      title: "Review " + i,
      source: { workspaceId: "default", approvalId: "row-" + i },
      href: "/ops/approvals?shell=classic&approvalId=row-" + i,
    }),
  );
  inboxMock.result = {
    data: { ...projection, items, counts: { ...projection.counts, needs_decision: { known: 125, complete: true } } },
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  };
  const client = new QueryClient();
  await renderUpdates(client);
  expect(container.querySelectorAll("[data-inbox-item]").length).toBeLessThan(100);
  expect(container.querySelector('[aria-label="Needs decision Gateway count"]')?.textContent).toBe("125");
  const scroller = container.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]')!;
  Object.defineProperties(scroller, { offsetHeight: { value: 350 }, scrollHeight: { value: 17500 } });
  vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({ height: 350 } as DOMRect);
  vi.spyOn(scroller, "scrollTo").mockImplementation((options) => {
    scroller.scrollTop = (options as ScrollToOptions).top ?? 0;
    scroller.dispatchEvent(new Event("scroll"));
  });
  for (let i = 0; i < 125; i++)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    });
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
  });
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute("href")).toBe(`${items[124]!.href}&shellScope=visit`),
  );
  expect(apiMocks.resolveApproval).not.toHaveBeenCalled();
  expect(switchShellMock).not.toHaveBeenCalled();
  client.clear();
});

it("opens an exact approval link even outside the Inbox projection", async () => {
  inboxMock.result = {
    data: { ...projection, items: [] },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  };
  window.history.replaceState(null, "", "/inbox?workspaceId=default&item=approval%3Atest&shell=cockpit");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await renderUpdates(client);
  await vi.waitFor(() => expect(document.body.textContent).toContain("Review the file write."));
  expect(apiMocks.fetchApproval).toHaveBeenCalledWith("test", expect.objectContaining({ workspaceId: "default" }));
  expect(container.querySelector("[data-inbox-owner]")?.getAttribute("href")).toContain("approvalId=test");
  expect(switchShellMock).not.toHaveBeenCalled();
  client.clear();
});

it.each(["workspace", "history"])("reopens the exact linked approval after a new %s lifetime", async (lifetime) => {
  window.history.replaceState(null, "", "/inbox?workspaceId=default&item=approval%3Atest&shell=cockpit");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await renderUpdates(client);
  expect(container.querySelector('[aria-label="Inspector: Review file write"]')).not.toBeNull();
  if (lifetime === "workspace") {
    await act(async () => scopePreferences.setActiveWorkspaceId("other"));
    expect(container.querySelector('[aria-label="Inspector: Review file write"]')).toBeNull();
    await act(async () => scopePreferences.setActiveWorkspaceId("default"));
  } else {
    await act(async () => {
      window.history.pushState(null, "", window.location.href + "#record");
      window.dispatchEvent(new Event("goatcitadel:cockpit-location"));
    });
  }
  expect(container.querySelector('[aria-label="Inspector: Review file write"]')).not.toBeNull();
  expect(apiMocks.resolveApproval).not.toHaveBeenCalled();
  client.clear();
});
