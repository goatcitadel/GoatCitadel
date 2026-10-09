// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApprovalRequest, OperatorInboxItem } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { InboxApprovalDetail } from "./InboxApprovalDetail";

const api = vi.hoisted(() => ({
  fetchApprovalReplay: vi.fn(async () => ({ approval: { ...approval, status: "approved", linkage: {workspaceId:"default"} }, effects: [], events: [] })),
  fetchApproval: vi.fn(),
  fetchApprovals: vi.fn(),
  fetchOperatorInbox: vi.fn(),
  fetchDurableRun: vi.fn(),
  fetchRuntimeLifecycle: vi.fn(async (): Promise<Record<string, unknown>> => ({ approval: { ...approval, linkage: { workspaceId: "default" } }, canonical: { approvalId: approval.approvalId }, turns: [] })),
}));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({
  fetchApproval: api.fetchApproval,
  fetchApprovalReplay: api.fetchApprovalReplay,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ fetchApprovals: api.fetchApprovals, fetchApprovalReplay: api.fetchApprovalReplay, fetchRuntimeLifecycle: api.fetchRuntimeLifecycle, fetchDurableRun: api.fetchDurableRun }));
vi.mock("@goatcitadel/mission-control-shared/api/operator-inbox", () => ({
  fetchOperatorInbox: api.fetchOperatorInbox,
}));
vi.mock("@goatcitadel/mission-control-shared/api/durable", () => ({ fetchDurableRun: api.fetchDurableRun }));
const notFound = () => new ApiRequestError("API error 404", { kind: "http", method: "GET", path: "/x", status: 404 });
vi.mock("./InboxApprovalActions", () => ({
  InboxApprovalActions: ({
    checking,
    onResolved,
    onInvalidated,
  }: {
    checking?: boolean;
    onResolved: (message: string) => void;
    onInvalidated: (message?: string) => void;
  }) => (
    <>
      <button type="button" disabled={checking}>
        Decision controls
      </button>
      <button type="button" onClick={() => onResolved("Approved decision recorded.")}>
        Record decision
      </button>
      <button type="button" onClick={() => onInvalidated()}>
        Report changed record
      </button>
      <button type="button" onClick={() => onInvalidated("Specialist evidence changed. Refresh and review the current target before approving.")}>Report specialist change</button>
    </>
  ),
}));

const approval: ApprovalRequest = {
  approvalId: "approval-a",
  kind: "tool_invoke",
  riskLevel: "caution",
  status: "pending",
  payload: {},
  preview: { commands: ["pnpm test"] },
  createdAt: "2026-10-03T00:00:00Z",
  explanationStatus: "not_requested",
};
const item: OperatorInboxItem = {
  id: "approval:approval-a",
  kind: "approval",
  group: "needs_decision",
  title: "Run tests",
  summary: "pnpm test",
  createdAt: "2026-10-03T00:00:00Z",
  source: { workspaceId: "default", approvalId: "approval-a" },
  href: "/inbox",
};

let root: Root;
const decisionControls = () =>
  [...container.querySelectorAll("button")].find((button) => button.textContent === "Decision controls")!;
let container: HTMLDivElement;
let client: QueryClient;

/** Query results reach React on zero-delay timers, so let them fire inside act until the view settles. */
async function settleUntil(done: () => boolean) {
  for (let pass = 0; pass < 20 && !done(); pass += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

beforeEach(() => {
  api.fetchApproval.mockReset();
  api.fetchApprovals.mockReset();
  api.fetchOperatorInbox.mockReset();
  api.fetchApproval.mockResolvedValue(approval);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

describe("Inbox approval detail", () => {
  it.each(["llama_cpp_setup", "llama_cpp_configuration", "unrelated"])("exposes the native setup return only for the supported %s target", async targetResourceId => {
    api.fetchApproval.mockResolvedValue({...approval,kind:"change_plan_effect",payload:{targetResourceId},linkage:{workspaceId:"default"}});
    await act(async()=>root.render(<QueryClientProvider client={client}><InboxApprovalDetail item={item} workspaceId="default"/></QueryClientProvider>));
    await settleUntil(()=>Boolean(container.textContent?.includes("Decision controls")));
    const link=[...container.querySelectorAll('a')].find(item=>item.textContent==='Return to llama.cpp setup');
    if(targetResourceId==='unrelated') expect(link).toBeUndefined();
    else expect(link?.getAttribute('href')).toBe('/settings/models?shell=cockpit#local-ai');
  });
  it("keeps the approval and its decision controls while the record is rechecked", async () => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <InboxApprovalDetail item={item} workspaceId="default" />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(container.textContent).toContain("Decision controls"));
    let release!: () => void;
    api.fetchApproval.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(approval);
        }),
    );
    await act(async () => {
      void client.invalidateQueries();
      // Query status reaches React on a zero-delay timer; let it fire inside act.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("Checking for changes…");
    expect(container.textContent).toContain("Decision controls");
    expect(decisionControls().disabled).toBe(true);
    expect(container.textContent).not.toContain("Loading the current approval…");
    await act(async () => release());
    await vi.waitFor(() => expect(container.textContent).not.toContain("Checking for changes…"));
    expect(decisionControls().disabled).toBe(false);
  });

  it("keeps the approval beside a failed recheck and says how old it is", async () => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <InboxApprovalDetail item={item} workspaceId="default" />
        </QueryClientProvider>,
      ),
    );
    await settleUntil(() => Boolean(container.textContent?.includes("Decision controls")));
    api.fetchApproval.mockRejectedValueOnce(
      new ApiRequestError("API error 503", { kind: "http", method: "GET", path: "/x", status: 503 }),
    );
    await act(async () => {
      void client.invalidateQueries();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settleUntil(() => Boolean(container.querySelector('[role="alert"]')));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).toContain("Decision controls");
    expect(container.textContent).toContain("pnpm test");
    expect(container.textContent).toMatch(/Showing the last version from \d/);
    expect(container.textContent).not.toContain("no longer waiting");
  });

  it.each([
    ["Record decision", "Approved decision recorded."],
    ["Report changed record", "The approval changed. Review the refreshed record before deciding."],
    ["Report specialist change", "Specialist evidence changed. Refresh and review the current target before approving."],
  ])("drops the settled record while the queue is re-read after %s", async (action, notice) => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <InboxApprovalDetail item={item} workspaceId="default" />
        </QueryClientProvider>,
      ),
    );
    await settleUntil(() => Boolean(container.textContent?.includes("Decision controls")));
    expect(container.textContent).toContain("Decision controls");
    let release!: () => void;
    api.fetchApproval.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          release = () => reject(notFound());
        }),
    );
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === action)!.click();
      // Query status reaches React on a zero-delay timer; let it fire inside act.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // The superseded record and its controls leave, so only this panel announces the outcome.
    expect(container.textContent).not.toContain("Decision controls");
    expect([...container.querySelectorAll('[role="status"]')].map((node) => node.textContent)).toContain(notice);
    await act(async () => release());
    await settleUntil(() => !container.textContent?.includes("Loading the current approval"));
    expect(container.textContent).not.toContain("This approval is no longer waiting.");
    expect(container.textContent).toContain(notice);
    expect(document.activeElement?.textContent).toBe(notice);
  });

  it("opens with one read of the approval by id and no Inbox or queue read", async () => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <InboxApprovalDetail item={item} workspaceId="default" />
        </QueryClientProvider>,
      ),
    );
    await settleUntil(() => Boolean(container.textContent?.includes("Decision controls")));
    expect(api.fetchApproval).toHaveBeenCalledExactlyOnceWith("approval-a", {
      workspaceId: "default",
      signal: expect.any(AbortSignal),
    });
    expect(api.fetchApprovals).not.toHaveBeenCalled();
    expect(api.fetchOperatorInbox).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing approval", () => api.fetchApproval.mockRejectedValue(notFound())],
    ["a decided approval", () => api.fetchApproval.mockResolvedValue({ ...approval, status: "approved" })],
  ])("says %s is no longer waiting and offers no decision", async (_label, arrange) => {
    arrange();
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <InboxApprovalDetail item={item} workspaceId="default" />
        </QueryClientProvider>,
      ),
    );
    await settleUntil(() =>
      Boolean(
        container.textContent?.includes(_label === "a decided approval" ? "Decision recorded" : "no longer waiting"),
      ),
    );
    expect(container.textContent).toContain(
      _label === "a decided approval" ? "Decision recorded: approved" : "This approval is no longer waiting.",
    );
    expect(container.textContent).not.toContain("Decision controls");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

it("retains decided approval evidence without decision controls", async () => {
  api.fetchApproval.mockResolvedValue({ ...approval, status: "approved" });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <InboxApprovalDetail item={item} workspaceId="default" />
      </QueryClientProvider>,
    ),
  );
  await settleUntil(() => Boolean(container.textContent?.includes("Approved")));
  expect(container.textContent).toContain("Approved");
  expect(container.textContent).toContain("pnpm test");
  expect(container.textContent).not.toContain("Decision controls");
});

it("shows linked execution independently of the approved decision", async () => {
  api.fetchApproval.mockResolvedValue({ ...approval, status: "approved", linkage: { workspaceId: "default" } });
  // The original run comes from the Gateway canonical lifecycle, never from an approval-supplied run id.
  api.fetchRuntimeLifecycle.mockResolvedValueOnce({
    approval: { ...approval, linkage: { workspaceId: "default" } },
    canonical: { approvalId: approval.approvalId, runId: "run-a" },
    turns: [],
  });
  api.fetchDurableRun.mockResolvedValueOnce({
    runId: "run-a",
    workflowKey: "remediation.apply",
    status: "waiting",
    payload: { workspaceId: "default" },
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <InboxApprovalDetail item={item} workspaceId="default" />
      </QueryClientProvider>,
    ),
  );
  await settleUntil(() => Boolean(container.textContent?.includes("Original linked work: waiting")));
  expect(container.textContent).toContain("Original linked work: waiting");
  expect(container.textContent).toContain("Approved");
  expect(container.textContent).not.toContain("Decision controls");
});
