import React, { useCallback, useMemo, useRef, useState } from "react";
import { act, create as createTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThreadResponse } from "@goatcitadel/contracts";
import { resetChatStreamingPreviewForTests } from "@goatcitadel/mission-control-shared/state/chat-streaming-preview-store";
import type { ActiveChatStreamState, useChatOutboundExecution as OutboundHook } from "./useChatOutboundExecution";
let useChatOutboundExecution: typeof OutboundHook;

const codeLease = vi.hoisted(() => ({
  callerRevision: 0,
  access: 0,
  gateway: "http://gateway-a",
  loads: 0,
  gate: Promise.resolve() as Promise<void>,
}));
vi.mock("@goatcitadel/mission-control-shared/api/access-scope", () => ({
  getGatewayCallerScopeRevision: () => codeLease.callerRevision,
  getGatewayAccessRevision: () => codeLease.access,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => codeLease.gateway,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const approveChatToolMock = vi.fn();
const answerChatUserInputPromptMock = vi.fn();
const submitChatSecureConfigurationMock = vi.fn();
const denyChatToolMock = vi.fn();
const editChatTurnMock = vi.fn();
const fetchChatPendingApprovalsMock = vi.fn();
const resumeChatTurnStreamMock = vi.fn();
const retryChatTurnMock = vi.fn();
const selectChatBranchTurnMock = vi.fn();
const sendAgentChatMessageMock = vi.fn();
const streamAgentChatMessageMock = vi.fn();
const streamEditChatTurnMock = vi.fn();
const streamRetryChatTurnMock = vi.fn();
const recordClientDiagnosticMock = vi.fn();
const recordChatStreamChunkActivityMock = vi.fn();
const clearChatStreamActivityMock = vi.fn();

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  answerChatUserInputPrompt: (...args: unknown[]) => answerChatUserInputPromptMock(...args),
  submitChatSecureConfiguration: (...args: unknown[]) => submitChatSecureConfigurationMock(...args),
  approveChatTool: (...args: unknown[]) => approveChatToolMock(...args),
  denyChatTool: (...args: unknown[]) => denyChatToolMock(...args),
  editChatTurn: (...args: unknown[]) => editChatTurnMock(...args),
  fetchChatPendingApprovals: (...args: unknown[]) => fetchChatPendingApprovalsMock(...args),
  resumeChatTurnStream: (...args: unknown[]) => resumeChatTurnStreamMock(...args),
  retryChatTurn: (...args: unknown[]) => retryChatTurnMock(...args),
  selectChatBranchTurn: (...args: unknown[]) => selectChatBranchTurnMock(...args),
  sendAgentChatMessage: (...args: unknown[]) => sendAgentChatMessageMock(...args),
  streamAgentChatMessage: (...args: unknown[]) => streamAgentChatMessageMock(...args),
  streamEditChatTurn: (...args: unknown[]) => streamEditChatTurnMock(...args),
  streamRetryChatTurn: (...args: unknown[]) => streamRetryChatTurnMock(...args),
}));

vi.mock("@goatcitadel/mission-control-shared/state/dev-diagnostics-store", () => ({
  recordClientDiagnostic: (...args: unknown[]) => recordClientDiagnosticMock(...args),
  createCorrelationId: () => `correlation-${Math.random().toString(36).slice(2)}`,
}));

vi.mock("@goatcitadel/mission-control-shared/state/chat-stream-activity-store", () => ({
  recordChatStreamChunkActivity: (...args: unknown[]) => recordChatStreamChunkActivityMock(...args),
  clearChatStreamActivity: (...args: unknown[]) => clearChatStreamActivityMock(...args),
}));

type HarnessState = {
  execute: (item: any) => Promise<void>;
  approve: (allowScope?: "once" | "session" | "workspace") => Promise<void>;
  deny: () => Promise<void>;
  submitUserInput: (response: any) => Promise<void>;
  selectBranch: (turnId: string) => Promise<ChatThreadResponse | null | undefined>;
  applyFetchedThread: (thread: ChatThreadResponse, requestVersion: number | null) => boolean;
  tryBegin: () => boolean;
  setActiveStream: (stream: ActiveChatStreamState | null) => void;
  setPendingApproval: React.Dispatch<React.SetStateAction<any>>;
  setPendingUserInput: React.Dispatch<React.SetStateAction<any>>;
  getSnapshot: () => {
    activeStream: ActiveChatStreamState | null;
    draft: string;
    error: string | null;
    pendingAttachments: any[];
    pendingApproval: any;
    pendingUserInput: any;
    streamStatus: string;
    streamingPreview: unknown;
    activeStreamingTurnId: string | null;
    optimisticUserMessage: unknown;
    sending: boolean;
    thread: ChatThreadResponse | null;
    mutationVersion: number;
  };
};

let latest: HarnessState | null = null;

/**
 * Every mounted Harness, so `afterEach` can unmount it.
 *
 * Each Harness publishes its hook handle to the module-level `latest` on every
 * render, so `latest` is owned by whichever component rendered most recently.
 * A Harness left mounted after its test ends keeps its pending async work alive
 * (stream reconciliation timers, in-flight session loads, sidebar refreshes);
 * when that work lands it re-renders that stale component and re-points
 * `latest` at a previous test's hook instance. The next test then drives the
 * wrong harness -- typically a streaming one when it asked for a plain send --
 * so the mock it asserts on is never called at all. Unmounting after every test
 * drops those components and their timers, so `latest` can only ever refer to a
 * Harness the current test mounted.
 */
const mountedRenderers: ReturnType<typeof createTestRenderer>[] = [];

function create(element: React.ReactElement) {
  const renderer = createTestRenderer(element);
  mountedRenderers.push(renderer);
  return renderer;
}

function makeThread(): ChatThreadResponse {
  return {
    sessionId: "session-1",
    turns: [
      {
        turnId: "turn-1",
        userMessage: {
          messageId: "user-1",
          sessionId: "session-1",
          role: "user",
          actorType: "user",
          actorId: "operator",
          content: "Original prompt",
          timestamp: "2026-05-03T12:45:00.000Z",
        },
        trace: {
          status: "completed",
          routing: {},
          toolRuns: [],
          capabilityUpgradeSuggestions: [],
          specialistCandidateSuggestions: [],
        },
      },
    ],
    selectedTurnId: "turn-1",
    activeLeafTurnId: "turn-1",
  } as any;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function Harness(props: {
  workspaceId?: string;
  ensureFreshRoutePreflight?: (input?: any) => Promise<any>;
  ensureSession?: (onResolved?: (session: any) => void) => Promise<any>;
  handleCommandExecution?: (sessionId: string, commandText: string) => Promise<void>;
  initialError?: string | null;
  initialErrorSource?: "send" | "edit" | "other" | null;
  initialDraft?: string;
  initialPendingAttachments?: any[];
  initialActiveStream?: ActiveChatStreamState | null;
  initialSending?: boolean;
  initialThread?: ChatThreadResponse | null;
  isRoutePreflightAcknowledged?: (hash: string) => boolean;
  loadSessionCoreState?: (sessionId: string, options?: any) => Promise<void>;
  loadSidebar?: () => Promise<void>;
  pushLocalNotice?: (content: string, tone?: "neutral" | "success" | "warning") => void;
  queuedOutbound?: any[];
  prefs?: any;
  selectedSession?: any | null;
  selectedSessionId?: string | null;
  streamEnabled?: boolean;
  surfaceMode?: "chat" | "cowork" | "code";
  fullWebAccess?: boolean;
  /** Test-only seam: lets a test poison the capability-suggestions setter to
   * simulate an onChunk handler throwing mid-processing. */
  setCapabilitySuggestionsOverride?: (...args: unknown[]) => void;
  setSpecialistSuggestionsOverride?: (...args: unknown[]) => void;
  /** HX-407 C3: success-only consumer for queue-frozen external context refs. */
  onExternalContextSent?: (item: unknown) => void;
  onTemplateInvocationSent?: (item: unknown) => void;
  onWorkspaceSnapshotFailed?: (item: unknown) => void;
}) {
  const [thread, setThread] = useState<ChatThreadResponse | null>(
    props.initialThread === undefined ? makeThread() : props.initialThread,
  );
  const [draft, setDraft] = useState(props.initialDraft ?? "");
  const [pendingAttachments, setPendingAttachments] = useState<any[]>(props.initialPendingAttachments ?? []);
  const [, setCapabilitySuggestionsState] = useState<any[]>([]);
  const setCapabilitySuggestions = props.setCapabilitySuggestionsOverride ?? setCapabilitySuggestionsState;
  const [, setSpecialistSuggestionsState] = useState<any[]>([]);
  const setSpecialistSuggestions = props.setSpecialistSuggestionsOverride ?? setSpecialistSuggestionsState;
  const [sending, setSending] = useState(Boolean(props.initialSending));
  const [error, setErrorState] = useState<string | null>(props.initialError ?? null);
  const activeStreamRef = useRef<ActiveChatStreamState | null>(null);
  if (activeStreamRef.current === null && props.initialActiveStream) {
    activeStreamRef.current = props.initialActiveStream;
  }
  const executeOutboundItemRef = useRef(async (_item: unknown) => undefined);
  const tryBeginOutboundExecutionRef = useRef(() => true);
  const applyFetchedThreadRef = useRef((_thread: ChatThreadResponse, _requestVersion: number | null) => false);
  const messageMutationVersionRef = useRef(0);
  const ensureFreshRoutePreflight = useMemo(
    () =>
      props.ensureFreshRoutePreflight ??
      vi.fn(async () => ({
        requestedProviderId: "openai-codex",
        requestedModel: "gpt-5.5",
        effectiveProviderId: "openai-codex",
        effectiveModel: "gpt-5.5",
        selectionSource: "session",
        fallbackPolicy: "off",
        fallbackResult: "not_applicable",
        runtimeReachability: "not_checked",
        runtimeClass: "cloud",
        decision: {
          action: "send",
          issuedAt: "2026-05-03T12:45:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
          requestedProviderId: "openai-codex",
          requestedModel: "gpt-5.5",
          effectiveProviderId: "openai-codex",
          effectiveModel: "gpt-5.5",
          selectionSource: "session",
          fallbackPolicy: "off",
          fallbackResult: "not_applicable",
          runtimeReachability: "not_checked",
          runtimeClass: "cloud",
          fingerprint: "route-fingerprint",
        },
      })),
    [props.ensureFreshRoutePreflight],
  );
  const setError = useCallback((value: string | null) => {
    setErrorState(value);
  }, []);
  const messages = useMemo(
    () =>
      thread?.turns.flatMap((turn) => [turn.userMessage, ...(turn.assistantMessage ? [turn.assistantMessage] : [])]) ??
      [],
    [thread],
  );

  const outbound = useChatOutboundExecution({
    workspaceId: props.workspaceId,
    sessionConfig: {
      surfaceMode: props.surfaceMode,
      selectedSessionId: props.selectedSessionId === undefined ? "session-1" : props.selectedSessionId,
      selectedSession:
        props.selectedSession === undefined
          ? ({
              sessionId: "session-1",
              projectId: "project-1",
              pinned: false,
              lifecycleStatus: "active",
              scope: "mission",
            } as any)
          : props.selectedSession,
      prefs:
        props.prefs === undefined
          ? ({
              sessionId: "session-1",
              mode: "chat",
              providerId: "openai-codex",
              model: "gpt-5.5",
              webMode: "auto",
              memoryMode: "auto",
              thinkingLevel: "standard",
            } as any)
          : props.prefs,
      fullWebAccess: props.fullWebAccess,
    },
    streamConfig: {
      streamEnabled: props.streamEnabled ?? false,
      activeStreamRef,
    },
    stateConfig: {
      sending,
      error,
      errorSource: props.initialErrorSource ?? null,
      queuedOutbound: props.queuedOutbound ?? [],
      thread,
      messages: messages as any,
    },
    stateSetters: {
      setThread,
      setError,
      setSending,
      setDraft,
      setPendingAttachments,
      setEditingTurnId: vi.fn(),
      setCapabilitySuggestions,
      setSpecialistSuggestions,
    },
    operations: {
      loadSidebar: props.loadSidebar ?? vi.fn(async () => undefined),
      loadSessionCoreState: props.loadSessionCoreState ?? vi.fn(async () => undefined),
      ensureSession:
        props.ensureSession ??
        vi.fn(
          async () =>
            ({
              sessionId: "session-1",
              ...(props.workspaceId === undefined ? {} : { workspaceId: props.workspaceId }),
            }) as any,
        ),
      pushLocalNotice: props.pushLocalNotice ?? vi.fn(),
      handleCommandExecution: props.handleCommandExecution ?? vi.fn(async () => undefined),
    },
    refs: {
      executeOutboundItemRef,
      tryBeginOutboundExecutionRef,
      applyFetchedThreadRef,
      messageMutationVersionRef,
    },
    routing: {
      ensureFreshRoutePreflight,
      isRoutePreflightAcknowledged: props.isRoutePreflightAcknowledged ?? (() => false),
    },
    ...(props.onExternalContextSent || props.onTemplateInvocationSent || props.onWorkspaceSnapshotFailed
      ? {
          externalContext: {
            onExternalContextSent: props.onExternalContextSent,
            onTemplateInvocationSent: props.onTemplateInvocationSent,
            onWorkspaceSnapshotFailed: props.onWorkspaceSnapshotFailed,
          },
        }
      : {}),
  });

  latest = {
    execute: executeOutboundItemRef.current,
    approve: outbound.handleApprovePending,
    deny: outbound.handleDenyPending,
    submitUserInput: outbound.handleSubmitUserInput,
    selectBranch: outbound.handleSelectBranchTurn,
    applyFetchedThread: applyFetchedThreadRef.current,
    tryBegin: tryBeginOutboundExecutionRef.current,
    setActiveStream: (stream) => {
      activeStreamRef.current = stream;
    },
    setPendingApproval: outbound.setPendingApproval,
    setPendingUserInput: outbound.setPendingUserInput,
    getSnapshot: () => ({
      activeStream: activeStreamRef.current,
      draft,
      error,
      pendingAttachments,
      pendingApproval: outbound.pendingApproval,
      pendingUserInput: outbound.pendingUserInput,
      streamStatus: outbound.streamStatus,
      streamingPreview: outbound.streamingPreview,
      activeStreamingTurnId: outbound.activeStreamingTurnId,
      optimisticUserMessage: outbound.optimisticUserMessage,
      sending,
      thread,
      mutationVersion: messageMutationVersionRef.current,
    }),
  };
  return null;
}

describe("outbound action code loading", () => {
  beforeEach(async () => {
    vi.doUnmock("./outbound-execution-code.js");
    vi.resetModules();
    codeLease.callerRevision = 0;
    codeLease.access = 0;
    codeLease.gateway = "http://gateway-a";
    codeLease.gate = Promise.resolve();
    codeLease.loads = 0;
    vi.doMock("./outbound-execution-code.js", async () => {
      codeLease.loads += 1;
      await codeLease.gate;
      return vi.importActual("./outbound-execution-code.js");
    });
    ({ useChatOutboundExecution } = await import("./useChatOutboundExecution"));

    latest = null;
    resetChatStreamingPreviewForTests();
    approveChatToolMock.mockReset();
    answerChatUserInputPromptMock.mockReset();
    submitChatSecureConfigurationMock.mockReset();
    denyChatToolMock.mockReset();
    editChatTurnMock.mockReset();
    fetchChatPendingApprovalsMock.mockReset();
    resumeChatTurnStreamMock.mockReset();
    retryChatTurnMock.mockReset();
    selectChatBranchTurnMock.mockReset();
    sendAgentChatMessageMock.mockReset();
    streamAgentChatMessageMock.mockReset();
    streamEditChatTurnMock.mockReset();
    streamRetryChatTurnMock.mockReset();
    recordClientDiagnosticMock.mockReset();
    recordChatStreamChunkActivityMock.mockReset();
    clearChatStreamActivityMock.mockReset();
    fetchChatPendingApprovalsMock.mockResolvedValue({
      items: [],
      activeApprovalId: null,
      remainingCount: 0,
    });
    sendAgentChatMessageMock.mockResolvedValue({
      sessionId: "session-1",
      turnId: "turn-2",
      userMessage: {
        messageId: "user-2",
        sessionId: "session-1",
        role: "user",
        actorType: "user",
        actorId: "operator",
        content: "Coordinate beta outreach",
        timestamp: "2026-05-03T12:45:02.000Z",
      },
      assistantMessage: {
        messageId: "assistant-2",
        sessionId: "session-1",
        role: "assistant",
        actorType: "agent",
        actorId: "assistant",
        content: "Done",
        timestamp: "2026-05-03T12:45:03.000Z",
      },
      trace: {
        status: "completed",
        routing: {},
        toolRuns: [],
        capabilityUpgradeSuggestions: [],
        specialistCandidateSuggestions: [],
      },
    });
    retryChatTurnMock.mockResolvedValue({
      sessionId: "session-1",
      turnId: "turn-2",
      userMessage: {
        messageId: "user-1",
        sessionId: "session-1",
        role: "user",
        actorType: "user",
        actorId: "operator",
        content: "Original prompt",
        timestamp: "2026-05-03T12:45:00.000Z",
      },
      assistantMessage: {
        messageId: "assistant-2",
        sessionId: "session-1",
        role: "assistant",
        actorType: "agent",
        actorId: "assistant",
        content: "Retried",
        timestamp: "2026-05-03T12:45:03.000Z",
      },
      trace: {
        status: "completed",
        routing: {},
        toolRuns: [],
        capabilityUpgradeSuggestions: [],
        specialistCandidateSuggestions: [],
      },
    });
    editChatTurnMock.mockResolvedValue({
      sessionId: "session-1",
      turnId: "turn-2",
      userMessage: {
        messageId: "user-2",
        sessionId: "session-1",
        role: "user",
        actorType: "user",
        actorId: "operator",
        content: "Edited prompt",
        timestamp: "2026-05-03T12:45:02.000Z",
      },
      assistantMessage: {
        messageId: "assistant-2",
        sessionId: "session-1",
        role: "assistant",
        actorType: "agent",
        actorId: "assistant",
        content: "Edited",
        timestamp: "2026-05-03T12:45:03.000Z",
      },
      trace: {
        status: "completed",
        routing: {},
        toolRuns: [],
        capabilityUpgradeSuggestions: [],
        specialistCandidateSuggestions: [],
      },
    });
  });
  afterEach(() => {
    // Unmount before restoring real timers so the teardown clearTimeout calls
    // still target the same timer implementation the test scheduled against.
    act(() => {
      for (const renderer of mountedRenderers.splice(0)) {
        renderer.unmount();
      }
    });
    latest = null;
    vi.doUnmock("./outbound-execution-code.js");
    vi.resetModules();
    vi.useRealTimers();
  });

  const item = () => ({
    id: "code-load-send",
    action: "send" as const,
    sessionId: "session-1",
    content: "Queued message",
    attachments: [],
    createdAt: "2026-10-14T00:00:00.000Z",
  });
  async function mount(props: Parameters<typeof Harness>[0] = {}) {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<Harness {...props} />);
    });
    return renderer;
  }
  async function begin(value: ReturnType<typeof item> & { requestPrefs?: any } = item()) {
    let attempt!: Promise<void>;
    await act(async () => {
      expect(latest!.tryBegin()).toBe(true);
      attempt = latest!.execute(value);
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(codeLease.loads).toBeGreaterThan(0);
    });
    return { attempt };
  }

  it("projects immediately and excludes another admission while code and I/O are pending", async () => {
    const ensureSession = vi.fn(async () => ({ sessionId: "session-1" }) as any);
    await mount({ ensureSession });
    const gate = createDeferred<void>();
    codeLease.gate = gate.promise;
    const { attempt } = await begin();
    expect(latest!.getSnapshot().optimisticUserMessage).toEqual(expect.objectContaining({ content: "Queued message" }));
    expect(latest!.getSnapshot().sending).toBe(true);
    expect(latest!.getSnapshot().streamStatus).toBe("connecting");
    expect(latest!.tryBegin()).toBe(false);
    expect(ensureSession).not.toHaveBeenCalled();
    expect(sendAgentChatMessageMock).not.toHaveBeenCalled();
    await act(async () => {
      gate.resolve();
      await attempt;
    });
    expect(sendAgentChatMessageMock).toHaveBeenCalledTimes(1);
    expect(latest!.getSnapshot().sending).toBe(false);
  });

  it.each([
    "session",
    "session ABA",
    "workspace",
    "workspace ABA",
    "unmount",
    "caller ABA",
    "Gateway",
    "access",
  ] as const)("performs no outbound I/O after %s changes during code loading", async (change) => {
    const ensureSession = vi.fn(async () => ({ sessionId: "session-1", workspaceId: "workspace-a" }) as any);
    const preflight = vi.fn(async () => null);
    const props = { workspaceId: "workspace-a", ensureSession, ensureFreshRoutePreflight: preflight };
    const renderer = await mount(props);
    const gate = createDeferred<void>();
    codeLease.gate = gate.promise;
    const { attempt } = await begin();
    await act(async () => {
      if (change === "session" || change === "session ABA")
        renderer.update(<Harness {...props} selectedSessionId="session-2" />);
      if (change === "workspace" || change === "workspace ABA")
        renderer.update(<Harness {...props} workspaceId="workspace-b" />);
      if (change === "unmount") renderer.unmount();
      if (change === "caller ABA") codeLease.callerRevision += 2;
      if (change === "Gateway") codeLease.gateway = "http://gateway-b";
      if (change === "access") codeLease.access += 1;
    });
    if (change === "session ABA" || change === "workspace ABA")
      await act(async () => {
        renderer.update(<Harness {...props} selectedSessionId="session-1" />);
      });
    await act(async () => {
      gate.resolve();
      await attempt;
    });
    expect(ensureSession).not.toHaveBeenCalled();
    expect(preflight).not.toHaveBeenCalled();
    expect(sendAgentChatMessageMock).not.toHaveBeenCalled();
    expect(streamAgentChatMessageMock).not.toHaveBeenCalled();
  });

  it("detects empty Chat workspace change before any first-send creation", async () => {
    const ensureSession = vi.fn(async () => ({ sessionId: "created-a", workspaceId: "workspace-a" }) as any);
    const renderer = await mount({
      workspaceId: "workspace-a",
      selectedSessionId: null,
      selectedSession: null,
      ensureSession,
    });
    const gate = createDeferred<void>();
    codeLease.gate = gate.promise;
    const { attempt } = await begin();
    await act(async () => {
      renderer.update(
        <Harness
          workspaceId="workspace-b"
          selectedSessionId={null}
          selectedSession={null}
          ensureSession={ensureSession}
        />,
      );
    });
    await act(async () => {
      gate.resolve();
      await attempt;
    });
    expect(ensureSession).not.toHaveBeenCalled();
    expect(sendAgentChatMessageMock).not.toHaveBeenCalled();
  });

  it("binds only the canonical first-created session once and rejects its later selection ABA", async () => {
    const creation = createDeferred<any>(),
      preflight = createDeferred<any>();
    const ensureSession = vi.fn(() => creation.promise),
      freshPreflight = vi.fn(() => preflight.promise);
    const props = { workspaceId: "workspace-a", ensureSession, ensureFreshRoutePreflight: freshPreflight };
    const renderer = await mount({ ...props, selectedSessionId: null, selectedSession: null });
    const { attempt } = await begin();
    await vi.waitFor(() => {
      expect(ensureSession).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      renderer.update(
        <Harness
          {...props}
          selectedSessionId="created-a"
          selectedSession={{ sessionId: "created-a", workspaceId: "workspace-a" }}
        />,
      );
      creation.resolve({ sessionId: "created-a", workspaceId: "workspace-a" });
      await Promise.resolve();
    });
    expect(freshPreflight).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer.update(<Harness {...props} selectedSessionId="other" />);
    });
    await act(async () => {
      renderer.update(<Harness {...props} selectedSessionId="created-a" />);
    });
    await act(async () => {
      preflight.resolve(null);
      await attempt;
    });
    expect(sendAgentChatMessageMock).not.toHaveBeenCalled();
  });

  it("retains a newer draft and attachments after import failure, releases the current lock and permits retry", async () => {
    const attachment = {
      attachmentId: "attachment-owned",
      fileName: "draft.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
    };
    const ensureSession = vi.fn(async () => ({ sessionId: "session-1" }) as any);
    await mount({ ensureSession, initialDraft: "A newer operator draft", initialPendingAttachments: [attachment] });
    const gate = createDeferred<void>();
    codeLease.gate = gate.promise;
    const { attempt } = await begin();
    await act(async () => {
      gate.reject(new Error("Action code unavailable"));
      await attempt;
    });
    await expect(gate.promise).rejects.toThrow("Action code unavailable");
    expect(ensureSession).not.toHaveBeenCalled();
    expect(sendAgentChatMessageMock).not.toHaveBeenCalled();
    expect(latest!.getSnapshot()).toEqual(
      expect.objectContaining({
        draft: "A newer operator draft",
        pendingAttachments: [attachment],
        sending: false,
        error: expect.stringContaining("[vitest] There was an error when mocking a module"),
      }),
    );
    codeLease.gate = Promise.resolve();
    vi.doMock("./outbound-execution-code.js", () => vi.importActual("./outbound-execution-code.js"));
    const retry = await begin();
    await act(async () => {
      await retry.attempt;
    });
    expect(sendAgentChatMessageMock).toHaveBeenCalledTimes(1);
  });

  it("cannot settle a stale failed load over a newer queued send's optimistic message or lock", async () => {
    const ensureSession = vi.fn(async () => ({ sessionId: "session-2" }) as any);
    const renderer = await mount({
      selectedSessionId: "session-1",
      ensureSession,
      initialDraft: "Keep this newer draft",
    });
    const gate = createDeferred<void>();
    codeLease.gate = gate.promise;
    const first = await begin();
    await act(async () => {
      renderer.update(<Harness selectedSessionId="session-2" ensureSession={ensureSession} />);
    });
    const second = await begin({ ...item(), id: "second-owned-send", sessionId: "session-2" });
    expect(latest!.getSnapshot().optimisticUserMessage).toEqual(
      expect.objectContaining({ queueItemId: "second-owned-send" }),
    );
    await act(async () => {
      gate.reject(new Error("Both imports failed"));
      await Promise.all([first.attempt, second.attempt]);
    });
    await expect(gate.promise).rejects.toThrow("Both imports failed");
    expect(latest!.getSnapshot().draft).toBe("Keep this newer draft");
    expect(latest!.getSnapshot().error).toContain("[vitest] There was an error when mocking a module");
    expect(latest!.getSnapshot().sending).toBe(false);
    expect(ensureSession).not.toHaveBeenCalled();
  });

  it("keeps the immutable queue request snapshot after preferences change during code loading", async () => {
    const queuedPrefs = {
      mode: "chat",
      providerId: "queued-provider",
      model: "queued-model",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "minimal",
      speedMode: "standard",
      subagentPolicy: "off",
      fullWebAccess: false,
    };
    const preflight = vi.fn(async () => null);
    const renderer = await mount({ ensureFreshRoutePreflight: preflight });
    const gate = createDeferred<void>();
    codeLease.gate = gate.promise;
    const { attempt } = await begin({ ...item(), requestPrefs: Object.freeze(queuedPrefs) });
    await act(async () => {
      renderer.update(
        <Harness
          prefs={{ providerId: "later-provider", model: "later-model" }}
          ensureFreshRoutePreflight={preflight}
        />,
      );
    });
    await act(async () => {
      gate.resolve();
      await attempt;
    });
    expect(preflight).toHaveBeenCalledWith(expect.objectContaining({ requestPrefs: queuedPrefs }));
    expect(sendAgentChatMessageMock).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        providerId: "queued-provider",
        model: "queued-model",
        memoryMode: "off",
        webMode: "off",
      }),
      { originSurface: "chat" },
    );
  });

  it("retains canonical uncertain-send recovery after the real action code loads", async () => {
    const loadSessionCoreState = vi.fn(async () => undefined);
    await mount({ initialDraft: "Keep this newer draft", loadSessionCoreState });
    sendAgentChatMessageMock.mockRejectedValueOnce(new Error("Gateway send outcome unavailable"));
    const { attempt } = await begin();
    await act(async () => {
      await attempt;
    });
    expect(sendAgentChatMessageMock).toHaveBeenCalledTimes(1);
    expect(loadSessionCoreState).toHaveBeenCalledWith("session-1", { background: true, includeThread: true });
    expect(latest!.getSnapshot()).toEqual(
      expect.objectContaining({
        draft: "Keep this newer draft",
        sending: false,
        error: "Gateway send outcome unavailable",
      }),
    );
  });
  it("does not start stale sidebar I/O or settle callbacks after an awaited local command", async () => {
    const command = createDeferred<void>(),
      loadSidebar = vi.fn(async () => undefined);
    const handleCommandExecution = vi.fn(() => command.promise),
      failedSnapshot = vi.fn();
    const props = { handleCommandExecution, loadSidebar, onWorkspaceSnapshotFailed: failedSnapshot };
    const renderer = await mount(props);
    const { attempt } = await begin({ ...item(), content: "/status" });
    await vi.waitFor(() => {
      expect(handleCommandExecution).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      renderer.update(<Harness {...props} selectedSessionId="session-2" />);
    });
    await act(async () => {
      command.resolve();
      await attempt;
    });
    expect(loadSidebar).not.toHaveBeenCalled();
    expect(failedSnapshot).not.toHaveBeenCalled();
  });

  it("admits the exact canonical first-created session and sends once", async () => {
    const creation = createDeferred<any>(),
      ensureSession = vi.fn(() => creation.promise);
    const renderer = await mount({
      workspaceId: "workspace-a",
      selectedSessionId: null,
      selectedSession: null,
      ensureSession,
    });
    const { attempt } = await begin();
    await vi.waitFor(() => {
      expect(ensureSession).toHaveBeenCalledTimes(1);
    });
    sendAgentChatMessageMock.mockResolvedValueOnce({
      sessionId: "created-a",
      turnId: "turn-created",
      userMessage: { messageId: "user-created" },
    });
    await act(async () => {
      renderer.update(
        <Harness
          workspaceId="workspace-a"
          selectedSessionId="created-a"
          selectedSession={{ sessionId: "created-a", workspaceId: "workspace-a" }}
          ensureSession={ensureSession}
          ensureFreshRoutePreflight={async () => null}
        />,
      );
      creation.resolve({ sessionId: "created-a", workspaceId: "workspace-a" });
      await attempt;
    });
    expect(sendAgentChatMessageMock).toHaveBeenCalledTimes(1);
    expect(sendAgentChatMessageMock).toHaveBeenCalledWith(
      "created-a",
      expect.objectContaining({ content: "Queued message" }),
      { originSurface: "chat" },
    );
  });

  it("rejects a canonical owner result for another workspace before preflight or send", async () => {
    const preflight = vi.fn(async () => null);
    await mount({
      workspaceId: "workspace-a",
      ensureSession: async () => ({ sessionId: "session-1", workspaceId: "workspace-b" }) as any,
      ensureFreshRoutePreflight: preflight,
    });
    const { attempt } = await begin();
    await act(async () => {
      await attempt;
    });
    expect(preflight).not.toHaveBeenCalled();
    expect(sendAgentChatMessageMock).not.toHaveBeenCalled();
    expect(latest!.getSnapshot().error).toContain("does not match the outbound workspace");
  });

  it("does not load action code or dispatch merely because saved outbound items exist at bootstrap", async () => {
    const ensureSession = vi.fn(async () => ({ sessionId: "session-1" }) as any);
    await mount({ ensureSession, queuedOutbound: [item()] });
    expect(codeLease.loads).toBe(0);
    expect(ensureSession).not.toHaveBeenCalled();
    expect(sendAgentChatMessageMock).not.toHaveBeenCalled();
    expect(latest!.getSnapshot().streamStatus).toBe("queued");
  });

  it.each(["session", "workspace", "caller", "access", "Gateway", "unmount"] as const)(
    "cannot start a saved old callback after %s custody changes",
    async (change) => {
      const ensureSession = vi.fn(async () => ({ sessionId: "session-1", workspaceId: "workspace-a" }) as any);
      const renderer = await mount({ workspaceId: "workspace-a", ensureSession, initialDraft: "Current draft" });
      const saved = latest!.execute;
      await act(async () => {
        if (change === "session")
          renderer.update(
            <Harness workspaceId="workspace-a" selectedSessionId="session-2" ensureSession={ensureSession} />,
          );
        if (change === "workspace")
          renderer.update(<Harness workspaceId="workspace-b" ensureSession={ensureSession} />);
        if (change === "caller") codeLease.callerRevision += 1;
        if (change === "access") codeLease.access += 1;
        if (change === "Gateway") codeLease.gateway = "http://gateway-b";
        if (change === "unmount") renderer.unmount();
      });
      await act(async () => {
        await saved(item());
      });
      expect(codeLease.loads).toBe(0);
      expect(ensureSession).not.toHaveBeenCalled();
      expect(sendAgentChatMessageMock).not.toHaveBeenCalled();
      if (change !== "unmount") {
        expect(latest!.getSnapshot().draft).toBe("Current draft");
        expect(latest!.getSnapshot().optimisticUserMessage).toBeNull();
        expect(latest!.getSnapshot().sending).toBe(false);
      }
    },
  );

  it.each(["session", "workspace", "caller", "access", "Gateway"] as const)(
    "releases its completed stale load after %s changes and admits a current intentional send",
    async (change) => {
      let sessionId = "session-1",
        workspaceId = "workspace-a";
      const ensureSession = vi.fn(async () => ({ sessionId, workspaceId }) as any);
      const renderer = await mount({ workspaceId, ensureSession, initialDraft: "Current draft" });
      const gate = createDeferred<void>();
      codeLease.gate = gate.promise;
      const first = await begin();
      if (change === "session") sessionId = "session-2";
      if (change === "workspace") workspaceId = "workspace-b";
      if (change === "caller") codeLease.callerRevision += 1;
      if (change === "access") codeLease.access += 1;
      if (change === "Gateway") codeLease.gateway = "http://gateway-b";
      await act(async () => {
        renderer.update(
          <Harness workspaceId={workspaceId} selectedSessionId={sessionId} ensureSession={ensureSession} />,
        );
      });
      await act(async () => {
        gate.resolve();
        await first.attempt;
      });
      expect(ensureSession).not.toHaveBeenCalled();
      expect(sendAgentChatMessageMock).not.toHaveBeenCalled();
      expect(latest!.getSnapshot()).toEqual(
        expect.objectContaining({ draft: "Current draft", error: null, sending: false, optimisticUserMessage: null }),
      );
      const current = await begin({ ...item(), id: "current-intent", sessionId });
      await act(async () => {
        await current.attempt;
      });
      expect(sendAgentChatMessageMock).toHaveBeenCalledTimes(1);
      expect(sendAgentChatMessageMock.mock.calls[0]?.[0]).toBe(sessionId);
      expect(latest!.getSnapshot().sending).toBe(false);
    },
  );

  it("cannot release a newer ticket after the old shared import completes stale", async () => {
    const response = createDeferred<any>(),
      ensureSession = vi.fn(async () => ({ sessionId: "session-2" }) as any);
    sendAgentChatMessageMock.mockReturnValueOnce(response.promise);
    const renderer = await mount({
      selectedSessionId: "session-1",
      ensureSession,
      initialDraft: "Keep the current draft",
    });
    const gate = createDeferred<void>();
    codeLease.gate = gate.promise;
    const first = await begin();
    await act(async () => {
      renderer.update(<Harness selectedSessionId="session-2" ensureSession={ensureSession} />);
    });
    const second = await begin({ ...item(), id: "second-ticket", sessionId: "session-2" });
    await act(async () => {
      gate.resolve();
      await first.attempt;
    });
    await vi.waitFor(() => expect(sendAgentChatMessageMock).toHaveBeenCalledTimes(1));
    expect(latest!.getSnapshot()).toEqual(
      expect.objectContaining({
        sending: true,
        draft: "Keep the current draft",
        optimisticUserMessage: expect.objectContaining({ queueItemId: "second-ticket" }),
      }),
    );
    expect(latest!.tryBegin()).toBe(false);
    await act(async () => {
      response.resolve({ sessionId: "session-2", userMessage: { messageId: "second-confirmed" } });
      await second.attempt;
    });
    expect(latest!.getSnapshot().sending).toBe(false);
    expect(sendAgentChatMessageMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["send", "session"],
    ["send", "workspace"],
    ["send", "caller"],
    ["send", "access"],
    ["edit", "session"],
    ["edit", "workspace"],
    ["edit", "caller"],
    ["edit", "access"],
    ["retry", "session"],
    ["retry", "workspace"],
    ["retry", "caller"],
    ["retry", "access"],
  ] as const)(
    "adopts no stale client state or follow-up read after a confirmed %s response and %s departure",
    async (action, change) => {
      const response = createDeferred<any>(),
        loadSessionCoreState = vi.fn(async () => undefined),
        loadSidebar = vi.fn(async () => undefined);
      const capabilities = vi.fn(),
        specialists = vi.fn(),
        external = vi.fn();
      const operation =
        action === "send" ? sendAgentChatMessageMock : action === "edit" ? editChatTurnMock : retryChatTurnMock;
      operation.mockReturnValueOnce(response.promise);
      const props = {
        workspaceId: "workspace-a",
        loadSessionCoreState,
        loadSidebar,
        initialDraft: "Current draft",
        setCapabilitySuggestionsOverride: capabilities,
        setSpecialistSuggestionsOverride: specialists,
        onExternalContextSent: external,
      };
      const renderer = await mount(props);
      const value = {
        ...item(),
        action,
        targetTurnId: action === "send" ? undefined : "turn-1",
        externalContextRefs: [{ kind: "memory", id: "context-1" }],
      };
      const { attempt } = await begin(value as ReturnType<typeof item>);
      await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
      if (change === "caller") codeLease.callerRevision += 1;
      if (change === "access") codeLease.access += 1;
      await act(async () => {
        renderer.update(
          <Harness
            {...props}
            workspaceId={change === "workspace" ? "workspace-b" : "workspace-a"}
            selectedSessionId={change === "session" ? "session-2" : "session-1"}
          />,
        );
      });
      const capabilitiesBefore = capabilities.mock.calls.length,
        specialistsBefore = specialists.mock.calls.length;
      await act(async () => {
        response.resolve({
          sessionId: "session-1",
          userMessage: { messageId: "accepted-original" },
          trace: {
            capabilityUpgradeSuggestions: [{ id: "old-capability" }],
            specialistCandidateSuggestions: [{ id: "old-specialist" }],
          },
        });
        await attempt;
      });
      expect(operation).toHaveBeenCalledTimes(1);
      expect(loadSessionCoreState).not.toHaveBeenCalled();
      expect(loadSidebar).not.toHaveBeenCalled();
      expect(capabilities).toHaveBeenCalledTimes(capabilitiesBefore);
      expect(specialists).toHaveBeenCalledTimes(specialistsBefore);
      expect(external).not.toHaveBeenCalled();
      expect(latest!.getSnapshot()).toEqual(
        expect.objectContaining({ draft: "Current draft", error: null, sending: false }),
      );
    },
  );
});
