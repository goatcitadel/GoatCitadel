// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { APPROVAL_EXPIRY_ACTOR_ID, type ApprovalRequest } from "@goatcitadel/contracts";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { InboxApprovalHistory } from "./InboxApprovalHistory";
import { notifyGatewayAccessChanged } from "@goatcitadel/mission-control-shared/api/access-scope";
import { __resetApprovalOperationAttemptsForTests } from "./approval-operation-attempts";
import { queryKeys } from "../../data/query-keys";
const api = vi.hoisted(() => ({ list: vi.fn(), bulk: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({
  fetchApprovals: api.list,
  resolveApprovalsBulk: api.bulk,
}));
vi.mock("./LinkedApproval", () => ({
  LinkedApproval: ({ approvalId }: { approvalId: string }) => <p>Selected {approvalId}</p>,
}));
const record = (id: string, workspaceId = "one"): ApprovalRequest => ({
  approvalId: id,
  kind: "tool.invoke",
  status: "rejected",
  riskLevel: "caution",
  explanationStatus: "not_requested",
  payload: {},
  preview: {},
  linkage: { workspaceId },
  createdAt: "2026-01-01T00:00:00Z",
});
let root: Root, host: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  window.history.replaceState({}, "", "/inbox?keep=yes#anchor");
  __resetApprovalOperationAttemptsForTests();
  api.list.mockReset();
  api.bulk.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});
async function render(workspaceId = "one") {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <InboxApprovalHistory workspaceId={workspaceId} />
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    ),
  );
}
async function click(name: string) {
  const button = [...host.querySelectorAll("button")].find(
    (item) => (item.getAttribute("aria-label") ?? item.textContent) === name,
  )!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
it("uses workspace-bound server cursors and server status filters, including empty filtered pages", async () => {
  api.list.mockImplementation(async ({ status, cursor }) =>
    status
      ? { items: [record("status")] }
      : cursor
        ? { items: [record("older")] }
        : { items: [record("recent")], nextCursor: "cursor-one" },
  );
  await render();
  await click("Approval history and replay");
  await click("Load more approvals");
  expect(api.list).toHaveBeenNthCalledWith(2, { workspaceId: "one", limit: 100, cursor: "cursor-one" });
  await click("Inspect decision older");
  expect(new URLSearchParams(window.location.search).get("approvalId")).toBe("older");
  expect(window.location.search).toContain("keep=yes");
  expect(window.location.hash).toBe("#anchor");
  expect(host.textContent).toContain("End of retained approval history");
  await act(async () => {
    const select = host.querySelector("select")!;
    select.value = "rejected";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await vi.waitFor(() =>
    expect(api.list).toHaveBeenLastCalledWith({
      workspaceId: "one",
      limit: 100,
      cursor: undefined,
      status: "rejected",
    }),
  );
});
it("withholds foreign pages and retains useful pagination failures", async () => {
  api.list
    .mockResolvedValueOnce({ items: [record("recent")], nextCursor: "next" })
    .mockRejectedValueOnce(new Error("history unavailable"));
  await render();
  await click("Approval history and replay");
  await click("Load more approvals");
  expect(host.textContent).toContain("history unavailable");
  expect(host.textContent).toContain("Retained pages may be stale");
  expect(host.textContent).not.toContain("End of retained");
  api.list.mockResolvedValue({ items: [record("foreign", "other")] });
  await render("other-scope");
  await click("Approval history and replay");
  expect(host.textContent).toContain("outside this workspace");
  expect(host.querySelector('[aria-label="Inspect decision foreign"]')).toBeNull();
});
it("labels an expiry sweep as expired and shows who settled an operator decision", async () => {
  api.list.mockResolvedValue({
    items: [
      {
        ...record("expired"),
        resolvedBy: APPROVAL_EXPIRY_ACTOR_ID,
        resolutionNote: "Approval expired expired before operator resolution.",
      },
      { ...record("bulk"), resolvedBy: "operator:ana", resolutionNote: "Bulk rejected from the approvals queue." },
      { ...record("plain") },
    ],
  });
  await render();
  await click("Approval history and replay");
  const card = (id: string) =>
    host.querySelector(`[aria-label="Inspect decision ${id}"]`)?.closest("article")?.textContent ?? "";
  const expired = card("expired");
  const bulk = card("bulk");
  const plain = card("plain");
  expect(expired).not.toBe("");
  expect(expired).toContain("Tool invoke · Expired ·");
  expect(expired).toContain("Expired without an operator decision. Approval expired expired before operator resolution.");
  expect(expired).not.toContain("Rejected");
  expect(bulk).toContain("Tool invoke · Rejected ·");
  expect(bulk).toContain("Decided by operator:ana. Bulk rejected from the approvals queue.");
  expect(plain).toContain("Tool invoke · Rejected ·");
  expect(plain).not.toContain("Decided by");
});

it("refreshes the pending Inbox projection and every approval read after an installation-wide rejection", async () => {
  api.list.mockResolvedValue({ items: [record("recent")] });
  api.bulk.mockResolvedValue({ resolvedCount: 1, skippedCount: 0, failedCount: 0 });
  await render();
  await click("Approval history and replay");
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const dialogButton = (name: string) =>
    [...document.body.querySelectorAll("button")].find(
      (item) => !item.closest('[aria-hidden="true"]') && item.textContent === name,
    )!;
  await act(async () => dialogButton("Review installation-wide rejection").click());
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "reject all");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => dialogButton("Confirm installation-wide rejection").click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(api.bulk).toHaveBeenCalledOnce();
  expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.inbox("one") });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["approvals"] });
  invalidate.mockRestore();
});

it("does not expose retained history after a caller transition", async () => {
  api.list.mockResolvedValue({ items: [record("private")] });
  await render();
  await click("Approval history and replay");
  expect(host.querySelector('[aria-label="Inspect decision private"]')).not.toBeNull();
  await act(async () => notifyGatewayAccessChanged());
  expect(host.querySelector('[aria-label="Inspect decision private"]')).toBeNull();
});
