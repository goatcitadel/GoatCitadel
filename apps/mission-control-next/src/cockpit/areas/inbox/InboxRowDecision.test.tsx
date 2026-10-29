// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApprovalRequest, OperatorInboxItem } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InboxRowDecision } from "./InboxRowDecision";

const api = vi.hoisted(() => ({ fetchApproval: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ fetchApproval: api.fetchApproval }));
vi.mock("../../../features/native-routes/projects/use-project-access", () => ({
  useProjectAccess: () => ({ identity: "caller-a" }),
}));
// Records the props the decision bar receives, so a test can check the record and the scope it decides in.
const bar = vi.hoisted(() => ({ props: vi.fn() }));
vi.mock("./ApprovalDecisionBar", () => ({
  ApprovalDecisionBar: (props: { approval: ApprovalRequest; workspaceId: string | null }) => {
    bar.props(props);
    return <p>Decision bar</p>;
  },
}));

const record = (approvalId: string, extra: Partial<ApprovalRequest>): ApprovalRequest => ({
  approvalId,
  kind: "tool_invoke",
  riskLevel: "safe",
  status: "pending",
  payload: {},
  preview: {},
  createdAt: "2026-10-29T12:00:00.000Z",
  explanationStatus: "not_requested",
  ...extra,
});
const records: Record<string, ApprovalRequest> = {
  linked: record("linked", { linkage: { workspaceId: "ws-a" } }),
  skill: record("skill", { kind: "skill.lifecycle", riskLevel: "caution" }),
};
const inboxItem = (approvalId: string, riskLevel: "safe" | "caution", installWide: boolean): OperatorInboxItem => ({
  id: `approval:${approvalId}`,
  kind: "approval",
  group: "needs_decision",
  riskLevel,
  title: "Approval",
  summary: "Summary",
  createdAt: "2026-10-29T12:00:00.000Z",
  source: { workspaceId: "ws-a", approvalId, ...(installWide ? { installWide: true as const } : {}) },
  href: "/inbox",
});

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  api.fetchApproval.mockReset();
  bar.props.mockReset();
  api.fetchApproval.mockImplementation(async (approvalId: string) => records[approvalId]);
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

async function renderRow(item: OperatorInboxItem) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <InboxRowDecision item={item} workspaceId="ws-a" onDecision={() => undefined} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(bar.props).toHaveBeenCalled());
  const [approvalId, options] = api.fetchApproval.mock.calls[0] as [string, Record<string, unknown>];
  const props = bar.props.mock.lastCall![0] as { approval: ApprovalRequest; workspaceId: string | null };
  return { approvalId, options, props };
}

describe("Inbox row decision", () => {
  it("reads an approval of no workspace without one and decides it with none", async () => {
    const { approvalId, options, props } = await renderRow(inboxItem("skill", "caution", true));
    expect(approvalId).toBe("skill");
    expect(options).not.toHaveProperty("workspaceId");
    expect(props.approval.approvalId).toBe("skill");
    expect(props.workspaceId).toBeNull();
  });

  it("still reads and decides a linked approval in its workspace", async () => {
    const { approvalId, options, props } = await renderRow(inboxItem("linked", "safe", false));
    expect(approvalId).toBe("linked");
    expect(options).toHaveProperty("workspaceId", "ws-a");
    expect(props.approval.approvalId).toBe("linked");
    expect(props.workspaceId).toBe("ws-a");
  });
});
