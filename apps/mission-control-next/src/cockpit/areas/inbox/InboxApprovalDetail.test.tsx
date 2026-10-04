// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApprovalRequest, OperatorInboxItem } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InboxApprovalDetail } from "./InboxApprovalDetail";

const api = vi.hoisted(() => ({ fetchApprovals: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ fetchApprovals: api.fetchApprovals }));
vi.mock("./InboxApprovalActions", () => ({
  InboxApprovalActions: ({
    onResolved,
    onInvalidated,
  }: {
    onResolved: (message: string) => void;
    onInvalidated: () => void;
  }) => (
    <>
      <button type="button">Decision controls</button>
      <button type="button" onClick={() => onResolved("Approved decision recorded.")}>
        Record decision
      </button>
      <button type="button" onClick={onInvalidated}>
        Report changed record
      </button>
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
  api.fetchApprovals.mockReset();
  api.fetchApprovals.mockResolvedValue({ items: [approval] });
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
    api.fetchApprovals.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ items: [approval] });
        }),
    );
    await act(async () => {
      void client.invalidateQueries();
      // Query status reaches React on a zero-delay timer; let it fire inside act.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("Checking for changes…");
    expect(container.textContent).toContain("Decision controls");
    expect(container.textContent).not.toContain("Loading the current approval…");
    await act(async () => release());
    await vi.waitFor(() => expect(container.textContent).not.toContain("Checking for changes…"));
  });

  it.each([
    ["Record decision", "Approved decision recorded."],
    ["Report changed record", "The approval changed. Review the refreshed record before deciding."],
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
    api.fetchApprovals.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ items: [] });
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
    await settleUntil(() => Boolean(container.textContent?.includes("not found in the first page")));
    expect(container.textContent).toContain("not found in the first page");
    expect(container.textContent).toContain(notice);
  });
});
