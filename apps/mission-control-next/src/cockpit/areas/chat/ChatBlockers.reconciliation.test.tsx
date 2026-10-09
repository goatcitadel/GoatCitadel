// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import { useChatOperatorPrompts } from "../../../../../../packages/threaded-surface-core/src/chat/useChatOperatorPrompts";
import { ChatBlockers } from "./ChatBlockers";
const api = vi.hoisted(() => ({
  fetchChatPendingApprovals: vi.fn(),
  resolveApproval: vi.fn(),
  fetchApproval: vi.fn(),
  fetchApprovalReplay: vi.fn(),
  approveChatTool: vi.fn(),
  denyChatTool: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => api);
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "default" }),
}));
vi.mock("@goatcitadel/mission-control-shared/state/dev-diagnostics-store", () => ({ recordClientDiagnostic: vi.fn() }));
const reload = vi.fn(async () => undefined),
  noop = () => undefined;
const session = { sessionId: "session-a" } as ChatSessionRecord;
let owner: ReturnType<typeof useChatOperatorPrompts>;
function Harness() {
  owner = useChatOperatorPrompts({
    selectedSessionId: session.sessionId,
    selectedSession: session,
    thread: null,
    loadSessionCoreState: reload,
    pushLocalNotice: noop,
    setError: noop,
    commitThreadUpdate: noop,
  });
  return (
    <ChatBlockers
      props={{
        ...owner,
        selectedSessionId: session.sessionId,
        onRefreshThread: () => void owner.refreshThreadAndApprovals(),
        onApprovePending: noop,
        onDenyPending: noop,
        onSubmitUserInput: noop,
      }}
    />
  );
}
it("the real shared decision bar reconciles the actual Chat prompt owner without a second resolve", async () => {
  const pending = {
    approvalId: "approval-a",
    sessionId: "session-a",
    kind: "tool_invoke",
    riskLevel: "safe",
    status: "pending",
    payload: {},
    preview: { targets: ["fixture.txt"] },
    createdAt: "2026-10-05T00:00:00Z",
  };
  api.fetchApproval.mockResolvedValue(pending);
  api.fetchChatPendingApprovals.mockResolvedValue({
    items: [pending],
    activeApprovalId: pending.approvalId,
    remainingCount: 1,
  });
  api.resolveApproval.mockImplementation(async () => {
    const settled = { ...pending, status: "approved" };
    api.fetchApproval.mockResolvedValue(settled);
    api.fetchApprovalReplay.mockResolvedValue({ approval: settled, effects: [] });
    api.fetchChatPendingApprovals.mockResolvedValue({ items: [], remainingCount: 0 });
    return { approval: settled, effects: [] };
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host),
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
      ),
    );
    for (let attempt = 0; attempt < 30 && !host.textContent?.includes("Approve once"); attempt++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    expect(owner.pendingApproval?.approvalId).toBe(pending.approvalId);
    const button = [...host.querySelectorAll("button")].find((item) => item.textContent === "Approve once")!;
    await act(async () => {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(api.resolveApproval).toHaveBeenCalledExactlyOnceWith(pending.approvalId, "approve");
    expect(owner.pendingApproval).toBeNull();
    expect(host.textContent).not.toContain("Approval needed");
    expect(reload).toHaveBeenCalledWith(session.sessionId, { background: true, includeThread: true });
    expect(api.approveChatTool).not.toHaveBeenCalled();
    expect(api.denyChatTool).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
  }
});
