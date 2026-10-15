// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { __resetApprovalOperationAttemptsForTests } from "./approval-operation-attempts";
import { InboxBulkRejectZone } from "./InboxBulkRejectZone";
const api = vi.hoisted(() => ({ bulk: vi.fn(), list: vi.fn(), workspaces: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({
  resolveApprovalsBulk: api.bulk,
  fetchApprovals: api.list,
}));
vi.mock("@goatcitadel/mission-control-shared/api/workspaces", () => ({ fetchWorkspaces: api.workspaces }));
const pending = (id: string, workspaceId: string): ApprovalRequest => ({
  approvalId: id,
  kind: "tool.invoke",
  status: "pending",
  riskLevel: "caution",
  explanationStatus: "not_requested",
  payload: {},
  preview: {},
  linkage: { workspaceId },
  createdAt: "2026-01-01T00:00:00Z",
});
let root: Root, host: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  __resetApprovalOperationAttemptsForTests();
  api.bulk.mockReset();
  api.list.mockReset();
  api.workspaces.mockReset().mockResolvedValue({ items: [] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <InboxBulkRejectZone />
      </QueryClientProvider>,
    ),
  );
  await settle();
}
const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (item) => !item.closest('[aria-hidden="true"]') && item.textContent === name,
  )!;

it("stays hidden while nothing is pending anywhere in the installation", async () => {
  api.list.mockResolvedValue({ items: [] });
  await render();
  expect(api.list).toHaveBeenCalledWith({ status: "pending", limit: 200 });
  expect(host.textContent).toBe("");
});

it("stays hidden when the pending read fails", async () => {
  api.list.mockRejectedValue(new Error("Gateway unavailable"));
  await render();
  expect(host.textContent).toBe("");
});

it("shows a separate danger zone that names its installation-wide reach", async () => {
  api.list.mockResolvedValue({ items: [pending("a", "one")] });
  await render();
  expect(host.querySelector("h2")?.textContent).toBe("Reject everything pending");
  expect(host.textContent).toContain("This applies to every workspace in the installation");
  expect(button("Review installation-wide rejection").className).toContain("text-status-failed");
});

it("refreshes every approval read, the Inbox included, after a bulk rejection and keeps the receipt", async () => {
  api.list.mockResolvedValue({ items: [pending("a", "one"), pending("b", "two")] });
  api.bulk.mockResolvedValue({ resolvedCount: 2, skippedCount: 0, failedCount: 0 });
  await render();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  await act(async () => button("Review installation-wide rejection").click());
  await settle();
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "reject all");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  api.list.mockResolvedValue({ items: [] });
  await act(async () => button("Confirm installation-wide rejection").click());
  await settle();
  expect(api.bulk).toHaveBeenCalledOnce();
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["approvals"] });
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Rejected 2. Skipped 0. Failed 0.");
  invalidate.mockRestore();
});
