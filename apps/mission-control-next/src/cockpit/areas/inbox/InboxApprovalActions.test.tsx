// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApprovalRequest, OperatorInboxItem } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InboxApprovalActions } from "./InboxApprovalActions";
import { __resetInboxApprovalAttemptsForTests } from "./inbox-approval-attempts";

const api = vi.hoisted(() => ({ fetchApprovals: vi.fn(), resolveApproval: vi.fn() }));
const preferences = vi.hoisted(() => ({ activeWorkspaceId: "default" }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => preferences }));

const approval: ApprovalRequest = {
  approvalId: "approval-a",
  kind: "file.write",
  riskLevel: "danger",
  status: "pending",
  payload: {},
  preview: { targets: ["workspace/note.txt"] },
  createdAt: "2026-09-28T00:00:00Z",
  explanationStatus: "pending",
};
const item: OperatorInboxItem = {
  id: "approval:approval-a",
  kind: "approval",
  group: "needs_decision",
  title: "Review file write",
  summary: "Review",
  createdAt: approval.createdAt,
  source: { workspaceId: "default", approvalId: "approval-a" },
  href: "/ops/approvals",
};
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  __resetInboxApprovalAttemptsForTests();
  preferences.activeWorkspaceId = "default";
  api.fetchApprovals.mockReset();
  api.resolveApproval.mockReset();
  api.fetchApprovals.mockResolvedValue({ items: [approval] });
  api.resolveApproval.mockResolvedValue({ approval: { ...approval, status: "approved" }, effects: [] });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  vi.useRealTimers();
});

function renderActions(
  reviewed: ApprovalRequest,
  onResolved = vi.fn<(message: string) => void>(),
  onInvalidated = vi.fn<() => void>(),
  selected = item,
  workspaceId = "default",
) {
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <InboxApprovalActions
          item={selected}
          approval={reviewed}
          workspaceId={workspaceId}
          onResolved={onResolved}
          onInvalidated={onInvalidated}
        />
      </QueryClientProvider>,
    ),
  );
  return { onResolved, onInvalidated };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function approve() {
  await act(async () => button("Review approval").click());
  await act(async () => button("Approve once").click());
}

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find((entry) => entry.textContent === label);
  if (!found) throw new Error(`Missing ${label} button`);
  return found;
}

async function typeConfirmation(value: string) {
  const input = document.body.querySelector<HTMLInputElement>('[role="dialog"] input');
  if (!input) throw new Error("Missing confirmation input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Inbox approval decisions", () => {
  it("explains request changes and unavailable project grants without adding decision authority", async () => {
    renderActions(approval);
    expect(container.textContent).toContain("To change this request, open its source and submit a new request");
    expect(container.textContent).toContain("Editing an approval withdraws the original action");
    expect(container.textContent).toContain("does not authorize a replacement");
    expect(container.textContent).toContain("Project-wide always-allow is unavailable here");
    expect([...container.querySelectorAll("button")].map((entry) => entry.textContent)).toEqual([
      "Review approval",
      "Deny",
    ]);
    expect(api.resolveApproval).not.toHaveBeenCalled();
    await approve();
    expect(api.resolveApproval).toHaveBeenCalledExactlyOnceWith("approval-a", "approve");
  });

  it("requires danger confirmation, then rereads the same pending owner record before approval", async () => {
    const { onResolved } = renderActions(approval);
    await act(async () => button("Review approval").click());
    expect(api.resolveApproval).not.toHaveBeenCalled();
    await act(async () => button("Approve once").click());
    expect(api.fetchApprovals).toHaveBeenCalledWith({ status: "pending", workspaceId: "default", limit: 200 });
    expect(api.resolveApproval).toHaveBeenCalledWith("approval-a", "approve");
    expect(onResolved).toHaveBeenCalledWith(expect.stringContaining("Follow-on execution needs separate verification"));
  });

  it("refuses a changed action even after confirmation", async () => {
    api.fetchApprovals.mockResolvedValue({ items: [{ ...approval, preview: { targets: ["other.txt"] } }] });
    const { onInvalidated } = renderActions(approval);
    await act(async () => button("Review approval").click());
    await act(async () => button("Approve once").click());
    expect(api.resolveApproval).not.toHaveBeenCalled();
    expect(onInvalidated).toHaveBeenCalledOnce();
  });

  it("locks both decisions after a mutation response with an uncertain outcome", async () => {
    api.resolveApproval.mockRejectedValue(new Error("Connection lost"));
    renderActions(approval);
    await act(async () => button("Review approval").click());
    await act(async () => button("Approve once").click());
    expect(api.resolveApproval).toHaveBeenCalledOnce();
    expect(button("Review approval").disabled).toBe(true);
    expect(button("Deny").disabled).toBe(true);
    expect(container.textContent).toContain("Decision outcome is uncertain");
  });

  it("allows another check when the owner read fails before a mutation", async () => {
    api.fetchApprovals.mockRejectedValue(new Error("Connection lost"));
    renderActions(approval);
    await act(async () => button("Review approval").click());
    await act(async () => button("Approve once").click());
    expect(api.resolveApproval).not.toHaveBeenCalled();
    expect(button("Review approval").disabled).toBe(false);
    expect(container.textContent).toContain("Could not check the current approval");
  });

  it("leaves specialist approval decisions in their owner review", () => {
    renderActions({ ...approval, kind: "code_mode.run" });
    expect(container.textContent).toContain("specialist review");
    expect(container.querySelector("button")).toBeNull();
  });

  it.each(["workspace", "selection", "same-id evidence", "unmount"])(
    "cancels before POST when %s changes during the owner read",
    async (change) => {
      const read = deferred<{ items: ApprovalRequest[] }>();
      api.fetchApprovals.mockReturnValue(read.promise);
      const callbacks = renderActions(approval);
      await approve();
      if (change === "workspace") {
        preferences.activeWorkspaceId = "workspace-b";
        renderActions(approval);
      } else if (change === "selection") {
        renderActions({ ...approval, approvalId: "approval-b" }, undefined, undefined, {
          ...item,
          id: "approval:approval-b",
          source: { workspaceId: "default", approvalId: "approval-b" },
        });
      } else if (change === "same-id evidence") {
        renderActions({ ...approval, preview: { targets: ["other.txt"] } });
      } else {
        act(() => root.render(null));
      }
      await act(async () => read.resolve({ items: [approval] }));
      expect(api.resolveApproval).not.toHaveBeenCalled();
      expect(callbacks.onResolved).not.toHaveBeenCalled();
      expect(callbacks.onInvalidated).not.toHaveBeenCalled();
      preferences.activeWorkspaceId = "default";
      renderActions(approval);
      expect(button("Review approval").disabled).toBe(false);
    },
  );

  it("does not carry an open danger or deny confirmation to another selected record", async () => {
    renderActions(approval);
    await act(async () => button("Review approval").click());
    renderActions({ ...approval, preview: { targets: ["new-target.txt"] } });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => button("Deny").click());
    renderActions(approval);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(api.resolveApproval).not.toHaveBeenCalled();
  });

  it("retains the pending and uncertain lock after remount, without notifying the new detail", async () => {
    const result = deferred<{ approval: ApprovalRequest; effects: [] }>();
    api.resolveApproval.mockReturnValue(result.promise);
    const original = renderActions(approval);
    await approve();
    expect(api.resolveApproval).toHaveBeenCalledOnce();
    act(() => root.render(null));
    const next = renderActions(approval);
    expect(button("Review approval").disabled).toBe(true);
    expect(button("Deny").disabled).toBe(true);
    await act(async () => result.reject(new Error("Response lost")));
    expect(original.onResolved).not.toHaveBeenCalled();
    expect(next.onResolved).not.toHaveBeenCalled();
    act(() => root.render(null));
    renderActions(approval);
    expect(container.textContent).toContain("Decision outcome is uncertain");
    expect(button("Review approval").disabled).toBe(true);
    expect(button("Deny").disabled).toBe(true);
    expect(api.resolveApproval).toHaveBeenCalledOnce();
  });

  it("retains a verified decision after navigation without applying its callback to a different selection", async () => {
    const result = deferred<{ approval: ApprovalRequest; effects: [] }>();
    api.resolveApproval.mockReturnValue(result.promise);
    const original = renderActions(approval);
    await approve();
    const next = renderActions({ ...approval, approvalId: "approval-b" }, undefined, undefined, {
      ...item,
      id: "approval:approval-b",
      source: { workspaceId: "default", approvalId: "approval-b" },
    });
    await act(async () => result.resolve({ approval: { ...approval, status: "approved" }, effects: [] }));
    expect(original.onResolved).not.toHaveBeenCalled();
    expect(next.onResolved).not.toHaveBeenCalled();
    expect(button("Review approval").disabled).toBe(false);
    renderActions(approval);
    expect(button("Review approval").disabled).toBe(true);
    expect(container.textContent).toContain("decision recorded");
  });

  it.each([
    { approvalId: "approval-b" },
    { status: "pending" as const },
    { status: "rejected" as const },
    { linkage: { workspaceId: "other" } },
    { preview: { targets: ["other.txt"] } },
  ])("withholds success and retains the lock for a mismatched response %j", async (mismatch) => {
    api.resolveApproval.mockResolvedValue({ approval: { ...approval, status: "approved", ...mismatch }, effects: [] });
    const { onResolved } = renderActions(approval);
    await approve();
    expect(onResolved).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Decision outcome is uncertain");
    expect(button("Deny").disabled).toBe(true);
  });

  it("keeps the original scope lock while another workspace can review its own request", async () => {
    api.resolveApproval.mockRejectedValue(new Error("Response lost"));
    renderActions(approval);
    await approve();
    preferences.activeWorkspaceId = "workspace-b";
    renderActions(
      approval,
      undefined,
      undefined,
      { ...item, source: { ...item.source, workspaceId: "workspace-b" } },
      "workspace-b",
    );
    expect(button("Review approval").disabled).toBe(false);
    preferences.activeWorkspaceId = "default";
    renderActions(approval);
    expect(button("Review approval").disabled).toBe(true);
  });

  it("rechecks and validates a denied receipt separately from approval", async () => {
    api.resolveApproval.mockResolvedValue({ approval: { ...approval, status: "rejected" }, effects: [] });
    const { onResolved } = renderActions(approval);
    await act(async () => button("Deny").click());
    expect(api.resolveApproval).not.toHaveBeenCalled();
    await act(async () => button("Confirm deny").click());
    expect(api.resolveApproval).toHaveBeenCalledWith("approval-a", "reject");
    expect(onResolved).toHaveBeenCalledWith(expect.stringContaining("decision recorded"));
  });

  it("requires the typed nuclear confirmation, then rereads the same pending owner record before approval", async () => {
    const nuclear: ApprovalRequest = { ...approval, riskLevel: "nuclear" };
    api.fetchApprovals.mockResolvedValue({ items: [nuclear] });
    api.resolveApproval.mockResolvedValue({ approval: { ...nuclear, status: "approved" }, effects: [] });
    const { onResolved } = renderActions(nuclear);
    await act(async () => button("Review approval").click());
    expect(button("Approve once").disabled).toBe(true);
    await typeConfirmation("approve");
    expect(button("Approve once").disabled).toBe(false);
    expect(api.fetchApprovals).not.toHaveBeenCalled();
    expect(api.resolveApproval).not.toHaveBeenCalled();
    await act(async () => button("Approve once").click());
    expect(api.fetchApprovals).toHaveBeenCalledWith({ status: "pending", workspaceId: "default", limit: 200 });
    expect(api.resolveApproval).toHaveBeenCalledExactlyOnceWith("approval-a", "approve");
    expect(onResolved).toHaveBeenCalledWith(expect.stringContaining("decision recorded"));
  });

  it("closes an open nuclear confirmation when its reviewed evidence changes", async () => {
    renderActions({ ...approval, riskLevel: "nuclear" });
    await act(async () => button("Review approval").click());
    await typeConfirmation("approve");
    expect(button("Approve once").disabled).toBe(false);
    renderActions({ ...approval, riskLevel: "nuclear", preview: { targets: ["new-target.txt"] } });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => button("Review approval").click());
    expect(button("Approve once").disabled).toBe(true);
    expect(api.fetchApprovals).not.toHaveBeenCalled();
    expect(api.resolveApproval).not.toHaveBeenCalled();
  });

  it("refuses a record that expires while its owner read is pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T00:00:00Z"));
    const reviewed = { ...approval, expiresAt: "2026-09-30T00:00:01Z" };
    const read = deferred<{ items: ApprovalRequest[] }>();
    api.fetchApprovals.mockReturnValue(read.promise);
    renderActions(reviewed);
    await approve();
    vi.setSystemTime(new Date("2026-09-30T00:00:02Z"));
    await act(async () => read.resolve({ items: [reviewed] }));
    expect(api.resolveApproval).not.toHaveBeenCalled();
  });
});
