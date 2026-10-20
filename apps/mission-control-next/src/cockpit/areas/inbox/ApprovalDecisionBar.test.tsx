// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApprovalDecisionBar } from "./ApprovalDecisionBar";
import { __resetInboxApprovalAttemptsForTests } from "./inbox-approval-attempts";

const api = vi.hoisted(() => ({ fetchApproval: vi.fn(), resolveApproval: vi.fn() }));
const preferences = vi.hoisted(() => ({ activeWorkspaceId: "default", showTechnicalDetails: false }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ resolveApproval: api.resolveApproval }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ fetchApproval: api.fetchApproval }));
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
let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  __resetInboxApprovalAttemptsForTests();
  api.fetchApproval.mockReset().mockResolvedValue(approval);
  api.resolveApproval.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});
const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find(
    (entry) => !entry.closest('[aria-hidden="true"]') && entry.textContent === label,
  )!;

const renderBar = async (record: ApprovalRequest) =>
  act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ApprovalDecisionBar approval={record} workspaceId="default" onResolved={vi.fn()} onInvalidated={vi.fn()} />
      </QueryClientProvider>,
    ),
  );

it("denies in one neutral click, because denying is the safe choice", async () => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ApprovalDecisionBar approval={approval} workspaceId="default" onResolved={vi.fn()} onInvalidated={vi.fn()} />
      </QueryClientProvider>,
    ),
  );
  const deny = button("Deny");
  expect(deny.className).toContain("bg-raised");
  expect(deny.className).not.toContain("text-status-failed");
  expect(button("Review danger approval").className).toContain("text-status-failed");
  api.resolveApproval.mockResolvedValue({ approval: { ...approval, status: "rejected" }, effects: [] });
  await act(async () => deny.click());
  expect(document.body.querySelector("[role=dialog]")).toBeNull();
  expect(api.resolveApproval).toHaveBeenCalledExactlyOnceWith("approval-a", "reject");
});

it("shows Expired before the missing-preview message", async () => {
  await renderBar({ ...approval, preview: {}, expiresAt: "2020-01-01T00:00:00Z" });
  expect(document.body.textContent).toContain("has expired and can no longer be decided");
  expect(document.body.textContent).not.toContain("can't be decided yet");
});

it("treats a malformed expiresAt as not expired, as the list does", async () => {
  await renderBar({ ...approval, expiresAt: "not-a-date" });
  expect(button("Deny")).toBeDefined();
  expect(document.body.textContent).not.toContain("has expired");
});

it("leaves the expiry to the surrounding view and states the disclaimer once", async () => {
  await renderBar({ ...approval, expiresAt: "2099-01-01T00:00:00Z" });
  const text = document.body.textContent ?? "";
  expect(text).not.toContain("Expiry:");
  expect(text.split(/does not prove the action ran/).length - 1).toBe(1);
});
