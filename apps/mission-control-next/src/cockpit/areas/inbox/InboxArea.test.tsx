// @vitest-environment happy-dom
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { SHELL_HISTORY_POSITION } from "../../../app/shell-transition";
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

const apiMocks = vi.hoisted(() => ({
  fetchApproval: vi.fn(),
  fetchApprovals: vi.fn(),
  resolveApproval: vi.fn(),
  markRead: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/operator-inbox", () => ({
  markOperatorInboxUpdatesRead: apiMocks.markRead,
}));
const switchShellMock = vi.hoisted(() => vi.fn<typeof import("../../../shell-preference").switchShell>());
vi.mock("../../../shell-preference", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shell-preference")>()),
  switchShell: switchShellMock,
}));
const inboxMock = vi.hoisted(() => ({ result: null as unknown, installation: "http://localhost:8787" }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => apiMocks);
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({
  fetchApproval: apiMocks.fetchApproval,
  fetchApprovals: apiMocks.fetchApprovals,
}));
vi.mock("@goatcitadel/mission-control-shared/api/workspaces", () => ({
  fetchWorkspaces: vi.fn(async () => ({ items: [] })),
}));
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
  localStorage.clear();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: async (_name: string, _options: unknown, fn: () => unknown) => fn() },
  });
  __resetInboxViewedUpdatesForTests();
  inboxMock.installation = "http://localhost:8787";
  window.history.replaceState(null, "", "/inbox");
  inboxMock.result = { data: projection, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };
  apiMocks.fetchApproval.mockReset();
  // The Inbox reads installation-wide pending approvals for its bulk-rejection zone; none by default.
  apiMocks.fetchApprovals.mockReset().mockResolvedValue({ items: [] });
  apiMocks.markRead.mockReset();
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
  version: "a".repeat(64),
  title: "Viewed report",
  summary: "A file deliverable was recorded.",
  createdAt: "2026-09-28T00:00:00Z",
  source: { workspaceId: "default", taskId: "task-a", deliverableId: "delivery-a" },
  href: "/ops/kanban?shell=classic&taskId=task-a",
};

function updateProjection(item = update): OperatorInboxResponse {
  const data = {
    ...projection,
    readStatus: { scope: "browser_local" as const },
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
    expect(link.getAttribute("href")).toBe("/inbox?approvalId=test&shell=cockpit&workspaceId=default");
    expect(link.textContent).toContain("Open approval");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true })));
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true })));
    expect(document.activeElement).toBe(link);
    expect(switchShellMock).not.toHaveBeenCalled();
    await act(async () => {
      link.click();
    });
    expect(switchShellMock).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/inbox");
    expect(new URLSearchParams(window.location.search).get("approvalId")).toBe("test");
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
    expect(container.querySelector('[data-inbox-count="updates"]')?.textContent).toBe("At least 4");
    expect(container.textContent).toContain("4 known items; more may be outside this view.");
    expect(container.textContent).toContain("0 unread · 1 read from shown updates");
    await clickButton("Show read updates (1)");
    expect(container.querySelectorAll("[data-inbox-item]")).toHaveLength(1);
    await clickButton("Hide read updates");
    expect(container.querySelectorAll("[data-inbox-item]")).toHaveLength(0);
    expect(data).toEqual(original);
    expect(JSON.stringify({ ...window.localStorage })).not.toBe(persistedBefore);
    expect(apiMocks.fetchApproval).not.toHaveBeenCalled();
    expect(apiMocks.resolveApproval).not.toHaveBeenCalled();
  });

  it("keeps Mark all shown updates read available during a background refetch", async () => {
    const data = updateProjection();
    inboxMock.result = { data, isLoading: false, isError: false, isFetching: true, refetch: vi.fn() };
    await renderUpdates(new QueryClient());
    const markAll = [...container.querySelectorAll("button")].find(
      (entry) => entry.textContent === "Mark all shown updates read",
    );
    if (!markAll) throw new Error("Missing Mark all shown updates read button");
    expect(markAll.disabled).toBe(false);
    await act(async () => markAll.click());
    expect(isInboxUpdateViewed(inboxMock.installation, "default", update)).toBe(true);
    expect(container.textContent).toContain("0 unread · 1 read from shown updates");
  });

  it("opens a native Work owner link for a task deliverable without a Classic handoff", async () => {
    updateProjection({ ...update, href: "/work/kanban?taskId=task-a" });
    await renderUpdates(new QueryClient());
    const link = container.querySelector<HTMLAnchorElement>("a[data-inbox-owner]");
    if (!link) throw new Error("Missing owner link");
    expect(link.getAttribute("href")).toBe("/work/tasks/task-a?taskId=task-a&workspaceId=default&shell=cockpit");
    expect(link.textContent).toContain("Open in Work");
    expect(link.textContent).not.toContain("classic");
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
      if (change === "new version") updateProjection({ ...update, version: "b".repeat(64), summary: "New evidence" });
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
    updateProjection({
      ...update,
      version: "b".repeat(64),
      summary: "New evidence",
      updatedAt: "2026-09-30T00:00:00Z",
    });
    await renderUpdates(client);
    expect(container.querySelectorAll("[data-inbox-item]")).toHaveLength(1);
    expect(container.textContent).toContain("1 unread · 0 read from shown updates");
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
    expect(container.textContent).not.toContain("Couldn't fully check");
    expect(container.textContent).not.toContain("Count unknown");
    // Empty groups are hidden: one empty state replaces the four empty sections (IN-10).
    expect(container.textContent).toContain("You're all caught up");
    expect(container.querySelector("[data-inbox-count]")).toBeNull();
    expect(container.textContent).not.toContain("Nothing found here");
    expect(container.textContent).not.toContain("Mark all shown updates read");
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
    expect(container.textContent).toContain("Nothing found, but some sources couldn't be checked completely");
    expect(container.textContent).not.toContain("Nothing needs your attention");
    expect(container.textContent).toContain("Couldn't fully check 1 source");
    // The coverage summary is static polled context, not a live region.
    expect(
      [...container.querySelectorAll('[role="status"]')].some((node) =>
        node.textContent?.includes("Nothing found, but some sources"),
      ),
    ).toBe(false);
    expect(container.textContent).toContain("Some sources couldn't be checked");
    expect(container.textContent).not.toContain("You're all caught up");
    expect(container.querySelector("[data-inbox-count]")).toBeNull();
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
    expect(container.textContent).toContain("Some items couldn't be checked");
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
    expect(container.textContent).toContain("Couldn't fully check 1 source");
    expect(container.textContent).toContain("Review file write");
    // The empty group with an incomplete count is hidden; the coverage line above says more may exist (IN-10).
    expect(container.querySelector('[data-inbox-count="needs_attention"]')).toBeNull();
    const link = container.querySelector('a[href="/inbox?approvalId=test&shell=cockpit&workspaceId=default"]');
    expect(link?.textContent).toContain("Open approval");
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
    // Only the bulk-rejection zone's installation-wide pending read; opening details never lists approvals.
    for (const [input] of apiMocks.fetchApprovals.mock.calls) expect(input).toEqual({ status: "pending", limit: 200 });
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
      "/inbox?approvalId=test&shell=cockpit&workspaceId=default",
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
      container.querySelector('a[href="/work/tasks/task-a?shell=cockpit&taskId=task-a&workspaceId=default"]')
        ?.textContent,
    ).toContain("Open in Work");
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
      container.querySelector('a[href="/work/runs/child-run-a?runId=child-run-a&shell=cockpit&workspaceId=default"]')
        ?.textContent,
    ).toContain("Open in Work");
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
  expect(container.querySelector('[data-inbox-count="needs_decision"]')?.textContent).toBe("125");
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
    expect(document.activeElement?.getAttribute("href")).toBe(
      "/inbox?shell=cockpit&approvalId=row-124&workspaceId=default",
    ),
  );
  expect(apiMocks.resolveApproval).not.toHaveBeenCalled();
  expect(switchShellMock).not.toHaveBeenCalled();
  client.clear();
});

it("acknowledges only shown update references and reports skipped operator receipts", async () => {
  const data = updateProjection();
  data.readStatus = { scope: "operator", scopeId: "operator-a" };
  apiMocks.markRead.mockResolvedValue({
    readStatus: { scope: "operator", scopeId: "operator-a" },
    acknowledged: [],
    skipped: [{ id: update.id, version: update.version, reason: "not_current" }],
  });
  await renderUpdates(new QueryClient());
  const before = JSON.stringify({ ...localStorage });
  await clickButton("Mark all shown updates read");
  expect(apiMocks.markRead).toHaveBeenCalledWith("default", [{ id: update.id, version: update.version }]);
  expect(container.textContent).toContain("1 update was not acknowledged");
  expect(container.querySelectorAll("[data-inbox-item]")).toHaveLength(1);
  expect(apiMocks.resolveApproval).not.toHaveBeenCalled();
  expect(JSON.stringify({ ...localStorage })).toBe(before);
});
it("shows server-scoped approval history with an older-page continuation", async () => {
  apiMocks.fetchApprovals.mockResolvedValue({
    items: [{ ...approval, linkage: { ...approval.linkage, workspaceId: "default" }, status: "rejected" }],
    nextCursor: "more",
  });
  await renderUpdates(new QueryClient());
  await clickButton("Approval history");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(apiMocks.fetchApprovals).toHaveBeenCalledWith({ workspaceId: "default", limit: 100 });
  expect(container.textContent).toContain("Load more to see older approvals");
  expect(container.textContent).toContain("Denied");
  expect(apiMocks.resolveApproval).not.toHaveBeenCalled();
});

it("hides the installation-wide rejection while nothing is pending", async () => {
  await renderUpdates(new QueryClient());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(apiMocks.fetchApprovals).toHaveBeenCalledWith({ status: "pending", limit: 200 });
  expect(container.textContent).not.toContain("Reject everything pending");
  expect(container.textContent).not.toContain("Review installation-wide rejection");
});

it("puts the installation-wide rejection in its own zone at the bottom when approvals are pending", async () => {
  apiMocks.fetchApprovals.mockResolvedValue({ items: [approval] });
  await renderUpdates(new QueryClient());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const zone = [...container.querySelectorAll("section")].find(
    (section) => section.querySelector("h2")?.textContent === "Reject everything pending",
  )!;
  expect(zone.textContent).toContain("This applies to every workspace in the installation");
  expect(zone.textContent).toContain("Review installation-wide rejection");
  expect(zone.parentElement?.lastElementChild).toBe(zone);
});

it("lets operators disable single-letter shortcuts", async () => {
  await renderUpdates(new QueryClient());
  // Shortcut help and the switch sit behind the header's keyboard disclosure (IN-10, IN-18).
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  const help = container.querySelector<HTMLButtonElement>('button[aria-label="Keyboard shortcuts"]')!;
  expect(help.getAttribute("aria-expanded")).toBe("false");
  await act(async () => help.click());
  expect(help.getAttribute("aria-expanded")).toBe("true");
  expect(container.textContent).toContain("Focus the source link");
  const toggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => toggle.click());
  // The choice is remembered in this browser.
  expect(localStorage.getItem("goatcitadel.cockpit.inbox.letter-shortcuts.v1")).toBe("off");
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true })));
  expect(container.querySelector('[data-inbox-item][data-selected="true"]')).toBeNull();
  await act(async () => toggle.click());
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true })));
  expect(container.querySelector('[data-inbox-item][data-selected="true"]')).not.toBeNull();
  // Selection is exposed to assistive technology and shown with text, not only the accent border.
  const current = container.querySelectorAll('[data-inbox-item] article[aria-current="true"]');
  expect(current).toHaveLength(1);
  expect(current[0]?.textContent).toContain("Selected");
});
it("orders decisions by risk and selects the next remaining decision after settlement", async () => {
  const low = { ...projection.items[0]!, id: "approval:low", title: "Lower risk", riskLevel: "safe" as const };
  const high = { ...projection.items[0]!, id: "approval:high", title: "Higher risk", riskLevel: "nuclear" as const };
  const data = { ...projection, items: [low, high] };
  inboxMock.result = { data, isFetching: false, refetch: vi.fn() };
  const client = new QueryClient();
  await renderUpdates(client);
  expect(container.querySelector("[data-inbox-item] h3")?.textContent).toBe("Higher risk");
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true })));
  inboxMock.result = { data: { ...data, items: [low] }, isFetching: false, refetch: vi.fn() };
  await renderUpdates(client);
  expect(container.querySelector('[data-inbox-item][data-selected="true"] h3')?.textContent).toBe("Lower risk");
});

it.each([0, 1])(
  "shows one unavailable state after write denial with %s earlier saved updates",
  async (savedBeforeDenial) => {
    inboxMock.installation = "http://localhost:8787/write-denial-" + savedBeforeDenial;
    const data = updateProjection();
    data.items = [
      update,
      { ...update, id: "task_deliverable:second", source: { ...update.source, deliverableId: "second" } },
    ];
    await renderUpdates(new QueryClient());
    const original = localStorage.setItem.bind(localStorage);
    let attempts = 0;
    const write = vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
      if (key.startsWith("goatcitadel.inbox.read.v1:") && attempts++ >= savedBeforeDenial)
        throw new Error("write denied");
      original(key, value);
    });
    try {
      await clickButton("Mark all shown updates read");
      expect(container.textContent).toContain("Read storage unavailable");
      expect(container.textContent).not.toContain("Read status is saved in this browser");
      expect(container.textContent).toContain(String(savedBeforeDenial) + " read from shown updates");
      const action = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.textContent === "Mark all shown updates read",
      )!;
      expect(action.disabled).toBe(true);
    } finally {
      write.mockRestore();
    }
  },
);

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

it("selects the canonical linked item without an inherited approval and retains source linkage context", async () => {
  window.history.replaceState(
    { retained: "source-history" },
    "",
    "/inbox?approvalId=previous&citadelId=citadel-a&workspaceId=default&runId=old-run&sessionId=old-session&keep=one&keep=two#evidence",
  );
  inboxMock.result = {
    data: {
      ...projection,
      items: [
        {
          id: "change_plan:plan-a",
          kind: "change_plan",
          group: "needs_decision",
          title: "Review the canonical plan",
          summary: "Review its owner",
          createdAt: "2026-09-28T00:00:00Z",
          source: { workspaceId: "default", planId: "plan-a", sessionId: "session-a", runId: "run-a" },
          href: "/chat?sessionId=stale-session&approvalId=stale-approval&shell=classic",
        },
      ],
    },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await renderUpdates(client);
  const historyBefore = structuredClone(window.history.state);
  expect(historyBefore.retained).toBe("source-history");
  expect(Number.isInteger(historyBefore[SHELL_HISTORY_POSITION])).toBe(true);
  await renderUpdates(client);
  const link = container.querySelector<HTMLAnchorElement>("a[data-inbox-owner]")!;
  const target = new URL(link.href);
  expect(target.pathname).toBe("/inbox");
  expect(target.searchParams.get("item")).toBe("change_plan:plan-a");
  expect(target.searchParams.has("approvalId")).toBe(false);
  expect(target.searchParams.get("workspaceId")).toBe("default");
  expect(target.searchParams.get("citadelId")).toBe("citadel-a");
  expect(target.searchParams.get("runId")).toBe("run-a");
  expect(target.searchParams.get("sessionId")).toBe("session-a");
  expect(target.searchParams.getAll("keep")).toEqual(["one", "two"]);
  expect(target.hash).toBe("#evidence");
  expect(target.searchParams.get("shell")).toBe("cockpit");
  expect(window.history.state).toEqual(historyBefore);
  expect(apiMocks.resolveApproval).not.toHaveBeenCalled();
  expect(switchShellMock).not.toHaveBeenCalled();
  client.clear();
});

describe("decision focus, shortcuts, filters and expiry (IN-05, IN-07, IN-08, IN-09)", () => {
  const first = projection.items[0]!;
  const second: OperatorInboxItem = {
    ...first,
    id: "approval:second",
    title: "Second write",
    riskLevel: "caution",
    source: { workspaceId: "default", approvalId: "second" },
  };
  function show(items: OperatorInboxItem[], counts: Partial<OperatorInboxResponse["counts"]> = {}) {
    inboxMock.result = {
      data: { ...projection, items, counts: { ...projection.counts, ...counts } },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    };
  }
  const press = (key: string) =>
    act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  const announcer = () => container.querySelector("[data-inbox-announcer]")?.textContent?.trim();
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

  it("announces a decision once and moves focus once, to the next item", async () => {
    show([first, second], { needs_decision: { known: 2, complete: true } });
    apiMocks.resolveApproval.mockResolvedValue({ approval: { ...approval, status: "rejected" }, effects: [] });
    await renderUpdates(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    await press("d");
    await settle();
    await settle();
    expect(document.activeElement?.textContent).toBe("Deny");
    await act(async () => (document.activeElement as HTMLButtonElement).click());
    const confirm = [...document.body.querySelectorAll("button")].find((b) => b.textContent === "Confirm deny")!;
    await act(async () => confirm.click());
    await vi.waitFor(() => expect(announcer()).toContain("Decision recorded: Denied"));
    await vi.waitFor(() =>
      expect(document.activeElement?.closest("[data-inbox-row]")?.getAttribute("data-inbox-row")).toBe(
        "approval:second",
      ),
    );
    expect(document.activeElement?.textContent).toBe("Details");
    // The inspector keeps the notice as plain text: one announcement, one focus move.
    const notice = document.querySelector("[data-inbox-decision-notice]");
    expect(notice?.getAttribute("role")).toBeNull();
    expect(container.querySelectorAll("[data-inbox-announcer]")).toHaveLength(1);
  });

  it("moves the open inspector with J/K and says when A or D do not apply", async () => {
    show([first, update], { updates: { known: 1, complete: true } });
    await renderUpdates(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    await press("o");
    expect(container.querySelector('[aria-label="Inspector: Review file write"]')).not.toBeNull();
    await press("j");
    expect(container.querySelector('[aria-label="Inspector: Viewed report"]')).not.toBeNull();
    expect(container.querySelector('[data-inbox-item][data-selected="true"] h3')?.textContent).toBe("Viewed report");
    await press("a");
    expect(announcer()).toBe("No approval actions for this item.");
    await press("d");
    // The same message is announced again (a trailing no-break space changes the region's text).
    expect(announcer()).toBe("No approval actions for this item.");
    expect(apiMocks.resolveApproval).not.toHaveBeenCalled();
  });

  it("filters loaded items by kind and risk with truthful counts and a visible sort order", async () => {
    show([first, second, update], {
      needs_decision: { known: 2, complete: true },
      updates: { known: 3, complete: false },
    });
    await renderUpdates(new QueryClient());
    const summary = () => container.querySelector("[data-inbox-filter-summary]")?.textContent;
    const count = (group: string) => container.querySelector(`[data-inbox-count="${group}"]`)?.textContent;
    expect(summary()).toBe("Sorted by risk, then expiry, then age.");
    expect(count("needs_decision")).toBe("2");
    const choose = (label: string, value: string) =>
      act(async () => {
        const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    await choose("Filter loaded items by kind", "task_deliverable");
    expect(summary()).toBe("1 of 3 loaded items shown. Sorted by risk, then expiry, then age.");
    expect(count("needs_decision")).toBe("0 of 2 shown");
    expect(count("updates")).toBe("1 of at least 3 shown");
    expect(container.textContent).toContain("Nothing here matches the filters.");
    await choose("Filter loaded items by kind", "all");
    await choose("Filter loaded items by risk", "caution");
    expect(summary()).toBe("1 of 3 loaded items shown. Sorted by risk, then expiry, then age.");
    expect([...container.querySelectorAll("[data-inbox-item] h3")].map((node) => node.textContent)).toEqual([
      "Second write",
    ]);
    await clickButton("Clear filters");
    expect(container.querySelectorAll("[data-inbox-item]")).toHaveLength(3);
  });

  it("moves expired decisions to their own visible group with an Expired badge", async () => {
    const expired: OperatorInboxItem = {
      ...first,
      id: "approval:old",
      title: "Old write",
      expiresAt: "2020-01-01T00:00:00Z",
      source: { workspaceId: "default", approvalId: "old" },
    };
    show([first, expired], { needs_decision: { known: 2, complete: true } });
    await renderUpdates(new QueryClient());
    expect(container.querySelector('[data-inbox-count="needs_decision"]')?.textContent).toBe("1");
    expect(container.querySelector('[data-inbox-count="expired"]')?.textContent).toBe("1");
    const group = container.querySelector('section[aria-labelledby="inbox-expired"]');
    expect(group?.textContent).toContain("Old write");
    expect([...(group?.querySelectorAll("[data-tone]") ?? [])].map((node) => node.textContent)).toContain("Expired");
    const decisions = container.querySelector('section[aria-labelledby="inbox-needs_decision"]');
    expect(decisions?.textContent).not.toContain("Old write");
  });
});
