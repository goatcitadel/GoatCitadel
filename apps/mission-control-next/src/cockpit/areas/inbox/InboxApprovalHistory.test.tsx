// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { InboxApprovalHistory } from "./InboxApprovalHistory";
import { notifyGatewayAccessChanged } from "@goatcitadel/mission-control-shared/api/access-scope";
const api = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ fetchApprovals: api.list }));
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
  api.list.mockReset();
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
it("does not expose retained history after a caller transition", async () => {
  api.list.mockResolvedValue({ items: [record("private")] });
  await render();
  await click("Approval history and replay");
  expect(host.querySelector('[aria-label="Inspect decision private"]')).not.toBeNull();
  await act(async () => notifyGatewayAccessChanged());
  expect(host.querySelector('[aria-label="Inspect decision private"]')).toBeNull();
});
