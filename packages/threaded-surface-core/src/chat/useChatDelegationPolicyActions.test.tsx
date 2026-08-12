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
  shouldHydrateTraceDelegationRun,
  useChatDelegationPolicyActions,
} from "./useChatDelegationPolicyActions";
import { useChatDelegatedScopeControls, type ThreadedDelegatedScopeControls } from "./useChatDelegatedScopeControls";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchChatDelegationRunMock = vi.fn();
const fetchLatestChatWorkspaceExplorerMock = vi.fn();
const fetchChatDelegatedScopeCandidatesMock = vi.fn();
const requestChatDelegatedScopeExpansionMock = vi.fn();
const runChatDelegationMock = vi.fn();
const runChatResearchMock = vi.fn();
const streamChatDelegationMock = vi.fn();
const suggestChatDelegationMock = vi.fn();
const triggerChatProactiveMock = vi.fn();
const updateChatProactivePolicyMock = vi.fn();
const fetchChatProactiveStatusMock = vi.fn();
const ApiRequestErrorMock = vi.hoisted(
  () =>
    class ApiRequestError extends Error {
      public readonly status?: number;
      public constructor(message: string, options: { status?: number }) {
        super(message);
        this.status = options.status;
      }
    },
);

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  ApiRequestError: ApiRequestErrorMock,
  fetchChatProactiveStatus: (...args: unknown[]) => fetchChatProactiveStatusMock(...args),
  fetchChatDelegationRun: (...args: unknown[]) => fetchChatDelegationRunMock(...args),
  fetchLatestChatWorkspaceExplorer: (...args: unknown[]) => fetchLatestChatWorkspaceExplorerMock(...args),
  fetchChatDelegatedScopeCandidates: (...args: unknown[]) => fetchChatDelegatedScopeCandidatesMock(...args),
  requestChatDelegatedScopeExpansion: (...args: unknown[]) => requestChatDelegatedScopeExpansionMock(...args),
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
  delegatedScopeControls: ThreadedDelegatedScopeControls | null;
};

let latestHarness: HarnessSnapshot | null = null;

function makeSession(): ChatSessionRecord {
  return {
    sessionId: "session-1",
    revision: 7,
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
    revision: 7,
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

function makeThreadWithDurableParent(): ChatThreadResponse {
  const thread = makeThreadWithoutDelegatedSteps();
  thread.turns[0]!.trace.durable = { runId: "durable-parent-1", status: "completed" };
  return thread;
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
  fetchLatestChatWorkspaceExplorerMock.mockResolvedValue(null);
  fetchChatDelegatedScopeCandidatesMock.mockResolvedValue({
    runId: "run-stream",
    stepId: "step-stream",
    scopeHash: "scope-stream",
    candidates: [],
  });
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
    revision: 8,
    mode: "auto",
    autonomyBudget: { maxActionsPerHour: 2, maxActionsPerTurn: 1, cooldownSeconds: 30 },
    retrievalMode: "deep",
    reflectionMode: "summary",
  });
  fetchChatProactiveStatusMock.mockResolvedValue({
    policy: {
      sessionId: "session-1",
      revision: 8,
      mode: "off",
      autonomyBudget: { maxActionsPerHour: 2, maxActionsPerTurn: 1, cooldownSeconds: 30 },
      retrievalMode: "standard",
      reflectionMode: "off",
      updatedAt: "2026-05-01T00:00:00.000Z",
    },
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
  fullWebAccess?: boolean;
  streamEnabled?: boolean;
  sendingInitial?: boolean;
  selectedSession?: ChatSessionRecord | null;
  thread?: ChatThreadResponse | null;
  codeModeNeedsProjectBinding?: boolean;
  runtimeBlocked?: boolean;
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
  const runtimeBlockerActiveRef = useRef(Boolean(props.runtimeBlocked));
  runtimeBlockerActiveRef.current = Boolean(props.runtimeBlocked);
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
    fullWebAccess: props.fullWebAccess,
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
    runtimeBlockerActiveRef,
  });
  const delegatedScopeControls = useChatDelegatedScopeControls({
    sessionId: selectedSession?.sessionId ?? null,
    delegationRun: result.activeDelegationRun,
    pushLocalNotice,
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
    delegatedScopeControls,
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
      policyRunId: "run-existing",
      policyTaskId: "task-existing",
      surface: "chat",
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
      surface: "chat",
    });
  });

  it("does not synthesize an explorer report from a role-only standard run", async () => {
    fetchChatDelegationRunMock.mockResolvedValueOnce({
      run: {
        runId: "run-existing",
        taskId: "task-standard-role-only",
        objective: "Inspect without the explorer profile",
        roles: ["workspace-explorer"],
        mode: "sequential",
        status: "completed",
        stitchedOutput: "Standard delegation output.",
      },
      steps: [
        {
          stepId: "standard-role-only-step",
          runId: "run-existing",
          role: "workspace-explorer",
          status: "completed",
          index: 0,
        },
      ],
    });

    await act(async () => {
      create(<Harness thread={makeThread(true)} />);
      await flushEffects();
    });

    expect(latestHarness?.result.activeDelegationRun).toMatchObject({
      runId: "run-existing",
      label: "Delegation",
    });
    expect(latestHarness?.result.activeDelegationRun?.explorer).toBeUndefined();
  });

  it("recovers the latest canonical explorer report after reload", async () => {
    fetchLatestChatWorkspaceExplorerMock.mockResolvedValueOnce({
      run: {
        runId: "explorer-recovered",
        parentRunId: "durable-parent-1",
        sessionId: "session-1",
        taskId: "task-explorer",
        objective: "Find the runtime owner",
        roles: ["workspace-explorer"],
        mode: "sequential",
        status: "completed",
        workflowTemplate: "read_only_workspace_explorer",
        stitchedOutput: "The Gateway owns runtime truth.",
        citations: [],
        startedAt: "2026-08-12T00:00:00.000Z",
      },
      steps: [
        {
          stepId: "explorer-step",
          runId: "explorer-recovered",
          role: "workspace-explorer",
          status: "completed",
          index: 0,
          startedAt: "2026-08-12T00:00:00.000Z",
          durableRunId: "durable-explorer-child",
        },
      ],
      explorer: {
        profile: "read_only_explorer",
        answer: "The Gateway owns runtime truth.",
        evidenceReferences: ["apps/gateway/src/services/gateway-service.ts"],
        searchedScope: {
          kind: "server_owned_delegated_scope",
          approvedPaths: ["apps/gateway"],
          scopeHashes: ["scope-hash"],
        },
        partialResult: false,
        gaps: [],
      },
    });

    await act(async () => {
      create(
        <Harness
          thread={makeThreadWithDurableParent()}
          selectedSession={{ ...makeSession(), projectId: "project-1" }}
          prefs={makePrefs({ subagentPolicy: "off" })}
        />,
      );
      await flushEffects();
    });

    expect(fetchLatestChatWorkspaceExplorerMock).toHaveBeenCalledWith("session-1");
    expect(latestHarness?.result.activeDelegationRun).toMatchObject({
      runId: "explorer-recovered",
      attachedTurnId: "turn-1",
      label: "Workspace exploration",
      explorer: { answer: "The Gateway owns runtime truth.", partialResult: false },
    });
  });

  it("binds direct explorer work to the selected durable turn for the existing background rail", async () => {
    runChatDelegationMock.mockResolvedValueOnce({
      runId: "explorer-direct",
      taskId: "task-explorer",
      status: "completed",
      steps: [
        {
          stepId: "explorer-step",
          runId: "explorer-direct",
          role: "workspace-explorer",
          status: "completed",
          index: 0,
        },
      ],
      stitchedOutput: "Found it.",
      citations: [],
      explorer: {
        profile: "read_only_explorer",
        answer: "Found it.",
        evidenceReferences: [],
        searchedScope: { kind: "server_owned_delegated_scope", approvedPaths: [], scopeHashes: [] },
        partialResult: false,
        gaps: [],
      },
    });
    await act(async () => {
      create(
        <Harness
          thread={makeThreadWithDurableParent()}
          selectedSession={{ ...makeSession(), projectId: "project-1" }}
          prefs={makePrefs({ subagentPolicy: "off" })}
        />,
      );
      await flushEffects();
    });
    await act(async () => {
      await latestHarness?.result.handleExploreWorkspace();
    });

    expect(streamChatDelegationMock).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        executionProfile: "read_only_explorer",
        policyRunId: "durable-parent-1",
        roles: ["Workspace explorer"],
      }),
      expect.any(Function),
      expect.objectContaining({ signal: expect.any(Object) }),
    );
    expect(runChatDelegationMock).not.toHaveBeenCalled();
  });

  it("exposes governed scope controls from a waiting explorer stream before the done chunk", async () => {
    const scopeHash = "c".repeat(64);
    const candidate = { candidateId: "d".repeat(64), label: "packages", scopeHash };
    let releaseStream!: () => void;
    let doneEmitted = false;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    fetchChatDelegatedScopeCandidatesMock.mockResolvedValueOnce({
      runId: "explorer-stream",
      stepId: "explorer-stream-step",
      scopeHash,
      candidates: [candidate],
    });
    streamChatDelegationMock.mockImplementationOnce(async (_sessionId, _request, onChunk) => {
      onChunk({ type: "status", runId: "explorer-stream", taskId: "task-explorer-stream" });
      onChunk({
        type: "step",
        runId: "explorer-stream",
        taskId: "task-explorer-stream",
        step: {
          stepId: "explorer-stream-step",
          runId: "explorer-stream",
          role: "workspace-explorer",
          status: "running",
          index: 0,
          startedAt: "2026-08-12T12:00:00.000Z",
          scopeControl: {
            rootPath: "F:\\private\\workspace",
            resolvedPaths: ["F:\\private\\workspace\\src"],
            approvedPaths: ["src"],
            scopeHash,
            dispatchGeneration: "dispatch-stream",
            updatedAt: "2026-08-12T12:00:00.000Z",
          },
        },
      });
      await streamGate;
      doneEmitted = true;
      onChunk({
        type: "done",
        result: {
          runId: "explorer-stream",
          taskId: "task-explorer-stream",
          status: "running",
          steps: [
            {
              stepId: "explorer-stream-step",
              runId: "explorer-stream",
              role: "workspace-explorer",
              status: "running",
              index: 0,
              startedAt: "2026-08-12T12:00:00.000Z",
              scopeControl: {
                rootPath: "F:\\private\\workspace",
                approvedPaths: ["src"],
                scopeHash,
                dispatchGeneration: "dispatch-stream",
                updatedAt: "2026-08-12T12:00:00.000Z",
              },
            },
          ],
          stitchedOutput: "Waiting for additional governed scope.",
          citations: [],
        },
      });
    });

    let renderer: ReturnType<typeof create> | undefined;
    await act(async () => {
      renderer = create(
        <Harness
          streamEnabled
          thread={makeThreadWithDurableParent()}
          selectedSession={{ ...makeSession(), projectId: "project-1" }}
          prefs={makePrefs({ subagentPolicy: "off" })}
        />,
      );
      await flushEffects();
    });
    let exploration: Promise<void> | undefined;
    await act(async () => {
      exploration = latestHarness?.result.handleExploreWorkspace();
      await flushEffects(8);
    });

    expect(doneEmitted).toBe(false);
    expect(fetchChatDelegatedScopeCandidatesMock).toHaveBeenCalledWith({
      sessionId: "session-1",
      runId: "explorer-stream",
      stepId: "explorer-stream-step",
    });
    expect(latestHarness?.delegatedScopeControls?.candidates).toEqual([candidate]);
    expect(latestHarness?.delegatedScopeControls?.stepLabel).toBe("Workspace explorer");
    const streamedScope = latestHarness?.result.activeDelegationRun?.steps.find(
      (step) => step.stepId === "explorer-stream-step",
    )?.scopeControl;
    expect(streamedScope).toEqual({
      approvedPaths: ["src"],
      scopeHash,
      dispatchGeneration: "dispatch-stream",
      updatedAt: "2026-08-12T12:00:00.000Z",
    });
    expect(streamedScope).not.toHaveProperty("rootPath");
    expect(streamedScope).not.toHaveProperty("resolvedPaths");

    releaseStream();
    await act(async () => {
      await exploration;
      await flushEffects();
    });
    renderer?.unmount();
  });

  it("hands an active explorer observer to background attention without cancelling or wedging later work", async () => {
    let releaseExplorer!: () => void;
    let releaseResearch!: () => void;
    const explorerGate = new Promise<void>((resolve) => {
      releaseExplorer = resolve;
    });
    const researchGate = new Promise<void>((resolve) => {
      releaseResearch = resolve;
    });
    let explorerSignal: AbortSignal | undefined;
    streamChatDelegationMock.mockImplementationOnce(async (_sessionId, _request, onChunk, options) => {
      explorerSignal = options?.signal;
      onChunk({ type: "status", runId: "explorer-background", taskId: "task-explorer-background" });
      onChunk({
        type: "step",
        runId: "explorer-background",
        taskId: "task-explorer-background",
        step: {
          stepId: "explorer-background-step",
          runId: "explorer-background",
          role: "workspace-explorer",
          status: "running",
          index: 0,
          startedAt: "2026-08-12T12:00:00.000Z",
        },
      });
      // Deliberately ignore abort until released. This models a late transport
      // completion and proves it cannot overwrite a newer foreground action.
      await explorerGate;
      onChunk({
        type: "done",
        result: {
          runId: "explorer-background",
          taskId: "task-explorer-background",
          status: "completed",
          steps: [
            {
              stepId: "explorer-background-step",
              runId: "explorer-background",
              role: "workspace-explorer",
              status: "completed",
              index: 0,
            },
          ],
          stitchedOutput: "Late foreground payload that must be ignored.",
          citations: [],
        },
      });
    });
    runChatResearchMock.mockImplementationOnce(async () => {
      await researchGate;
      return { summary: "New foreground work completed", sources: [] };
    });

    let renderer: ReturnType<typeof create> | undefined;
    await act(async () => {
      renderer = create(
        <Harness
          streamEnabled
          thread={makeThreadWithDurableParent()}
          selectedSession={{ ...makeSession(), projectId: "project-1" }}
          prefs={makePrefs({ subagentPolicy: "off" })}
        />,
      );
      await flushEffects();
    });

    let exploration: Promise<void> | undefined;
    await act(async () => {
      exploration = latestHarness?.result.handleExploreWorkspace();
      await flushEffects(8);
    });
    expect(latestHarness?.sending).toBe(true);
    expect(latestHarness?.result.activeDelegationRun).toMatchObject({
      runId: "explorer-background",
      status: "running",
    });

    let handedOff = false;
    act(() => {
      handedOff =
        latestHarness?.result.continueActiveExplorerInBackground({
          parentRunId: "durable-parent-1",
          watcherId: "delegation-child:explorer-background-step",
        }) ?? false;
    });
    expect(handedOff).toBe(true);
    expect(explorerSignal?.aborted).toBe(true);
    expect(latestHarness?.sending).toBe(false);
    expect(latestHarness?.result.activeDelegationRun).toMatchObject({
      runId: "explorer-background",
      status: "running",
    });

    let research: Promise<void> | undefined;
    await act(async () => {
      research = latestHarness?.result.handleRunQuickResearch();
      await flushEffects();
    });
    expect(latestHarness?.sending).toBe(true);

    releaseExplorer();
    await act(async () => {
      await exploration;
      await flushEffects();
    });
    expect(latestHarness?.sending).toBe(true);
    expect(latestHarness?.result.activeDelegationRun).toMatchObject({
      runId: "explorer-background",
      status: "running",
    });
    expect(latestHarness?.errors).not.toContain("Workspace explorer observation continued in background.");

    releaseResearch();
    await act(async () => {
      await research;
      await flushEffects();
    });
    expect(latestHarness?.sending).toBe(false);
    renderer?.unmount();
  });

  it("streams explorer observation for background handoff when Chat streaming is disabled", async () => {
    let explorerSignal: AbortSignal | undefined;
    streamChatDelegationMock.mockImplementationOnce(async (_sessionId, _request, onChunk, options) => {
      explorerSignal = options?.signal;
      onChunk({ type: "status", runId: "explorer-stream-disabled", taskId: "task-explorer-stream-disabled" });
      onChunk({
        type: "step",
        runId: "explorer-stream-disabled",
        taskId: "task-explorer-stream-disabled",
        step: {
          stepId: "explorer-stream-disabled-step",
          runId: "explorer-stream-disabled",
          role: "workspace-explorer",
          status: "running",
          index: 0,
          startedAt: "2026-08-12T12:00:00.000Z",
        },
      });
      await new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("local observation detached")), {
          once: true,
        });
      });
    });

    let renderer: ReturnType<typeof create> | undefined;
    await act(async () => {
      renderer = create(
        <Harness
          thread={makeThreadWithDurableParent()}
          selectedSession={{ ...makeSession(), projectId: "project-1" }}
          prefs={makePrefs({ subagentPolicy: "off" })}
        />,
      );
      await flushEffects();
    });

    let exploration: Promise<void> | undefined;
    await act(async () => {
      exploration = latestHarness?.result.handleExploreWorkspace();
      await flushEffects(8);
    });

    expect(streamChatDelegationMock).toHaveBeenCalledOnce();
    expect(runChatDelegationMock).not.toHaveBeenCalled();
    expect(explorerSignal).toBeDefined();
    expect(latestHarness?.sending).toBe(true);
    expect(latestHarness?.result.activeDelegationRun).toMatchObject({
      runId: "explorer-stream-disabled",
      status: "running",
    });

    act(() => {
      expect(
        latestHarness?.result.continueActiveExplorerInBackground({
          parentRunId: "durable-parent-1",
          watcherId: "delegation-child:explorer-stream-disabled-step",
        }),
      ).toBe(true);
    });
    await act(async () => {
      await exploration;
      await flushEffects();
    });

    expect(explorerSignal?.aborted).toBe(true);
    expect(latestHarness?.sending).toBe(false);
    expect(latestHarness?.result.activeDelegationRun).toMatchObject({
      runId: "explorer-stream-disabled",
      status: "running",
    });
    expect(latestHarness?.errors).toEqual([]);
    renderer?.unmount();
  });

  it("rehydrates the persisted explorer report when the background rail observes terminal work", async () => {
    let rejectExplorer!: (reason?: unknown) => void;
    streamChatDelegationMock.mockImplementationOnce(async (_sessionId, _request, onChunk, options) => {
      onChunk({ type: "status", runId: "explorer-background", taskId: "task-explorer-background" });
      onChunk({
        type: "step",
        runId: "explorer-background",
        taskId: "task-explorer-background",
        step: {
          stepId: "explorer-background-step",
          runId: "explorer-background",
          role: "workspace-explorer",
          status: "running",
          index: 0,
          startedAt: "2026-08-12T12:00:00.000Z",
        },
      });
      await new Promise<void>((_resolve, reject) => {
        rejectExplorer = reject;
        options?.signal?.addEventListener("abort", () => reject(new Error("local observation detached")), {
          once: true,
        });
      });
    });

    let renderer: ReturnType<typeof create> | undefined;
    await act(async () => {
      renderer = create(
        <Harness
          streamEnabled
          thread={makeThreadWithDurableParent()}
          selectedSession={{ ...makeSession(), projectId: "project-1" }}
          prefs={makePrefs({ subagentPolicy: "off" })}
        />,
      );
      await flushEffects();
    });

    let exploration: Promise<void> | undefined;
    await act(async () => {
      exploration = latestHarness?.result.handleExploreWorkspace();
      await flushEffects(8);
    });
    expect(rejectExplorer).toBeTypeOf("function");
    expect(latestHarness?.result.activeDelegationRun).toMatchObject({
      runId: "explorer-background",
      status: "running",
    });

    act(() => {
      expect(
        latestHarness?.result.continueActiveExplorerInBackground({
          parentRunId: "durable-parent-1",
          watcherId: "delegation-child:explorer-background-step",
        }),
      ).toBe(true);
    });
    await act(async () => {
      await exploration;
      await flushEffects();
    });
    expect(latestHarness?.sending).toBe(false);
    expect(latestHarness?.result.activeDelegationRun).toMatchObject({
      runId: "explorer-background",
      status: "running",
    });

    const persistedExplorerDetail = {
      run: {
        runId: "explorer-background",
        parentRunId: "durable-parent-1",
        sessionId: "session-1",
        taskId: "task-explorer-background",
        objective: "Explore the workspace",
        roles: ["workspace-explorer"],
        mode: "sequential",
        status: "completed",
        workflowTemplate: "read_only_workspace_explorer",
        stitchedOutput: "The persisted Explorer answer.",
        citations: [],
        startedAt: "2026-08-12T12:00:00.000Z",
        finishedAt: "2026-08-12T12:01:00.000Z",
      },
      steps: [
        {
          stepId: "explorer-background-step",
          runId: "explorer-background",
          role: "workspace-explorer",
          status: "completed",
          index: 0,
          durableRunId: "durable-explorer-background-child",
          startedAt: "2026-08-12T12:00:00.000Z",
          finishedAt: "2026-08-12T12:01:00.000Z",
        },
      ],
      explorer: {
        profile: "read_only_explorer",
        answer: "The persisted Explorer answer.",
        evidenceReferences: ["apps/gateway/src/services/gateway-service.ts"],
        searchedScope: {
          kind: "server_owned_delegated_scope",
          approvedPaths: ["apps/gateway"],
          scopeHashes: ["scope-hash"],
        },
        partialResult: false,
        gaps: [],
      },
    };
    fetchChatDelegationRunMock.mockResolvedValue(persistedExplorerDetail);
    fetchChatDelegationRunMock.mockResolvedValueOnce({
      ...persistedExplorerDetail,
      run: { ...persistedExplorerDetail.run, sessionId: "different-session" },
    });

    await act(async () => {
      expect(
        await latestHarness?.result.rehydrateBackgroundExplorerReport({
          parentRunId: "durable-parent-1",
          delegationRunId: "explorer-background",
          delegationStepId: "explorer-background-step",
          childRunId: "durable-explorer-background-child",
        }),
      ).toBe(false);
      expect(
        await latestHarness?.result.rehydrateBackgroundExplorerReport({
          parentRunId: "different-parent",
          delegationRunId: "explorer-background",
          delegationStepId: "explorer-background-step",
          childRunId: "durable-explorer-background-child",
        }),
      ).toBe(false);
      expect(
        await latestHarness?.result.rehydrateBackgroundExplorerReport({
          parentRunId: "durable-parent-1",
          delegationRunId: "different-delegation",
          delegationStepId: "explorer-background-step",
          childRunId: "durable-explorer-background-child",
        }),
      ).toBe(false);
      expect(
        await latestHarness?.result.rehydrateBackgroundExplorerReport({
          parentRunId: "durable-parent-1",
          delegationRunId: "explorer-background",
          delegationStepId: "different-step",
          childRunId: "durable-explorer-background-child",
        }),
      ).toBe(false);
      expect(
        await latestHarness?.result.rehydrateBackgroundExplorerReport({
          parentRunId: "durable-parent-1",
          delegationRunId: "explorer-background",
          delegationStepId: "explorer-background-step",
          childRunId: "different-child",
        }),
      ).toBe(false);
      await flushEffects();
    });
    expect(latestHarness?.result.activeDelegationRun).toMatchObject({
      runId: "explorer-background",
      status: "running",
    });
    expect(latestHarness?.result.activeDelegationRun?.explorer).toBeUndefined();

    let rehydrated = false;
    await act(async () => {
      rehydrated =
        (await latestHarness?.result.rehydrateBackgroundExplorerReport({
          parentRunId: "durable-parent-1",
          delegationRunId: "explorer-background",
          delegationStepId: "explorer-background-step",
          childRunId: "durable-explorer-background-child",
        })) ?? false;
      await flushEffects();
    });

    expect(rehydrated).toBe(true);
    expect(fetchChatDelegationRunMock).toHaveBeenLastCalledWith("session-1", "explorer-background");
    expect(latestHarness?.result.activeDelegationRun).toMatchObject({
      runId: "explorer-background",
      status: "completed",
      stitchedOutput: "The persisted Explorer answer.",
      explorer: {
        answer: "The persisted Explorer answer.",
        evidenceReferences: ["apps/gateway/src/services/gateway-service.ts"],
        partialResult: false,
      },
    });

    let resolveStaleDetail!: (value: typeof persistedExplorerDetail) => void;
    fetchChatDelegationRunMock.mockImplementationOnce(
      () =>
        new Promise<typeof persistedExplorerDetail>((resolve) => {
          resolveStaleDetail = resolve;
        }),
    );
    const staleRefresh = latestHarness?.result.rehydrateBackgroundExplorerReport({
      parentRunId: "durable-parent-1",
      delegationRunId: "explorer-background",
      delegationStepId: "explorer-background-step",
      childRunId: "durable-explorer-background-child",
    });
    await act(async () => {
      renderer?.update(
        <Harness
          streamEnabled
          thread={makeThreadWithDurableParent()}
          selectedSession={{ ...makeSession(), sessionId: "session-2", projectId: "project-1" }}
          prefs={makePrefs({ subagentPolicy: "off" })}
        />,
      );
      await flushEffects();
    });
    resolveStaleDetail({
      ...persistedExplorerDetail,
      explorer: { ...persistedExplorerDetail.explorer, answer: "Stale report that must not cross sessions." },
    });
    await act(async () => {
      expect(await staleRefresh).toBe(false);
      await flushEffects();
    });
    expect(latestHarness?.result.activeDelegationRun).toBeNull();
    renderer?.unmount();
  });

  it("does not launch untracked exploration without project scope and a durable parent", async () => {
    await act(async () => {
      create(<Harness thread={makeThreadWithoutDelegatedSteps()} prefs={makePrefs({ subagentPolicy: "off" })} />);
      await flushEffects();
    });
    expect(latestHarness?.result.workspaceExplorerEligible).toBe(false);
    await act(async () => {
      await latestHarness?.result.handleExploreWorkspace();
    });
    expect(latestHarness?.errors).toContain(
      "Bind this Chat to a project before exploring its governed workspace scope.",
    );

    await act(async () => {
      create(
        <Harness
          thread={makeThreadWithoutDelegatedSteps()}
          selectedSession={{ ...makeSession(), projectId: "project-1" }}
          prefs={makePrefs({ subagentPolicy: "off" })}
        />,
      );
      await flushEffects();
    });
    expect(latestHarness?.result.workspaceExplorerEligible).toBe(false);
    await act(async () => {
      await latestHarness?.result.handleExploreWorkspace();
    });
    expect(latestHarness?.errors).toContain(
      "Send a Chat turn first so workspace exploration can attach to durable progress and recovery.",
    );

    const delegatedParent = makeThread(true);
    delegatedParent.turns[0]!.trace.durable = { runId: "durable-parent-with-delegation", status: "completed" };
    await act(async () => {
      create(
        <Harness
          thread={delegatedParent}
          selectedSession={{ ...makeSession(), projectId: "project-1" }}
          prefs={makePrefs({ subagentPolicy: "off" })}
        />,
      );
      await flushEffects();
    });
    expect(latestHarness?.result.workspaceExplorerEligible).toBe(false);
    await act(async () => {
      await latestHarness?.result.handleExploreWorkspace();
    });
    expect(latestHarness?.errors).toContain(
      "This Chat turn already owns delegated work. Send a new turn before exploring the workspace.",
    );
    expect(runChatDelegationMock).not.toHaveBeenCalled();
  });

  it("does not start quick research while a runtime blocker is active", async () => {
    await act(async () => {
      create(<Harness runtimeBlocked />);
      await flushEffects();
    });

    await act(async () => {
      await latestHarness?.result.handleRunQuickResearch();
    });

    expect(runChatResearchMock).not.toHaveBeenCalled();
    expect(latestHarness?.sending).toBe(false);
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
    const activeRun = {
      label: "Delegation",
      objective: "Test helpers",
      mode: "parallel",
      status: "running",
      steps: [{ stepId: "step-1", role: "Architect", status: "pending", index: 0 }],
    } as any;
    expect(shouldHydrateTraceDelegationRun(null, "run-existing", "turn-1")).toBe(true);
    expect(shouldHydrateTraceDelegationRun({ ...activeRun, attachedTurnId: "turn-2" }, "run-existing", "turn-1")).toBe(
      true,
    );
    expect(shouldHydrateTraceDelegationRun({ ...activeRun, attachedTurnId: "turn-1" }, "run-existing", "turn-1")).toBe(
      false,
    );
    expect(
      shouldHydrateTraceDelegationRun(
        { ...activeRun, runId: "run-newer", attachedTurnId: "turn-1" },
        "run-existing",
        "turn-1",
      ),
    ).toBe(false);
    expect(
      shouldHydrateTraceDelegationRun(
        { ...activeRun, runId: "run-existing", attachedTurnId: "turn-1" },
        "run-existing",
        "turn-1",
      ),
    ).toBe(true);
    expect(
      shouldHydrateTraceDelegationRun(
        { ...activeRun, runId: "run-existing", attachedTurnId: "turn-1", status: "completed" },
        "run-existing",
        "turn-1",
      ),
    ).toBe(false);
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
      expectedRevision: 7,
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
      surface: "chat",
    });
    expect(latestHarness?.proactiveRuns[0]?.runId).toBe("proactive-1");
  });

  it("keeps canonical proactive policy separate from an actual 409 draft and retries explicitly", async () => {
    await act(async () => {
      create(<Harness />);
      await flushEffects();
    });
    updateChatProactivePolicyMock.mockRejectedValueOnce(new ApiRequestErrorMock("stale policy", { status: 409 }));

    await act(async () => {
      await latestHarness?.result.handleProactivePolicyPatch({
        proactiveMode: "auto",
        reflectionMode: "summary",
      });
    });

    expect(latestHarness?.proactiveStatus.mode).toBe("off");
    expect(latestHarness?.prefs?.proactiveMode).toBe("off");
    expect(latestHarness?.result.proactivePolicyConflict).toBe(true);
    expect(latestHarness?.result.proactivePolicyDraft).toEqual({
      proactiveMode: "auto",
      reflectionMode: "summary",
    });
    expect(latestHarness?.errors).toContain(
      "This chat changed elsewhere. Canonical policy was refreshed; your unsaved policy draft is preserved for review and retry.",
    );

    await act(async () => {
      await latestHarness?.result.handleProactivePolicyPatch(latestHarness.result.proactivePolicyDraft!);
    });
    expect(updateChatProactivePolicyMock).toHaveBeenLastCalledWith("session-1", {
      expectedRevision: 8,
      proactiveMode: "auto",
      reflectionMode: "summary",
    });
    expect(latestHarness?.result.proactivePolicyConflict).toBe(false);
    expect(latestHarness?.result.proactivePolicyDraft).toBeNull();
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

  it("carries active workflow lineage into manual delegation requests", async () => {
    await act(async () => {
      create(<Harness thread={makeThread(true)} />);
      await flushEffects();
    });

    await act(async () => {
      await latestHarness?.result.handleSuggestDelegation();
    });
    await act(async () => {
      await latestHarness?.result.handleAcceptDelegation();
    });

    expect(runChatDelegationMock).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        policyRunId: "run-existing",
        policyTaskId: "task-existing",
      }),
    );
  });

  it("does not replace a newer manual delegation with stale trace hydration", async () => {
    await act(async () => {
      create(<Harness thread={makeThread(true)} prefs={makePrefs({ subagentPolicy: "off" })} />);
      await flushEffects();
    });
    expect(latestHarness?.result.activeDelegationRun?.runId).toBe("run-existing");
    fetchChatDelegationRunMock.mockClear();

    runChatDelegationMock.mockResolvedValueOnce({
      runId: "run-newer",
      taskId: "task-newer",
      executionPlanId: "plan-newer",
      steps: [{ stepId: "delegation-step-1", runId: "run-newer", role: "Architect", status: "completed", index: 0 }],
      stitchedOutput: "Fresh manual delegation result.",
    });

    await act(async () => {
      latestHarness?.result.setDelegationSuggestion({
        objective: "Run a fresh delegation",
        mode: "sequential",
        roles: ["Architect"],
        rationale: "Operator approved a new subagent pass.",
      } as any);
      await flushEffects();
    });
    await act(async () => {
      await latestHarness?.result.handleAcceptDelegation();
      await flushEffects();
    });

    expect(fetchChatDelegationRunMock).not.toHaveBeenCalled();
    expect(latestHarness?.result.activeDelegationRun).toEqual(
      expect.objectContaining({
        runId: "run-newer",
        taskId: "task-newer",
        status: "completed",
      }),
    );
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
        expect.stringContaining("Ship cycle finished partially:"),
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
    expect(latestHarness?.notices.map((notice) => notice.content)).not.toContain(
      "Subagents may help with this task. Review the suggested delegation plan in Assist.",
    );
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
      surface: "chat",
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
      create(
        <Harness
          thread={makeThreadWithoutDelegatedSteps()}
          prefs={makePrefs({ subagentPolicy: "off" })}
          fullWebAccess
        />,
      );
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
        fullWebAccess: true,
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
      expect.objectContaining({
        objective: expect.stringContaining("Review the release branch"),
        surfaceMode: "code",
      }),
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
        <Harness
          draft=""
          surfaceMode="cowork"
          thread={
            {
              sessionId: "session-1",
              selectedTurnId: "turn-1",
              activeLeafTurnId: "turn-1",
              turns: [
                {
                  turnId: "turn-1",
                  userMessage: makeMessages("Please implement, refactor, test, and review this end-to-end.")[0],
                  trace: {
                    status: "partial",
                    routing: {},
                    toolRuns: [],
                    capabilityUpgradeSuggestions: [],
                    specialistCandidateSuggestions: [],
                    orchestration: {
                      runId: "run-existing-partial",
                      status: "partial",
                    },
                  },
                },
              ],
            } as ChatThreadResponse
          }
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
