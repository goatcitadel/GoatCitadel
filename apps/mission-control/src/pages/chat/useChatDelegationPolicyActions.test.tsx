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

vi.mock("../../api/client", () => ({
  fetchChatDelegationRun: apiMocks.fetchChatDelegationRun,
  runChatDelegation: apiMocks.runChatDelegation,
  runChatResearch: apiMocks.runChatResearch,
  streamChatDelegation: apiMocks.streamChatDelegation,
  suggestChatDelegation: apiMocks.suggestChatDelegation,
  triggerChatProactive: apiMocks.triggerChatProactive,
  updateChatProactivePolicy: apiMocks.updateChatProactivePolicy,
}));

type HarnessState = ReturnType<typeof useChatDelegationPolicyActions> & {
  error: string | null;
  notices: Array<{ content: string; tone?: "neutral" | "success" | "warning" }>;
  prefs: any;
  proactiveRuns: any[];
  proactiveStatus: any;
  sending: boolean;
  localPrefMutationAt: number;
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
    timestamp: "2026-04-08T00:00:00.000Z",
  };
}

function Harness(props: {
  draft?: string;
  messages?: any[];
  selectedSession?: any | null;
  streamEnabled?: boolean;
  codeModeNeedsProjectBinding?: boolean;
  thread?: any;
  selectedTurnId?: string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [prefs, setPrefs] = useState<any>({
    sessionId: "session-1",
    mode: "code",
    providerId: "openai",
    model: "gpt-5.4-mini",
    webMode: "deep",
  });
  const [proactiveStatus, setProactiveStatus] = useState<any>(null);
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
    codeModeNeedsProjectBinding: props.codeModeNeedsProjectBinding ?? false,
    loadSidebar: vi.fn(async () => undefined),
    ensureSession: vi.fn(async () => baseSession as any),
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
    prefs,
    proactiveRuns,
    proactiveStatus,
    sending,
    localPrefMutationAt: lastLocalPrefMutationAtRef.current,
  };
  return null;
}

describe("useChatDelegationPolicyActions", () => {
  beforeEach(() => {
    latest = null;
    for (const mock of Object.values(apiMocks)) {
      mock.mockReset();
    }
    apiMocks.runChatResearch.mockResolvedValue({ summary: "Research result", sources: ["https://example.com"] });
    apiMocks.runChatDelegation.mockResolvedValue({
      runId: "run-1",
      taskId: "task-1",
      executionPlanId: "plan-1",
      steps: [],
      stitchedOutput: "Done",
    });
    apiMocks.suggestChatDelegation.mockResolvedValue({
      suggestion: {
        objective: "Break down the work",
        roles: ["Researcher", "QA"],
        mode: "parallel",
      },
    });
    apiMocks.triggerChatProactive.mockResolvedValue({
      runId: "proactive-1",
      status: "completed",
      reasoningSummary: "Checked the session.",
    });
    apiMocks.updateChatProactivePolicy.mockResolvedValue({
      sessionId: "session-1",
      mode: "auto_safe",
      autonomyBudget: { maxActionsPerHour: 4 },
      retrievalMode: "layered",
      reflectionMode: "standard",
    });
  });

  it("runs quick research from the latest user message when the draft is empty", async () => {
    create(<Harness messages={[userMessage("First request"), userMessage("Latest research question")]} />);

    await act(async () => {
      await latest?.handleRunQuickResearch();
    });

    expect(apiMocks.runChatResearch).toHaveBeenCalledWith("session-1", {
      query: "Latest research question",
      mode: "deep",
      providerId: "openai",
      model: "gpt-5.4-mini",
      surface: "code",
    });
    expect(latest?.notices.at(-1)).toEqual({
      content: "Research summary:\nResearch result\n\nSources: 1",
      tone: "success",
    });
    expect(latest?.error).toBeNull();
  });

  it("updates proactive policy state and mirrors the policy into prefs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T12:00:00.000Z"));
    create(<Harness />);

    await act(async () => {
      await latest?.handleProactivePolicyPatch({
        proactiveMode: "auto_safe",
        autonomyBudget: { maxActionsPerHour: 4 },
        retrievalMode: "layered",
      });
    });

    expect(apiMocks.updateChatProactivePolicy).toHaveBeenCalledWith("session-1", {
      proactiveMode: "auto_safe",
      autonomyBudget: { maxActionsPerHour: 4 },
      retrievalMode: "layered",
    });
    expect(latest?.proactiveStatus).toMatchObject({ mode: "auto_safe", retrievalMode: "layered" });
    expect(latest?.prefs).toMatchObject({
      proactiveMode: "auto_safe",
      autonomyBudget: { maxActionsPerHour: 4 },
      retrievalMode: "layered",
      reflectionMode: "standard",
    });
    expect(latest?.localPrefMutationAt).toBe(Date.now());
    vi.useRealTimers();
  });

  it("blocks code delegation until a Code session has a project binding", async () => {
    create(<Harness codeModeNeedsProjectBinding draft="Implement the feature" />);

    await act(async () => {
      await latest?.handleRunCodeDelegation("implement");
    });

    expect(apiMocks.runChatDelegation).not.toHaveBeenCalled();
    expect(latest?.error).toBe("Bind this Code session to a project before running delegated implementation work.");
  });

  it("builds code delegation steps from the selected execution plan", async () => {
    const thread = {
      sessionId: "session-1",
      selectedTurnId: "turn-1",
      activeLeafTurnId: "turn-1",
      turns: [
        {
          turnId: "turn-1",
          userMessage: userMessage("Ship the patch"),
          trace: {
            status: "completed",
            routing: {},
            toolRuns: [],
            executionPlan: {
              steps: [
                {
                  stepId: "step-2",
                  index: 1,
                  delegatedRole: "QA",
                  parallelizable: false,
                  dependsOnStepIds: ["step-1", "ignored-step"],
                },
                {
                  stepId: "step-1",
                  index: 0,
                  delegatedRole: "Coder",
                  parallelizable: true,
                },
                {
                  stepId: "ignored-step",
                  index: 2,
                },
              ],
            },
          },
        },
      ],
    };
    apiMocks.runChatDelegation.mockResolvedValue({
      runId: "run-code",
      taskId: "task-code",
      executionPlanId: "plan-code",
      stitchedOutput: "Shipped",
      steps: [
        { stepId: "step-1", runId: "run-code", role: "Coder", status: "completed", index: 0 },
        { stepId: "step-2", runId: "run-code", role: "QA", status: "completed", index: 1 },
      ],
    });
    create(<Harness draft="Fix coverage gaps" thread={thread} selectedTurnId="turn-1" />);

    await act(async () => {
      await latest?.handleRunCodeDelegation("ship");
    });

    expect(apiMocks.runChatDelegation).toHaveBeenCalledWith("session-1", {
      objective:
        "Run an implement-review-test cycle for this task, then stitch the result into one operator-ready handoff. Fix coverage gaps",
      roles: ["Coder", "QA"],
      mode: "sequential",
      surfaceMode: "code",
      providerId: "openai",
      model: "gpt-5.4-mini",
      steps: [
        { stepId: "step-1", index: 0, role: "Coder", parallelizable: true, dependsOnStepIds: undefined },
        { stepId: "step-2", index: 1, role: "QA", parallelizable: false, dependsOnStepIds: ["step-1"] },
      ],
    });
    expect(latest?.activeDelegationRun).toMatchObject({
      runId: "run-code",
      status: "completed",
      stitchedOutput: "Shipped",
    });
    expect(latest?.notices.at(-1)).toEqual({ content: "Ship cycle completed:\nShipped", tone: "success" });
  });

  it("streams accepted delegation progress and records partial completion", async () => {
    apiMocks.streamChatDelegation.mockImplementation(async (_sessionId, _request, onChunk) => {
      onChunk({ type: "status", runId: "run-stream", taskId: "task-stream", message: "Delegation started." });
      onChunk({
        type: "step",
        runId: "run-stream",
        taskId: "task-stream",
        step: { stepId: "step-1", runId: "run-stream", role: "researcher", status: "running", index: 0 },
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
          output: "Findings",
        },
      });
      onChunk({
        type: "done",
        result: {
          runId: "run-stream",
          taskId: "task-stream",
          executionPlanId: "plan-stream",
          stitchedOutput: "Partial output",
          steps: [
            { stepId: "step-1", runId: "run-stream", role: "Researcher", status: "completed", index: 0 },
            { stepId: "step-2", runId: "run-stream", role: "QA", status: "failed", index: 1, error: "No data" },
          ],
        },
      });
    });
    create(<Harness draft="Coordinate the review" streamEnabled />);

    await act(async () => {
      await latest?.handleSuggestDelegation();
    });
    await act(async () => {
      await latest?.handleAcceptDelegation();
    });

    expect(apiMocks.suggestChatDelegation).toHaveBeenCalledWith("session-1", { objective: "Coordinate the review" });
    expect(apiMocks.streamChatDelegation).toHaveBeenCalled();
    expect(latest?.activeDelegationRun).toMatchObject({
      runId: "run-stream",
      status: "partial",
      stitchedOutput: "Partial output",
    });
    expect(latest?.delegationSuggestion).toBeNull();
    expect(latest?.notices.map((notice) => notice.content)).toContain("Delegation started.");
  });
});
