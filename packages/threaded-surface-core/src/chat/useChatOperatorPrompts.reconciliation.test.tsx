import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { useChatOperatorPrompts } from "./useChatOperatorPrompts";
import type { ChatSessionRecord, ChatThreadResponse } from "@goatcitadel/contracts";
import { notifyGatewayAccessChanged } from "@goatcitadel/mission-control-shared/api/access-scope";
const api = vi.hoisted(() => ({ fetchChatPendingApprovals: vi.fn(), approveChatTool: vi.fn(), denyChatTool: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/state/dev-diagnostics-store", () => ({ recordClientDiagnostic: vi.fn() }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReactTestRenderer;
let owner: ReturnType<typeof useChatOperatorPrompts>;
const reload = vi.fn(async () => undefined),
  notice = vi.fn(),
  error = vi.fn(),
  commit = vi.fn();
function Harness({ sessionId = "session-a" }) {
  owner = useChatOperatorPrompts({
    selectedSessionId: sessionId,
    selectedSession: { sessionId } as ChatSessionRecord,
    thread: null,
    loadSessionCoreState: reload,
    pushLocalNotice: notice,
    setError: error,
    commitThreadUpdate: commit,
  });
  return null;
}
const pending = (sessionId = "session-a", approvalId = "approval-a") => ({
  activeApprovalId: approvalId,
  remainingCount: 1,
  items: [{ approvalId, sessionId, riskLevel: "safe", kind: "tool_invoke" }],
});
beforeEach(() => {
  vi.clearAllMocks();
  api.fetchChatPendingApprovals.mockResolvedValue(pending());
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
});
it("reconciles the actual retained prompt from the canonical queue after another decision owner resolved it", async () => {
  await act(async () => {
    renderer = create(<Harness />);
  });
  expect(owner.pendingApproval?.approvalId).toBe("approval-a");
  api.fetchChatPendingApprovals.mockResolvedValue({ items: [], remainingCount: 0 });
  expect(owner.pendingApproval?.approvalId).toBe("approval-a");
  await act(async () => owner.refreshThreadAndApprovals());
  expect(owner.pendingApproval).toBeNull();
  expect(reload).toHaveBeenCalledExactlyOnceWith("session-a", { background: true, includeThread: true });
  expect(api.approveChatTool).not.toHaveBeenCalled();
  expect(api.denyChatTool).not.toHaveBeenCalled();
  expect(commit).not.toHaveBeenCalled();
});
it("never applies an old session's held queue response to the newly selected session", async () => {
  await act(async () => {
    renderer = create(<Harness />);
  });
  let finish!: (value: ReturnType<typeof pending>) => void;
  api.fetchChatPendingApprovals.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let refresh!: Promise<void>;
  await act(async () => {
    refresh = owner.refreshThreadAndApprovals();
  });
  api.fetchChatPendingApprovals.mockResolvedValue(pending("session-b", "approval-b"));
  await act(async () => renderer.update(<Harness sessionId="session-b" />));
  await act(async () => {
    finish(pending());
    await refresh;
  });
  expect(owner.pendingApproval?.approvalId).toBe("approval-b");
});
it("retains the blocker and reports a failed canonical refresh without resolving again", async () => {
  await act(async () => {
    renderer = create(<Harness />);
  });
  api.fetchChatPendingApprovals.mockRejectedValueOnce(new Error("owner unavailable"));
  await act(async () => owner.refreshThreadAndApprovals());
  expect(owner.pendingApproval?.approvalId).toBe("approval-a");
  expect(error).toHaveBeenCalledWith("owner unavailable", "approval");
  expect(api.approveChatTool).not.toHaveBeenCalled();
});

it("rejects a late queue response after access custody changes", async () => {
  await act(async () => {
    renderer = create(<Harness />);
  });
  let finish!: (value: { items: never[]; remainingCount: number }) => void;
  api.fetchChatPendingApprovals.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let refresh!: Promise<void>;
  await act(async () => {
    refresh = owner.refreshThreadAndApprovals();
  });
  notifyGatewayAccessChanged();
  await act(async () => {
    finish({ items: [], remainingCount: 0 });
    await refresh;
  });
  expect(owner.pendingApproval?.approvalId).toBe("approval-a");
});

it("does not let a lagging thread snapshot reopen an approval the queue reports as settled", async () => {
  const waitingThread = () =>
    ({
      sessionId: "session-a",
      selectedTurnId: "turn-a",
      activeLeafTurnId: "turn-a",
      turns: [
        {
          turnId: "turn-a",
          toolRuns: [],
          trace: {
            status: "waiting_for_approval",
            toolRuns: [{ toolName: "documents.create", status: "approval_required", approvalId: "approval-a" }],
          },
        },
      ],
    }) as unknown as ChatThreadResponse;
  function ThreadHarness({ thread }: { thread: ChatThreadResponse }) {
    owner = useChatOperatorPrompts({
      selectedSessionId: "session-a",
      selectedSession: { sessionId: "session-a" } as ChatSessionRecord,
      thread,
      loadSessionCoreState: reload,
      pushLocalNotice: notice,
      setError: error,
      commitThreadUpdate: commit,
    });
    return null;
  }
  await act(async () => {
    renderer = create(<ThreadHarness thread={waitingThread()} />);
  });
  expect(owner.pendingApproval?.approvalId).toBe("approval-a");
  api.fetchChatPendingApprovals.mockResolvedValue({
    items: [{ approvalId: "approval-a", sessionId: "session-a", stale: true, staleReason: "approved" }],
    activeApprovalId: null,
    remainingCount: 0,
  });
  await act(async () => owner.refreshThreadAndApprovals());
  expect(owner.pendingApproval).toBeNull();
  // The background reload hands back a snapshot that has not caught up with the decision yet.
  await act(async () => renderer.update(<ThreadHarness thread={waitingThread()} />));
  expect(owner.pendingApproval).toBeNull();
});
