import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveChatDelegationRun } from "./useChatDelegationPolicyActions";
import { useChatDelegatedScopeControls, type ThreadedDelegatedScopeControls } from "./useChatDelegatedScopeControls";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  fetchChatDelegatedScopeCandidates: vi.fn(),
  requestChatDelegatedScopeExpansion: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => apiMocks);

const candidate = {
  candidateId: "a".repeat(64),
  label: "docs",
  scopeHash: "b".repeat(64),
};
const run: ActiveChatDelegationRun = {
  runId: "run-1",
  taskId: "task-1",
  label: "Explore workspace",
  objective: "Inspect docs",
  mode: "sequential",
  status: "running",
  steps: [
    {
      stepId: "step-1",
      role: "workspace-explorer",
      status: "running",
      index: 0,
      scopeControl: {
        approvedPaths: ["src"],
        scopeHash: candidate.scopeHash,
        dispatchGeneration: "dispatch-1",
        updatedAt: "2026-08-12T12:00:00.000Z",
      },
    },
  ],
};

let latest: ThreadedDelegatedScopeControls | null = null;
const pushLocalNotice = vi.fn();

function Harness(props: { sessionId?: string | null; delegationRun?: ActiveChatDelegationRun | null }) {
  latest = useChatDelegatedScopeControls({
    sessionId: props.sessionId === undefined ? "session-1" : props.sessionId,
    delegationRun: props.delegationRun === undefined ? run : props.delegationRun,
    pushLocalNotice,
  });
  return null;
}

async function renderHarness(props: Parameters<typeof Harness>[0] = {}): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null;
  await act(async () => {
    renderer = create(<Harness {...props} />);
  });
  return renderer!;
}

beforeEach(() => {
  latest = null;
  pushLocalNotice.mockReset();
  apiMocks.fetchChatDelegatedScopeCandidates.mockReset();
  apiMocks.requestChatDelegatedScopeExpansion.mockReset();
  apiMocks.fetchChatDelegatedScopeCandidates.mockResolvedValue({
    runId: "run-1",
    stepId: "step-1",
    scopeHash: candidate.scopeHash,
    candidates: [candidate],
  });
});

describe("useChatDelegatedScopeControls", () => {
  it("loads eligible server candidates only for an active scoped step", async () => {
    const renderer = await renderHarness();
    expect(apiMocks.fetchChatDelegatedScopeCandidates).toHaveBeenCalledWith({
      sessionId: "session-1",
      runId: "run-1",
      stepId: "step-1",
    });
    expect(latest?.candidates).toEqual([candidate]);
    expect(latest?.stepLabel).toBe("Workspace explorer");
    renderer.unmount();

    const idle = await renderHarness({ delegationRun: { ...run, status: "completed" } });
    expect(latest).toBeNull();
    idle.unmount();

    const mixed = await renderHarness({
      delegationRun: {
        ...run,
        steps: [
          { ...run.steps[0]!, status: "completed" },
          { ...run.steps[0]!, stepId: "step-2", role: "Researcher", status: "running" },
        ],
      },
    });
    expect(latest).toBeNull();
    mixed.unmount();
  });

  it("submits only a currently listed opaque candidate and projects the approval wait", async () => {
    apiMocks.requestChatDelegatedScopeExpansion.mockResolvedValue({
      runId: "run-1",
      stepId: "step-1",
      approvalId: "approval-1",
      waitingForApproval: true,
    });
    const renderer = await renderHarness();
    await act(async () => latest?.onRequest(candidate.candidateId));
    expect(apiMocks.requestChatDelegatedScopeExpansion).toHaveBeenCalledWith({
      sessionId: "session-1",
      runId: "run-1",
      stepId: "step-1",
      candidateIds: [candidate.candidateId],
    });
    expect(latest?.pendingApprovalId).toBe("approval-1");
    expect(latest?.candidates).toEqual([]);
    expect(pushLocalNotice).toHaveBeenCalledWith(expect.stringContaining("canonical approval decision"));
    renderer.unmount();
  });

  it("rejects an id absent from the latest server listing without calling the request route", async () => {
    const renderer = await renderHarness();
    await act(async () => latest?.onRequest("f".repeat(64)));
    expect(apiMocks.requestChatDelegatedScopeExpansion).not.toHaveBeenCalled();
    expect(latest?.error).toMatch(/no longer eligible/i);
    renderer.unmount();
  });
});
