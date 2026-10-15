// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { __resetApprovalOperationAttemptsForTests } from "./approval-operation-attempts";
import { ApprovalBulkReject } from "./ApprovalBulkReject";
import {
  notifyGatewayAccessChanged,
  setGatewayCallerScope,
} from "@goatcitadel/mission-control-shared/api/access-scope";
const api = vi.hoisted(() => ({ bulk: vi.fn(), list: vi.fn(), workspaces: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({
  resolveApprovalsBulk: api.bulk,
  fetchApprovals: api.list,
}));
vi.mock("@goatcitadel/mission-control-shared/api/workspaces", () => ({ fetchWorkspaces: api.workspaces }));
const bulk = api.bulk;
const pending = (id: string, workspaceId?: string): ApprovalRequest => ({
  approvalId: id,
  kind: "tool.invoke",
  status: "pending",
  riskLevel: "caution",
  explanationStatus: "not_requested",
  payload: {},
  preview: {},
  linkage: workspaceId ? { workspaceId } : undefined,
  createdAt: "2026-01-01T00:00:00Z",
});
let root: Root, host: HTMLDivElement, client: QueryClient;
function view() {
  return (
    <QueryClientProvider client={client}>
      <ApprovalBulkReject onResolved={vi.fn()} />
    </QueryClientProvider>
  );
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
beforeEach(async () => {
  __resetApprovalOperationAttemptsForTests();
  bulk.mockReset();
  api.list.mockReset().mockResolvedValue({ items: [pending("a", "one"), pending("b", "one"), pending("c", "two")] });
  api.workspaces.mockReset().mockResolvedValue({
    items: [
      { workspaceId: "one", name: "Alpha" },
      { workspaceId: "two", name: "Beta" },
    ],
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(view()));
  await settle();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});
function button(name: string) {
  return [...document.querySelectorAll("button")].find(
    (item) => !item.closest('[aria-hidden="true"]') && item.textContent === name,
  )!;
}
async function click(name: string) {
  await act(async () => button(name).click());
  await settle();
}
async function type(value = "reject all") {
  const input = document.querySelector('[role="dialog"] input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const dialogText = () => document.querySelector('[role="dialog"]')?.textContent ?? "";
const confirmDisabled = () => button("Confirm installation-wide rejection").disabled;

it("requires typed installation-wide review, cancels without effects and permits a fresh review after a canonical receipt", async () => {
  await click("Review installation-wide rejection");
  expect(confirmDisabled()).toBe(true);
  await type();
  await click("Cancel");
  expect(bulk).not.toHaveBeenCalled();
  bulk.mockResolvedValue({ resolvedCount: 2, skippedCount: 0, failedCount: 0 });
  await click("Review installation-wide rejection");
  await type();
  await click("Confirm installation-wide rejection");
  expect(bulk).toHaveBeenCalledExactlyOnceWith({
    decision: "reject",
    status: "pending",
    resolutionNote: "Bulk rejected from the approvals queue.",
  });
  await click("Cancel");
  await click("Review installation-wide rejection");
  await type();
  await click("Confirm installation-wide rejection");
  expect(bulk).toHaveBeenCalledTimes(2);
});

it("states how many requests it rejects, across which workspaces, before confirming", async () => {
  await click("Review installation-wide rejection");
  expect(api.list).toHaveBeenLastCalledWith({ status: "pending", limit: 200 });
  expect(dialogText()).toContain("Rejects 3 pending requests across 2 workspaces.");
  expect(dialogText()).toContain("Workspaces: Alpha, Beta.");
  expect(dialogText()).toContain("Pending requests may change while this review is open.");
});

it("uses singular wording and counts a workspace with no name here without printing its ID", async () => {
  api.list.mockResolvedValue({ items: [pending("a", "unknown")] });
  await click("Review installation-wide rejection");
  expect(dialogText()).toContain("Rejects 1 pending request across 1 workspace.");
  expect(dialogText()).toContain("Workspaces: 1 unnamed workspace.");
  expect(dialogText()).not.toContain("unknown");
});

it("says at least 200 when more pending requests exist than one read returns", async () => {
  const items = Array.from({ length: 200 }, (_, index) => pending(`p${index}`, index % 2 ? "one" : "two"));
  api.list.mockResolvedValue({ items, nextCursor: "more" });
  await click("Review installation-wide rejection");
  expect(dialogText()).toContain("Rejects at least 200 pending requests across at least 2 workspaces.");
});

it("keeps confirm unavailable while the scope is loading", async () => {
  api.list.mockImplementation(() => new Promise(() => undefined));
  await click("Review installation-wide rejection");
  await type();
  expect(dialogText()).toContain("Checking how many requests are pending");
  expect(confirmDisabled()).toBe(true);
});

it("keeps confirm unavailable when the scope cannot be checked", async () => {
  api.list.mockRejectedValue(new Error("Gateway unavailable"));
  await click("Review installation-wide rejection");
  await type();
  expect(dialogText()).toContain("The scope couldn't be checked, so rejection stays unavailable.");
  expect(confirmDisabled()).toBe(true);
  await act(async () => button("Confirm installation-wide rejection").click());
  expect(bulk).not.toHaveBeenCalled();
});

it("keeps confirm unavailable when nothing is pending", async () => {
  api.list.mockResolvedValue({ items: [] });
  await click("Review installation-wide rejection");
  await type();
  expect(dialogText()).toContain("There is nothing pending to reject.");
  expect(confirmDisabled()).toBe(true);
});

it("accepts the phrase in any case with surrounding spaces, shown in monospace", async () => {
  await click("Review installation-wide rejection");
  expect(document.querySelector('[role="dialog"] code')?.textContent).toBe("reject all");
  await type("reject");
  expect(confirmDisabled()).toBe(true);
  await type("  Reject ALL ");
  expect(confirmDisabled()).toBe(false);
});

it("retains an unconfirmed response lock and closes review on caller change", async () => {
  bulk.mockRejectedValue(new Error("lost response"));
  await click("Review installation-wide rejection");
  await type();
  await click("Confirm installation-wide rejection");
  await click("Cancel");
  await click("Review installation-wide rejection");
  await type();
  expect(confirmDisabled()).toBe(true);
  expect(bulk).toHaveBeenCalledOnce();
  await act(async () => notifyGatewayAccessChanged());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("preserves a lost response through history collapse and remount", async () => {
  bulk.mockRejectedValue(new Error("response lost"));
  await click("Review installation-wide rejection");
  await type();
  await click("Confirm installation-wide rejection");
  await act(async () => root.render(null));
  await act(async () => root.render(view()));
  await click("Review installation-wide rejection");
  await type();
  expect(confirmDisabled()).toBe(true);
  expect(bulk).toHaveBeenCalledOnce();
});

it("keeps an interrupted caller operation locked after switching away and back", async () => {
  await act(async () => setGatewayCallerScope("caller-a"));
  let reject!: (error: Error) => void;
  bulk.mockImplementation(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  await click("Review installation-wide rejection");
  await type();
  await click("Confirm installation-wide rejection");
  await act(async () => setGatewayCallerScope("caller-b"));
  await act(async () => reject(new Error("late response lost")));
  await act(async () => setGatewayCallerScope("caller-a"));
  await click("Review installation-wide rejection");
  await type();
  expect(confirmDisabled()).toBe(true);
  expect(bulk).toHaveBeenCalledOnce();
  await act(async () => setGatewayCallerScope(""));
});
