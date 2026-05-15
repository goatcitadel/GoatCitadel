import React, { useCallback, useRef, useState } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatMessageRecord,
  ChatSessionPrefsRecord,
  ChatSessionRecord,
  ChatThreadResponse,
} from "@goatcitadel/contracts";
import {
  applyDelegationStatusChunk,
  applyDelegationStepChunk,
  applyDelegationStreamFailure,
  createSeedDelegationSteps,
  inferDelegationRunStatus,
  resolveDelegationMode,
  resolveDelegationRoute,
  resolveSelectedTurn,
  useChatDelegationPolicyActions,
} from "./useChatDelegationPolicyActions";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchChatDelegationRunMock = vi.fn();
const runChatDelegationMock = vi.fn();
const runChatResearchMock = vi.fn();
const streamChatDelegationMock = vi.fn();
const suggestChatDelegationMock = vi.fn();
const triggerChatProactiveMock = vi.fn();
const updateChatProactivePolicyMock = vi.fn();

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchChatDelegationRun: (...args: unknown[]) => fetchChatDelegationRunMock(...args),
  runChatDelegation: (...args: unknown[]) => runChatDelegationMock(...args),
  runChatResearch: (...args: unknown[]) => runChatResearchMock(...args),
  streamChatDelegation: (...args: unknown[]) => streamChatDelegationMock(...args),
  suggestChatDelegation: (...args: unknown[]) => suggestChatDelegationMock(...args),
  triggerChatProactive: (...args: unknown[]) => triggerChatProactiveMock(...args),
  updateChatProactivePolicy: (...args: unknown[]) => updateChatProactivePolicyMock(...args),
}));

type HookResult = ReturnType<typeof useChatDelegationPolicyActions>;

type HarnessSnapshot = {
  result: HookResult;
  errors: string[];
  notices: Array<{ content: string; tone?: string }>;
  prefs: ChatSessionPrefsRecord | null;
  proactiveStatus: any;
  proactiveRuns: any[];
  sending: boolean;
  loadSidebar: ReturnType<typeof vi.fn>;
};

let latestHarness: HarnessSnapshot | null = null;

function makeSession(): ChatSessionRecord {
  return {
    sessionId: "session-1",
    title: "Build the panel",
    scope: "mission",
    lifecycleStatus: "active",
    pinned: false,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  } as ChatSessionRecord;
}

function makeMessages(
  content = "Implement the dashboard, refactor the state, and test the result.",
): ChatMessageRecord[] {
  return [
    {
      messageId: "message-user",
      sessionId: "session-1",
      role: "user",
      actorType: "user",
      actorId: "operator",
      content,
      timestamp: "2026-05-01T00:00:00.000Z",
    } as ChatMessageRecord,
  ];
}

function makeThread(withWorkflow = false): ChatThreadResponse {
  return {
    sessionId: "session-1",
    selectedTurnId: "turn-1",
    activeLeafTurnId: "turn-1",
    turns: [
      {
        turnId: "turn-1",
        userMessage: makeMessages()[0],
        trace: {
          status: withWorkflow ? "running" : "completed",
          routing: {},
          toolRuns: [],
          capabilityUpgradeSuggestions: [],
          specialistCandidateSuggestions: [],
          orchestration: withWorkflow ? { runId: "run-existing" } : undefined,
          executionPlan: {
            steps: [
              {
                stepId: "plan-1",
                index: 0,
                label: "Review",
                delegatedRole: "Architect",
                parallelizable: true,
                dependsOnStepIds: ["missing"],
              },
              {
                stepId: "plan-2",
                index: 1,
                label: "Implement",
                delegatedRole: "Coder",
                parallelizable: false,
                dependsOnStepIds: ["plan-1"],
              },
            ],
          },
        },
      },
    ],
  } as ChatThreadResponse;
}

function makeThreadWithoutDelegatedSteps(): ChatThreadResponse {
  return {
    sessionId: "session-1",
    selectedTurnId: "turn-1",
    activeLeafTurnId: "turn-1",
    turns: [
      {
        turnId: "turn-1",
        userMessage: makeMessages()[0],
        trace: {
          status: "completed",
          routing: {},
          toolRuns: [],
          capabilityUpgradeSuggestions: [],
          specialistCandidateSuggestions: [],
          executionPlan: {
            steps: [
              {
                stepId: "plan-local",
                index: 0,
                label: "Local review",
                parallelizable: false,
                dependsOnStepIds: [],
              },
            ],
          },
        },
      },
    ],
  } as ChatThreadResponse;
}

function makePrefs(patch: Partial<ChatSessionPrefsRecord> = {}): ChatSessionPrefsRecord {
  return {
    sessionId: "session-1",
    mode: "chat",
    webMode: "quick",
    memoryMode: "auto",
    thinkingLevel: "standard",
    providerId: "openai",
    model: "gpt-5.5",
    proactiveMode: "off",
    retrievalMode: "auto",
    reflectionMode: "auto",
    subagentPolicy: "ask_when_useful",
    ...patch,
  } as ChatSessionPrefsRecord;
}

function setupApiDefaults() {
  fetchChatDelegationRunMock.mockResolvedValue({
    run: {
      runId: "run-existing",
      taskId: "task-existing",
      executionPlanId: "plan-existing",
      objective: "Existing work",
      mode: "parallel",
      status: "running",
      stitchedOutput: null,
    },
    steps: [
      {
        stepId: "step-existing",
        runId: "run-existing",
        role: "Researcher",
        status: "running",
        index: 0,
      },
    ],
  });
  runChatResearchMock.mockResolvedValue({ summary: "Research complete", sources: [{ url: "https://example.test" }] });
  updateChatProactivePolicyMock.mockResolvedValue({
    mode: "auto",
    autonomyBudget: { maxActionsPerHour: 2, maxActionsPerTurn: 1, cooldownSeconds: 30 },
    retrievalMode: "deep",
    reflectionMode: "summary",
  });
  triggerChatProactiveMock.mockResolvedValue({
    runId: "proactive-1",
    status: "queued",
    reasoningSummary: "Queued for follow-up",
  });
  suggestChatDelegationMock.mockResolvedValue({
    suggestion: {
      objective: "Suggested plan",
      mode: "parallel",
      roles: ["Architect", "Coder"],
      rationale: "This can split cleanly.",
    },
  });
  runChatDelegationMock.mockResolvedValue({
    runId: "run-accepted",
    taskId: "task-accepted",
    executionPlanId: "plan-accepted",
    steps: [
      { stepId: "plan-1", runId: "run-accepted", role: "Architect", status: "completed", index: 0 },
      { stepId: "plan-2", runId: "run-accepted", role: "Coder", status: "completed", index: 1 },
    ],
    stitchedOutput: "Delegation stitched.",
  });
  streamChatDelegationMock.mockImplementation(async (_sessionId, _request, onChunk) => {
    onChunk({ type: "status", runId: "run-stream", taskId: "task-stream", message: "Starting" });
    onChunk({
      type: "step",
      runId: "run-stream",
      taskId: "task-stream",
      step: { stepId: "step-1", runId: "run-stream", role: "coder", status: "running", index: 0 },
    });
    onChunk({
      type: "step",
      runId: "run-stream",
      taskId: "task-stream",
      step: { stepId: "step-1", runId: "run-stream", role: "coder", status: "completed", index: 0 },
    });
    onChunk({
      type: "step",
      runId: "run-stream",
      taskId: "task-stream",
      step: { stepId: "step-2", runId: "run-stream", role: "qa", status: "failed", index: 1, error: "test failed" },
    });
    onChunk({
      type: "step",
      runId: "run-stream",
      taskId: "task-stream",
      step: { stepId: "step-3", runId: "run-stream", role: "ops", status: "skipped", index: 2 },
    });
    onChunk({
      type: "done",
      result: {
        runId: "run-stream",
        taskId: "task-stream",
        executionPlanId: "plan-stream",
        steps: [
          { stepId: "step-1", runId: "run-stream", role: "coder", status: "completed", index: 0 },
          { stepId: "step-2", runId: "run-stream", role: "qa", status: "failed", index: 1 },
        ],
        stitchedOutput: "Partial stream output",
      },
    });
  });
}

function Harness(props: {
  draft?: string;
  messages?: ChatMessageRecord[];
  prefs?: ChatSessionPrefsRecord | null;
  surfaceMode?: "chat" | "cowork" | "code";
  streamEnabled?: boolean;
  sendingInitial?: boolean;
  selectedSession?: ChatSessionRecord | null;
  thread?: ChatThreadResponse | null;
  codeModeNeedsProjectBinding?: boolean;
}) {
  const [sending, setSending] = useState(Boolean(props.sendingInitial));
  const [prefs, setPrefs] = useState<ChatSessionPrefsRecord | null>(
    props.prefs === undefined ? makePrefs() : props.prefs,
  );
  const [proactiveStatus, setProactiveStatus] = useState<any>(null);
  const [proactiveRuns, setProactiveRuns] = useState<any[]>([]);
  const errorsRef = useRef<string[]>([]);
  const noticesRef = useRef<Array<{ content: string; tone?: string }>>([]);
  const loadSidebar = useRef(vi.fn(async () => undefined)).current;
  const lastLocalPrefMutationAtRef = useRef(0);
  const selectedSession = props.selectedSession === undefined ? makeSession() : props.selectedSession;
  const setError = useCallback((value: string | null) => {
    if (value) {
      errorsRef.current.push(value);
    }
  }, []);
  const pushLocalNotice = useCallback((content: string, tone?: "neutral" | "success" | "warning") => {
    noticesRef.current.push({ content, tone });
  }, []);
  const ensureSession = useCallback(async () => selectedSession ?? makeSession(), [selectedSession]);

  const result = useChatDelegationPolicyActions({
    selectedSession,
    thread: props.thread ?? makeThread(),
    selectedTurnId: "turn-1",
    draft: props.draft ?? "Coordinate the launch research",
    messages: props.messages ?? makeMessages(),
    prefs,
    selectedProviderId: "anthropic",
    selectedModel: "claude-4",
    surfaceMode: props.surfaceMode ?? "chat",
    sending,
    streamEnabled: Boolean(props.streamEnabled),
    codeModeNeedsProjectBinding: Boolean(props.codeModeNeedsProjectBinding),
    loadSidebar,
    ensureSession,
    setError,
    setSending,
    setPrefs,
    setProactiveStatus,
    setProactiveRuns,
    pushLocalNotice,
    lastLocalPrefMutationAtRef,
  });

  latestHarness = {
    result,
    errors: errorsRef.current,
    notices: noticesRef.current,
    prefs,
    proactiveStatus,
    proactiveRuns,
    sending,
    loadSidebar,
  };
  return null;
}

async function flushEffects(times = 4) {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

describe("useChatDelegationPolicyActions", () => {
  beforeEach(() => {
    latestHarness = null;
    vi.clearAllMocks();
    setupApiDefaults();
  });

  it("loads attached workflow runs and handles quick research", async () => {
    await act(async () => {
      create(<Harness thread={makeThread(true)} />);
      await flushEffects();
    });

    expect(fetchChatDelegationRunMock).toHaveBeenCalledWith("session-1", "run-existing");
    expect(latestHarness?.result.activeDelegationRun?.steps[0]?.role).toBe("Researcher");

    await act(async () => {
      await latestHarness?.result.handleRunQuickResearch();
    });

    expect(runChatResearchMock).toHaveBeenCalledWith("session-1", {
      query: "Coordinate the launch research",
      mode: "quick",
      providerId: "openai",
      model: "gpt-5.5",
    });
    expect(latestHarness?.notices.at(-1)?.content).toContain("Research summary:");

    await act(async () => {
      create(<Harness draft="" messages={[]} />);
      await flushEffects();
    });
    await act(async () => {
      await latestHarness?.result.handleRunQuickResearch();
    });

    expect(latestHarness?.errors).toContain("Enter a query first or send a user message before research.");

    await act(async () => {
      create(<Harness draft="fallback provider research" prefs={null} sendingInitial />);
      await flushEffects();
    });
    await act(async () => {
      await latestHarness?.result.handleRunQuickResearch();
    });
    expect(runChatResearchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      create(<Harness draft="fallback provider research" prefs={null} />);
      await flushEffects();
    });
    await act(async () => {
      await latestHarness?.result.handleRunQuickResearch();
    });
    expect(runChatResearchMock).toHaveBeenLastCalledWith("session-1", {
      query: "fallback provider research",
      mode: "quick",
      providerId: "anthropic",
      model: "claude-4",
    });
  });

  it("covers delegation status and selected-turn fallback helpers", () => {
    expect(inferDelegationRunStatus([], "partial")).toBe("partial");
    expect(inferDelegationRunStatus([{ status: "blocked" }] as never, "running")).toBe("running");
    expect(resolveSelectedTurn(null, "turn-1")).toBeNull();
    expect(resolveDelegationMode(undefined)).toBe("sequential");
    expect(resolveDelegationMode("parallel")).toBe("parallel");
    expect(resolveDelegationRoute(null, "anthropic", "claude-4")).toEqual({
      providerId: "anthropic",
      model: "claude-4",
    });
    expect(
      resolveDelegationRoute(makePrefs({ providerId: "openai", model: "gpt-5.5" }), "anthropic", "claude-4"),
    ).toEqual({ providerId: "openai", model: "gpt-5.5" });
    expect(
      createSeedDelegationSteps({
        objective: "Seed defaults",
        roles: ["Architect"],
        steps: [{ role: "Coder" }, { stepId: "qa", role: "QA", index: -1 }],
      } as any),
    ).toEqual([
      { stepId: "qa", role: "QA", status: "pending", index: -1 },
      { stepId: "delegation-step-1", role: "Coder", status: "pending", index: 0 },
    ]);

    const activeRun = {
      label: "Delegation",
      objective: "Test helpers",
      mode: "parallel",
      status: "running",
      steps: [{ stepId: "step-1", role: "Architect", status: "pending", index: 0 }],
    } as any;
    expect(applyDelegationStatusChunk(null, { runId: "ignored" })).toBeNull();
    expect(applyDelegationStatusChunk(activeRun, { runId: "run-1", taskId: "task-1" })).toMatchObject({
      runId: "run-1",
      taskId: "task-1",
    });
    expect(
      applyDelegationStatusChunk({ ...activeRun, runId: "existing-run", taskId: "existing-task" }, {}),
    ).toMatchObject({
      runId: "existing-run",
      taskId: "existing-task",
    });
    expect(applyDelegationStepChunk(null, { runId: "ignored" }, activeRun.steps[0])).toBeNull();
    expect(
      applyDelegationStepChunk(activeRun, { runId: "run-2" }, { ...activeRun.steps[0], status: "completed" }),
    ).toMatchObject({ runId: "run-2", status: "completed" });
    expect(
      applyDelegationStepChunk({ ...activeRun, runId: "existing-run", taskId: "existing-task" }, {}, {
        stepId: "step-2",
        role: "QA",
        status: "pending",
        index: 2,
      } as any),
    ).toMatchObject({ runId: "existing-run", taskId: "existing-task" });
    expect(resolveSelectedTurn({ turns: [] } as any, "missing")).toBeNull();
    expect(applyDelegationStreamFailure(null)).toBeNull();
    expect(
      applyDelegationStreamFailure({ ...activeRun, steps: [{ ...activeRun.steps[0], status: "completed" }] }),
    ).toMatchObject({ status: "completed" });
  });

  it("patches proactive policy and triggers manual proactive runs", async () => {
    await act(async () => {
      create(<Harness />);
      await flushEffects();
    });

    await act(async () => {
      await latestHarness?.result.handleProactivePolicyPatch({
        proactiveMode: "auto",
        retrievalMode: "deep",
        reflectionMode: "summary",
      });
    });

    expect(updateChatProactivePolicyMock).toHaveBeenCalledWith("session-1", {
      proactiveMode: "auto",
      retrievalMode: "deep",
      reflectionMode: "summary",
    });
    expect(latestHarness?.proactiveStatus.mode).toBe("auto");
    expect(latestHarness?.prefs?.proactiveMode).toBe("auto");

    await act(async () => {
      await latestHarness?.result.handleTriggerProactive();
    });

    expect(triggerChatProactiveMock).toHaveBeenCalledWith("session-1", {
      source: "manual",
      reason: "Operator triggered from chat workspace.",
    });
    expect(latestHarness?.proactiveRuns[0]?.runId).toBe("proactive-1");
  });

  it("suggests and accepts delegation with execution-plan graph steps", async () => {
    await act(async () => {
      create(<Harness thread={makeThread()} />);
      await flushEffects();
    });

    await act(async () => {
      await latestHarness?.result.handleSuggestDelegation();
    });
    expect(suggestChatDelegationMock).toHaveBeenCalledWith("session-1", {
      objective: "Coordinate the launch research",
    });
    expect(latestHarness?.result.delegationSuggestion?.objective).toBe("Suggested plan");

    await act(async () => {
      await latestHarness?.result.handleAcceptDelegation();
    });

    expect(runChatDelegationMock).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        objective: "Suggested plan",
        roles: ["Architect", "Coder"],
        mode: "parallel",
        providerId: "openai",
        model: "gpt-5.5",
        steps: [
          { stepId: "plan-1", index: 0, role: "Architect", parallelizable: true, dependsOnStepIds: [] },
          { stepId: "plan-2", index: 1, role: "Coder", parallelizable: false, dependsOnStepIds: ["plan-1"] },
        ],
      }),
    );
    expect(latestHarness?.result.activeDelegationRun?.status).toBe("completed");
    expect(latestHarness?.loadSidebar).toHaveBeenCalled();
  });

  it("guards code delegation project binding and streams code delegation progress", async () => {
    await act(async () => {
      create(<Harness surfaceMode="code" codeModeNeedsProjectBinding />);
      await flushEffects();
    });
    await act(async () => {
      await latestHarness?.result.handleRunCodeDelegation("implement");
    });
    expect(latestHarness?.errors).toContain(
      "Bind this Code session to a project before running delegated implementation work.",
    );
    expect(streamChatDelegationMock).not.toHaveBeenCalled();

    await act(async () => {
      create(<Harness surfaceMode="code" streamEnabled prefs={makePrefs({ subagentPolicy: "off" })} />);
      await flushEffects();
    });
    await act(async () => {
      await latestHarness?.result.handleRunCodeDelegation("ship");
    });

    expect(streamChatDelegationMock).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        objective: expect.stringContaining("Run an implement-review-test cycle"),
        roles: ["Architect", "Coder"],
        mode: "sequential",
        surfaceMode: "code",
      }),
      expect.any(Function),
    );
    expect(latestHarness?.notices.map((item) => item.content)).toEqual(
      expect.arrayContaining([
        "Starting",
        "Coder started ship cycle step 1/2.",
        "Coder completed ship cycle step 1/2.",
        "Qa failed ship cycle step 2/2: test failed",
        "Ops skipped ship cycle step 3/2: Dependency did not settle successfully.",
        expect.stringContaining("Ship cycle completed:"),
      ]),
    );
    expect(latestHarness?.result.activeDelegationRun?.runId).toBe("run-stream");
  });

  it("auto-suggests delegation when the session policy asks for useful subagents", async () => {
    await act(async () => {
      create(
        <Harness
          draft=""
          prefs={makePrefs({ subagentPolicy: "ask_when_useful" })}
          messages={makeMessages("Please implement, refactor, test, and review this end-to-end with several agents.")}
        />,
      );
      await flushEffects();
    });

    expect(suggestChatDelegationMock).toHaveBeenCalledWith("session-1", {
      objective: "Please implement, refactor, test, and review this end-to-end with several agents.",
    });
    expect(latestHarness?.result.delegationSuggestion?.objective).toBe("Suggested plan");
    expect(latestHarness?.notices.at(-1)?.content).toContain("Subagents may help");
  });

  it("handles missing sessions, empty objectives, and API failures", async () => {
    await act(async () => {
      create(<Harness selectedSession={null} prefs={makePrefs({ subagentPolicy: "off" })} />);
      await flushEffects();
    });
    await act(async () => {
      await latestHarness?.result.handleProactivePolicyPatch({ proactiveMode: "auto" });
      await latestHarness?.result.handleTriggerProactive();
      await latestHarness?.result.handleSuggestDelegation();
      await latestHarness?.result.handleAcceptDelegation();
      await latestHarness?.result.handleRunCodeDelegation("review");
    });
    expect(updateChatProactivePolicyMock).not.toHaveBeenCalled();
    expect(triggerChatProactiveMock).not.toHaveBeenCalled();
    expect(suggestChatDelegationMock).not.toHaveBeenCalled();
    expect(runChatDelegationMock).not.toHaveBeenCalled();

    runChatResearchMock.mockRejectedValueOnce(new Error("research down"));
    await act(async () => {
      create(
        <Harness
          prefs={makePrefs({ subagentPolicy: "off", webMode: "deep" })}
          draft=""
          messages={makeMessages("Research the release")}
        />,
      );
      await flushEffects();
    });
    await act(async () => {
      await latestHarness?.result.handleRunQuickResearch();
    });
    expect(runChatResearchMock).toHaveBeenCalledWith("session-1", {
      query: "Research the release",
      mode: "deep",
      providerId: "openai",
      model: "gpt-5.5",
    });
    expect(latestHarness?.errors).toContain("research down");

    updateChatProactivePolicyMock.mockRejectedValueOnce(new Error("policy down"));
    await act(async () => {
      await latestHarness?.result.handleProactivePolicyPatch({ retrievalMode: "deep" });
    });
    expect(latestHarness?.errors).toContain("policy down");

    updateChatProactivePolicyMock.mockResolvedValueOnce({
      mode: "auto",
      autonomyBudget: { maxActionsPerHour: 4, maxActionsPerTurn: 2, cooldownSeconds: 10 },
      retrievalMode: "deep",
      reflectionMode: "summary",
    });
    await act(async () => {
      create(<Harness prefs={null} />);
      await flushEffects();
    });
    await act(async () => {
      await latestHarness?.result.handleProactivePolicyPatch({ proactiveMode: "auto" });
    });
    expect(latestHarness?.prefs).toBeNull();

    triggerChatProactiveMock.mockRejectedValueOnce(new Error("proactive down"));
    await act(async () => {
      await latestHarness?.result.handleTriggerProactive();
    });
    expect(latestHarness?.errors).toContain("proactive down");

    await act(async () => {
      create(<Harness draft="" messages={[]} prefs={makePrefs({ subagentPolicy: "off" })} />);
      await flushEffects();
    });
    await act(async () => {
      await latestHarness?.result.handleSuggestDelegation();
    });
    expect(latestHarness?.errors).toContain("Write a request first so I can suggest a delegation plan.");

    suggestChatDelegationMock.mockRejectedValueOnce(new Error("suggest down"));
    await act(async () => {
      create(
        <Harness
          draft=""
          messages={makeMessages("Split this across agents")}
          prefs={makePrefs({ subagentPolicy: "off" })}
        />,
      );
      await flushEffects();
    });
    await act(async () => {
      await latestHarness?.result.handleSuggestDelegation();
    });
    expect(latestHarness?.errors).toContain("suggest down");
  });

  it("handles workflow fetch failures and cancellation cleanup", async () => {
    fetchChatDelegationRunMock.mockRejectedValueOnce(new Error("fetch down"));
    await act(async () => {
      create(<Harness thread={makeThread(true)} prefs={makePrefs({ subagentPolicy: "off" })} />);
      await flushEffects();
    });
    expect(fetchChatDelegationRunMock).toHaveBeenCalledWith("session-1", "run-existing");
    expect(latestHarness?.result.activeDelegationRun).toBeNull();

    let resolveFetch!: (value: unknown) => void;
    fetchChatDelegationRunMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(<Harness thread={makeThread(true)} prefs={makePrefs({ subagentPolicy: "off" })} />);
      await flushEffects();
    });
    await act(async () => {
      renderer?.unmount();
      await flushEffects();
    });
    await act(async () => {
      resolveFetch({
        run: {
          runId: "run-cancelled",
          taskId: "task-cancelled",
          objective: "Cancelled",
          mode: "parallel",
          status: "running",
        },
        steps: [],
      });
      await flushEffects();
    });

    let rejectFetch!: (error: Error) => void;
    fetchChatDelegationRunMock.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectFetch = reject;
      }),
    );
    await act(async () => {
      renderer = create(<Harness thread={makeThread(true)} prefs={makePrefs({ subagentPolicy: "off" })} />);
      await flushEffects();
    });
    await act(async () => {
      renderer?.unmount();
      await flushEffects();
    });
    await act(async () => {
      rejectFetch(new Error("late fetch down"));
      await flushEffects();
    });
  });

  it("accepts role-only delegation graphs and reports failed non-stream results", async () => {
    runChatDelegationMock.mockResolvedValueOnce({
      runId: "run-failed",
      taskId: "task-failed",
      executionPlanId: "plan-failed",
      steps: [{ stepId: "delegation-step-1", runId: "run-failed", role: "Architect", status: "failed", index: 0 }],
      stitchedOutput: "Delegation failed.",
    });
    await act(async () => {
      create(<Harness thread={makeThreadWithoutDelegatedSteps()} prefs={makePrefs({ subagentPolicy: "off" })} />);
      await flushEffects();
    });
    await act(async () => {
      latestHarness?.result.setDelegationSuggestion({
        objective: "Review the migration",
        mode: "sequential",
        roles: ["Architect"],
        rationale: "A single review lane is enough.",
      } as any);
      await flushEffects();
    });
    await act(async () => {
      await latestHarness?.result.handleAcceptDelegation();
    });
    expect(runChatDelegationMock).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        objective: "Review the migration",
        roles: ["Architect"],
      }),
    );
    expect(runChatDelegationMock.mock.calls.at(-1)?.[1]).not.toHaveProperty("steps");
    expect(latestHarness?.result.activeDelegationRun?.status).toBe("failed");
  });

  it("surfaces stream failures and missing final delegation payloads", async () => {
    streamChatDelegationMock.mockImplementationOnce(async (_sessionId, _request, onChunk) => {
      onChunk({ type: "status", runId: "run-failing", taskId: "task-failing", message: "Opening stream" });
      onChunk({
        type: "step",
        runId: "run-failing",
        taskId: "task-failing",
        step: { stepId: "delegation-step-1", runId: "run-failing", role: "architect", status: "failed", index: 0 },
      });
      throw new Error("stream down");
    });
    await act(async () => {
      create(<Harness streamEnabled thread={null} prefs={makePrefs({ subagentPolicy: "off" })} />);
      await flushEffects();
    });
    await act(async () => {
      latestHarness?.result.setDelegationSuggestion({
        objective: "Stream this plan",
        mode: "parallel",
        roles: ["Architect"],
        rationale: "Needs streaming.",
      } as any);
      await flushEffects();
    });
    await act(async () => {
      await latestHarness?.result.handleAcceptDelegation();
      await flushEffects();
    });
    expect(latestHarness?.errors).toContain("stream down");

    streamChatDelegationMock.mockImplementationOnce(async (_sessionId, _request, onChunk) => {
      onChunk({ type: "status", runId: "run-empty", taskId: "task-empty" });
    });
    await act(async () => {
      create(<Harness streamEnabled thread={null} prefs={makePrefs({ subagentPolicy: "off" })} />);
      await flushEffects();
    });
    await act(async () => {
      latestHarness?.result.setDelegationSuggestion({
        objective: "Finish without payload",
        mode: "parallel",
        roles: ["Architect"],
        rationale: "Exercises the guard.",
      } as any);
      await flushEffects();
    });
    await act(async () => {
      await latestHarness?.result.handleAcceptDelegation();
    });
    expect(latestHarness?.errors).toContain("Delegation finished without a final result payload.");
  });

  it("runs auto delegation policies, deduplicates recommendations, and reports auto failures", async () => {
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <Harness
          draft=""
          prefs={makePrefs({ subagentPolicy: "auto_when_useful" })}
          messages={makeMessages("Please implement, refactor, test, review, and ship this full end-to-end workflow.")}
        />,
      );
      await flushEffects();
    });
    expect(suggestChatDelegationMock).toHaveBeenCalledWith("session-1", {
      objective: "Please implement, refactor, test, review, and ship this full end-to-end workflow.",
    });
    expect(runChatDelegationMock).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ objective: "Suggested plan", roles: ["Architect", "Coder"] }),
    );
    expect(latestHarness?.loadSidebar).toHaveBeenCalled();
    expect(latestHarness?.sending).toBe(false);

    await act(async () => {
      renderer?.update(
        <Harness
          draft=""
          prefs={makePrefs({ subagentPolicy: "auto_when_useful" })}
          messages={makeMessages("Please implement, refactor, test, review, and ship this full end-to-end workflow.")}
        />,
      );
      await flushEffects();
    });
    expect(suggestChatDelegationMock).toHaveBeenCalledTimes(1);

    suggestChatDelegationMock.mockRejectedValueOnce(new Error("auto suggest down"));
    await act(async () => {
      create(
        <Harness
          draft=""
          selectedSession={{ ...makeSession(), sessionId: "session-auto-error" }}
          prefs={makePrefs({ subagentPolicy: "auto_when_useful" })}
          messages={makeMessages("Please implement, refactor, test, review, and ship this full error workflow.")}
        />,
      );
      await flushEffects();
    });
    expect(latestHarness?.errors).toContain("auto suggest down");
    expect(latestHarness?.sending).toBe(false);
  });

  it("does not continue auto delegation work after unmount cancellation", async () => {
    let resolveSuggestion!: (value: unknown) => void;
    suggestChatDelegationMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSuggestion = resolve;
      }),
    );
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <Harness
          draft=""
          prefs={makePrefs({ subagentPolicy: "auto_when_useful" })}
          messages={makeMessages("Please implement, refactor, test, review, and ship this cancellable workflow.")}
        />,
      );
      await flushEffects();
    });
    await act(async () => {
      renderer?.unmount();
      await flushEffects();
    });
    await act(async () => {
      resolveSuggestion({
        suggestion: {
          objective: "Cancelled suggestion",
          mode: "parallel",
          roles: ["Architect", "Coder"],
          rationale: "Cancelled.",
        },
      });
      await flushEffects();
    });
    expect(runChatDelegationMock).not.toHaveBeenCalled();
  });

  it("falls back to code objective sources and reports code delegation failures", async () => {
    await act(async () => {
      create(
        <Harness
          surfaceMode="code"
          draft=""
          messages={[]}
          selectedSession={{ ...makeSession(), title: "   " }}
          prefs={makePrefs({ subagentPolicy: "off" })}
        />,
      );
      await flushEffects();
    });
    await act(async () => {
      await latestHarness?.result.handleRunCodeDelegation("test");
    });
    expect(latestHarness?.errors).toContain(
      "Write a coding objective first so GoatCitadel has something concrete to implement or review.",
    );

    runChatDelegationMock.mockRejectedValueOnce(new Error("delegation down"));
    await act(async () => {
      create(
        <Harness
          surfaceMode="code"
          draft=""
          messages={makeMessages("Review the release branch")}
          prefs={makePrefs({ subagentPolicy: "off" })}
        />,
      );
      await flushEffects();
    });
    await act(async () => {
      await latestHarness?.result.handleRunCodeDelegation("test");
    });
    expect(runChatDelegationMock).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ objective: expect.stringContaining("Review the release branch") }),
    );
    expect(latestHarness?.errors).toContain("delegation down");
  });

  it("auto-suggests for cowork surfaces and long chat tasks with few explicit complexity terms", async () => {
    await act(async () => {
      create(
        <Harness
          draft=""
          surfaceMode="cowork"
          prefs={makePrefs({ subagentPolicy: "ask_when_useful" })}
          messages={makeMessages("summarize")}
        />,
      );
      await flushEffects();
    });
    expect(suggestChatDelegationMock).toHaveBeenCalledWith("session-1", { objective: "summarize" });

    suggestChatDelegationMock.mockClear();
    await act(async () => {
      create(
        <Harness
          draft=""
          prefs={makePrefs({ subagentPolicy: "ask_when_useful" })}
          messages={makeMessages(Array.from({ length: 60 }, (_unused, index) => `word${index}`).join(" "))}
        />,
      );
      await flushEffects();
    });
    expect(suggestChatDelegationMock).toHaveBeenCalledTimes(1);
  });

  it("uses request metadata fallbacks when a delegation stream only emits a final payload", async () => {
    streamChatDelegationMock.mockImplementationOnce(async (_sessionId, _request, onChunk) => {
      onChunk({
        type: "done",
        result: {
          runId: "run-done-only",
          taskId: "task-done-only",
          executionPlanId: "plan-done-only",
          steps: [{ stepId: "done-step", runId: "run-done-only", role: "Architect", status: "completed", index: 0 }],
          stitchedOutput: "Done-only stream output",
        },
      });
    });

    await act(async () => {
      create(
        <Harness
          streamEnabled
          thread={{ sessionId: "session-1", selectedTurnId: null, activeLeafTurnId: null, turns: [] } as any}
          prefs={makePrefs({ subagentPolicy: "off" })}
        />,
      );
      await flushEffects();
    });
    await act(async () => {
      latestHarness?.result.setDelegationSuggestion({
        objective: "Done-only objective",
        mode: "parallel",
        roles: ["Architect"],
        rationale: "Covers final chunk fallbacks.",
      } as any);
      await flushEffects();
    });
    await act(async () => {
      await latestHarness?.result.handleAcceptDelegation();
      await flushEffects();
    });

    expect(latestHarness?.result.activeDelegationRun).toMatchObject({
      runId: "run-done-only",
      taskId: "task-done-only",
      executionPlanId: "plan-done-only",
      attachedTurnId: null,
      label: "Delegation",
      objective: "Done-only objective",
      mode: "parallel",
      status: "completed",
      stitchedOutput: "Done-only stream output",
    });
  });

  it("keeps auto-subagent recommendation guards explicit for draft, policy, session, and simple chat cases", async () => {
    await act(async () => {
      create(
        <Harness
          draft="unsent operator draft"
          prefs={makePrefs({ subagentPolicy: "ask_when_useful" })}
          messages={makeMessages("Please implement, refactor, test, and review this end-to-end.")}
        />,
      );
      await flushEffects();
    });
    expect(suggestChatDelegationMock).not.toHaveBeenCalled();

    await act(async () => {
      create(
        <Harness
          draft=""
          prefs={makePrefs({ subagentPolicy: "off" })}
          messages={makeMessages("Please implement, refactor, test, and review this end-to-end.")}
        />,
      );
      await flushEffects();
    });
    expect(suggestChatDelegationMock).not.toHaveBeenCalled();

    await act(async () => {
      create(
        <Harness
          draft=""
          selectedSession={null}
          prefs={makePrefs({ subagentPolicy: "ask_when_useful" })}
          messages={makeMessages("Please implement, refactor, test, and review this end-to-end.")}
        />,
      );
      await flushEffects();
    });
    expect(suggestChatDelegationMock).not.toHaveBeenCalled();

    await act(async () => {
      create(
        <Harness
          draft=""
          sendingInitial
          prefs={makePrefs({ subagentPolicy: "ask_when_useful" })}
          messages={makeMessages("Please implement, refactor, test, and review this end-to-end.")}
        />,
      );
      await flushEffects();
    });
    expect(suggestChatDelegationMock).not.toHaveBeenCalled();

    await act(async () => {
      create(
        <Harness draft="" prefs={makePrefs({ subagentPolicy: "ask_when_useful" })} messages={makeMessages("simple")} />,
      );
      await flushEffects();
    });
    expect(suggestChatDelegationMock).not.toHaveBeenCalled();

    await act(async () => {
      create(
        <Harness
          draft=""
          prefs={makePrefs({ subagentPolicy: "ask_when_useful" })}
          messages={[]}
          selectedSession={{ ...makeSession(), title: "Session fallback is not user intent" }}
        />,
      );
      await flushEffects();
    });
    expect(suggestChatDelegationMock).not.toHaveBeenCalled();
  });
});
