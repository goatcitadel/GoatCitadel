// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChatThreadTurnRecord, ChatToolRunRecord } from "@goatcitadel/contracts";
import { fetchApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { ChatTurnApprovalHistory } from "./ChatTurnApprovalHistory";

vi.mock("@goatcitadel/mission-control-shared/api/approvals", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchApproval: vi.fn(),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.mocked(fetchApproval).mockReset();
});

const decidedAt = "2026-10-24T17:30:36.965Z";
function tool(toolRunId: string, overrides: Partial<ChatToolRunRecord>): ChatToolRunRecord {
  return {
    toolRunId,
    turnId: "turn-1",
    sessionId: "sess-1",
    toolName: "documents.create",
    status: "executed",
    args: {},
    startedAt: "2026-10-24T17:30:25.000Z",
    ...overrides,
  } as ChatToolRunRecord;
}
function turnWith(toolRuns: ChatToolRunRecord[]): ChatThreadTurnRecord {
  return {
    turnId: "turn-1",
    trace: { sessionId: "sess-1" },
    toolRuns,
    citations: [],
  } as unknown as ChatThreadTurnRecord;
}
function record(approvalId: string, overrides: Record<string, unknown> = {}) {
  return {
    approvalId,
    kind: "tool_invoke",
    status: "approved",
    riskLevel: "caution",
    createdAt: "2026-10-24T17:30:25.275Z",
    resolvedAt: decidedAt,
    resolvedBy: "auth:operator",
    explanationStatus: "not_requested",
    linkage: { toolName: "documents.create", turnId: "turn-1" },
    payload: {},
    preview: {},
    ...overrides,
  };
}
async function render(turn: ChatThreadTurnRecord | undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatTurnApprovalHistory turn={turn} />
      </QueryClientProvider>,
    ),
  );
}
const history = () => container.querySelector('section[aria-label="Approvals for this response"]');

describe("ChatTurnApprovalHistory (#499)", () => {
  it("lists each approval the turn's tools asked for, from its persisted record: what, decision, who and when", async () => {
    vi.mocked(fetchApproval).mockImplementation(async (approvalId) => record(approvalId) as never);
    await render(turnWith([tool("run-1", { approvalId: "approval-1" }), tool("run-2", { toolName: "fs.read" })]));
    await vi.waitFor(() => expect(history()?.textContent).toContain("Approved by an operator"));
    expect(fetchApproval).toHaveBeenCalledTimes(1);
    expect(fetchApproval).toHaveBeenCalledWith("approval-1", expect.objectContaining({ workspaceId: "default" }));
    const item = history()!.querySelector("li")!;
    expect(item.textContent).toContain("Create document");
    expect(item.querySelector("time")?.getAttribute("dateTime")).toBe(decidedAt);
  });

  it("reads one record per approval even when two tool runs share it", async () => {
    vi.mocked(fetchApproval).mockImplementation(async (approvalId) => record(approvalId) as never);
    await render(turnWith([tool("run-1", { approvalId: "approval-1" }), tool("run-2", { approvalId: "approval-1" })]));
    await vi.waitFor(() => expect(history()?.querySelectorAll("li").length).toBe(1));
    expect(fetchApproval).toHaveBeenCalledTimes(1);
  });

  it("shows a pending approval as waiting, without crediting a decision", async () => {
    vi.mocked(fetchApproval).mockImplementation(
      async (approvalId) =>
        record(approvalId, { status: "pending", resolvedAt: undefined, resolvedBy: undefined }) as never,
    );
    await render(turnWith([tool("run-1", { approvalId: "approval-1", status: "approval_required" })]));
    await vi.waitFor(() => expect(history()?.textContent).toContain("Waiting on you"));
    expect(history()?.textContent).not.toContain("by an operator");
  });

  it("says when a decision record cannot be loaded instead of guessing one", async () => {
    vi.mocked(fetchApproval).mockRejectedValue(new Error("offline"));
    await render(turnWith([tool("run-1", { approvalId: "approval-1" })]));
    await vi.waitFor(() => expect(history()?.textContent).toContain("The decision record could not be loaded."));
    expect(history()?.textContent).toContain("Create document");
  });

  it("states that no approval was recorded when the turn's tools asked for none", async () => {
    await render(turnWith([tool("run-1", { toolName: "fs.read" })]));
    expect(history()?.textContent).toContain("No approvals were recorded for this response.");
    expect(fetchApproval).not.toHaveBeenCalled();
  });
});
