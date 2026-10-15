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

it("denies with a neutral secondary button and confirms the deny as primary, because denying is safe", async () => {
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
  expect(button("Review approval").className).toContain("text-status-failed");
  await act(async () => deny.click());
  expect(button("Confirm deny").className).toContain("bg-accent");
  expect(api.resolveApproval).not.toHaveBeenCalled();
});
