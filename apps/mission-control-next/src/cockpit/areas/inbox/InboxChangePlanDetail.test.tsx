// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChangePlanRecord, OperatorInboxItem, OperatorInboxResponse } from "@goatcitadel/contracts";
import { UiPreferencesProvider } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InboxChangePlanDetail } from "./InboxChangePlanDetail";
import { queryKeys } from "../../data/query-keys";
import { __resetInboxChangePlanAttemptsForTests } from "./use-inbox-change-plan";

const api = vi.hoisted(() => ({ fetchOperatorInbox: vi.fn(), fetchChangePlan: vi.fn(), confirmChangePlan: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/operator-inbox", () => ({
  fetchOperatorInbox: api.fetchOperatorInbox,
}));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({
  fetchChangePlan: api.fetchChangePlan,
  confirmChangePlan: api.confirmChangePlan,
}));

const item: OperatorInboxItem = {
  id: "change_plan:plan-a",
  kind: "change_plan",
  group: "needs_decision",
  title: "Change model",
  summary: "Use a reviewed model",
  createdAt: "2026-09-28T00:00:00Z",
  updatedAt: "2026-09-28T00:01:00Z",
  riskLevel: "caution",
  source: {
    workspaceId: "default",
    planId: "plan-a",
    planRevision: 2,
    planStatus: "awaiting_confirmation",
    sessionId: "session-a",
    turnId: "turn-a",
  },
  href: "/chat?sessionId=session-a&shell=classic",
};
const plan = {
  schemaVersion: 1,
  kind: "session_model",
  request: { kind: "session_model", model: "reviewed-model" },
  intentHash: "a".repeat(64),
  adapter: { adapterId: "session-model", version: 1 },
  target: { ownerId: "chat_session", resourceId: "session-a", expectedRevision: 1 },
  planId: "plan-a",
  status: "awaiting_confirmation",
  revision: 2,
  title: "Change model",
  summary: "Use a reviewed model",
  impact: "The current Chat model changes.",
  scope: "current_chat",
  risk: "caution",
  origin: { workspaceId: "default", sessionId: "session-a", turnId: "turn-a", surface: "chat" },
  requiredAction: {
    kind: "confirmation",
    actionId: "action-a",
    actionNonce: "nonce-long-enough-for-owner",
    title: "Confirm model",
    confirmationText: "Apply this exact Chat model change.",
  },
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
} as ChangePlanRecord;
const projection: OperatorInboxResponse = {
  authority: "derived_projection",
  workspaceId: "default",
  generatedAt: "2026-09-28T00:01:00Z",
  items: [item],
  coverage: [{ source: "change_plans", state: "current" }],
  counts: {
    needs_decision: { known: 1, complete: true },
    proposals: { known: 0, complete: true },
    needs_attention: { known: 0, complete: false },
    updates: { known: 0, complete: false },
  },
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  __resetInboxChangePlanAttemptsForTests();
  for (const mock of Object.values(api)) mock.mockReset();
  api.fetchOperatorInbox.mockResolvedValue(projection);
  api.fetchChangePlan.mockResolvedValue(plan);
  api.confirmChangePlan.mockResolvedValue({
    ...plan,
    revision: 3,
    status: "awaiting_approval",
    requiredAction: {
      kind: "approval",
      actionId: "action-b",
      actionNonce: "another-long-owner-nonce",
      title: "Review approval",
      risk: "caution",
      approvalId: "approval-a",
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderDetail(inboxItem = item) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The Inbox area keeps the Inbox cached; seed it from the mocked owner read, then forget that read.
  client.setQueryData(queryKeys.inbox("default"), await api.fetchOperatorInbox("default"));
  api.fetchOperatorInbox.mockClear();
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <UiPreferencesProvider>
          <InboxChangePlanDetail item={inboxItem} workspaceId="default" />
        </UiPreferencesProvider>
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    if (api.fetchChangePlan.mock.results[0]) await api.fetchChangePlan.mock.results[0].value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find((entry) => entry.textContent === label);
  if (!found) throw new Error(`Missing ${label} button: ${document.body.textContent}`);
  return found;
}

describe("Inbox change-plan confirmation", () => {
  it("reviews impact, re-reads projection and plan, and sends the exact revision and nonce once", async () => {
    await renderDetail();
    expect(container.textContent).toContain("The current Chat model changes.");
    await act(async () => button("Review confirmation").click());
    expect(document.body.textContent).toContain("Apply this exact Chat model change.");
    expect(api.confirmChangePlan).not.toHaveBeenCalled();
    await act(async () => button("Confirm change").click());
    // Opening checked the cached Inbox; only the confirmation re-read it.
    expect(api.fetchOperatorInbox).toHaveBeenCalledTimes(1);
    expect(api.fetchChangePlan).toHaveBeenCalledTimes(2);
    expect(api.confirmChangePlan).toHaveBeenCalledOnce();
    expect(api.confirmChangePlan).toHaveBeenCalledWith(
      "plan-a",
      {
        workspaceId: "default",
        sessionId: "session-a",
        turnId: "turn-a",
      },
      { expectedRevision: 2, actionNonce: "nonce-long-enough-for-owner" },
    );
    expect(container.textContent).toContain("A separate canonical approval is required");
    expect(container.textContent).not.toContain("change was applied");
  });

  it("refuses a changed revision after review", async () => {
    api.fetchChangePlan.mockResolvedValueOnce(plan).mockResolvedValueOnce({ ...plan, revision: 3 });
    await renderDetail();
    await act(async () => button("Review confirmation").click());
    await act(async () => button("Confirm change").click());
    expect(api.confirmChangePlan).not.toHaveBeenCalled();
    expect(container.textContent).toContain("changed or is no longer waiting");
  });

  it("never reads a plan from a foreign Inbox projection", async () => {
    api.fetchOperatorInbox.mockResolvedValue({ ...projection, workspaceId: "other" });
    await renderDetail();
    expect(api.fetchChangePlan).not.toHaveBeenCalled();
    expect(container.textContent).toContain("no longer waiting in the selected workspace");
    expect(container.textContent).not.toContain("Review confirmation");
  });

  it("refuses an owner plan with a different session", async () => {
    api.fetchChangePlan.mockResolvedValue({ ...plan, origin: { ...plan.origin, sessionId: "other-session" } });
    await renderDetail();
    expect(container.textContent).toContain("no longer waiting in the selected workspace");
    expect(container.textContent).not.toContain("Review confirmation");
  });

  it("keeps an expired confirmation read-only", async () => {
    const expiresAt = "2020-01-01T00:00:00.000Z";
    api.fetchOperatorInbox.mockResolvedValue({ ...projection, items: [{ ...item, expiresAt }] });
    api.fetchChangePlan.mockResolvedValue({ ...plan, expiresAt });
    await renderDetail({ ...item, expiresAt });
    expect(container.textContent).toContain("confirmation has expired");
    expect(container.textContent).not.toContain("Review confirmation");
  });

  it("keeps protected input in the existing owner flow", async () => {
    api.fetchOperatorInbox.mockResolvedValue({
      ...projection,
      items: [{ ...item, source: { ...item.source, planStatus: "awaiting_input" } }],
    });
    api.fetchChangePlan.mockResolvedValue({
      ...plan,
      status: "awaiting_input",
      requiredAction: {
        kind: "secure_input",
        actionId: "action-a",
        actionNonce: "nonce-long-enough-for-owner",
        targetId: "target-a",
        title: "Enter key",
        expiresAt: "2030-01-01T00:00:00Z",
      },
    });
    await renderDetail({ ...item, source: { ...item.source, planStatus: "awaiting_input" } });
    expect(container.textContent).toContain("protected input in its existing secure owner flow");
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(api.confirmChangePlan).not.toHaveBeenCalled();
  });

  it("locks another confirmation after an uncertain owner request", async () => {
    api.confirmChangePlan.mockRejectedValue(new Error("Connection lost"));
    await renderDetail();
    await act(async () => button("Review confirmation").click());
    await act(async () => button("Confirm change").click());
    expect(api.confirmChangePlan).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Confirmation outcome is uncertain");
    expect(container.textContent).not.toContain("Review confirmation");
  });
});
