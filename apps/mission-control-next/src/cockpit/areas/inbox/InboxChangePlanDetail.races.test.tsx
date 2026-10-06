// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChangePlanRecord, OperatorInboxItem, OperatorInboxResponse } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InboxChangePlanDetail } from "./InboxChangePlanDetail";
import { queryKeys } from "../../data/query-keys";
import { __resetInboxChangePlanAttemptsForTests } from "./use-inbox-change-plan";
import { __resetSettingsApprovalContinuationsForTests } from "../../../features/native-routes/settings/use-settings-approval-continuation";

const api = vi.hoisted(() => ({
  fetchOperatorInbox: vi.fn(),
  fetchChangePlan: vi.fn(),
  confirmChangePlan: vi.fn(),
  fetchApprovalReplay: vi.fn(),
  respondToChangePlan: vi.fn(),
}));
const scope = vi.hoisted(() => ({ activeWorkspaceId: "workspace-a" }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => scope }));
vi.mock("@goatcitadel/mission-control-shared/api/operator-inbox", () => ({
  fetchOperatorInbox: api.fetchOperatorInbox,
}));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({
  fetchChangePlan: api.fetchChangePlan,
  confirmChangePlan: api.confirmChangePlan,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ ...api }));

function fixture(status: "awaiting_confirmation" | "awaiting_approval" = "awaiting_confirmation") {
  const plan: ChangePlanRecord = {
    schemaVersion: 1,
    planId: "plan-a",
    revision: 2,
    status,
    phase: status === "awaiting_approval" ? "authorization" : "confirmation",
    kind: "runtime_configuration",
    scope: "installation",
    risk: "caution",
    title: "Set budget preference",
    summary: "Use balanced mode",
    impact: "The saved budget preference changes.",
    origin: { surface: "settings", workspaceId: "workspace-a" },
    request: { kind: "runtime_configuration", change: { operation: "budget_mode", mode: "balanced" } },
    target: { ownerId: "runtime_settings", resourceId: "installation", expectedRevision: 1 },
    adapter: { adapterId: "runtime-config", version: 1 },
    intentHash: "a".repeat(64),
    evidenceRefs: [],
    rollbackRefs: [],
    requiredAction:
      status === "awaiting_approval"
        ? {
            kind: "approval",
            actionId: "approval-action",
            actionNonce: "nonce-approval-action",
            approvalId: "approval-a",
            title: "Approve change",
            risk: "caution",
          }
        : {
            kind: "confirmation",
            actionId: "confirmation-action",
            actionNonce: "nonce-confirmation-action",
            confirmationText: "Change the saved preference?",
            title: "Confirm change",
          },
    approvalRefs: status === "awaiting_approval" ? ["approval-a"] : [],
    createdAt: "2026-09-30T00:00:00Z",
    updatedAt: "2026-09-30T00:01:00Z",
  };
  const item: OperatorInboxItem = {
    id: "change_plan:plan-a",
    kind: "change_plan",
    group: "needs_decision",
    title: plan.title,
    summary: plan.summary,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    riskLevel: plan.risk,
    source: { workspaceId: "workspace-a", planId: plan.planId, planRevision: plan.revision, planStatus: plan.status },
    href: "/settings/budget?shell=classic",
  };
  const projection = {
    authority: "derived_projection",
    workspaceId: "workspace-a",
    items: [item],
    coverage: [],
    counts: {
      needs_decision: { known: 1, complete: true },
      proposals: { known: 0, complete: true },
      needs_attention: { known: 0, complete: true },
      updates: { known: 0, complete: true },
    },
    generatedAt: plan.updatedAt,
  } satisfies OperatorInboxResponse;
  const receipt = {
    ...plan,
    revision: 4,
    status: "completed",
    phase: "terminal",
    requiredAction: undefined,
  } as ChangePlanRecord;
  return { plan, item, projection, receipt };
}

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
let data = fixture();
beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  __resetInboxChangePlanAttemptsForTests();
  __resetSettingsApprovalContinuationsForTests();
  scope.activeWorkspaceId = "workspace-a";
  data = fixture();
  api.fetchOperatorInbox.mockImplementation(async () => data.projection);
  api.fetchChangePlan.mockImplementation(async () => data.plan);
  api.confirmChangePlan.mockImplementation(async () => data.receipt);
  api.respondToChangePlan.mockImplementation(async () => data.receipt);
  api.fetchApprovalReplay.mockImplementation(async () => ({
    approval: {
      approvalId: "approval-a",
      kind: "change_plan_effect",
      status: "approved",
      resolutionOutcome: "approved",
      linkage: { workspaceId: data.plan.origin.workspaceId, actionType: "change_plan_effect" },
      payload: {
        planId: data.plan.planId,
        kind: data.plan.kind,
        scope: data.plan.scope,
        intentHash: data.plan.intentHash,
        targetOwnerId: data.plan.target.ownerId,
        targetResourceId: data.plan.target.resourceId,
        targetRevision: data.plan.target.expectedRevision,
        adapterId: data.plan.adapter.adapterId,
        adapterVersion: data.plan.adapter.version,
      },
    },
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  client.clear();
});
async function render(item = data.item, strict = false) {
  // The Inbox area keeps the Inbox cached; the detail reads that copy instead of fetching it again.
  client.setQueryData(queryKeys.inbox("workspace-a"), data.projection);
  const content = (
    <QueryClientProvider client={client}>
      <InboxChangePlanDetail item={item} workspaceId="workspace-a" />
    </QueryClientProvider>
  );
  await act(async () => root.render(strict ? <StrictMode>{content}</StrictMode> : content));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
function button(label: string) {
  const found = [...document.body.querySelectorAll("button")].find((entry) => entry.textContent === label);
  if (!found) throw new Error(`Missing ${label}: ${document.body.textContent}`);
  return found;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("Inbox confirmation lifecycle", () => {
  it.each(["unmount", "selection", "workspace-away-and-back", "same-id-evidence"])(
    "cancels a late owner read after %s",
    async (change) => {
      await render();
      await click("Review confirmation");
      const read = deferred<OperatorInboxResponse>();
      api.fetchOperatorInbox.mockReturnValueOnce(read.promise);
      await click("Confirm change");
      if (change === "unmount") act(() => root.render(null));
      if (change === "selection")
        await render({ ...data.item, id: "change_plan:other", source: { ...data.item.source, planId: "other" } });
      if (change === "workspace-away-and-back") {
        scope.activeWorkspaceId = "workspace-b";
        await render();
        scope.activeWorkspaceId = "workspace-a";
        await render();
      }
      if (change === "same-id-evidence") await render({ ...data.item, summary: "Changed projection evidence" });
      await act(async () => read.resolve(data.projection));
      expect(api.confirmChangePlan).not.toHaveBeenCalled();
    },
  );

  it("retains a dispatched unknown result after remount", async () => {
    await render();
    await click("Review confirmation");
    const write = deferred<ChangePlanRecord>();
    api.confirmChangePlan.mockReturnValueOnce(write.promise);
    await click("Confirm change");
    act(() => root.render(null));
    await render();
    expect(host.textContent).not.toContain("Review confirmation");
    await act(async () => write.reject(new Error("Connection lost")));
    expect(host.textContent).toContain("Confirmation outcome is uncertain");
    act(() => root.render(null));
    await render();
    expect(host.textContent).toContain("Confirmation outcome is uncertain");
    expect(api.confirmChangePlan).toHaveBeenCalledOnce();
  });

  it("retains the exact late confirmed result without acknowledging a different item", async () => {
    await render();
    await click("Review confirmation");
    const write = deferred<ChangePlanRecord>();
    api.confirmChangePlan.mockReturnValueOnce(write.promise);
    await click("Confirm change");
    await render({ ...data.item, id: "change_plan:other", source: { ...data.item.source, planId: "other" } });
    await act(async () => write.resolve(data.receipt));
    expect(host.textContent).not.toContain("Gateway recorded the request");
    await render();
    expect(host.textContent).toContain("Gateway recorded the request");
    expect(host.textContent).not.toContain("Review confirmation");
  });

  it.each(["target", "request", "origin", "nonce", "revision"])("locks an unbound %s receipt", async (field) => {
    const receipt = { ...data.receipt };
    if (field === "target") receipt.target = { ...receipt.target, resourceId: "other" };
    if (field === "request") receipt.request = { kind: "session_model", model: "different" };
    if (field === "origin") receipt.origin = { ...receipt.origin, actorId: "other-operator" };
    if (field === "nonce") receipt.requiredAction = data.plan.requiredAction;
    if (field === "revision") receipt.revision = Number.NaN;
    api.confirmChangePlan.mockResolvedValueOnce(receipt);
    await render();
    await click("Review confirmation");
    await click("Confirm change");
    expect(host.textContent).toContain("Confirmation outcome is uncertain");
    expect(host.textContent).not.toContain("Gateway recorded the request");
  });

  it("supports StrictMode and accepts reordered canonical receipt fields", async () => {
    api.confirmChangePlan.mockResolvedValueOnce({
      ...data.receipt,
      target: { expectedRevision: 1, resourceId: "installation", ownerId: "runtime_settings" },
    });
    await render(data.item, true);
    await click("Review confirmation");
    await click("Confirm change");
    expect(api.confirmChangePlan).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Gateway recorded the request");
  });
});

describe("Inbox Settings continuation reuse", () => {
  it("explicitly continues only an exact approved Settings plan through the shared owner hook", async () => {
    data = fixture("awaiting_approval");
    await render();
    expect(api.respondToChangePlan).not.toHaveBeenCalled();
    expect(host.textContent).toContain("does not prove the settings were saved");
    expect(
      host.querySelector('a[href="/ops/approvals?shell=classic&approvalId=approval-a&shellScope=visit"]'),
    ).not.toBeNull();
    await click("Continue approved change");
    expect(api.respondToChangePlan).toHaveBeenCalledExactlyOnceWith(
      "plan-a",
      { workspaceId: "workspace-a" },
      {
        expectedRevision: 2,
        actionId: "approval-action",
        actionNonce: "nonce-approval-action",
        values: {},
      },
    );
    expect(api.confirmChangePlan).not.toHaveBeenCalled();
  });

  it.each(["chat", "session", "turn", "rollback"])("keeps %s plans in their existing owner flow", async (variant) => {
    data = fixture("awaiting_approval");
    if (variant === "chat") data.plan = { ...data.plan, origin: { ...data.plan.origin, surface: "chat" } };
    if (variant === "session" || variant === "turn") {
      const key = variant === "session" ? "sessionId" : "turnId";
      data.plan = { ...data.plan, origin: { ...data.plan.origin, [key]: "source" } };
      data.item = { ...data.item, source: { ...data.item.source, [key]: "source" } };
      data.projection.items = [data.item];
    }
    if (variant === "rollback")
      data.plan = { ...data.plan, result: { summary: "Rollback approval", failureCode: "rollback_approval_pending" } };
    await render();
    expect(host.textContent).not.toContain("Continue approved change");
    expect(api.respondToChangePlan).not.toHaveBeenCalled();
  });

  it("cancels continuation on Inbox navigation and shares uncertain locks across remounts", async () => {
    data = fixture("awaiting_approval");
    await render();
    const read = deferred<ChangePlanRecord>();
    api.fetchChangePlan.mockReturnValueOnce(read.promise);
    await click("Continue approved change");
    act(() => root.render(null));
    await act(async () => read.resolve(data.plan));
    expect(api.respondToChangePlan).not.toHaveBeenCalled();
    await render();
    api.respondToChangePlan.mockRejectedValueOnce(new Error("Connection lost"));
    await click("Continue approved change");
    act(() => root.render(null));
    await render();
    expect(host.textContent).toContain("Continuation outcome is uncertain");
    expect(button("Continue approved change").disabled).toBe(true);
    expect(api.respondToChangePlan).toHaveBeenCalledOnce();
  });
});
