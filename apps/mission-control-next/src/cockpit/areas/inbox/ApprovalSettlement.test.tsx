// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApprovalSettlement } from "./ApprovalSettlement";

const mocks = vi.hoisted(() => ({ read: vi.fn(), plan: vi.fn(), accessIdentity: "access-a" }));
vi.mock("./approval-follow-on", () => ({ readApprovalFollowOn: mocks.read }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({ fetchChangePlan: mocks.plan }));
vi.mock("../../../features/native-routes/projects/use-project-access", () => ({
  useProjectAccess: () => ({ identity: mocks.accessIdentity, current: () => true }),
}));

const approval = { approvalId: "approval-a", status: "approved", kind: "tool_invoke" } as ApprovalRequest;
const state = (effect: string, run: string, runId = "run-a", wait = "completed", waitId = "wait-a") => ({
  replay: { approval, effects: [{ effectId: "effect-a", status: effect }], events: [] },
  run: { runId, status: run },
  wait: { runId: waitId, status: wait },
});
type FollowOnState = ReturnType<typeof state>;
let client: QueryClient;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  notifyManager.setNotifyFunction((callback) => {
    act(callback);
  });
  mocks.read.mockReset();
  mocks.accessIdentity = "access-a";
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  notifyManager.setNotifyFunction((callback) => callback());
});

async function render(notify: () => void) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ApprovalSettlement approval={approval} workspaceId="default" onFollowOnChange={notify} />
      </QueryClientProvider>,
    ),
  );
}

async function waitForRefresh(fetching: boolean) {
  await vi.waitFor(async () => {
    await act(async () => {});
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Refresh follow-on work",
    );
    expect(button?.disabled).toBe(fetching);
  });
}

async function refresh(next: FollowOnState) {
  let resolve!: (value: FollowOnState) => void;
  mocks.read.mockReturnValueOnce(
    new Promise<FollowOnState>((done) => {
      resolve = done;
    }),
  );
  await act(async () => {
    void client.invalidateQueries({ queryKey: ["approval-settlement"] });
  });
  // Keep the owner request open until React displays its fetching state, then
  // wait for the new outcome to render. Query invalidation alone does not wait
  // for React Query's batched observer notifications or the component effect.
  await waitForRefresh(true);
  await act(async () => resolve(next));
  await waitForRefresh(false);
}

it("notifies Chat when a slow effect or linked run changes, without refreshing on identical polls", async () => {
  mocks.read.mockResolvedValue(state("running", "waiting"));
  const notify = vi.fn();
  await render(notify);
  await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
  await refresh(state("running", "waiting"));
  expect(notify).toHaveBeenCalledTimes(1);
  await refresh(state("completed", "running"));
  expect(notify).toHaveBeenCalledTimes(2);
  await refresh(state("completed", "completed"));
  expect(notify).toHaveBeenCalledTimes(3);
  expect(container.textContent).toContain("Original linked work: Done");
});

it("shows background checking as quiet text instead of a live region", async () => {
  mocks.read.mockResolvedValue(state("completed", "completed"));
  await render(vi.fn());
  await waitForRefresh(false);
  let resolve!: (value: FollowOnState) => void;
  mocks.read.mockReturnValueOnce(
    new Promise<FollowOnState>((done) => {
      resolve = done;
    }),
  );
  await act(async () => {
    void client.invalidateQueries({ queryKey: ["approval-settlement"] });
  });
  await waitForRefresh(true);
  const checking = [...container.querySelectorAll("p")].find((node) =>
    node.textContent?.includes("Checking follow-on work"),
  );
  expect(checking).toBeDefined();
  expect(checking?.closest('[role="status"], [role="alert"], [aria-live]')).toBeNull();
  await act(async () => resolve(state("completed", "completed")));
  await waitForRefresh(false);
  const live = [...container.querySelectorAll('[role="status"]')].map((node) => node.textContent);
  expect(live.some((text) => text?.includes("Original linked work: Done"))).toBe(true);
  expect(live.some((text) => text?.includes("Checking canonical"))).toBe(false);
});

it("uses the current callback only when a follow-on outcome changes", async () => {
  mocks.read.mockResolvedValue(state("completed", "completed"));
  const original = vi.fn();
  const current = vi.fn();
  await render(original);
  await vi.waitFor(() => expect(original).toHaveBeenCalledTimes(1));
  await render(current);
  expect(current).not.toHaveBeenCalled();
  await refresh(state("completed", "completed"));
  expect(current).not.toHaveBeenCalled();
  await refresh(state("completed", "failed"));
  expect(original).toHaveBeenCalledTimes(1);
  expect(current).toHaveBeenCalledTimes(1);
});

it("refreshes Chat after the access identity changes even when cached outcomes match", async () => {
  const outcome = state("completed", "completed");
  mocks.read.mockResolvedValue(outcome);
  const notify = vi.fn();
  await render(notify);
  await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
  client.setQueryData(["approval-settlement", "default", approval.approvalId, "access-b"], outcome);
  mocks.accessIdentity = "access-b";
  await render(notify);
  await waitForRefresh(false);
  expect(notify).toHaveBeenCalledTimes(2);
  await refresh(outcome);
  expect(notify).toHaveBeenCalledTimes(2);
});

it("refreshes Chat when linked execution or approval-wait identity changes at the same status", async () => {
  mocks.read.mockResolvedValue(state("completed", "completed"));
  const notify = vi.fn();
  await render(notify);
  await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
  await refresh(state("completed", "completed", "run-b"));
  expect(notify).toHaveBeenCalledTimes(2);
  await refresh(state("completed", "completed", "run-b", "completed", "wait-b"));
  expect(notify).toHaveBeenCalledTimes(3);
  await refresh(state("completed", "completed", "run-b", "completed", "wait-b"));
  expect(notify).toHaveBeenCalledTimes(3);
});

it("keeps settlement inspection in native history while preserving scoped conversation/run/query/fragment context", async () => {
  const prior = window.location.href;
  const priorState = window.history.state;
  try {
    window.history.replaceState(
      { retained: "state" },
      "",
      "/chat?workspaceId=stale&approvalId=stale&sessionId=session%2Fone&runId=original%3Atwo&keep=yes&shell=classic&shellScope=visit#receipt",
    );
    mocks.read.mockResolvedValue(state("completed", "completed"));
    const notify = vi.fn();
    await render(notify);
    await waitForRefresh(false);
    const link = [...container.querySelectorAll("a")].find(
      (item) => item.textContent?.trim() === "Inspect decision and execution record",
    )!;
    expect(link).toBeDefined();
    const target = new URL(link.href);
    expect(target.pathname).toBe("/inbox");
    expect(target.searchParams.get("approvalId")).toBe("approval-a");
    expect(target.searchParams.get("workspaceId")).toBe("default");
    expect(target.searchParams.get("sessionId")).toBe("session/one");
    expect(target.searchParams.get("runId")).toBe("original:two");
    expect(target.searchParams.get("keep")).toBe("yes");
    expect(target.searchParams.get("shell")).toBe("cockpit");
    expect(target.searchParams.has("shellScope")).toBe(false);
    expect(target.hash).toBe("#receipt");
    expect(container.textContent).toContain("Original linked work: Done");
    expect(notify).toHaveBeenCalled();
    expect(window.history.state).toEqual({ retained: "state" });
  } finally {
    window.history.replaceState(priorState, "", prior);
  }
});

const planApproval = {
  approvalId: "approval-plan",
  status: "approved",
  kind: "change_plan_effect",
  payload: { planId: "plan-a" },
  linkage: { workspaceId: "default", actionType: "change_plan_effect" },
} as unknown as ApprovalRequest;

async function renderPlanApproval() {
  mocks.read.mockResolvedValue({ replay: { approval: planApproval, effects: [], events: [] } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ApprovalSettlement approval={planApproval} workspaceId="default" />
      </QueryClientProvider>,
    ),
  );
}

it("reports the linked change's result for a change-plan approval instead of a missing run (#496)", async () => {
  mocks.plan.mockResolvedValue({
    planId: "plan-a",
    status: "completed",
    approvalRefs: ["approval-plan"],
    origin: { workspaceId: "default", surface: "settings" },
    result: { summary: "Claude Code CLI: reuse one process between tool steps is now off." },
  });
  await renderPlanApproval();
  await vi.waitFor(() => expect(container.textContent).toContain("Applied."));
  expect(container.textContent).toContain("Claude Code CLI: reuse one process between tool steps is now off.");
  expect(container.textContent).not.toContain("No original run was found");
  expect(mocks.plan).toHaveBeenCalledWith("plan-a", { workspaceId: "default" });
});

it("does not report a change that is not bound to this approval", async () => {
  mocks.plan.mockResolvedValue({
    planId: "plan-a",
    status: "completed",
    approvalRefs: ["another-approval"],
    origin: { workspaceId: "default", surface: "settings" },
    result: { summary: "Something else is now on." },
  });
  await renderPlanApproval();
  await vi.waitFor(() => expect(container.textContent).toContain("The linked change could not be checked."));
  expect(container.textContent).not.toContain("Something else is now on.");
  expect(container.textContent).not.toContain("Applied.");
});

it("reads a Chat change plan with its conversation, which the owner requires", async () => {
  const chatApproval = {
    ...planApproval,
    linkage: { workspaceId: "default", sessionId: "session-a", turnId: "turn-a", actionType: "change_plan_effect" },
  } as unknown as ApprovalRequest;
  mocks.plan.mockResolvedValue({
    planId: "plan-a",
    status: "completed",
    approvalRefs: ["approval-plan"],
    origin: { workspaceId: "default", surface: "chat", sessionId: "session-a", turnId: "turn-a" },
    result: { summary: "The Chat model is now reviewed-model." },
  });
  mocks.read.mockResolvedValue({ replay: { approval: chatApproval, effects: [], events: [] } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ApprovalSettlement approval={chatApproval} workspaceId="default" />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(container.textContent).toContain("Applied. The Chat model is now reviewed-model."));
  expect(mocks.plan).toHaveBeenCalledWith("plan-a", {
    workspaceId: "default",
    sessionId: "session-a",
    turnId: "turn-a",
  });
});

it("re-reads the linked change when a change-plan event arrives, so 'not applied yet' does not stick", async () => {
  mocks.plan.mockResolvedValueOnce({
    planId: "plan-a",
    status: "awaiting_approval",
    approvalRefs: ["approval-plan"],
    origin: { workspaceId: "default", surface: "settings" },
  });
  await renderPlanApproval();
  await vi.waitFor(() => expect(container.textContent).toContain("The change has not been applied yet."));
  mocks.plan.mockResolvedValue({
    planId: "plan-a",
    status: "completed",
    approvalRefs: ["approval-plan"],
    origin: { workspaceId: "default", surface: "settings" },
    result: { summary: "The switch is now off." },
  });
  // The realtime event map invalidates every ["change-plan"] query on an evolution_control_plane event.
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["change-plan"] });
  });
  await vi.waitFor(() => expect(container.textContent).toContain("Applied. The switch is now off."));
});

it("never says Approved for a refused decision whose plan has not settled yet", async () => {
  const denied = { ...planApproval, status: "rejected" } as ApprovalRequest;
  mocks.plan.mockResolvedValue({
    planId: "plan-a",
    status: "awaiting_approval",
    approvalRefs: ["approval-plan"],
    origin: { workspaceId: "default", surface: "settings" },
  });
  mocks.read.mockResolvedValue({ replay: { approval: denied, effects: [], events: [] } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ApprovalSettlement approval={denied} workspaceId="default" />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(container.textContent).toContain("Linked change: The change has not been applied."));
  expect(container.textContent).not.toContain("Linked change: Approved.");
});

it("says a rollback is running instead of 'Applying'", async () => {
  mocks.plan.mockResolvedValue({
    planId: "plan-a",
    status: "rolling_back",
    approvalRefs: ["approval-plan"],
    origin: { workspaceId: "default", surface: "settings" },
  });
  await renderPlanApproval();
  await vi.waitFor(() => expect(container.textContent).toContain("Linked change: Rolling back the change…"));
});

it("explains a decision that had no waiting run in plain words", async () => {
  const { noRunLine } = await import("./ApprovalSettlement");
  const base = { approvalId: "a", kind: "tool_call", status: "approved" } as never;
  expect(noRunLine({ ...(base as object), kind: "memory.write" } as never)).toBe(
    "Approved. Nothing was waiting to use this approval, so no memory was saved.",
  );
  expect(noRunLine(base)).toBe("Approved. Nothing was waiting to use this approval, so nothing ran.");
  expect(noRunLine({ ...(base as object), status: "rejected" } as never)).toBe("Nothing was waiting on this decision.");
});
