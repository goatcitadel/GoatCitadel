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

type DialogProps = Partial<Parameters<typeof SettingsApprovalDialog>[0]>;

async function render(onResolved = vi.fn(), props: DialogProps = {}) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <SettingsApprovalDialog approvalId="approval-1" onResolved={onResolved} {...props} />
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

/** Every option object `fetchApproval` was read with. */
const readOptions = () => fetchApproval.mock.calls.map(([, options]) => (options ?? {}) as Record<string, unknown>);

it("leaves Settings approvals scoped to their workspace", async () => {
  const onResolved = await render();
  expect(fetchApproval).toHaveBeenCalledWith("approval-1", { workspaceId: "default", signal: expect.any(AbortSignal) });
  expect(decisionBar).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: "default" }));
  await act(async () => button("Approve once")!.click());
  // The status after the decision is read in the same workspace.
  expect(readOptions().every((options) => options.workspaceId === "default")).toBe(true);
  expect(onResolved).toHaveBeenCalledTimes(1);

  // Settings keeps its own words: the title for a change without one, and how to recover from a failed read.
  act(() => root.unmount());
  root = createRoot(container);
  __resetSettingsApprovalDialogsForTests();
  client.clear();
  fetchApproval.mockResolvedValue({ ...approval, approvalId: "approval-1", preview: {} });
  await render();
  expect(dialog()?.textContent).toContain("Approve this Settings change?");
  act(() => root.unmount());
  root = createRoot(container);
  client.clear();
  fetchApproval.mockRejectedValue(new Error("offline"));
  await render();
  expect(container.textContent).toBe(
    "The approval for this change could not be loaded. Use Refresh change status, or decide it in Inbox.",
  );
});

it("reads a skill approval without a workspace and approves it in one click", async () => {
  fetchApproval.mockResolvedValue({ ...approval, kind: "skill.lifecycle", preview: {} });
  const onResolved = await render(vi.fn(), {
    workspaceId: null,
    title: "Approve this skill change?",
    loadFailureHint: "Decide it in Inbox.",
  });
  // A skill approval belongs to no workspace, so a read scoped to one would find nothing.
  expect(fetchApproval).toHaveBeenCalledWith("approval-1", { signal: expect.any(AbortSignal) });
  expect(dialog()?.textContent).toContain("Approve this skill change?");
  expect(decisionBar).toHaveBeenLastCalledWith(
    expect.objectContaining({ workspaceId: null, reviewedInPlace: true, compact: true }),
  );

  await act(async () => button("Approve once")!.click());
  expect(onResolved).toHaveBeenCalledTimes(1);
  expect(dialog()).toBeNull();
  // Every read, the one after the decision included, was without a workspace.
  expect(fetchApproval.mock.calls.length).toBeGreaterThan(1);
  expect(readOptions().every((options) => !("workspaceId" in options))).toBe(true);
});

it("says a skill approval that can't be read is decided in Inbox", async () => {
  fetchApproval.mockRejectedValue(new Error("offline"));
  await render(vi.fn(), { workspaceId: null, loadFailureHint: "Decide it in Inbox." });
  expect(container.textContent).toBe("The approval for this change could not be loaded. Decide it in Inbox.");
});
