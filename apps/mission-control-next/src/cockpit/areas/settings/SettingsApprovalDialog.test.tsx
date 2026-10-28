// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fetchApproval = vi.hoisted(() => vi.fn());
const decisionBar = vi.hoisted(() => vi.fn());
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ fetchApproval }));
vi.mock("../../../features/native-routes/projects/use-project-access", () => ({
  useProjectAccess: () => ({ identity: "access-1" }),
}));
vi.mock("../inbox/ApprovalReviewSummary", () => ({
  ApprovalReviewSummary: () => <p>Full review evidence</p>,
}));
vi.mock("../inbox/ApprovalDecisionBar", () => ({
  ApprovalDecisionBar: (props: { reviewedInPlace?: boolean; compact?: boolean; onResolved: (m: string) => void }) => {
    decisionBar(props);
    return (
      <button type="button" onClick={() => props.onResolved("Approved.")}>
        Approve once
      </button>
    );
  },
}));

import { __resetSettingsApprovalDialogsForTests, SettingsApprovalDialog } from "./SettingsApprovalDialog";

const approval: ApprovalRequest = {
  approvalId: "approval-1",
  kind: "change_plan_effect",
  riskLevel: "danger",
  status: "pending",
  payload: {},
  preview: {
    title: "Change the network allowlist",
    summary: "Replace the network allowlist with 23 reviewed entries.",
    impact: "Provider and tool egress is recalculated from the exact reviewed list.",
  },
  createdAt: "2026-10-28T00:00:00Z",
  explanationStatus: "not_requested",
};

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find((element) => element.textContent?.trim() === label);
const dialog = () => document.body.querySelector('[role="dialog"]');

async function render(onResolved = vi.fn()) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <SettingsApprovalDialog approvalId="approval-1" onResolved={onResolved} />
      </QueryClientProvider>,
    ),
  );
  // The approval read settles through the query cache over a few ticks.
  for (let tick = 0; tick < 5; tick += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  return onResolved;
}

beforeEach(() => {
  __resetSettingsApprovalDialogsForTests();
  fetchApproval.mockReset().mockResolvedValue(approval);
  decisionBar.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

it("opens the approval where the change was saved, with the review collapsed and a one-click Approve", async () => {
  await render();
  expect(dialog()?.textContent).toContain("Change the network allowlist");
  expect(dialog()?.textContent).toContain("Provider and tool egress is recalculated");
  const details = dialog()!.querySelector("details")!;
  expect(details.open).toBe(false);
  expect(details.querySelector("summary")?.textContent).toBe("Show details");
  expect(decisionBar).toHaveBeenLastCalledWith(expect.objectContaining({ reviewedInPlace: true, compact: true }));
});

it("closes and settles the change after one Approve click", async () => {
  const onResolved = await render();
  await act(async () => button("Approve once")!.click());
  expect(onResolved).toHaveBeenCalledTimes(1);
  expect(dialog()).toBeNull();
});

it("does not reopen an approval the operator closed, but keeps a way back to it", async () => {
  await render();
  await act(async () => document.body.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!.click());
  expect(dialog()).toBeNull();
  act(() => root.unmount());
  root = createRoot(container);
  await render();
  expect(dialog()).toBeNull();
  await act(async () => button("Review approval")!.click());
  expect(dialog()).not.toBeNull();
});

it("offers nothing to approve once the approval is no longer pending", async () => {
  fetchApproval.mockResolvedValue({ ...approval, status: "approved" });
  await render();
  expect(dialog()).toBeNull();
  expect(button("Review approval")).toBeUndefined();
});
