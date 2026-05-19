import React, { useRef, useState } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatDelegationPolicyActions } from "./useChatDelegationPolicyActions";

const apiMocks = vi.hoisted(() => ({
  fetchChatDelegationRun: vi.fn(),
  runChatDelegation: vi.fn(),
  runChatResearch: vi.fn(),
  streamChatDelegation: vi.fn(),
  suggestChatDelegation: vi.fn(),
  triggerChatProactive: vi.fn(),
  updateChatProactivePolicy: vi.fn(),
}));

vi.mock("../../api/client", () => apiMocks);

const loadSidebarMock = vi.fn(async () => undefined);
const ensureSessionMock = vi.fn(async () => baseSession as any);

type HarnessState = ReturnType<typeof useChatDelegationPolicyActions> & {
  error: string | null;
  notices: Array<{ content: string; tone?: "neutral" | "success" | "warning" }>;
  proactiveRuns: any[];
  sending: boolean;
};

let latest: HarnessState | null = null;

const baseSession = {
  sessionId: "session-1",
  title: "Code task",
  mode: "code",
  pinned: false,
  lifecycleStatus: "active",
  scope: "mission",
};

function userMessage(content: string) {
  return {
    messageId: `message-${content}`,
    sessionId: "session-1",
    role: "user",
    actorType: "user",
    actorId: "operator",
    content,
    timestamp: "2026-05-14T00:00:00.000Z",
  };
}

function buildWorkflowThread() {
  return {
    sessionId: "session-1",
    selectedTurnId: "turn-active",
    activeLeafTurnId: "turn-active",
    turns: [
      {
        turnId: "turn-active",
        userMessage: userMessage("Coordinate the workflow"),
        trace: {
          status: "completed",
          orchestration: {
            runId: "delegation-run-1",
          },
          executionPlan: {
            steps: [],
          },
        },
      },
    ],
  };
}

function Harness(props: {
  draft?: string;
  messages?: any[];
  selectedSession?: any | null;
  streamEnabled?: boolean;
  thread?: any;
  selectedTurnId?: string | null;
  sendingInitially?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(props.sendingInitially ?? false);
  const [prefs, setPrefs] = useState<any>({
    sessionId: "session-1",
    mode: "code",
    providerId: "openai",
    model: "gpt-5.4-mini",
    webMode: "quick",
  });
  const [, setProactiveStatus] = useState<any>(null);
  const [proactiveRuns, setProactiveRuns] = useState<any[]>([]);
  const [notices, setNotices] = useState<HarnessState["notices"]>([]);
  const lastLocalPrefMutationAtRef = useRef(0);

  const hook = useChatDelegationPolicyActions({
    selectedSession: props.selectedSession === undefined ? (baseSession as any) : props.selectedSession,
    thread: props.thread ?? null,
    selectedTurnId: props.selectedTurnId ?? null,
    draft: props.draft ?? "",
    messages: props.messages ?? [],
    prefs,
    sending,
    streamEnabled: props.streamEnabled ?? false,
    codeModeNeedsProjectBinding: false,
    loadSidebar: loadSidebarMock,
    ensureSession: ensureSessionMock,
    setError,
    setSending,
    setPrefs,
    setProactiveStatus,
    setProactiveRuns,
    pushLocalNotice: (content, tone) => setNotices((current) => [...current, { content, tone }]),
    lastLocalPrefMutationAtRef,
  });

  latest = {
    ...hook,
    error,
    notices,
    proactiveRuns,
    sending,
  };
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("useChatDelegationPolicyActions loop 24 behavior", () => {
  beforeEach(() => {
    latest = null;
    loadSidebarMock.mockClear();
    ensureSessionMock.mockClear();
    for (const mock of Object.values(apiMocks)) {
      mock.mockReset();
    }
    apiMocks.fetchChatDelegationRun.mockResolvedValue({
      run: {
        runId: "delegation-run-1",
        taskId: "task-1",
        executionPlanId: "plan-1",
        objective: "Coordinate the workflow",
        mode: "parallel",
        status: "completed",
        stitchedOutput: "Loaded delegation output",
      },
      steps: [
        {
          stepId: "step-2",
          runId: "delegation-run-1",
          role: "QA",
          status: "completed",
          index: 1,
        },
        {
          stepId: "step-1",
          runId: "delegation-run-1",
          role: "Researcher",
          status: "completed",
          index: 0,
        },
      ],
    });
    apiMocks.runChatDelegation.mockResolvedValue({
      runId: "run-accepted",
      taskId: "task-accepted",
      executionPlanId: "plan-accepted",
      stitchedOutput: "Accepted output",
      steps: [
        {
          stepId: "step-1",
          runId: "run-accepted",
          role: "Researcher",
          status: "completed",
          index: 0,
        },
      ],
    });
    apiMocks.runChatResearch.mockResolvedValue({ summary: "Research", sources: [] });
    apiMocks.suggestChatDelegation.mockResolvedValue({
      suggestion: {
        objective: "Coordinate the review",
        roles: ["Researcher", "QA"],
        mode: "parallel",
      },
    });
    apiMocks.triggerChatProactive.mockResolvedValue({
      runId: "proactive-1",
      status: "completed",
      reasoningSummary: "No action needed.",
    });
    apiMocks.updateChatProactivePolicy.mockResolvedValue({
      sessionId: "session-1",
      mode: "auto_safe",
      autonomyBudget: { maxActionsPerHour: 4 },
      retrievalMode: "standard",
      reflectionMode: "off",
    });
  });

  it("hydrates the active delegation run from the active workflow turn", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<Harness thread={buildWorkflowThread()} selectedTurnId="turn-active" />);
      });
      await flush();

      expect(apiMocks.fetchChatDelegationRun).toHaveBeenCalledWith("session-1", "delegation-run-1");
      expect(latest?.activeDelegationRun).toMatchObject({
        runId: "delegation-run-1",
        attachedTurnId: "turn-active",
        status: "completed",
        stitchedOutput: "Loaded delegation output",
      });
      expect(latest?.activeDelegationRun?.steps.map((step) => step.role)).toEqual(["Researcher", "QA"]);
    } finally {
      renderer.unmount();
    }
  });

  it("surfaces quick-research, proactive, and suggestion guardrail failures", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<Harness />);
      });

      await act(async () => {
        await latest?.handleRunQuickResearch();
      });
      expect(latest?.error).toBe("Enter a query first or send a user message before research.");

      apiMocks.runChatResearch.mockRejectedValueOnce(new Error("research failed"));
      await act(async () => {
        renderer.update(<Harness draft="fresh query" />);
      });
      await act(async () => {
        await latest?.handleRunQuickResearch();
      });
      expect(latest?.error).toBe("research failed");

      await act(async () => {
        await latest?.handleTriggerProactive();
      });
      expect(apiMocks.triggerChatProactive).toHaveBeenCalledWith("session-1", {
        source: "manual",
        reason: "Operator triggered from chat workspace.",
        surface: "code",
      });
      expect(latest?.proactiveRuns).toHaveLength(1);
      expect(latest?.notices.at(-1)?.content).toBe("Proactive run completed: No action needed.");

      apiMocks.triggerChatProactive.mockRejectedValueOnce(new Error("proactive failed"));
      await act(async () => {
        await latest?.handleTriggerProactive();
      });
      expect(latest?.error).toBe("proactive failed");

      await act(async () => {
        renderer.update(<Harness messages={[]} draft="" />);
      });
      await act(async () => {
        await latest?.handleSuggestDelegation();
      });
      expect(latest?.error).toBe("Write a request first so I can suggest a delegation plan.");

      apiMocks.suggestChatDelegation.mockRejectedValueOnce(new Error("suggestion failed"));
      await act(async () => {
        renderer.update(<Harness draft="plan this" />);
      });
      await act(async () => {
        await latest?.handleSuggestDelegation();
      });
      expect(latest?.error).toBe("suggestion failed");
    } finally {
      renderer.unmount();
    }
  });

  it("accepts non-streaming delegation suggestions and refreshes the sidebar", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<Harness draft="coordinate the review" />);
      });
      await act(async () => {
        await latest?.handleSuggestDelegation();
      });
      await act(async () => {
        await latest?.handleAcceptDelegation();
      });

      expect(apiMocks.runChatDelegation).toHaveBeenCalledWith("session-1", {
        objective: "Coordinate the review",
        roles: ["Researcher", "QA"],
        mode: "parallel",
        surfaceMode: "code",
        providerId: "openai",
        model: "gpt-5.4-mini",
      });
      expect(latest?.activeDelegationRun).toMatchObject({
        runId: "run-accepted",
        status: "completed",
        stitchedOutput: "Accepted output",
      });
      expect(latest?.delegationSuggestion).toBeNull();
      expect(loadSidebarMock).toHaveBeenCalledOnce();
      expect(latest?.notices.at(-1)).toEqual({
        content: "Delegation completed:\nAccepted output",
        tone: "success",
      });
    } finally {
      renderer.unmount();
    }
  });

  it("records partial streaming state when delegation progress fails before the final payload", async () => {
    apiMocks.streamChatDelegation.mockImplementation(async (_sessionId, _request, onChunk) => {
      onChunk({
        type: "status",
        runId: "run-stream",
        taskId: "task-stream",
      });
      onChunk({
        type: "step",
        runId: "run-stream",
        taskId: "task-stream",
        step: {
          stepId: "step-1",
          runId: "run-stream",
          role: "researcher",
          status: "completed",
          index: 0,
        },
      });
      onChunk({
        type: "step",
        runId: "run-stream",
        taskId: "task-stream",
        step: {
          stepId: "step-2",
          runId: "run-stream",
          role: "qa",
          status: "skipped",
          index: 1,
        },
      });
      throw new Error("stream broke");
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<Harness draft="coordinate the review" streamEnabled />);
      });
      await act(async () => {
        await latest?.handleSuggestDelegation();
      });
      await act(async () => {
        await latest?.handleAcceptDelegation();
      });

      expect(latest?.error).toBe("stream broke");
      expect(latest?.activeDelegationRun).toMatchObject({
        runId: "run-stream",
        status: "partial",
      });
      expect(latest?.notices.map((notice) => notice.content)).toContain("Researcher completed delegation step 1/2.");
      expect(latest?.notices.map((notice) => notice.content)).toContain(
        "Qa skipped delegation step 2/2: Dependency did not settle successfully.",
      );
    } finally {
      renderer.unmount();
    }
  });
});
