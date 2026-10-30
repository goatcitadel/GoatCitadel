// @vitest-environment happy-dom
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { act } from "react";
import { VirtuosoMockContext } from "react-virtuoso";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApprovalRequest, OperatorInboxResponse } from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { UiPreferencesProvider } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InspectorPanel, InspectorProvider } from "../../app/inspector";
import { InboxArea } from "./InboxArea";
import { __resetInboxApprovalAttemptsForTests } from "./inbox-approval-attempts";
import { __resetInboxViewedUpdatesForTests } from "./inbox-viewed-updates";

const apiMocks = vi.hoisted(() => ({
  fetchApproval: vi.fn(),
  fetchApprovals: vi.fn(),
  resolveApproval: vi.fn(),
  fetchApprovalReplay: vi.fn(),
  fetchRuntimeLifecycle: vi.fn(),
  fetchDurableRun: vi.fn(),
  markRead: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/operator-inbox", () => ({
  markOperatorInboxUpdatesRead: apiMocks.markRead,
}));
const inboxMock = vi.hoisted(() => ({ result: null as unknown }));
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
  getGatewayApiBaseUrl: () => "http://localhost:8787",
}));
vi.mock("../../data/use-operator-inbox", () => ({
  useOperatorInbox: () => inboxMock.result,
  useCachedInboxItem: () => ({ projection: (inboxMock.result as { data?: unknown })?.data, fingerprint: "cached" }),
}));

const APPROVAL_ID = "5f0b6d2e-6c1a-4d3e-9b7a-2f1e0c9d8b7a";

/** A pending skill change as the Gateway records it: it belongs to no workspace, so it has no linkage. */
function skillApproval(): ApprovalRequest {
  return {
    approvalId: APPROVAL_ID,
    kind: "skill.lifecycle",
    riskLevel: "danger",
    status: "pending",
    payload: {
      skillLifecycle: {
        schemaVersion: "goatcitadel.skill-lifecycle-approval.v1",
        scopeKind: "global",
        subjectKind: "skill",
        subjectId: "planner",
        action: "skill_state_set",
        requestSha256: "a".repeat(64),
        expectedStateSha256: "b".repeat(64),
      },
      request: {
        schemaVersion: "goatcitadel.skill-lifecycle-request-envelope.v1",
        requesterId: "operator",
        mutation: { skillId: "planner", state: "enabled", note: null },
      },
    },
    preview: {
      title: "Approve skill state change",
      action: "skill_state_set",
      skillId: "planner",
      state: "enabled",
      currentState: "disabled",
    },
    createdAt: "2026-10-29T10:00:00.000Z",
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    explanationStatus: "not_requested",
  };
}

const projection: OperatorInboxResponse = {
  authority: "derived_projection",
  workspaceId: "default",
  generatedAt: "2026-10-29T10:00:00.000Z",
  items: [
    {
      id: `approval:${APPROVAL_ID}`,
      kind: "approval",
      group: "needs_decision",
      title: "Turn on skill planner",
      summary: "Applies to every workspace.",
      createdAt: "2026-10-29T10:00:00.000Z",
      riskLevel: "danger",
      source: { workspaceId: "default", approvalId: APPROVAL_ID, installWide: true },
      href: `/inbox?approvalId=${APPROVAL_ID}`,
    },
  ],
  coverage: [{ source: "approvals", state: "current" }],
  counts: {
    needs_decision: { known: 1, complete: true },
    proposals: { known: 0, complete: true },
    needs_attention: { known: 0, complete: true },
    updates: { known: 0, complete: true },
  },
};

let stored: ApprovalRequest;
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  localStorage.clear();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: async (_name: string, _options: unknown, fn: () => unknown) => fn() },
  });
  __resetInboxViewedUpdatesForTests();
  window.history.replaceState(null, "", "/inbox");
  inboxMock.result = { data: projection, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };
  stored = skillApproval();
  // As the Gateway answers: a read scoped to a workspace does not find an approval of no workspace.
  apiMocks.fetchApproval.mockReset().mockImplementation(async (_id: string, options?: { workspaceId?: string }) => {
    if (options?.workspaceId)
      throw new ApiRequestError("API error 404", { kind: "http", method: "GET", path: "/x", status: 404 });
    return stored;
  });
  apiMocks.fetchApprovals.mockReset().mockResolvedValue({ items: [] });
  apiMocks.markRead.mockReset();
  apiMocks.resolveApproval.mockReset().mockImplementation(async (_id: string, decision: "approve" | "reject") => {
    stored = {
      ...stored,
      status: decision === "approve" ? "approved" : "rejected",
      resolvedBy: "operator",
      resolvedAt: "2026-10-29T10:01:00.000Z",
    };
    return { approval: stored, effects: [] };
  });
  // The decided skill change stays install-wide in its follow-on records too.
  apiMocks.fetchApprovalReplay
    .mockReset()
    .mockImplementation(async () => ({ approval: stored, effects: [], events: [] }));
  apiMocks.fetchRuntimeLifecycle.mockReset().mockImplementation(async () => ({ approval: stored, turns: [] }));
  apiMocks.fetchDurableRun.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  __resetInboxApprovalAttemptsForTests();
  vi.unstubAllGlobals();
});

async function renderInbox() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <UiPreferencesProvider>
          <CockpitNavigationProvider>
            <InspectorProvider>
              <VirtuosoMockContext.Provider value={{ viewportHeight: 350, itemHeight: 140 }}>
                <InboxArea />
              </VirtuosoMockContext.Provider>
              <InspectorPanel />
            </InspectorProvider>
          </CockpitNavigationProvider>
        </UiPreferencesProvider>
      </QueryClientProvider>,
    );
  });
}

/** Query results reach React on zero-delay timers, so let them fire inside act until the view settles. */
async function settleUntil(done: () => boolean) {
  for (let pass = 0; pass < 40 && !done(); pass += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

const inspector = () => container.querySelector('[aria-label="Inspector: Turn on skill planner"]');
const inspectorButton = (label: string) =>
  [...(inspector()?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.trim() === label);

async function openSkillApproval() {
  await renderInbox();
  const row = container.querySelector("[data-inbox-item]");
  expect(row?.textContent).toContain("Turn on skill planner");
  const review = [...(row?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Review");
  if (!review) throw new Error("Missing Review button");
  await act(async () => review.click());
  expect(inspector()).not.toBeNull();
  await settleUntil(() => Boolean(inspectorButton("Deny")));
  expect(inspectorButton("Deny")).toBeDefined();
}

it("shows a skill approval, opens it and approves it in one click", async () => {
  await openSkillApproval();
  // The operator asked for this change, so there is no danger-level review step in front of Approve.
  expect(inspectorButton("Review danger approval")).toBeUndefined();
  const approve = inspectorButton("Approve once");
  if (!approve) throw new Error("Missing Approve once button");
  await act(async () => approve.click());
  await settleUntil(() => apiMocks.resolveApproval.mock.calls.length > 0);
  expect(apiMocks.resolveApproval).toHaveBeenCalledExactlyOnceWith(APPROVAL_ID, "approve");
  // One click: no confirmation dialog opened on the way.
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  // Every read of this approval goes without a workspace, since a read scoped to one would not find it.
  for (const [id, options] of apiMocks.fetchApproval.mock.calls) {
    expect(id).toBe(APPROVAL_ID);
    expect(options).not.toHaveProperty("workspaceId");
  }
  // The receipt reads the decided record's follow-on work without calling it another scope.
  await settleUntil(() => Boolean(inspector()?.textContent?.includes("Decision history")));
  expect(inspector()?.textContent).toContain("Decision recorded: Approved");
  expect(inspector()?.textContent).toContain("Decision history");
  expect(inspector()?.textContent).not.toContain("does not match this approval scope");
});

it("denies a skill approval from the Inbox", async () => {
  await openSkillApproval();
  await act(async () => inspectorButton("Deny")!.click());
  await settleUntil(() => apiMocks.resolveApproval.mock.calls.length > 0);
  expect(apiMocks.resolveApproval).toHaveBeenCalledExactlyOnceWith(APPROVAL_ID, "reject");
});
