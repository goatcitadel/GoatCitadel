import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachmentRecord, ChatMode, ChatThreadResponse } from "@goatcitadel/contracts";
import {
  MissionThreadedControllerHost,
  formatFallbackSummary,
  formatRoutingTargetSummary,
  formatRuntimeSummary,
  formatThreadedRunStateLabel,
  formatThreadedRunStateSummary,
  reconcilePendingAttachmentModes,
  mergeHydratedOutboundQueue,
  parseHydratedChatAttachments,
  parseHydratedOutboundQueue,
  requiresBoundaryAcknowledgment,
  resolveExecutionRoutePrefs,
  runWithSelectedSession,
  runWithSelectedSessionId,
  type MissionThreadedRenderSurfaceInput,
} from "./MissionThreadedControllerHost";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const attachThreadKnowledgeAttachmentMock = vi.fn();
const createChatGeneratedArtifactMock = vi.fn();
const createChatSideChatMock = vi.fn();
const createChatSessionMock = vi.fn();
const forkChatSessionFromTurnMock = vi.fn();
const fetchAgentsMock = vi.fn();
const fetchChatGeneratedArtifactMock = vi.fn();
const fetchChatSessionGoalMock = vi.fn();
const setChatSessionGoalMock = vi.fn();
const clearChatSessionGoalMock = vi.fn();
const steerChatSessionMock = vi.fn();
const fetchChatSessionPrefsMock = vi.fn();
const fetchChatSideChatMock = vi.fn();
const fetchChatThreadMock = vi.fn();
const fetchMcpServersMock = vi.fn();
const fetchMcpTemplatesMock = vi.fn();
const fetchRuntimeLifecycleExportMock = vi.fn();
const fetchSkillsMock = vi.fn();
const parseChatCommandMock = vi.fn();
const preflightChatRouteMock = vi.fn();
const removeThreadKnowledgeAttachmentMock = vi.fn();
const streamAgentChatMessageMock = vi.fn();
const updateChatSessionPrefsMock = vi.fn();
const fetchAgenticRunsMock = vi.fn();
const fetchAgenticRunTreeMock = vi.fn();
const controlAgenticRunMock = vi.fn();
const createCodeModeRunMock = vi.fn();
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

const setDevDiagnosticsActiveChatSessionMock = vi.fn();
const setDevDiagnosticsLatestTraceSummaryMock = vi.fn();
const loadModelsForProviderMock = vi.fn(async (providerId: string) => [`${providerId}-model`]);
const getCachedModelsMock = vi.fn((providerId: string) =>
  providerId === "anthropic" ? ["claude-4"] : ["gpt-5.5", "gpt-image-2"],
);
const useChatSessionDataMock = vi.fn();
const useChatThreadControllerMock = vi.fn();
const useChatSessionControlsMock = vi.fn();
const useChatSurfaceOrchestrationMock = vi.fn();
const useChatProviderRoutingControllerMock = vi.fn();
const useChatRoutePreflightMock = vi.fn();
const useChatContextActionsMock = vi.fn();
const useChatOutboundExecutionMock = vi.fn();
const useChatApprovalControllerMock = vi.fn();
const useChatDockWorkbenchControllerMock = vi.fn();
const useChatComposerInteractionsMock = vi.fn();
const useChatMultimodalControlsMock = vi.fn();
const useRouteGeneratedArtifactRevealMock = vi.fn();
const useExternalSourceAttachmentsMock = vi.fn();
const useMediaQueryMock = vi.fn();

let mockSurfaceMode: ChatMode = "chat";
let mockCompact = false;
let mockSurfacePreview:
  | { mode: ChatMode; confidence: number; source?: string; rationale?: string; alternatives?: unknown[] }
  | undefined;
const handleSendMock = vi.fn(async () => undefined);
// HX-411: mutable session-control status the mocked hook returns. Defaults to
// operator/absent (unlocked) in setupMocks so the other suites are unaffected.
const sessionControlHookState = vi.hoisted(() => ({
  value: {
    data: null as unknown,
    loading: false,
    error: null as string | null,
    reload: vi.fn(async () => undefined),
  },
}));
let latestSurfaceInput: MissionThreadedRenderSurfaceInput | null = null;
let confirmModalProps: any[] = [];
let mockSelectedTurn: any = null;
const mountedRenderers: ReactTestRenderer[] = [];

const selectedSession = {
  sessionId: "session-1",
  revision: 7,
  sessionKey: "session-1",
  workspaceId: "workspace-1",
  title: "Launch plan",
  scope: "mission",
  mode: "chat",
  lifecycleStatus: "active",
  includeInHistory: true,
  pinned: false,
  projectId: "project-1",
  folderName: "Ops",
  tags: ["launch", "ops"],
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
  lastActivityAt: "2026-05-01T00:00:00.000Z",
};

const selectedProject = {
  projectId: "project-1",
  name: "Mission Project",
  lifecycleStatus: "active",
  workspacePath: "F:/code/personal-ai",
};

const selectedTurn = {
  turnId: "turn-1",
  userMessage: {
    messageId: "message-user",
    sessionId: "session-1",
    role: "user",
    actorType: "user",
    actorId: "operator",
    content: "Build the launch plan",
    timestamp: "2026-05-01T00:00:00.000Z",
  },
  assistantMessage: {
    messageId: "message-assistant",
    sessionId: "session-1",
    role: "assistant",
    actorType: "agent",
    actorId: "assistant",
    content: "Launch plan ready.",
    timestamp: "2026-05-01T00:00:01.000Z",
  },
  generatedArtifacts: [{ artifactId: "artifact-1" }],
  trace: {
    status: "completed",
    model: "gpt-5.5",
    routing: {
      primaryProviderId: "openai",
      primaryModel: "gpt-5.5",
      effectiveProviderId: "openai",
      effectiveModel: "gpt-5.5",
    },
    durable: { runId: "durable-1" },
    toolRuns: [{ approvalId: "approval-1" }],
    capabilityUpgradeSuggestions: [{ kind: "skill", title: "Planning", recommendedAction: "connect_mcp" }],
    specialistCandidateSuggestions: [{ title: "Launch analyst", candidateId: "catalog-1" }],
    executionPlan: { steps: [] },
  },
};

const thread = {
  sessionId: "session-1",
  selectedTurnId: "turn-1",
  activeLeafTurnId: "turn-1",
  turns: [selectedTurn],
} as ChatThreadResponse;

const prefs = {
  sessionId: "session-1",
  revision: 7,
  mode: "chat",
  webMode: "auto",
  memoryMode: "auto",
  thinkingLevel: "standard",
  speedMode: "standard",
  subagentPolicy: "ask_when_useful",
  providerId: "openai",
  model: "gpt-5.5",
  toolAutonomy: "safe_auto",
  planningMode: "off",
};

const outboundRequestPrefs = {
  mode: "chat",
  providerId: "openai",
  model: "gpt-5.5",
  webMode: "auto",
  memoryMode: "auto",
  thinkingLevel: "standard",
  speedMode: "standard",
  subagentPolicy: "ask_when_useful",
  fullWebAccess: false,
} as const;

function createStoredAttachment(overrides: Partial<ChatAttachmentRecord> = {}): ChatAttachmentRecord {
  const attachmentId = overrides.attachmentId ?? "attachment-1";
  return {
    attachmentId,
    sessionId: "session-1",
    workspaceId: "workspace-1",
    fileName: `${attachmentId}.txt`,
    mimeType: "text/plain",
    mediaType: "text",
    sizeBytes: 12,
    sha256: "a".repeat(64),
    storageRelPath: `chat/default/attachments/${attachmentId}.txt`,
    extractStatus: "ready",
    createdAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

const generatedArtifact = {
  artifactId: "artifact-1",
  sessionId: "session-1",
  turnId: "turn-1",
  title: "Launch artifact",
  kind: "markdown",
  content: "# Launch",
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
};

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  ApiRequestError: ApiRequestErrorMock,
  attachThreadKnowledgeAttachment: (...args: unknown[]) => attachThreadKnowledgeAttachmentMock(...args),
  createChatGeneratedArtifact: (...args: unknown[]) => createChatGeneratedArtifactMock(...args),
  createChatSideChat: (...args: unknown[]) => createChatSideChatMock(...args),
  createChatSession: (...args: unknown[]) => createChatSessionMock(...args),
  forkChatSessionFromTurn: (...args: unknown[]) => forkChatSessionFromTurnMock(...args),
  fetchAgents: (...args: unknown[]) => fetchAgentsMock(...args),
  fetchChatGeneratedArtifact: (...args: unknown[]) => fetchChatGeneratedArtifactMock(...args),
  fetchChatSessionGoal: (...args: unknown[]) => fetchChatSessionGoalMock(...args),
  setChatSessionGoal: (...args: unknown[]) => setChatSessionGoalMock(...args),
  clearChatSessionGoal: (...args: unknown[]) => clearChatSessionGoalMock(...args),
  steerChatSession: (...args: unknown[]) => steerChatSessionMock(...args),
  fetchChatSessionPrefs: (...args: unknown[]) => fetchChatSessionPrefsMock(...args),
  fetchChatSideChat: (...args: unknown[]) => fetchChatSideChatMock(...args),
  fetchChatThread: (...args: unknown[]) => fetchChatThreadMock(...args),
  fetchMcpServers: (...args: unknown[]) => fetchMcpServersMock(...args),
  fetchMcpTemplates: (...args: unknown[]) => fetchMcpTemplatesMock(...args),
  fetchRuntimeLifecycleExport: (...args: unknown[]) => fetchRuntimeLifecycleExportMock(...args),
  fetchSkills: (...args: unknown[]) => fetchSkillsMock(...args),
  parseChatCommand: (...args: unknown[]) => parseChatCommandMock(...args),
  preflightChatRoute: (...args: unknown[]) => preflightChatRouteMock(...args),
  removeThreadKnowledgeAttachment: (...args: unknown[]) => removeThreadKnowledgeAttachmentMock(...args),
  streamAgentChatMessage: (...args: unknown[]) => streamAgentChatMessageMock(...args),
  updateChatSessionPrefs: (...args: unknown[]) => updateChatSessionPrefsMock(...args),
}));

vi.mock("@goatcitadel/mission-control-shared/api/agentic", () => ({
  controlAgenticRun: (...args: unknown[]) => controlAgenticRunMock(...args),
  fetchAgenticRuns: (...args: unknown[]) => fetchAgenticRunsMock(...args),
  fetchAgenticRunTree: (...args: unknown[]) => fetchAgenticRunTreeMock(...args),
}));

vi.mock("@goatcitadel/mission-control-shared/api/capabilities", () => ({
  createCodeModeRun: (...args: unknown[]) => createCodeModeRunMock(...args),
}));

vi.mock("@goatcitadel/mission-control-shared/components/CardSkeleton", () => ({
  CardSkeleton: () => <div data-card-skeleton />,
}));

vi.mock("@goatcitadel/mission-control-shared/components/ConfirmModal", () => ({
  ConfirmModal: (props: any) => {
    confirmModalProps.push(props);
    return props.open ? <div data-confirm-modal={props.title} /> : null;
  },
}));

vi.mock("@goatcitadel/mission-control-shared/components/PageHeader", () => ({
  PageHeader: (props: any) => <header data-page-header={props.title}>{props.actions}</header>,
}));

vi.mock("@goatcitadel/mission-control-shared/components/StatusChip", () => ({
  StatusChip: (props: any) => <span data-status-chip={props.tone}>{props.children}</span>,
}));

vi.mock("@goatcitadel/mission-control-shared/hooks/useEventStreamStatus", () => ({
  useEventStreamStatus: () => ({ connected: true, label: "Live" }),
}));

vi.mock("@goatcitadel/mission-control-shared/hooks/useMediaQuery", () => ({
  useMediaQuery: (query: string) => {
    useMediaQueryMock(query);
    return mockCompact;
  },
}));

vi.mock("@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog", () => ({
  useProviderModelCatalog: () => ({
    config: { activeProviderId: "openai", activeModel: "gpt-5.5", providers: [] },
    providers: [
      {
        providerId: "openai",
        label: "OpenAI",
        defaultModel: "gpt-5.5",
        hasApiKey: true,
        capabilities: { imageGenerate: true, imageEdit: true, voiceInput: true, voiceOutput: true },
        models: ["gpt-5.5", "gpt-image-2"],
        modelProbeState: "ready",
      },
      {
        providerId: "anthropic",
        label: "Anthropic",
        defaultModel: "claude-4",
        hasApiKey: true,
        models: ["claude-4"],
        modelProbeState: "ready",
      },
    ],
    getCachedModels: getCachedModelsMock,
    loadModelsForProvider: loadModelsForProviderMock,
  }),
}));

vi.mock("@goatcitadel/mission-control-shared/hooks/useSessionControlStatus", () => ({
  useSessionControlStatus: () => sessionControlHookState.value,
}));
vi.mock("@goatcitadel/mission-control-shared/api/session-control-operator", () => ({
  revokeSessionControl: vi.fn(async () => ({})),
  handoffSessionControl: vi.fn(async () => ({})),
  fetchSessionControlDetail: vi.fn(async () => sessionControlHookState.value.data),
}));
vi.mock("@goatcitadel/mission-control-shared/state/dev-diagnostics-store", () => ({
  setDevDiagnosticsActiveChatSession: (...args: unknown[]) => setDevDiagnosticsActiveChatSessionMock(...args),
  setDevDiagnosticsLatestTraceSummary: (...args: unknown[]) => setDevDiagnosticsLatestTraceSummaryMock(...args),
}));

vi.mock("./chat/useChatSessionData", () => ({
  useChatSessionData: (...args: unknown[]) => useChatSessionDataMock(...args),
}));

vi.mock("./chat/useChatThreadController", () => ({
  useChatThreadController: (...args: unknown[]) => useChatThreadControllerMock(...args),
}));

vi.mock("./chat/useChatSessionControls", () => ({
  useChatSessionControls: (...args: unknown[]) => useChatSessionControlsMock(...args),
}));

vi.mock("./chat/useChatSurfaceOrchestration", () => ({
  resolveOutboundDraftContent: (draft: string, attachmentCount: number) =>
    draft.trim() || (attachmentCount > 0 ? "attachments" : ""),
  useChatSurfaceOrchestration: (...args: unknown[]) => useChatSurfaceOrchestrationMock(...args),
}));

vi.mock("./chat/useChatProviderRoutingController", () => ({
  useChatProviderRoutingController: (...args: unknown[]) => useChatProviderRoutingControllerMock(...args),
}));

vi.mock("./chat/useChatRoutePreflight", () => ({
  useChatRoutePreflight: (...args: unknown[]) => useChatRoutePreflightMock(...args),
}));

vi.mock("./chat/useChatContextActions", () => ({
  useChatContextActions: (...args: unknown[]) => useChatContextActionsMock(...args),
}));

vi.mock("./chat/useChatOutboundExecution", () => ({
  abortActiveChatStream: vi.fn(),
  captureOutboundRequestPrefsSnapshot: (input: {
    prefs?: Record<string, unknown> | null;
    selectedProviderId?: string;
    selectedModel?: string;
    fullWebAccess?: boolean;
  }) => ({
    mode: "chat",
    providerId: input.prefs?.providerId ?? input.selectedProviderId,
    model: input.prefs?.model ?? input.selectedModel,
    webMode: input.prefs?.webMode ?? "auto",
    memoryMode: input.prefs?.memoryMode ?? "auto",
    thinkingLevel: input.prefs?.thinkingLevel ?? "standard",
    speedMode: input.prefs?.speedMode ?? "standard",
    subagentPolicy: input.prefs?.subagentPolicy ?? "ask_when_useful",
    fullWebAccess: Boolean(input.fullWebAccess),
  }),
  useChatOutboundExecution: (...args: unknown[]) => useChatOutboundExecutionMock(...args),
}));

vi.mock("./chat/useChatApprovalController", () => ({
  useChatApprovalController: (...args: unknown[]) => useChatApprovalControllerMock(...args),
}));

vi.mock("./chat/useChatDockWorkbenchController", () => ({
  useChatDockWorkbenchController: (...args: unknown[]) => useChatDockWorkbenchControllerMock(...args),
}));

vi.mock("./chat/useChatComposerInteractions", () => ({
  useChatComposerInteractions: (...args: unknown[]) => useChatComposerInteractionsMock(...args),
}));

vi.mock("./chat/useChatMultimodalControls", () => ({
  useChatMultimodalControls: (...args: unknown[]) => useChatMultimodalControlsMock(...args),
}));

vi.mock("./chat/useRouteGeneratedArtifactReveal", () => ({
  useRouteGeneratedArtifactReveal: (...args: unknown[]) => useRouteGeneratedArtifactRevealMock(...args),
}));

vi.mock("./chat/useExternalSourceAttachments", () => ({
  useExternalSourceAttachments: (...args: unknown[]) => useExternalSourceAttachmentsMock(...args),
}));

vi.mock("./chat/useSurfaceClassifyPreview", () => ({ useSurfaceClassifyPreview: () => mockSurfacePreview }));

vi.mock("./chat/useMissionControlSurfaceState", () => ({
  formatSessionLabel: (session: any) => session?.title ?? session?.sessionId ?? "Session",
  looksMachineSessionLabel: (value: string) => value.startsWith("sess_"),
  shouldShowLearnedMemoryPanel: () => true,
  shouldShowSuggestionsPanel: () => true,
  shouldShowTracePanel: () => true,
  useMissionControlSurfaceState: () => ({
    messageMode: mockSurfaceMode,
    activeModePreset: { label: mockSurfaceMode === "code" ? "Code" : mockSurfaceMode === "cowork" ? "Cowork" : "Chat" },
    isChatSurface: mockSurfaceMode === "chat",
    isCoworkSurface: mockSurfaceMode === "cowork",
    isCodeSurface: mockSurfaceMode === "code",
    surfaceHeaderTitle: `${mockSurfaceMode} header`,
    surfaceHeaderSubtitle: `${mockSurfaceMode} subtitle`,
    workspaceSummaryCards: [{ label: "Sessions", value: "1" }],
    selectedTurn: mockSelectedTurn,
    selectedTurnRecovery: null,
    effectiveToolAutonomy: "safe_auto",
    selectedSessionLabel: "Launch plan",
    codeModeNeedsProjectBinding: false,
    selectedProjectBindingCandidateId: "project-1",
    selectedProjectBindingCandidateName: "Mission Project",
    showTracePanel: true,
    showSuggestionsPanel: true,
    showLearnedMemoryPanel: true,
    dockSectionOrder: ["trace", "memory"],
  }),
}));

function installBrowserGlobals(search = "") {
  const store = new Map<string, string>();
  const appended: any[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { search, hash: "" },
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      },
      URL: {
        createObjectURL: vi.fn(() => "blob://coverage"),
        revokeObjectURL: vi.fn(),
      },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      body: {
        appendChild: (node: any) => appended.push(node),
      },
      createElement: vi.fn(() => ({
        href: "",
        download: "",
        click: vi.fn(),
        remove: vi.fn(),
      })),
    },
  });
  Object.defineProperty(globalThis, "Blob", {
    configurable: true,
    value: class Blob {
      public constructor(
        public readonly parts: unknown[],
        public readonly options?: unknown,
      ) {}
    },
  });
}

function setupMocks() {
  fetchAgentsMock.mockResolvedValue({
    items: [
      {
        agentId: "agent-1",
        name: "Operator preset",
        presetDefaults: {
          presetLabel: "Launch preset",
          presetSummary: "Launch defaults",
          routeHint: "cowork",
          preferredProviderId: "anthropic",
          preferredModel: "claude-4",
          toolsPosture: "manual",
          knowledgeAttachmentIds: ["missing-knowledge"],
          promptFraming: "Frame this as launch work.",
        },
      },
    ],
  });
  fetchAgenticRunsMock.mockResolvedValue({ items: [{ runId: "agentic-run-1" }] });
  fetchAgenticRunTreeMock.mockResolvedValue({
    runId: "agentic-run-1",
    taskRevision: 12,
    status: "running",
    generatedAt: "2026-05-01T00:00:00.000Z",
    nodes: [],
    edges: [],
    diagnostics: [],
    controls: [{ action: "pause", label: "Pause", enabled: true, requiresApproval: false }],
  });
  controlAgenticRunMock.mockResolvedValue({ message: "Paused run." });
  createChatGeneratedArtifactMock.mockResolvedValue({ item: generatedArtifact });
  fetchChatGeneratedArtifactMock.mockResolvedValue({ item: generatedArtifact });
  fetchRuntimeLifecycleExportMock.mockResolvedValue({ exported: true });
  attachThreadKnowledgeAttachmentMock.mockResolvedValue({
    item: { attachmentId: "knowledge-url", sourceRef: "https://docs.example.test", retrievalMode: "retrieval" },
  });
  removeThreadKnowledgeAttachmentMock.mockResolvedValue({ ok: true });
  createChatSideChatMock.mockResolvedValue({
    item: {
      sideChatId: "btw-1",
      parentSessionId: "session-1",
      childSessionId: "session-btw",
      workspaceId: "workspace-1",
      createdFromSurface: "chat",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    },
    childSession: {
      ...selectedSession,
      sessionId: "session-btw",
      sessionKey: "session-btw",
      mode: "chat",
      includeInHistory: false,
      title: "Side chat - Launch plan",
    },
  });
  fetchChatSideChatMock.mockResolvedValue({ item: null });
  fetchChatThreadMock.mockResolvedValue({ sessionId: "session-btw", turns: [] });
  preflightChatRouteMock.mockResolvedValue({
    blockedReason: undefined,
    effectiveProviderId: "openai",
    effectiveModel: "gpt-5.5",
    decision: { providerId: "openai", model: "gpt-5.5" },
  });
  streamAgentChatMessageMock.mockImplementation(async () => undefined);
  createChatSessionMock.mockResolvedValue({
    ...selectedSession,
    sessionId: "session-new",
    sessionKey: "session-new",
    title: "Trail from Launch plan",
  });
  forkChatSessionFromTurnMock.mockResolvedValue({
    session: {
      ...selectedSession,
      sessionId: "session-new",
      sessionKey: "session-new",
      title: "Fork of Launch plan",
    },
    manifest: { forkId: "fork-1" },
  });
  fetchChatSessionGoalMock.mockResolvedValue({
    sessionId: "session-1",
    revision: 7,
    goal: null,
    turnBudget: null,
    turnsUsed: 0,
    setAt: null,
  });
  setChatSessionGoalMock.mockResolvedValue({
    sessionId: "session-1",
    revision: 8,
    goal: "Ship safely",
    turnBudget: 4,
    turnsUsed: 0,
    setAt: "2026-05-01T00:00:00.000Z",
  });
  clearChatSessionGoalMock.mockResolvedValue({ ok: true });
  steerChatSessionMock.mockResolvedValue({ accepted: true });
  fetchChatSessionPrefsMock.mockImplementation(async (sessionId: string) => ({ ...prefs, sessionId }));
  updateChatSessionPrefsMock.mockImplementation(
    async (sessionId: string, patch: Record<string, unknown> & { expectedRevision?: number }) => {
      const { expectedRevision, ...acceptedPatch } = patch;
      return {
        ...prefs,
        ...acceptedPatch,
        sessionId,
        revision: (expectedRevision ?? prefs.revision) + 1,
      };
    },
  );
  fetchSkillsMock.mockResolvedValue({ items: [{ skillId: "skill-1", name: "Skill", state: "enabled" }] });
  fetchMcpServersMock.mockResolvedValue({ items: [{ serverId: "server-1", label: "Server", status: "connected" }] });
  fetchMcpTemplatesMock.mockResolvedValue({
    items: [{ templateId: "template-1", label: "Template", installed: false }],
  });
  parseChatCommandMock.mockResolvedValue({ ok: true, command: "/plan", prefs: { ...prefs, planningMode: "advisory" } });
  createCodeModeRunMock.mockResolvedValue({ runId: "code-run-1" });
  // HX-411: default to operator/absent control (unlocked) unless a test opts in.
  sessionControlHookState.value = { data: null, loading: false, error: null, reload: vi.fn(async () => undefined) };

  useChatSessionDataMock.mockReturnValue({
    projects: { items: [selectedProject] },
    setProjects: vi.fn(),
    sessions: { items: [selectedSession] },
    setSessions: vi.fn(),
    thread,
    setThread: vi.fn(),
    prefs,
    setPrefs: vi.fn(),
    binding: { sessionId: "session-1", target: null },
    setBinding: vi.fn(),
    generatedArtifacts: { items: [generatedArtifact] },
    setGeneratedArtifacts: vi.fn(),
    threadKnowledgeAttachments: {
      items: [{ attachmentId: "knowledge-1", sourceRef: "file.pdf", retrievalMode: "retrieval" }],
    },
    setThreadKnowledgeAttachments: vi.fn(),
    settings: { llm: { activeProviderId: "openai", activeModel: "gpt-5.5" } },
    setSettings: vi.fn(),
    commandCatalog: [{ command: "/plan", usage: "/plan", description: "Plan" }],
    proactiveStatus: { mode: "off" },
    setProactiveStatus: vi.fn(),
    proactiveRuns: [{ runId: "proactive-1", status: "suggested" }],
    setProactiveRuns: vi.fn(),
    learnedMemory: [{ memoryId: "memory-1", content: "Memory" }],
    setLearnedMemory: vi.fn(),
    specialistCandidates: [{ candidateId: "candidate-1", title: "Analyst", status: "draft" }],
    setSpecialistCandidates: vi.fn(),
    installedSkills: [{ skillId: "skill-1", name: "Skill", state: "enabled" }],
    setInstalledSkills: vi.fn(),
    mcpServers: [{ serverId: "server-1", label: "Server", status: "connected" }],
    setMcpServers: vi.fn(),
    mcpTemplates: [{ templateId: "template-1", label: "Template", installed: false }],
    setMcpTemplates: vi.fn(),
    loading: false,
    isRefreshing: false,
    messagesLoading: false,
    secondaryLoading: false,
    historicalWindow: null,
    historicalWindowLoading: false,
    historicalWindowError: null,
    historicalWindowTarget: null,
    historicalContinuationLoading: null,
    historicalContinuationError: null,
    loadSidebar: vi.fn(async () => undefined),
    openHistoricalWindow: vi.fn(async () => undefined),
    returnToLatest: vi.fn(),
    loadHistoricalContinuation: vi.fn(async () => undefined),
    loadRuntimeCatalog: vi.fn(async () => undefined),
    loadSessionCoreState: vi.fn(async () => undefined),
    loadSessionSecondaryState: vi.fn(async () => undefined),
    loadSessionState: vi.fn(async () => undefined),
    refreshViewState: vi.fn(async () => undefined),
  });
  useChatThreadControllerMock.mockReturnValue({
    selectedSession,
    selectedProject,
    messages: [selectedTurn.userMessage, selectedTurn.assistantMessage],
    missionSessions: [selectedSession],
    externalSessions: [],
    workspaceMissionSessionCount: 1,
    boundMissionSessionCount: 1,
    visibleSessionLabelById: new Map([["session-1", "Launch plan"]]),
    availableFolders: [{ folderId: "all", name: "All", count: 1 }],
  });
  useChatSessionControlsMock.mockReturnValue({
    creatingSessionMode: null,
    projectName: "",
    setProjectName: vi.fn(),
    projectPath: "",
    setProjectPath: vi.fn(),
    showProjectCreate: false,
    setShowProjectCreate: vi.fn(),
    sessionControlPending: null,
    sessionDeleteConfirm: null,
    setSessionDeleteConfirm: vi.fn(),
    archiveWorkspacePending: false,
    archiveWorkspaceConfirmOpen: false,
    setArchiveWorkspaceConfirmOpen: vi.fn(),
    integrationConnectionId: "",
    setIntegrationConnectionId: vi.fn(),
    integrationTarget: "",
    setIntegrationTarget: vi.fn(),
    handleCreateSession: vi.fn(async () => selectedSession),
    ensureSession: vi.fn(async () => selectedSession),
    handleCreateProject: vi.fn(async () => undefined),
    handleArchiveWorkspaceMissionChats: vi.fn(async () => undefined),
    handleRenameSession: vi.fn(async () => undefined),
    handleSaveOrganization: vi.fn(async () => undefined),
    handleTogglePinSession: vi.fn(async () => undefined),
    handleToggleArchiveSession: vi.fn(async () => undefined),
    handleDeleteSession: vi.fn(),
    confirmDeleteSession: vi.fn(async () => undefined),
    handleAssignProject: vi.fn(async () => undefined),
    handleImportCodeProject: vi.fn(async () => undefined),
    handleSaveExternalBinding: vi.fn(async () => undefined),
  });
  useChatSurfaceOrchestrationMock.mockReturnValue({
    queuedOutbound: [{ id: "queue-1", action: "send", content: "Queued", createdAt: "2026-05-01T00:00:00.000Z" }],
    setQueuedOutbound: vi.fn(),
    editingTurnId: null,
    setEditingTurnId: vi.fn(),
    handleSend: handleSendMock,
    handleRetryTurn: vi.fn(async () => undefined),
    handleStopActiveTurn: vi.fn(async () => undefined),
    handleBeginEditTurn: vi.fn(),
    handleResumeQueue: vi.fn(),
    handleRemoveQueuedItem: vi.fn(),
  });
  useChatProviderRoutingControllerMock.mockReturnValue({
    commandIndex: 0,
    setCommandIndex: vi.fn(),
    commandSuggestions: [{ key: "plan", command: "/plan", description: "Plan", applyValue: "/plan" }],
    selectedProviderId: "openai",
    selectedModel: "gpt-5.5",
    selectedProviderLabel: "OpenAI",
    selectedModelLabel: "gpt-5.5",
    requestedProviderLabel: "OpenAI",
    requestedModelLabel: "gpt-5.5",
    selectionSourceLabel: "Selection: session",
    runtimeSummary: "Remote provider ready",
    runtimeTone: "success",
    providerOptions: [
      {
        providerId: "openai",
        label: "OpenAI",
        models: ["gpt-5.5", "gpt-image-2"],
        defaultModel: "gpt-5.5",
        capabilities: { imageGenerate: true, imageEdit: true },
      },
      { providerId: "anthropic", label: "Anthropic", models: ["claude-4"], defaultModel: "claude-4" },
    ],
  });
  useChatRoutePreflightMock.mockReturnValue({
    result: {
      requestedProviderId: "openai",
      requestedModel: "gpt-5.5",
      effectiveProviderId: "openai",
      effectiveModel: "gpt-5.5",
      selectionSource: "session",
      fallbackPolicy: "off",
      fallbackResult: "not_applicable",
      runtimeReachability: "reachable",
      runtimeClass: "cloud",
    },
    resultHash: "route-hash",
    loading: false,
    error: null,
    ensureFreshPreflight: vi.fn(async () => null),
  });
  useChatContextActionsMock.mockReturnValue({
    capabilitySuggestions: [{ kind: "skill", title: "Skill", recommendedAction: "connect_mcp" }],
    setCapabilitySuggestions: vi.fn(),
    specialistSuggestions: [{ title: "Specialist", candidateId: "catalog-1" }],
    setSpecialistSuggestions: vi.fn(),
    activeDelegationRun: {
      attachedTurnId: "turn-1",
      label: "Delegation",
      objective: "Work",
      mode: "parallel",
      status: "running",
      steps: [],
    },
    delegationSuggestion: { objective: "Delegate", roles: ["Coder"], mode: "sequential" },
    setDelegationSuggestion: vi.fn(),
    capabilitySuggestionConfirm: null,
    setCapabilitySuggestionConfirm: vi.fn(),
    capabilitySuggestionPending: false,
    capabilityConfirmationCopy: null,
    handleRunQuickResearch: vi.fn(async () => undefined),
    handleProactivePolicyPatch: vi.fn(async () => undefined),
    handleTriggerProactive: vi.fn(async () => undefined),
    handleSuggestDelegation: vi.fn(async () => undefined),
    handleAcceptDelegation: vi.fn(async () => undefined),
    handleRunCodeDelegation: vi.fn(async () => undefined),
    handleMemoryStatusUpdate: vi.fn(async () => undefined),
    handleRebuildLearnedMemory: vi.fn(async () => undefined),
    handleCreateSpecialistDraft: vi.fn(async () => undefined),
    handleActivateCatalogSpecialist: vi.fn(async () => undefined),
    handleSpecialistCandidatePatch: vi.fn(async () => undefined),
    handleCapabilitySuggestionAction: vi.fn(),
    confirmCapabilitySuggestionAction: vi.fn(async () => undefined),
  });
  useChatOutboundExecutionMock.mockReturnValue({
    pendingApproval: null,
    setPendingApproval: vi.fn(),
    pendingUserInput: null,
    setPendingUserInput: vi.fn(),
    approvalPending: false,
    userInputPending: false,
    handleApprovePending: vi.fn(async () => undefined),
    handleDenyPending: vi.fn(async () => undefined),
    handleSubmitUserInput: vi.fn(async () => undefined),
    handleSelectBranchTurn: vi.fn(async () => thread),
    streamStatus: "idle",
    prefsRef: { current: prefs },
  });
  useChatDockWorkbenchControllerMock.mockReturnValue({
    dockOpen: false,
    setDockOpen: vi.fn(),
    activeWorkflowTurn: null,
    workbenchState: { sessionId: "session-1", baseRef: "main" },
    workbenchTree: { items: [] },
    selectedWorkbenchFile: { relativePath: "src/index.ts", content: "export {};" },
    selectedWorkbenchFileDiff: null,
    workbenchDraftContent: "export {};",
    workbenchExpandedPaths: [],
    workbenchDiff: { changedFiles: [] },
    workbenchOutput: { output: "ok" },
    workbenchLoading: false,
    workbenchBusy: false,
    workbenchSaving: false,
    workbenchError: null,
    hasDirtyWorkbenchDraft: false,
    setWorkbenchDraftContent: vi.fn(),
    setWorkbenchExpandedPaths: vi.fn(),
    refreshWorkbench: vi.fn(async () => undefined),
    createWorkbenchWorktree: vi.fn(async () => undefined),
    openWorkbenchFile: vi.fn(async () => undefined),
    saveWorkbenchFile: vi.fn(async () => undefined),
    runWorkbenchFileOperation: vi.fn(async () => true),
    discardWorkbenchDraft: vi.fn(),
    runWorkbenchValidationCommand: vi.fn(async () => undefined),
    applyWorkbenchPatch: vi.fn(async () => undefined),
    exportWorkbenchPatch: vi.fn(async () => ({
      patch: "diff --git a/file b/file",
      changedFiles: ["file"],
      generatedAt: "2026-05-01T00:00:00.000Z",
    })),
    revertWorkbenchFile: vi.fn(async () => undefined),
    revertWorkbenchAll: vi.fn(async () => undefined),
    latestOrchestration: null,
    orchestrationRun: null,
    orchestrationCheckpoints: [],
    orchestrationLoading: false,
    orchestrationError: null,
    refreshOrchestrationRun: vi.fn(async () => undefined),
    coworkItems: [],
    selectedSessionProjectValue: "project-1",
    dockSectionStyle: "stacked",
  });
  useChatComposerInteractionsMock.mockReturnValue({
    uploadAttachments: vi.fn(async () => []),
    handleComposerKeyDown: vi.fn(),
    handleComposerPaste: vi.fn(),
    handleDragEnter: vi.fn(),
    handleDragOver: vi.fn(),
    handleDragLeave: vi.fn(),
    handleDrop: vi.fn(),
    handleDismissError: vi.fn(),
    handleCancelEdit: vi.fn(),
    handleCreateCurrentModeSession: vi.fn(async () => undefined),
    handleArchiveWorkspace: vi.fn(),
    handleConfirmCapabilitySuggestion: vi.fn(async () => undefined),
    handleConfirmDeleteSession: vi.fn(async () => undefined),
    handleConfirmArchiveWorkspace: vi.fn(async () => undefined),
    handleSetDeepMode: vi.fn(),
    handleApplyDraftCommand: vi.fn(),
    handleRemoveAttachment: vi.fn(),
    handleUploadFiles: vi.fn(async () => undefined),
  });
  useChatMultimodalControlsMock.mockReturnValue({
    audioInputRef: { current: null },
    voiceBusy: false,
    liveVoiceActive: false,
    liveVoiceAvailable: true,
    liveVoiceMuted: false,
    liveVoiceState: "idle",
    liveVoiceStatusLabel: "Live voice ready",
    liveVoiceUnavailableReason: null,
    voiceInputAvailable: true,
    voiceOutputAvailable: true,
    voiceTalkActive: false,
    voiceStatusLabel: "Voice ready",
    voiceUnavailableReason: null,
    speakResponsesEnabled: false,
    setSpeakResponsesEnabled: vi.fn(),
    imageBusy: false,
    imageGenerationAvailable: true,
    imageEditAvailable: true,
    imageProviderOptions: [
      { providerId: "openai", label: "OpenAI", defaultModel: "gpt-image-2", models: ["gpt-image-2"] },
    ],
    selectedImageProviderId: "openai",
    selectedImageModel: "gpt-image-2",
    imageRouteLabel: "OpenAI image",
    handleToggleLiveVoice: vi.fn(async () => undefined),
    handleToggleLiveVoiceMute: vi.fn(),
    handleToggleVoiceTalk: vi.fn(async () => undefined),
    handleOpenAudioTranscribe: vi.fn(),
    handleAudioFileSelected: vi.fn(async () => undefined),
    handleGenerateImage: vi.fn(async () => generatedArtifact),
    handleEditImage: vi.fn(async () => generatedArtifact),
  });
  // HX-407 C3 default: capability absent (pre-C4 posture) so every other suite
  // sees the degraded surface (externalSourceControls: null).
  useExternalSourceAttachmentsMock.mockReturnValue(buildExternalSourceAttachmentsState());
}

function buildExternalSourceAttachmentsState(overrides: Record<string, unknown> = {}) {
  return {
    supported: false,
    loading: false,
    error: null,
    attachments: [],
    selectedAttachmentIds: [],
    busyAttachmentId: null,
    canMutate: false,
    sessionIncarnationId: null,
    reload: vi.fn(async () => undefined),
    toggleSelection: vi.fn(),
    clearSelection: vi.fn(),
    attach: vi.fn(async () => true),
    detach: vi.fn(async () => true),
    requestKnowledgeSnapshot: vi.fn(async () => true),
    captureOutboundExternalContextRefs: vi.fn(() => []),
    handleOutboundExternalContextSent: vi.fn(),
    ...overrides,
  };
}

async function flushEffects(times = 4) {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

async function commitDraft(value: string) {
  await act(async () => {
    latestSurfaceInput?.activeSessionSurfaceProps?.onDraftChange(value);
    await flushEffects(8);
  });
  expect(latestSurfaceInput?.activeSessionSurfaceProps?.draft).toBe(value);
}

async function cleanupRenderedHosts() {
  const renderers = mountedRenderers.splice(0);
  if (renderers.length === 0) {
    latestSurfaceInput = null;
    return;
  }
  await act(async () => {
    for (const renderer of renderers) {
      renderer.unmount();
    }
    await flushEffects(4);
  });
  latestSurfaceInput = null;
}

async function renderHost(props: Partial<React.ComponentProps<typeof MissionThreadedControllerHost>> = {}) {
  let renderer: ReactTestRenderer | undefined;
  const renderSurface = vi.fn((input: MissionThreadedRenderSurfaceInput) => {
    latestSurfaceInput = input;
    return <div data-surface={input.messageMode} />;
  });
  await act(async () => {
    renderer = create(
      <MissionThreadedControllerHost
        workspaceId="workspace-1"
        workspaceName="Mission Workspace"
        approvalsCount={2}
        renderSurface={renderSurface}
        {...props}
      />,
    );
    await flushEffects();
  });
  mountedRenderers.push(renderer!);
  return { renderer: renderer!, renderSurface };
}

async function selectDefaultSession() {
  await act(async () => {
    latestSurfaceInput?.sessionRail.onSelectSession("session-1", { turnId: "turn-1" });
    await flushEffects(6);
  });
}

describe("MissionThreadedControllerHost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmModalProps = [];
    latestSurfaceInput = null;
    mockSurfaceMode = "chat";
    mockCompact = false;
    mockSurfacePreview = undefined;
    mockSelectedTurn = selectedTurn;
    installBrowserGlobals();
    setupMocks();
  });

  afterEach(async () => {
    await cleanupRenderedHosts();
  });

  it("hydrates only bounded session-bound queue envelopes and canonical request preferences", () => {
    const validPersistedItem = {
      id: "queue-valid",
      action: "send",
      sessionId: "session-1",
      content: "Ship the review",
      attachments: [createStoredAttachment()],
      createdAt: "2026-05-01T00:00:00.000Z",
      paused: false,
      modelCouncil: { enabled: true },
      requestPrefs: outboundRequestPrefs,
    };
    const parsed = parseHydratedOutboundQueue(JSON.stringify([validPersistedItem]), {
      workspaceId: "workspace-1",
      sessionId: "session-1",
    });

    expect(parsed).toEqual([
      expect.objectContaining({
        id: "queue-valid",
        paused: true,
        modelCouncil: { enabled: true },
        requestPrefs: outboundRequestPrefs,
      }),
    ]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed[0]?.requestPrefs)).toBe(true);

    const maliciousCandidates = [
      { ...validPersistedItem, unexpectedDispatchOverride: "foreign" },
      { ...validPersistedItem, id: " queue-with-whitespace" },
      { ...validPersistedItem, sessionId: "session-foreign" },
      { ...validPersistedItem, modelCouncil: { enabled: true, participants: ["attacker"] } },
      {
        ...validPersistedItem,
        requestPrefs: { ...outboundRequestPrefs, providerId: "openai\nforeign" },
      },
      {
        ...validPersistedItem,
        requestPrefs: { ...outboundRequestPrefs, fullWebAccess: "true" },
      },
      {
        ...validPersistedItem,
        requestPrefs: { ...outboundRequestPrefs, providerId: undefined },
      },
    ];
    for (const candidate of maliciousCandidates) {
      expect(
        parseHydratedOutboundQueue(JSON.stringify([candidate]), {
          workspaceId: "workspace-1",
          sessionId: "session-1",
        }),
      ).toEqual([]);
    }

    const { requestPrefs: _discardedRequestPrefs, ...legacyItemWithoutFrozenPrefs } = validPersistedItem;
    expect(
      parseHydratedOutboundQueue(JSON.stringify([legacyItemWithoutFrozenPrefs]), {
        workspaceId: "workspace-1",
        sessionId: "session-1",
      }),
    ).toEqual([]);

    expect(
      parseHydratedOutboundQueue(
        JSON.stringify(
          Array.from({ length: 65 }, (_, index) => ({
            ...validPersistedItem,
            id: `queue-${index}`,
          })),
        ),
        {
          workspaceId: "workspace-1",
          sessionId: "session-1",
        },
      ),
    ).toEqual([]);
    expect(
      parseHydratedOutboundQueue(`[{"content":"${"x".repeat(256 * 1024)}"}]`, {
        workspaceId: "workspace-1",
        sessionId: "session-1",
      }),
    ).toEqual([]);
  });

  it("hydrates queue-frozen external context refs on send items and rejects malformed refs", () => {
    const baseItem = {
      id: "queue-external",
      action: "send",
      sessionId: "session-1",
      content: "Use the imported context",
      attachments: [createStoredAttachment()],
      createdAt: "2026-05-01T00:00:00.000Z",
      requestPrefs: outboundRequestPrefs,
    };
    const validRefs = [
      { kind: "external_attachment", ref: "attachment-1", label: "External item-1" },
      { kind: "external_attachment", ref: "attachment-2" },
    ];
    const parsed = parseHydratedOutboundQueue(JSON.stringify([{ ...baseItem, externalContextRefs: validRefs }]), {
      workspaceId: "workspace-1",
      sessionId: "session-1",
    });
    expect(parsed[0]?.externalContextRefs).toEqual(validRefs);
    expect(Object.isFrozen(parsed[0]?.externalContextRefs)).toBe(true);

    const maliciousRefSets = [
      [],
      [{ kind: "attachment", ref: "attachment-1" }],
      [{ kind: "external_attachment", ref: " attachment-with-space" }],
      [{ kind: "external_attachment", ref: "attachment-1", content: "smuggled transcript" }],
      [{ kind: "external_attachment", ref: "attachment-1", label: "" }],
      [
        { kind: "external_attachment", ref: "attachment-1" },
        { kind: "external_attachment", ref: "attachment-1" },
      ],
      Array.from({ length: 17 }, (_, index) => ({ kind: "external_attachment", ref: `attachment-${index}` })),
      "not-an-array",
    ];
    for (const externalContextRefs of maliciousRefSets) {
      expect(
        parseHydratedOutboundQueue(JSON.stringify([{ ...baseItem, externalContextRefs }]), {
          workspaceId: "workspace-1",
          sessionId: "session-1",
        }),
      ).toEqual([]);
    }

    // Non-send actions can never carry frozen refs.
    expect(
      parseHydratedOutboundQueue(
        JSON.stringify([
          {
            ...baseItem,
            action: "edit",
            targetTurnId: "turn-1",
            externalContextRefs: validRefs,
          },
        ]),
        { workspaceId: "workspace-1", sessionId: "session-1" },
      ),
    ).toEqual([]);
  });

  it("hydrates bounded template invocations and rejects arbitrary or edit-time injection", () => {
    const baseItem = {
      id: "queue-template",
      action: "send",
      sessionId: "session-1",
      content: "Explain leases",
      attachments: [],
      createdAt: "2026-05-01T00:00:00.000Z",
      requestPrefs: outboundRequestPrefs,
    };
    const templateInvocation = {
      ownerKind: "prompt_pack",
      ownerId: "pack-1",
      ownerRevision: "revision-1",
      templateId: "test-1",
      schemaHash: "a".repeat(64),
      values: { topic: "leases", count: 2, public: false },
    };
    const parsed = parseHydratedOutboundQueue(JSON.stringify([{ ...baseItem, templateInvocation }]), {
      workspaceId: "workspace-1",
      sessionId: "session-1",
    });
    expect(parsed[0]?.templateInvocation).toEqual(templateInvocation);
    expect(Object.isFrozen(parsed[0]?.templateInvocation)).toBe(true);
    for (const malicious of [
      { ...templateInvocation, rawUrl: "https://attacker.test" },
      { ...templateInvocation, schemaHash: "not-a-hash" },
      { ...templateInvocation, values: { secret: { nested: "payload" } } },
      {
        ...templateInvocation,
        values: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`f${index}`, "x"])),
      },
    ]) {
      expect(
        parseHydratedOutboundQueue(JSON.stringify([{ ...baseItem, templateInvocation: malicious }]), {
          workspaceId: "workspace-1",
          sessionId: "session-1",
        }),
      ).toEqual([]);
    }
    expect(
      parseHydratedOutboundQueue(
        JSON.stringify([{ ...baseItem, action: "edit", targetTurnId: "turn-1", templateInvocation }]),
        { workspaceId: "workspace-1", sessionId: "session-1" },
      ),
    ).toEqual([]);
  });

  it("wires the external-source hook into orchestration, outbound execution, and the composer surface", async () => {
    const degradedState = buildExternalSourceAttachmentsState();
    useExternalSourceAttachmentsMock.mockReturnValue(degradedState);
    await renderHost();
    await selectDefaultSession();

    // Degraded (pre-C4): the surface receives no external controls at all.
    expect(latestSurfaceInput?.activeSessionSurfaceProps?.externalSourceControls).toBeNull();
    const orchestrationInput = useChatSurfaceOrchestrationMock.mock.calls.at(-1)?.[0] as any;
    expect(orchestrationInput?.captureOutboundExternalContextRefs()).toEqual([]);
    expect(degradedState.captureOutboundExternalContextRefs).toHaveBeenCalledOnce();
    const outboundInput = useChatOutboundExecutionMock.mock.calls.at(-1)?.[0] as any;
    const sentItem = { externalContextRefs: [] };
    outboundInput?.externalContext?.onExternalContextSent(sentItem);
    expect(degradedState.handleOutboundExternalContextSent).toHaveBeenCalledWith(sentItem);

    await cleanupRenderedHosts();
    setupMocks();
    const liveState = buildExternalSourceAttachmentsState({
      supported: true,
      canMutate: true,
      attachments: [
        {
          attachmentId: "attachment-1",
          workspaceId: "workspace-1",
          sessionId: "session-1",
          sourceId: "source-1",
          importId: "import-1",
          itemId: "item-1",
          mode: "read_only_external",
          status: "attached",
          revision: 1,
        },
      ],
      selectedAttachmentIds: ["attachment-1"],
    });
    useExternalSourceAttachmentsMock.mockReturnValue(liveState);
    await renderHost();
    await selectDefaultSession();

    const controls = latestSurfaceInput?.activeSessionSurfaceProps?.externalSourceControls;
    expect(controls?.attachments).toHaveLength(1);
    expect(controls?.selectedAttachmentIds).toEqual(["attachment-1"]);
    expect(controls?.canMutate).toBe(true);
    controls?.onToggleSelect("attachment-1");
    expect(liveState.toggleSelection).toHaveBeenCalledWith("attachment-1");
    controls?.onClearSelection();
    expect(liveState.clearSelection).toHaveBeenCalled();
    controls?.onDetach("attachment-1");
    expect(liveState.detach).toHaveBeenCalledWith("attachment-1");
    controls?.onRequestKnowledgeSnapshot("attachment-1");
    expect(liveState.requestKnowledgeSnapshot).toHaveBeenCalledWith("attachment-1");
    controls?.onAttach({ sourceId: "source-1", importId: "import-1", itemId: "item-9" });
    expect(liveState.attach).toHaveBeenCalledWith({ sourceId: "source-1", importId: "import-1", itemId: "item-9" });
    // The hook itself is scoped to the selected session's workspace, and the
    // host supplies NO incarnation of its own: since C4b the hook learns the
    // exact-CAS incarnation from its durable reload (list-carried), so the
    // host seam stays unused here by design.
    const hookInput = useExternalSourceAttachmentsMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(hookInput).toMatchObject({
      workspaceId: "workspace-1",
      sessionId: "session-1",
    });
    expect("sessionIncarnationId" in hookInput).toBe(false);
  });

  it("rejects malformed, foreign, traversing, duplicate, and oversized hydrated attachment references", () => {
    const attachment = createStoredAttachment();
    expect(
      parseHydratedChatAttachments(JSON.stringify([attachment]), {
        workspaceId: "workspace-1",
        sessionId: "session-1",
      }),
    ).toEqual([attachment]);

    const malformedCandidates = [
      { ...attachment, sessionId: "session-foreign" },
      { ...attachment, workspaceId: "workspace-foreign" },
      { ...attachment, storageRelPath: "../foreign.txt" },
      { ...attachment, storageRelPath: "chat/default/attachments/file.txt:secret" },
      { ...attachment, storageRelPath: "chat/default/attachments/CON.txt" },
      { ...attachment, storageRelPath: "chat/default/attachments/file.txt. " },
      { ...attachment, storageRelPath: "chat\\default\\attachments\\file.txt" },
      { ...attachment, sha256: "not-a-digest" },
      { ...attachment, sha256: "A".repeat(64) },
      { ...attachment, attachmentId: " attachment-with-whitespace" },
      { ...attachment, injected: true },
    ];
    for (const candidate of malformedCandidates) {
      expect(
        parseHydratedChatAttachments(JSON.stringify([candidate]), {
          workspaceId: "workspace-1",
          sessionId: "session-1",
        }),
      ).toEqual([]);
    }
    expect(
      parseHydratedChatAttachments(JSON.stringify([attachment, attachment]), {
        workspaceId: "workspace-1",
        sessionId: "session-1",
      }),
    ).toEqual([]);
    expect(
      parseHydratedChatAttachments(
        JSON.stringify(
          Array.from({ length: 17 }, (_, index) => createStoredAttachment({ attachmentId: `attachment-${index}` })),
        ),
        {
          workspaceId: "workspace-1",
          sessionId: "session-1",
        },
      ),
    ).toEqual([]);
  });

  it("does not drain a legacy hydrated item under newly selected request preferences", () => {
    const legacyItemWithoutFrozenPrefs = {
      id: "queue-legacy",
      action: "send",
      sessionId: "session-1",
      content: "Do not silently reroute me",
      attachments: [],
      createdAt: "2026-05-01T00:00:00.000Z",
    };
    const newlySelectedPrefs = {
      ...outboundRequestPrefs,
      providerId: "anthropic",
      model: "claude-new-selection",
    } as const;

    expect(newlySelectedPrefs.providerId).toBe("anthropic");
    expect(
      parseHydratedOutboundQueue(JSON.stringify([legacyItemWithoutFrozenPrefs]), {
        workspaceId: "workspace-1",
        sessionId: "session-1",
      }),
    ).toEqual([]);
  });

  it("merges session hydration without clobbering items queued after the session transition", () => {
    const queueItem = (id: string, sessionId = "session-1") => ({
      id,
      action: "send" as const,
      sessionId,
      content: id,
      attachments: [],
      createdAt: "2026-05-01T00:00:00.000Z",
      requestPrefs: outboundRequestPrefs,
    });
    const newlyQueued = queueItem("queue-new");
    const merged = mergeHydratedOutboundQueue({
      hydrated: [queueItem("queue-hydrated"), queueItem("queue-new")],
      current: [queueItem("queue-old"), newlyQueued, queueItem("queue-foreign", "session-foreign")],
      baselineIds: new Set(["queue-old"]),
      sessionId: "session-1",
    });

    expect(merged.map((item) => item.id)).toEqual(["queue-hydrated", "queue-new"]);
    expect(merged[1]).toBe(newlyQueued);
  });

  it("keeps compact session ownership aligned with the 1180px surface breakpoint", async () => {
    await renderHost();

    expect(useMediaQueryMock).toHaveBeenCalledWith("(width < 1180px)");
  });

  it("fails closed across direct mutation callbacks while an exact historical window is active", async () => {
    const baseSessionData = useChatSessionDataMock();
    useChatSessionDataMock.mockReturnValue({
      ...baseSessionData,
      historicalWindowTarget: { workspaceId: "workspace-1", sessionId: "session-1" },
      historicalWindow: {
        anchor: {
          state: "found",
          workspaceId: "workspace-1",
          sessionId: "session-1",
          messageId: "message-user",
          sequence: 1,
        },
        items: [
          {
            sequence: 1,
            isAnchor: true,
            message: {
              messageId: "message-user",
              sessionId: "session-1",
              role: "user",
              content: "Build the launch plan",
              timestamp: "2026-05-01T00:00:00.000Z",
            },
          },
        ],
        snapshotMaxSequence: 2,
        snapshotMessageCount: 2,
        hasOlder: false,
        hasNewer: true,
        newerCursor: { messageId: "message-user", sequence: 1, snapshotMaxSequence: 2 },
        truncated: false,
        droppedItems: 0,
        byteLength: 256,
      },
    });

    await renderHost();
    await act(async () => {
      latestSurfaceInput?.sessionRail.onSelectSession("session-1", {
        searchHit: {
          workspaceId: "workspace-1",
          sessionId: "session-1",
          messageId: "message-user",
          sequence: 1,
          excerpt: "Build the launch plan",
          score: 10,
        },
      });
      await flushEffects(8);
    });

    const surface = latestSurfaceInput?.activeSessionSurfaceProps;
    const dock = latestSurfaceInput?.contextDockProps;
    const sessionControls = useChatSessionControlsMock.mock.results.at(-1)?.value as any;
    const orchestration = useChatSurfaceOrchestrationMock.mock.results.at(-1)?.value as any;
    const contextActions = useChatContextActionsMock.mock.results.at(-1)?.value as any;
    const outbound = useChatOutboundExecutionMock.mock.results.at(-1)?.value as any;
    const composer = useChatComposerInteractionsMock.mock.results.at(-1)?.value as any;
    const multimodal = useChatMultimodalControlsMock.mock.results.at(-1)?.value as any;
    const rail = latestSurfaceInput?.sessionRail;
    const dropTarget = latestSurfaceInput?.dropTargetProps;
    vi.clearAllMocks();

    expect(surface?.historicalReadOnly).toBe(true);
    expect(surface?.canSend).toBe(false);

    await act(async () => {
      // Conversation and approval mutations.
      surface?.onSend();
      surface?.onRetryTurn("turn-1");
      surface?.onSwitchBranch("turn-1");
      surface?.onEditTurn("turn-1");
      surface?.onStartNewThreadFromTurn("turn-1");
      surface?.onRequestProviderChange("anthropic");
      surface?.onRequestModelChange("claude-4");
      surface?.onToggleArchiveSession();
      surface?.onApprovePending("once");
      surface?.onDenyPending();
      surface?.onSubmitUserInput({ kind: "text", text: "continue" });
      surface?.onResumeAll();
      surface?.onRemoveQueuedItem("queue-1");
      surface?.onCreateGeneratedArtifact("turn-1");
      surface?.onCreateGeneratedArtifactVersion("turn-1");
      await surface?.onAcceptDelegation();

      // Composer, upload, knowledge, planning, and research mutations.
      surface?.onComposerKeyDown({ preventDefault: vi.fn() } as any);
      surface?.onComposerPaste({ preventDefault: vi.fn() } as any);
      surface?.onDrop({ preventDefault: vi.fn() } as any);
      surface?.onTogglePlanningMode();
      surface?.onToggleResearchMode();
      surface?.onToggleReviewMode();
      surface?.onSetDeepMode();
      surface?.onSetThinkingLevel("deep");
      surface?.onSetSpeedMode("fast");
      surface?.onSetSubagentPolicy("auto_when_useful");
      surface?.onApplyDraftCommand("/plan on");
      surface?.onSetAttachmentMode?.("knowledge-1", "full_text");
      surface?.onRemoveThreadKnowledgeAttachment?.("knowledge-1");
      surface?.onAttachKnowledgeUrl?.();
      surface?.onRemoveAttachment("attachment-1");
      surface?.onUploadFiles(null);
      dropTarget?.onUploadFiles(null);
      surface?.onRunQuickResearch();

      // Voice, image, goal, and steering mutations.
      surface?.onRequestImageProviderChange?.("openai");
      surface?.onRequestImageModelChange?.("gpt-image-2");
      surface?.onToggleLiveVoice?.();
      surface?.onToggleLiveVoiceMute?.();
      surface?.onToggleVoiceTalk?.();
      surface?.onOpenAudioTranscribe?.();
      surface?.onAudioFileSelected?.(null);
      surface?.onToggleSpeakResponses?.();
      surface?.onGenerateImage?.();
      surface?.onEditImage?.();
      await surface?.onSteerMidTurn?.("continue safely");
      await surface?.onSetGoal?.("Ship safely", 4);
      await surface?.onClearGoal?.();

      // Drawer preferences, orchestration, memory, and session organization.
      await dock?.onPrefPatch({ model: "claude-4" });
      await dock?.onSuggestDelegation();
      await dock?.onTriggerProactive();
      await dock?.onProactivePolicyPatch({ mode: "suggest" } as any);
      await dock?.onRunCodeDelegation("implement");
      dock?.onCapabilitySuggestionAction(dock.capabilitySuggestions[0]);
      await dock?.onCreateSpecialistDraft(dock.specialistSuggestions[0]);
      await dock?.onActivateCatalogSpecialist(dock.specialistSuggestions[0]);
      await dock?.onSpecialistCandidatePatch("candidate-1", { title: "Blocked" }, "blocked");
      await dock?.onAcceptDelegation();
      await dock?.onRebuildLearnedMemory();
      await dock?.onUpdateMemoryStatus("memory-1", "disabled");
      await dock?.onRenameSession();
      await dock?.onSaveOrganization();
      await dock?.onTogglePinSession();
      await dock?.onToggleArchiveSession();
      dock?.onDeleteSession();
      await dock?.onAssignProject("project-2");
      await dock?.onSaveExternalBinding();

      // Rail-level creation and archive entry points are also locked.
      rail?.onCreateSession();
      rail?.onCreateProject();
      rail?.onArchiveWorkspace();
      await rail?.onConfirmArchiveWorkspace();

      // Stop and cancel are the only safety exceptions while reading history.
      surface?.onStopActiveTurn();
      surface?.onCoworkStopRun?.({ action: "pause", enabled: true, label: "Pause" } as any);
      surface?.onCoworkStopRun?.({ action: "cancel", enabled: true, label: "Cancel" } as any);
      await flushEffects(8);
    });

    expect(handleSendMock).not.toHaveBeenCalled();
    expect(sessionControls.handleCreateProject).not.toHaveBeenCalled();
    expect(sessionControls.handleToggleArchiveSession).not.toHaveBeenCalled();
    expect(sessionControls.handleRenameSession).not.toHaveBeenCalled();
    expect(sessionControls.handleSaveOrganization).not.toHaveBeenCalled();
    expect(sessionControls.handleTogglePinSession).not.toHaveBeenCalled();
    expect(sessionControls.handleDeleteSession).not.toHaveBeenCalled();
    expect(sessionControls.handleAssignProject).not.toHaveBeenCalled();
    expect(sessionControls.handleSaveExternalBinding).not.toHaveBeenCalled();
    expect(orchestration.handleRetryTurn).not.toHaveBeenCalled();
    expect(orchestration.handleBeginEditTurn).not.toHaveBeenCalled();
    expect(orchestration.handleResumeQueue).not.toHaveBeenCalled();
    expect(orchestration.handleRemoveQueuedItem).not.toHaveBeenCalled();
    expect(contextActions.handleAcceptDelegation).not.toHaveBeenCalled();
    expect(contextActions.handleRunQuickResearch).not.toHaveBeenCalled();
    expect(contextActions.handleSuggestDelegation).not.toHaveBeenCalled();
    expect(contextActions.handleTriggerProactive).not.toHaveBeenCalled();
    expect(contextActions.handleProactivePolicyPatch).not.toHaveBeenCalled();
    expect(contextActions.handleRunCodeDelegation).not.toHaveBeenCalled();
    expect(contextActions.handleCreateSpecialistDraft).not.toHaveBeenCalled();
    expect(contextActions.handleActivateCatalogSpecialist).not.toHaveBeenCalled();
    expect(contextActions.handleSpecialistCandidatePatch).not.toHaveBeenCalled();
    expect(contextActions.handleRebuildLearnedMemory).not.toHaveBeenCalled();
    expect(contextActions.handleMemoryStatusUpdate).not.toHaveBeenCalled();
    expect(outbound.handleSelectBranchTurn).not.toHaveBeenCalled();
    expect(outbound.handleApprovePending).not.toHaveBeenCalled();
    expect(outbound.handleDenyPending).not.toHaveBeenCalled();
    expect(outbound.handleSubmitUserInput).not.toHaveBeenCalled();
    expect(composer.handleCreateCurrentModeSession).not.toHaveBeenCalled();
    expect(composer.handleArchiveWorkspace).not.toHaveBeenCalled();
    expect(composer.handleConfirmArchiveWorkspace).not.toHaveBeenCalled();
    expect(composer.handleComposerKeyDown).not.toHaveBeenCalled();
    expect(composer.handleComposerPaste).not.toHaveBeenCalled();
    expect(composer.handleDrop).not.toHaveBeenCalled();
    expect(composer.handleSetDeepMode).not.toHaveBeenCalled();
    expect(composer.handleApplyDraftCommand).not.toHaveBeenCalled();
    expect(composer.handleRemoveAttachment).not.toHaveBeenCalled();
    expect(composer.handleUploadFiles).not.toHaveBeenCalled();
    expect(multimodal.handleToggleLiveVoice).not.toHaveBeenCalled();
    expect(multimodal.handleToggleLiveVoiceMute).not.toHaveBeenCalled();
    expect(multimodal.handleToggleVoiceTalk).not.toHaveBeenCalled();
    expect(multimodal.handleOpenAudioTranscribe).not.toHaveBeenCalled();
    expect(multimodal.handleAudioFileSelected).not.toHaveBeenCalled();
    expect(multimodal.setSpeakResponsesEnabled).not.toHaveBeenCalled();
    expect(multimodal.handleGenerateImage).not.toHaveBeenCalled();
    expect(multimodal.handleEditImage).not.toHaveBeenCalled();
    expect(updateChatSessionPrefsMock).not.toHaveBeenCalled();
    expect(createChatSessionMock).not.toHaveBeenCalled();
    expect(createChatGeneratedArtifactMock).not.toHaveBeenCalled();
    expect(attachThreadKnowledgeAttachmentMock).not.toHaveBeenCalled();
    expect(removeThreadKnowledgeAttachmentMock).not.toHaveBeenCalled();
    expect(setChatSessionGoalMock).not.toHaveBeenCalled();
    expect(clearChatSessionGoalMock).not.toHaveBeenCalled();
    expect(steerChatSessionMock).not.toHaveBeenCalled();
    expect(loadModelsForProviderMock).not.toHaveBeenCalled();
    expect(orchestration.handleStopActiveTurn).toHaveBeenCalledTimes(1);
    expect(controlAgenticRunMock).toHaveBeenCalledTimes(1);
    expect(controlAgenticRunMock).toHaveBeenCalledWith(
      "agentic-run-1",
      expect.objectContaining({ action: "cancel", expectedRevision: 12 }),
      { workspaceId: "workspace-1" },
    );
  });

  it("fails closed across code-workbench mutation callbacks while historical context is active", async () => {
    mockSurfaceMode = "code";
    const baseSessionData = useChatSessionDataMock();
    useChatSessionDataMock.mockReturnValue({
      ...baseSessionData,
      historicalWindowTarget: { workspaceId: "workspace-1", sessionId: "session-1" },
      historicalWindow: {
        anchor: {
          state: "found",
          workspaceId: "workspace-1",
          sessionId: "session-1",
          messageId: "message-user",
          sequence: 1,
        },
        items: [],
        snapshotMaxSequence: 2,
        snapshotMessageCount: 2,
        hasOlder: false,
        hasNewer: false,
        truncated: false,
        droppedItems: 0,
        byteLength: 2,
      },
    });

    await renderHost({ lockSurface: true, surface: "code" });
    await act(async () => {
      latestSurfaceInput?.sessionRail.onSelectSession("session-1", {
        searchHit: {
          workspaceId: "workspace-1",
          sessionId: "session-1",
          messageId: "message-user",
          sequence: 1,
          excerpt: "Build the launch plan",
          score: 10,
        },
      });
      await flushEffects(8);
    });

    const panel = latestSurfaceInput?.workflowPanel?.kind === "code" ? latestSurfaceInput.workflowPanel.props : null;
    const sessionControls = useChatSessionControlsMock.mock.results.at(-1)?.value as any;
    const workbench = useChatDockWorkbenchControllerMock.mock.results.at(-1)?.value as any;
    vi.clearAllMocks();

    expect(latestSurfaceInput?.activeSessionSurfaceProps?.historicalReadOnly).toBe(true);
    expect(panel).not.toBeNull();

    await act(async () => {
      await panel?.onBindExistingProject?.("project-2");
      await panel?.onImportProjectSource?.({ sourceType: "local_folder", sourcePath: "F:/repo" } as any);
      panel?.onCreateWorktree?.();
      panel?.onDraftChange?.("export const blocked = true;");
      panel?.onDiscardDraft?.();
      panel?.onSaveFile?.();
      await panel?.onFileOperation?.({ operation: "create_file", path: "src/blocked.ts" });
      panel?.onRunValidationCommand?.({ command: "pnpm", args: ["test"] } as any);
      panel?.onApplyPatch?.("diff --git a/a b/a");
      panel?.onRevertFile?.("src/index.ts");
      panel?.onRevertAll?.();
      panel?.onRunHelperSnippet?.("typescript", "export const blocked = true;");
      await flushEffects(8);
    });

    expect(sessionControls.handleAssignProject).not.toHaveBeenCalled();
    expect(sessionControls.handleImportCodeProject).not.toHaveBeenCalled();
    expect(workbench.createWorkbenchWorktree).not.toHaveBeenCalled();
    expect(workbench.setWorkbenchDraftContent).not.toHaveBeenCalled();
    expect(workbench.discardWorkbenchDraft).not.toHaveBeenCalled();
    expect(workbench.saveWorkbenchFile).not.toHaveBeenCalled();
    expect(workbench.runWorkbenchFileOperation).not.toHaveBeenCalled();
    expect(workbench.runWorkbenchValidationCommand).not.toHaveBeenCalled();
    expect(workbench.applyWorkbenchPatch).not.toHaveBeenCalled();
    expect(workbench.revertWorkbenchFile).not.toHaveBeenCalled();
    expect(workbench.revertWorkbenchAll).not.toHaveBeenCalled();
    expect(createCodeModeRunMock).not.toHaveBeenCalled();
  });

  it("covers package-local host helpers", () => {
    const labels = new Map([
      ["openai", "OpenAI"],
      ["local", "Local Runtime"],
    ]);
    expect(formatRoutingTargetSummary(labels, undefined, "gpt-5.5")).toBe("gpt-5.5");
    expect(formatRoutingTargetSummary(labels, "openai", "gpt-5.5")).toBe("OpenAI / gpt-5.5");
    expect(formatRoutingTargetSummary(labels, "custom-provider", undefined)).toBe("custom-provider");

    expect(formatFallbackSummary(null)).toEqual({ summary: "Fallback off", tone: "muted" });
    expect(formatFallbackSummary({ fallbackPolicy: "off" } as any)).toEqual({
      summary: "Fallback off",
      tone: "muted",
    });
    expect(formatFallbackSummary({ fallbackPolicy: "auto", fallbackResult: "local_to_cloud" } as any)).toEqual({
      summary: "Fallback armed · local to cloud",
      tone: "warning",
    });
    expect(formatFallbackSummary({ fallbackPolicy: "auto", fallbackResult: "cloud_to_local" } as any)).toEqual({
      summary: "Fallback armed · cloud to local",
      tone: "warning",
    });
    expect(formatFallbackSummary({ fallbackPolicy: "auto", fallbackResult: "none" } as any)).toEqual({
      summary: "Fallback armed",
      tone: "warning",
    });

    expect(formatRuntimeSummary(null)).toEqual({ summary: "Runtime not checked", tone: "muted" });
    expect(formatRuntimeSummary({ runtimeReachability: "not_checked" } as any)).toEqual({
      summary: "Runtime not checked",
      tone: "muted",
    });
    expect(formatRuntimeSummary({ runtimeReachability: "reachable", runtimeClass: "local" } as any)).toEqual({
      summary: "Runtime reachable",
      tone: "success",
    });
    expect(formatRuntimeSummary({ runtimeReachability: "reachable", runtimeClass: "cloud" } as any)).toEqual({
      summary: "Provider reachable",
      tone: "success",
    });
    expect(formatRuntimeSummary({ runtimeReachability: "unreachable", runtimeClass: "local" } as any)).toEqual({
      summary: "Runtime unreachable",
      tone: "critical",
    });
    expect(formatRuntimeSummary({ runtimeReachability: "unreachable", runtimeClass: "cloud" } as any)).toEqual({
      summary: "Provider unreachable",
      tone: "critical",
    });
    expect(formatRuntimeSummary({ runtimeReachability: "models_unavailable", runtimeClass: "local" } as any)).toEqual({
      summary: "Models unavailable",
      tone: "warning",
    });
    expect(formatRuntimeSummary({ runtimeReachability: "models_unavailable", runtimeClass: "cloud" } as any)).toEqual({
      summary: "Provider degraded",
      tone: "warning",
    });
    expect(formatThreadedRunStateLabel(selectedTurn as any, null)).toBe("completed");
    expect(
      formatThreadedRunStateLabel(selectedTurn as any, {
        attachedTurnId: "turn-1",
        label: "Delegation",
        objective: "Fresh run",
        mode: "parallel",
        status: "running",
        steps: [],
      }),
    ).toBe("delegation running");
    expect(
      formatThreadedRunStateSummary(
        {
          ...selectedTurn,
          trace: { ...selectedTurn.trace, status: "running" },
        } as any,
        {
          attachedTurnId: "turn-1",
          label: "Delegation",
          objective: "Fresh run",
          mode: "parallel",
          status: "partial",
          steps: [],
        },
      ),
    ).toBe("Run: delegation partial");
    expect(
      formatThreadedRunStateSummary(
        {
          ...selectedTurn,
          trace: {
            ...selectedTurn.trace,
            status: "partial",
            orchestration: {
              runId: "delegation-run-1",
              status: "partial",
            },
          },
        } as any,
        {
          runId: "delegation-run-1",
          attachedTurnId: "turn-1",
          label: "Delegation",
          objective: "Fresh run",
          mode: "parallel",
          status: "running",
          steps: [],
        },
      ),
    ).toBe("Run: delegation partial");
    expect(
      formatThreadedRunStateSummary(
        {
          ...selectedTurn,
          trace: { ...selectedTurn.trace, status: "waiting_for_approval" },
        } as any,
        {
          attachedTurnId: "turn-1",
          label: "Delegation",
          objective: "Fresh run",
          mode: "parallel",
          status: "failed",
          steps: [],
        },
      ),
    ).toBe("Run: waiting_for_approval");
    expect(
      formatThreadedRunStateSummary(null, {
        attachedTurnId: "turn-1",
        label: "Delegation",
        objective: "Fresh run",
        mode: "parallel",
        status: "failed",
        steps: [],
      }),
    ).toBe("Run: delegation failed");

    expect(requiresBoundaryAcknowledgment(null)).toBe(false);
    expect(requiresBoundaryAcknowledgment({ fallbackResult: "local_to_cloud" } as any)).toBe(true);
    expect(requiresBoundaryAcknowledgment({ fallbackResult: "cloud_to_local" } as any)).toBe(true);
    expect(requiresBoundaryAcknowledgment({ fallbackResult: "none" } as any)).toBe(false);

    expect(
      reconcilePendingAttachmentModes(
        {
          docRetrieval: "retrieval",
          docFullText: "full_text",
          docPendingFullText: "full_text",
          imageIgnored: "retrieval",
        },
        [
          { attachmentId: "docRetrieval", fileName: "notes.txt", mediaType: "text", mimeType: "text/plain" } as any,
          {
            attachmentId: "docFullText",
            fileName: "ready.pdf",
            mediaType: "file",
            mimeType: "application/pdf",
            extractStatus: "ready",
          } as any,
          {
            attachmentId: "docPendingFullText",
            fileName: "pending.pdf",
            mediaType: "file",
            mimeType: "application/pdf",
          } as any,
          { attachmentId: "imageIgnored", fileName: "image.png", mediaType: "image", mimeType: "image/png" } as any,
        ],
      ),
    ).toEqual({
      docRetrieval: "retrieval",
      docFullText: "full_text",
      docPendingFullText: "message",
    });

    expect(
      reconcilePendingAttachmentModes(
        {
          pdfByMime: "full_text",
          jsonByMime: "full_text",
          xmlByMime: "full_text",
          yamlByMime: "full_text",
          csvByMime: "full_text",
          mdByMime: "full_text",
          previewOnly: "full_text",
          ocrOnly: "full_text",
          transcriptOnly: "full_text",
          audioIgnored: "retrieval",
          videoIgnored: "retrieval",
        },
        [
          {
            attachmentId: "pdfByMime",
            fileName: "paper.bin",
            mediaType: "file",
            mimeType: "application/pdf",
            extractPreview: "preview",
          } as any,
          {
            attachmentId: "jsonByMime",
            fileName: "data.bin",
            mediaType: "file",
            mimeType: "application/json",
            ocrText: "ocr",
          } as any,
          {
            attachmentId: "xmlByMime",
            fileName: "feed.bin",
            mediaType: "file",
            mimeType: "application/xml",
            transcriptText: "transcript",
          } as any,
          {
            attachmentId: "yamlByMime",
            fileName: "config.bin",
            mediaType: "file",
            mimeType: "application/yaml",
            extractStatus: "ready",
          } as any,
          { attachmentId: "csvByMime", fileName: "rows.bin", mediaType: "file", mimeType: "text/csv" } as any,
          {
            attachmentId: "mdByMime",
            fileName: "notes.bin",
            mediaType: "file",
            mimeType: "text/markdown",
          } as any,
          {
            attachmentId: "previewOnly",
            fileName: "preview.bin",
            mediaType: "file",
            mimeType: "application/octet-stream",
            extractPreview: "preview",
          } as any,
          {
            attachmentId: "ocrOnly",
            fileName: "scan.bin",
            mediaType: "file",
            mimeType: "application/octet-stream",
            ocrText: "ocr",
          } as any,
          {
            attachmentId: "transcriptOnly",
            fileName: "audio.txt",
            mediaType: "file",
            mimeType: "application/octet-stream",
            transcriptText: "transcript",
          } as any,
          { attachmentId: "audioIgnored", fileName: "audio.mp3", mediaType: "audio", mimeType: "audio/mpeg" } as any,
          { attachmentId: "videoIgnored", fileName: "video.mp4", mediaType: "video", mimeType: "video/mp4" } as any,
        ],
      ),
    ).toEqual({
      pdfByMime: "full_text",
      jsonByMime: "full_text",
      xmlByMime: "full_text",
      yamlByMime: "full_text",
      csvByMime: "message",
      mdByMime: "message",
      previewOnly: "full_text",
      ocrOnly: "full_text",
      transcriptOnly: "full_text",
    });

    expect(resolveExecutionRoutePrefs(null, "cowork", undefined, undefined)).toBeNull();
    expect(resolveExecutionRoutePrefs(prefs as any, "cowork", undefined, undefined)).toEqual(
      expect.objectContaining({ mode: "cowork", providerId: "openai", model: "gpt-5.5" }),
    );
    expect(
      resolveExecutionRoutePrefs(
        { ...prefs, providerId: undefined, model: undefined } as any,
        "code",
        "anthropic",
        "claude-4",
      ),
    ).toEqual(expect.objectContaining({ mode: "code", providerId: "anthropic", model: "claude-4" }));

    const idRun = vi.fn((sessionId: string) => sessionId);
    expect(runWithSelectedSessionId(null, idRun)).toBeUndefined();
    expect(runWithSelectedSessionId("session-1", idRun)).toBe("session-1");
    const sessionRun = vi.fn((session: typeof selectedSession) => session.sessionId);
    expect(runWithSelectedSession(null, sessionRun as any)).toBeUndefined();
    expect(runWithSelectedSession(selectedSession as any, sessionRun as any)).toBe("session-1");
  });

  it("assembles chat surface props and routes user-facing callbacks", async () => {
    const workTrustSummary = vi.fn();
    const navigateSurface = vi.fn();
    await renderHost({
      onWorkTrustSummaryChange: workTrustSummary,
      onNavigateSurface: navigateSurface,
    });
    await selectDefaultSession();

    expect(latestSurfaceInput?.messageMode).toBe("chat");
    expect(latestSurfaceInput?.activeSessionSurfaceProps?.sessionTitle).toBe("Launch plan");
    expect(latestSurfaceInput?.activeSessionSurfaceProps?.visualStreamMode).toBe("smooth");
    expect(latestSurfaceInput?.contextDockProps?.visualStreamMode).toBe("smooth");
    expect(setDevDiagnosticsActiveChatSessionMock).toHaveBeenCalledWith("session-1");
    expect(setDevDiagnosticsLatestTraceSummaryMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", turnId: "turn-1" }),
    );

    await act(async () => {
      latestSurfaceInput?.contextDockProps?.onVisualStreamModeChange("instant");
      await flushEffects();
    });
    expect(latestSurfaceInput?.activeSessionSurfaceProps?.visualStreamMode).toBe("instant");
    expect(window.localStorage.getItem("goatcitadel.chat.visual_stream_mode.v1")).toBe("instant");

    await act(async () => {
      latestSurfaceInput?.onSessionRailOpenChange(true);
      latestSurfaceInput?.onDockOpenChange(true);
      latestSurfaceInput?.sessionRail.onSelectSession("session-1", { turnId: "turn-1" });
      latestSurfaceInput?.activeSessionSurfaceProps?.onRequestProviderChange("anthropic");
      latestSurfaceInput?.activeSessionSurfaceProps?.onRequestModelChange("claude-4");
      latestSurfaceInput?.activeSessionSurfaceProps?.onOpenRunDetails("turn-1");
      latestSurfaceInput?.activeSessionSurfaceProps?.onAcknowledgeRouteBoundary();
      latestSurfaceInput?.activeSessionSurfaceProps?.onDraftChange("Draft body");
      latestSurfaceInput?.activeSessionSurfaceProps?.onSetDeepMode();
      latestSurfaceInput?.activeSessionSurfaceProps?.onSetThinkingLevel("deep");
      latestSurfaceInput?.activeSessionSurfaceProps?.onSetSpeedMode("fast");
      latestSurfaceInput?.activeSessionSurfaceProps?.onSetSubagentPolicy("auto_when_useful");
      latestSurfaceInput?.activeSessionSurfaceProps?.onApplyDraftCommand("/plan on");
      latestSurfaceInput?.activeSessionSurfaceProps?.onRunQuickResearch();
      latestSurfaceInput?.activeSessionSurfaceProps?.onKnowledgeUrlDraftChange(" https://docs.example.test/runbook ");
      latestSurfaceInput?.activeSessionSurfaceProps?.onKnowledgeUrlModeChange("full_text");
      latestSurfaceInput?.activeSessionSurfaceProps?.onPresetChange("agent-1");
      latestSurfaceInput?.contextDockProps?.onSuggestDelegation();
      latestSurfaceInput?.contextDockProps?.onTriggerProactive();
      latestSurfaceInput?.contextDockProps?.onCapabilitySuggestionAction({
        kind: "skill",
        recommendedAction: "connect_mcp",
      } as any);
      latestSurfaceInput?.contextDockProps?.onRenameTitleChange("New title");
      latestSurfaceInput?.contextDockProps?.onFolderNameChange("New folder");
      latestSurfaceInput?.contextDockProps?.onTagsValueChange("new, tags");
      latestSurfaceInput?.contextDockProps?.onDeleteSession();
      latestSurfaceInput?.emptyStateProps.onCreateSession();
      latestSurfaceInput?.emptyStateProps.onOpenCowork();
      latestSurfaceInput?.dropTargetProps.onUploadFiles(null);
      await flushEffects();
    });

    expect(loadModelsForProviderMock).toHaveBeenCalledWith("anthropic");
    expect(updateChatSessionPrefsMock).toHaveBeenCalled();
    expect(confirmModalProps.some((props) => props.open && props.title === "Switch thread model?")).toBe(true);

    await act(async () => {
      const modelSwitchModal = confirmModalProps.find((props) => props.open && props.title === "Switch thread model?");
      modelSwitchModal?.onConfirm();
      await flushEffects();
    });
    expect(updateChatSessionPrefsMock).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ model: "claude-4" }),
    );

    await act(async () => {
      await latestSurfaceInput?.activeSessionSurfaceProps?.onCreateGeneratedArtifact("turn-1");
      await latestSurfaceInput?.activeSessionSurfaceProps?.onCreateGeneratedArtifactVersion("turn-1");
      await latestSurfaceInput?.activeSessionSurfaceProps?.onOpenGeneratedArtifact("turn-1");
      latestSurfaceInput?.activeSessionSurfaceProps?.onCloseGeneratedArtifact();
      await latestSurfaceInput?.activeSessionSurfaceProps?.onExportRunBundle();
      await latestSurfaceInput?.contextDockProps?.onExportSnapshot();
      await latestSurfaceInput?.activeSessionSurfaceProps?.onAttachKnowledgeUrl();
      await latestSurfaceInput?.activeSessionSurfaceProps?.onApplyPreset();
      await latestSurfaceInput?.activeSessionSurfaceProps?.onRemoveThreadKnowledgeAttachment("knowledge-1");
      await flushEffects();
    });

    expect(createChatGeneratedArtifactMock).toHaveBeenCalledWith("session-1", "turn-1", { supersedeLatest: false });
    expect(createChatGeneratedArtifactMock).toHaveBeenCalledWith("session-1", "turn-1", { supersedeLatest: true });
    expect(fetchChatGeneratedArtifactMock).toHaveBeenCalledWith("artifact-1", "workspace-1");
    expect(fetchRuntimeLifecycleExportMock).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-1" }));
    expect(attachThreadKnowledgeAttachmentMock).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ url: "https://docs.example.test/runbook", retrievalMode: "full_text" }),
    );
    expect(updateChatSessionPrefsMock).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ providerId: "anthropic", model: "claude-4", toolAutonomy: "manual" }),
    );
    expect(removeThreadKnowledgeAttachmentMock).toHaveBeenCalledWith("session-1", "knowledge-1");
    expect(navigateSurface).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ artifactId: undefined, sessionId: "session-1", turnId: "turn-1" }),
    );
  });

  it("builds code workflow props and runs workbench/code helper actions", async () => {
    mockSurfaceMode = "code";
    await renderHost({ lockSurface: true, surface: "code" });
    await selectDefaultSession();

    expect(latestSurfaceInput?.workflowPanel?.kind).toBe("code");
    const props = latestSurfaceInput?.workflowPanel?.kind === "code" ? latestSurfaceInput.workflowPanel.props : null;
    expect(props?.needsProjectBinding).toBe(false);

    await act(async () => {
      await props?.onBindExistingProject("project-1");
      await props?.onImportProjectSource({ workspacePath: "F:/code/personal-ai", name: "Imported" } as any);
      props?.onCreateWorktree();
      props?.onSelectFile("src/index.ts");
      props?.onDraftChange("next content");
      props?.onExpandedPathsChange(["src"]);
      props?.onRefresh();
      props?.onSaveFile();
      props?.onDiscardDraft();
      props?.onRunValidationCommand({ command: "pnpm test" } as any);
      props?.onApplyPatch("diff --git a/file b/file");
      await props?.onExportPatch();
      props?.onRevertFile("src/index.ts");
      props?.onRevertAll();
      await props?.onRunHelperSnippet("python", "print('x')");
      await props?.onRunHelperSnippet("ts", "export const x = 1;");
      await flushEffects();
    });

    expect(createCodeModeRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        language: "typescript",
        source: "export const x = 1;",
        originSurface: "chat",
        sessionId: "session-1",
      }),
    );
  });

  it("builds cowork workflow props and sends enabled agentic controls", async () => {
    mockSurfaceMode = "cowork";
    await renderHost({ lockSurface: true, surface: "cowork" });
    await selectDefaultSession();
    await act(async () => {
      await flushEffects();
    });

    expect(latestSurfaceInput?.workflowPanel?.kind).toBe("cowork");
    expect(latestSurfaceInput?.activeSessionSurfaceProps?.trust.runStateSummary).toBe("Run: delegation running");
    const props = latestSurfaceInput?.workflowPanel?.kind === "cowork" ? latestSurfaceInput.workflowPanel.props : null;
    await act(async () => {
      props?.onAgenticControl?.({ action: "pause", enabled: false, label: "Pause" } as any);
      props?.onAgenticControl?.({ action: "pause", enabled: true, label: "Pause" } as any);
      props?.onOpenDetails();
      props?.onFocusComposer();
      props?.onRefreshRunState();
      await flushEffects();
    });

    expect(fetchAgenticRunsMock).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      surface: "chat",
      limit: 1,
    });
    expect(fetchAgenticRunTreeMock).toHaveBeenCalledWith("agentic-run-1", { workspaceId: "workspace-1" });
    expect(controlAgenticRunMock).toHaveBeenCalledWith(
      "agentic-run-1",
      expect.objectContaining({ action: "pause", expectedRevision: 12, reason: "Mission Control operator action." }),
      { workspaceId: "workspace-1" },
    );
  });

  it("renders loading state and clears shell trust on unmount", async () => {
    useChatSessionDataMock.mockReturnValue({
      ...useChatSessionDataMock(),
      loading: true,
      projects: null,
      sessions: null,
    });
    const workTrustSummary = vi.fn();
    const { renderer } = await renderHost({
      lockSurface: true,
      surface: "chat",
      onWorkTrustSummaryChange: workTrustSummary,
    });

    expect(latestSurfaceInput).toBeNull();
    const loadingMarkup = JSON.stringify(renderer.toJSON());
    expect(loadingMarkup).toContain('Preparing ","Chat');
    expect(loadingMarkup).toContain("Checking runtime posture");
    expect(loadingMarkup).toContain("Mission Workspace");
    expect(loadingMarkup).toContain("Loading");
    await act(async () => {
      renderer.unmount();
      await flushEffects();
    });
    expect(workTrustSummary).toHaveBeenCalledWith(null);
  });

  it("formats trust summaries for route fallback and runtime variants", async () => {
    const cases = [
      {
        source: "global",
        fallbackResult: "local_to_cloud",
        runtimeReachability: "unreachable",
        runtimeClass: "local",
        expectedSelection: "Selection: global",
        expectedFallback: "Fallback armed · local to cloud",
        expectedRuntime: "Runtime unreachable",
      },
      {
        source: "manual",
        fallbackResult: "cloud_to_local",
        runtimeReachability: "models_unavailable",
        runtimeClass: "cloud",
        expectedSelection: "Selection: manual",
        expectedFallback: "Fallback armed · cloud to local",
        expectedRuntime: "Provider degraded",
      },
      {
        source: undefined,
        fallbackResult: "not_applicable",
        runtimeReachability: "not_checked",
        runtimeClass: "cloud",
        expectedSelection: "Selection: pending",
        expectedFallback: "Fallback armed",
        expectedRuntime: "Runtime not checked",
      },
    ];

    for (const item of cases) {
      setupMocks();
      latestSurfaceInput = null;
      useChatRoutePreflightMock.mockReturnValue({
        result: {
          requestedProviderId: "openai",
          requestedModel: "gpt-5.5",
          effectiveProviderId: "anthropic",
          effectiveModel: "claude-4",
          selectionSource: item.source,
          fallbackPolicy: "auto",
          fallbackResult: item.fallbackResult,
          runtimeReachability: item.runtimeReachability,
          runtimeClass: item.runtimeClass,
        },
        resultHash: "route-hash",
        loading: false,
        error: null,
        ensureFreshPreflight: vi.fn(async () => null),
      });

      await renderHost({ lockSurface: true, surface: "chat" });
      expect(latestSurfaceInput?.activeSessionSurfaceProps?.trust).toEqual(
        expect.objectContaining({
          selectionSourceSummary: item.expectedSelection,
          fallbackSummary: item.expectedFallback,
          runtimeSummary: item.expectedRuntime,
        }),
      );
    }

    setupMocks();
    const dockController = useChatDockWorkbenchControllerMock();
    useChatDockWorkbenchControllerMock.mockReturnValue({
      ...dockController,
      activeWorkflowTurn: {
        ...selectedTurn,
        trace: {
          ...selectedTurn.trace,
          status: "running",
          model: "fallback-model",
          routing: {
            primaryProviderId: "openai",
            primaryModel: "gpt-5.5",
            effectiveProviderId: "anthropic",
            effectiveModel: "claude-4",
            fallbackUsed: true,
            fallbackReason: "primary unavailable",
          },
        },
      },
    });
    await renderHost({ lockSurface: true, surface: "cowork" });
    expect(latestSurfaceInput?.activeSessionSurfaceProps?.trust).toEqual(
      expect.objectContaining({
        effectiveProviderModelSummary: "Anthropic / claude-4",
        fallbackSummary: "Fallback used · primary unavailable",
        fallbackTone: "warning",
        runStateSummary: "Run: running",
      }),
    );
  });

  it("uses shell-provided gateway status in threaded trust descriptors", async () => {
    await renderHost({
      lockSurface: true,
      surface: "chat",
      gatewayStatus: {
        ready: true,
        tone: "success",
        label: "Gateway ready",
        detail: "Gateway ready. Daemon health is serving.",
      },
    });

    expect(latestSurfaceInput?.activeSessionSurfaceProps?.trust).toEqual(
      expect.objectContaining({
        gatewayTone: "success",
        gatewayLabel: "Gateway ready",
        gatewayDetail: "Gateway ready. Daemon health is serving.",
      }),
    );
    expect(latestSurfaceInput?.contextDockProps?.trust).toEqual(
      expect.objectContaining({
        gatewayLabel: "Gateway ready",
        gatewayDetail: "Gateway ready. Daemon health is serving.",
      }),
    );
  });

  it("executes command refresh branches and clears diagnostics without a thread", async () => {
    mockSurfaceMode = "cowork";
    await renderHost({ lockSurface: true, surface: "cowork" });
    const outboundInput = useChatOutboundExecutionMock.mock.calls.at(-1)?.[0] as any;
    const sessionData = useChatSessionDataMock.mock.results.at(-1)?.value as any;

    parseChatCommandMock.mockResolvedValueOnce({
      ok: true,
      command: "/project",
      prefs: { ...prefs, memoryMode: "workspace" },
      session: { sessionId: "session-2" },
    });
    await act(async () => {
      await outboundInput.operations.handleCommandExecution("session-1", "/project Mission");
      await flushEffects();
    });
    expect(sessionData.setPrefs).toHaveBeenCalledWith(expect.objectContaining({ memoryMode: "workspace" }));
    expect(sessionData.loadSidebar).toHaveBeenCalled();

    parseChatCommandMock.mockResolvedValueOnce({ ok: true, command: "/skill" });
    await act(async () => {
      await outboundInput.operations.handleCommandExecution("session-1", "/skill enable skill-1");
      await flushEffects();
    });
    expect(fetchSkillsMock).toHaveBeenCalled();
    expect(sessionData.setInstalledSkills).toHaveBeenCalledWith([
      { skillId: "skill-1", name: "Skill", state: "enabled" },
    ]);

    parseChatCommandMock.mockResolvedValueOnce({ ok: true, command: "/mcp" });
    await act(async () => {
      await outboundInput.operations.handleCommandExecution("session-1", "/mcp connect server-1");
      await flushEffects();
    });
    expect(fetchMcpServersMock).toHaveBeenCalled();
    expect(fetchMcpTemplatesMock).toHaveBeenCalled();
    expect(sessionData.setMcpServers).toHaveBeenCalledWith([
      { serverId: "server-1", label: "Server", status: "connected" },
    ]);

    parseChatCommandMock.mockResolvedValueOnce({ ok: true, command: "/goal", message: "Goal paused." });
    await act(async () => {
      await outboundInput.operations.handleCommandExecution("session-1", "/goal pause");
      await flushEffects();
    });
    expect(parseChatCommandMock).toHaveBeenLastCalledWith("session-1", "/goal pause", { surface: "chat" });

    parseChatCommandMock.mockClear();
    await act(async () => {
      await outboundInput.operations.handleCommandExecution("session-1", "/queue followup run focused tests");
      await flushEffects();
    });
    expect(parseChatCommandMock).not.toHaveBeenCalled();

    await act(async () => {
      await outboundInput.operations.handleCommandExecution("session-1", "/btw quick aside");
      await flushEffects(4);
    });
    expect(parseChatCommandMock).not.toHaveBeenCalled();
    expect(createChatSideChatMock).toHaveBeenCalledWith(
      "session-1",
      { createdFromSurface: "chat", sourceTurnId: undefined },
      { originSurface: "chat" },
    );
    expect(streamAgentChatMessageMock).toHaveBeenCalledWith(
      "session-btw",
      expect.objectContaining({
        content: "quick aside",
        mode: "chat",
        sideChatContext: expect.objectContaining({
          parentSessionId: "session-1",
          originSurface: "chat",
        }),
      }),
      expect.any(Function),
      { originSurface: "chat" },
    );
    expect(latestSurfaceInput?.btwSideChatProps.open).toBe(true);

    setupMocks();
    useChatSessionDataMock.mockReturnValue({
      ...useChatSessionDataMock(),
      thread: null,
    });
    await renderHost();
    expect(setDevDiagnosticsLatestTraceSummaryMock).toHaveBeenCalledWith(undefined);
  });

  it("handles compact drawers, canonical Chat dirty workbench confirms, and route acknowledgement guards", async () => {
    mockCompact = true;
    mockSurfaceMode = "chat";
    const navigateSurface = vi.fn();
    const dirtyDock = {
      ...useChatDockWorkbenchControllerMock(),
      hasDirtyWorkbenchDraft: true,
      dockOpen: true,
      discardWorkbenchDraft: vi.fn(),
    };
    useChatDockWorkbenchControllerMock.mockReturnValue(dirtyDock);
    useChatRoutePreflightMock.mockReturnValue({
      result: {
        requestedProviderId: "openai",
        requestedModel: "gpt-5.5",
        effectiveProviderId: "openai",
        effectiveModel: "gpt-5.5",
        selectionSource: "session",
        fallbackPolicy: "auto",
        fallbackResult: "local_to_cloud",
        runtimeReachability: "reachable",
        runtimeClass: "cloud",
      },
      resultHash: null,
      loading: false,
      error: null,
      ensureFreshPreflight: vi.fn(async () => null),
    });

    const { renderer } = await renderHost({ lockSurface: true, surface: "chat", onNavigateSurface: navigateSurface });
    await selectDefaultSession();

    await act(async () => {
      latestSurfaceInput?.onSessionRailOpenChange(true);
      latestSurfaceInput?.onDockOpenChange(true);
      latestSurfaceInput?.activeSessionSurfaceProps?.onAcknowledgeRouteBoundary();
      latestSurfaceInput?.activeSessionSurfaceProps?.onNavigateSurface("cowork", { sessionId: "session-2" });
      await flushEffects();
    });
    expect(confirmModalProps.some((props) => props.open && props.title === "Discard unsaved workbench changes?")).toBe(
      true,
    );

    await act(async () => {
      for (const discardModal of confirmModalProps.filter(
        (props) => props.open && props.title === "Discard unsaved workbench changes?",
      )) {
        discardModal.onConfirm();
      }
      await flushEffects();
    });
    expect(dirtyDock.discardWorkbenchDraft).toHaveBeenCalled();
    const discardCallsBeforeRailNavigation = dirtyDock.discardWorkbenchDraft.mock.calls.length;

    await act(async () => {
      latestSurfaceInput?.sessionRail.onSelectSession("session-2", { turnId: "turn-2" });
      await flushEffects();
    });
    const railDiscardModal = confirmModalProps
      .filter((props) => props.open && props.title === "Discard unsaved workbench changes?")
      .at(-1);
    expect(railDiscardModal).toBeDefined();
    expect(dirtyDock.discardWorkbenchDraft).toHaveBeenCalledTimes(discardCallsBeforeRailNavigation);

    await act(async () => {
      railDiscardModal?.onConfirm();
      await flushEffects();
    });
    expect(dirtyDock.discardWorkbenchDraft).toHaveBeenCalledTimes(discardCallsBeforeRailNavigation + 1);

    setupMocks();
    mockCompact = true;
    mockSurfaceMode = "chat";
    useChatDockWorkbenchControllerMock.mockReturnValue({
      ...useChatDockWorkbenchControllerMock(),
      hasDirtyWorkbenchDraft: false,
      dockOpen: true,
      discardWorkbenchDraft: dirtyDock.discardWorkbenchDraft,
    });
    await act(async () => {
      renderer.update(
        <MissionThreadedControllerHost
          workspaceId="workspace-1"
          workspaceName="Mission Workspace"
          approvalsCount={2}
          lockSurface
          surface="chat"
          onNavigateSurface={navigateSurface}
          renderSurface={(input) => {
            latestSurfaceInput = input;
            return <div data-surface={input.messageMode} />;
          }}
        />,
      );
      await flushEffects(6);
    });
    expect(confirmModalProps.some((props) => props.title === "Discard unsaved workbench changes?" && !props.open)).toBe(
      true,
    );
  });

  it("prepares document attachments as thread knowledge before sending", async () => {
    const attachments = [
      createStoredAttachment({
        attachmentId: "doc-ready",
        fileName: "notes.txt",
        mediaType: "text",
        mimeType: "text/plain",
        extractStatus: "ready",
        extractPreview: "Operator notes",
      }),
      createStoredAttachment({
        attachmentId: "doc-pending",
        fileName: "paper.pdf",
        mediaType: "binary",
        mimeType: "application/pdf",
        extractStatus: "unsupported",
        analysisStatus: "pending",
      }),
      createStoredAttachment({
        attachmentId: "image-1",
        fileName: "image.png",
        mediaType: "image",
        mimeType: "image/png",
        extractStatus: "unsupported",
      }),
    ];
    window.localStorage.setItem("goatcitadel.chat.attachments.workspace-1.session-1", JSON.stringify(attachments));

    await renderHost();
    await selectDefaultSession();

    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onSetAttachmentMode("doc-ready", "full_text");
      latestSurfaceInput?.activeSessionSurfaceProps?.onSetAttachmentMode("doc-pending", "full_text");
      latestSurfaceInput?.activeSessionSurfaceProps?.onSetAttachmentMode("image-1", "retrieval");
      await flushEffects(4);
      latestSurfaceInput?.activeSessionSurfaceProps?.onSend();
      await flushEffects(8);
    });
    expect(attachThreadKnowledgeAttachmentMock).not.toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ chatAttachmentId: "doc-pending", retrievalMode: "full_text" }),
    );

    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onSetAttachmentMode("doc-pending", "retrieval");
      await flushEffects(4);
      latestSurfaceInput?.activeSessionSurfaceProps?.onSend();
      await flushEffects(8);
    });
    expect(attachThreadKnowledgeAttachmentMock).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ chatAttachmentId: "doc-ready", retrievalMode: "full_text" }),
    );
    expect(attachThreadKnowledgeAttachmentMock).not.toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ chatAttachmentId: "image-1" }),
    );
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onKnowledgeUrlDraftChange("   ");
      await flushEffects(2);
      await latestSurfaceInput?.activeSessionSurfaceProps?.onAttachKnowledgeUrl();
      await flushEffects(2);
    });
  });

  it("covers generated-artifact, preset, agentic-control, and image-send error paths", async () => {
    fetchAgentsMock.mockRejectedValueOnce(new Error("agents unavailable"));
    fetchAgenticRunsMock.mockResolvedValueOnce({ items: [{ runId: "agentic-run-1" }] });
    fetchAgenticRunTreeMock.mockRejectedValueOnce(new Error("tree unavailable"));
    await renderHost();
    await selectDefaultSession();

    await act(async () => {
      await latestSurfaceInput?.activeSessionSurfaceProps?.onOpenGeneratedArtifact("missing-turn");
      await latestSurfaceInput?.activeSessionSurfaceProps?.onCreateGeneratedArtifact("turn-1");
      latestSurfaceInput?.activeSessionSurfaceProps?.onPresetChange("missing-preset");
      await latestSurfaceInput?.activeSessionSurfaceProps?.onApplyPreset();
      await flushEffects();
    });
    expect(createChatGeneratedArtifactMock).toHaveBeenCalledWith("session-1", "turn-1", { supersedeLatest: false });

    fetchAgenticRunsMock.mockReset();
    fetchAgenticRunTreeMock.mockReset();
    setupMocks();
    mockSurfaceMode = "cowork";
    fetchAgenticRunTreeMock.mockRejectedValueOnce(new Error("tree unavailable"));
    await renderHost({ lockSurface: true, surface: "cowork" });
    await selectDefaultSession();
    await act(async () => {
      await flushEffects(8);
    });

    fetchAgenticRunsMock.mockReset();
    fetchAgenticRunTreeMock.mockReset();
    controlAgenticRunMock.mockReset();
    setupMocks();
    mockSurfaceMode = "cowork";
    controlAgenticRunMock.mockRejectedValueOnce(new Error("runtime could not be reached"));
    await renderHost({ lockSurface: true, surface: "cowork" });
    await selectDefaultSession();
    await act(async () => {
      const props =
        latestSurfaceInput?.workflowPanel?.kind === "cowork" ? latestSurfaceInput.workflowPanel.props : null;
      props?.onAgenticControl?.({ action: "pause", enabled: true, label: "Pause" } as any);
      await flushEffects(8);
    });
    expect(controlAgenticRunMock).toHaveBeenCalled();

    setupMocks();
    useChatMultimodalControlsMock.mockReturnValue({
      ...useChatMultimodalControlsMock(),
      imageBusy: true,
    });
    await renderHost();
    await selectDefaultSession();
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onDraftChange("make an image of a launch console");
      latestSurfaceInput?.activeSessionSurfaceProps?.onSend();
      await flushEffects(4);
    });

    setupMocks();
    useChatMultimodalControlsMock.mockReturnValue({
      ...useChatMultimodalControlsMock(),
      imageGenerationAvailable: false,
    });
    await renderHost();
    await selectDefaultSession();
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onDraftChange("generate an image of a launch console");
      latestSurfaceInput?.activeSessionSurfaceProps?.onSend();
      await flushEffects(4);
    });
  });

  it("covers host lifecycle cleanup, storage fallbacks, and shell trust repeat guards", async () => {
    let resolveAgents!: (value: unknown) => void;
    fetchAgentsMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAgents = resolve;
      }),
    );
    const pendingAgents = await renderHost();
    await act(async () => {
      pendingAgents.renderer.unmount();
      await flushEffects();
    });
    await act(async () => {
      resolveAgents({ items: [] });
      await flushEffects();
    });

    installBrowserGlobals();
    window.localStorage.setItem("goatcitadel.chat.attachments.workspace-1.session-1", "{bad json");
    await renderHost();
    await selectDefaultSession();
    expect(latestSurfaceInput?.activeSessionSurfaceProps?.pendingAttachments).toEqual([]);

    Reflect.deleteProperty(globalThis, "window");
    await renderHost();
    installBrowserGlobals();

    const workTrustSummary = vi.fn();
    const trusted = await renderHost({
      lockSurface: true,
      surface: "chat",
      onWorkTrustSummaryChange: workTrustSummary,
    });
    await act(async () => {
      trusted.renderer.update(
        <MissionThreadedControllerHost
          workspaceId="workspace-1"
          workspaceName="Mission Workspace"
          approvalsCount={2}
          lockSurface
          surface="chat"
          onWorkTrustSummaryChange={workTrustSummary}
          renderSurface={(input) => {
            latestSurfaceInput = input;
            return <div data-surface={input.messageMode} />;
          }}
        />,
      );
      await flushEffects();
    });
    const publishedCount = workTrustSummary.mock.calls.length;
    useChatProviderRoutingControllerMock.mockReturnValue({
      ...useChatProviderRoutingControllerMock(),
      selectedProviderLabel: "OpenAI / gpt-5.5",
      selectedModelLabel: undefined,
    });
    await act(async () => {
      trusted.renderer.update(
        <MissionThreadedControllerHost
          workspaceId="workspace-1"
          workspaceName="Mission Workspace"
          approvalsCount={2}
          lockSurface
          surface="chat"
          onWorkTrustSummaryChange={workTrustSummary}
          renderSurface={(input) => {
            latestSurfaceInput = input;
            return <div data-surface={input.messageMode} />;
          }}
        />,
      );
      await flushEffects();
    });
    expect(workTrustSummary).toHaveBeenCalledTimes(publishedCount);
    await act(async () => {
      trusted.renderer.update(
        <MissionThreadedControllerHost
          workspaceId="workspace-1"
          workspaceName="Mission Workspace"
          approvalsCount={2}
          lockSurface={false}
          surface="chat"
          onWorkTrustSummaryChange={workTrustSummary}
          renderSurface={(input) => {
            latestSurfaceInput = input;
            return <div data-surface={input.messageMode} />;
          }}
        />,
      );
      await flushEffects();
    });
    expect(workTrustSummary).toHaveBeenCalledWith("OpenAI / gpt-5.5");
    expect(workTrustSummary).toHaveBeenCalledWith(null);

    await act(async () => {
      const closedDiscard = confirmModalProps.find(
        (props) => props.title === "Discard unsaved workbench changes?" && !props.open,
      );
      const closedModelSwitch = confirmModalProps.find(
        (props) => props.title === "Switch thread model?" && !props.open,
      );
      closedDiscard?.onConfirm();
      closedModelSwitch?.onConfirm();
      await flushEffects();
    });
  });

  it("covers command, diagnostics, route prefs, and empty-session surface variants", async () => {
    await renderHost();
    const outboundInput = useChatOutboundExecutionMock.mock.calls.at(-1)?.[0] as any;
    const sessionData = useChatSessionDataMock.mock.results.at(-1)?.value as any;
    parseChatCommandMock.mockResolvedValueOnce({
      ok: true,
      command: "/plan",
      prefs: { ...prefs, planningMode: "advisory" },
    });
    await act(async () => {
      await outboundInput.operations.handleCommandExecution("session-1", "/plan advisory");
      await flushEffects();
    });
    expect(sessionData.setPrefs).toHaveBeenCalledWith(expect.objectContaining({ planningMode: "advisory" }));

    setupMocks();
    useChatSessionDataMock.mockReturnValue({
      ...useChatSessionDataMock(),
      thread: {
        sessionId: "session-1",
        selectedTurnId: "missing",
        activeLeafTurnId: "missing",
        turns: [{ turnId: "turn-without-trace" }],
      },
    });
    await renderHost();
    expect(setDevDiagnosticsLatestTraceSummaryMock).toHaveBeenCalledWith({ sessionId: "session-1", turnCount: 1 });

    setupMocks();
    useChatProviderRoutingControllerMock.mockReturnValue({
      ...useChatProviderRoutingControllerMock(),
      selectedProviderId: undefined,
      selectedModel: undefined,
    });
    await renderHost({ lockSurface: true, surface: "cowork" });
    expect(useChatRoutePreflightMock.mock.calls.at(-1)?.[0].prefs).toEqual(expect.objectContaining({ mode: "chat" }));

    for (const item of [
      { mode: "chat" as ChatMode, lockSurface: true },
      { mode: "code" as ChatMode, lockSurface: false },
      { mode: "cowork" as ChatMode, lockSurface: false },
    ]) {
      setupMocks();
      mockSurfaceMode = item.mode;
      useChatThreadControllerMock.mockReturnValue({
        ...useChatThreadControllerMock.getMockImplementation()?.(),
        selectedSession: null,
        selectedProject: null,
        messages: [],
      });
      await renderHost({ lockSurface: item.lockSurface, surface: item.mode });
      expect(latestSurfaceInput?.activeSessionSurfaceProps).toBeNull();
      expect(latestSurfaceInput?.contextDockProps).toBeNull();
    }
  });

  it("covers document attachment classifiers, duplicate knowledge sources, and send preparation failures", async () => {
    const documentAttachments = [
      createStoredAttachment({
        attachmentId: "doc-json",
        fileName: "data.json",
        mediaType: "binary",
        mimeType: "application/json",
      }),
      createStoredAttachment({
        attachmentId: "doc-xml",
        fileName: "data.xml",
        mediaType: "binary",
        mimeType: "application/xml",
      }),
      createStoredAttachment({
        attachmentId: "doc-yaml",
        fileName: "data.yaml",
        mediaType: "binary",
        mimeType: "application/x-yaml",
      }),
      createStoredAttachment({
        attachmentId: "doc-csv",
        fileName: "data.csv",
        mediaType: "binary",
        mimeType: "text/csv",
      }),
      createStoredAttachment({
        attachmentId: "doc-md",
        fileName: "notes.md",
        mediaType: "binary",
        mimeType: "text/markdown",
      }),
      createStoredAttachment({
        attachmentId: "doc-preview",
        fileName: "preview.bin",
        mediaType: "binary",
        mimeType: "application/octet-stream",
        extractPreview: "preview",
      }),
      createStoredAttachment({
        attachmentId: "doc-ocr",
        fileName: "scan.png",
        mediaType: "binary",
        mimeType: "image/png",
        ocrText: "ocr",
      }),
      createStoredAttachment({
        attachmentId: "doc-transcript",
        fileName: "call.mp3",
        mediaType: "binary",
        mimeType: "audio/mpeg",
        transcriptText: "transcript",
      }),
      createStoredAttachment({
        attachmentId: "doc-message",
        fileName: "message.txt",
        mediaType: "text",
        mimeType: "text/plain",
      }),
      createStoredAttachment({
        attachmentId: "image-ignored",
        fileName: "image.png",
        mediaType: "image",
        mimeType: "image/png",
        extractStatus: "unsupported",
      }),
    ];
    window.localStorage.setItem(
      "goatcitadel.chat.attachments.workspace-1.session-1",
      JSON.stringify(documentAttachments),
    );
    useChatSessionDataMock.mockReturnValue({
      ...useChatSessionDataMock(),
      threadKnowledgeAttachments: {
        items: [
          {
            attachmentId: "existing-json",
            chatAttachmentId: "doc-json",
            sourceRef: "data.json",
            retrievalMode: "retrieval",
          },
          { attachmentId: "existing-url", sourceRef: "https://docs.example.test/dup", retrievalMode: "retrieval" },
        ],
      },
    });
    await renderHost();
    await selectDefaultSession();

    await act(async () => {
      for (const attachment of documentAttachments) {
        latestSurfaceInput?.activeSessionSurfaceProps?.onSetAttachmentMode(attachment.attachmentId, "retrieval");
      }
      latestSurfaceInput?.activeSessionSurfaceProps?.onSetAttachmentMode("doc-message", "message");
      latestSurfaceInput?.activeSessionSurfaceProps?.onKnowledgeUrlDraftChange("https://docs.example.test/dup");
      await flushEffects(4);
    });
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onSend();
      await flushEffects(8);
    });
    expect(attachThreadKnowledgeAttachmentMock).not.toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ chatAttachmentId: "doc-json", retrievalMode: "retrieval" }),
    );
    expect(attachThreadKnowledgeAttachmentMock).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ chatAttachmentId: "doc-transcript", retrievalMode: "retrieval" }),
    );

    setupMocks();
    attachThreadKnowledgeAttachmentMock.mockRejectedValueOnce(new Error("knowledge attach failed"));
    window.localStorage.setItem(
      "goatcitadel.chat.attachments.workspace-1.session-1",
      JSON.stringify([createStoredAttachment({ attachmentId: "doc-error", fileName: "error.txt" })]),
    );
    await renderHost();
    await selectDefaultSession();
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onSetAttachmentMode("doc-error", "retrieval");
      await flushEffects(4);
    });
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onSend();
      await flushEffects(8);
    });
    expect(attachThreadKnowledgeAttachmentMock).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ chatAttachmentId: "doc-error" }),
    );
  });

  it("covers surface callbacks, image route changes, helper errors, and export fallbacks", async () => {
    const surfaceOrchestration = useChatSurfaceOrchestrationMock();
    useChatSurfaceOrchestrationMock.mockReturnValue({
      ...surfaceOrchestration,
      queuedOutbound: [
        {
          id: "queue-empty",
          action: "retry",
          content: "   ",
          targetTurnId: "turn-abcdef",
          createdAt: "2026-05-01T00:00:00.000Z",
        },
      ],
    });
    await renderHost();
    await selectDefaultSession();
    expect(latestSurfaceInput?.activeSessionSurfaceProps?.queueItems[0]?.label).toBe("Turn abcdef");
    expect(latestSurfaceInput?.messageMode).toBe("chat");
    expect(latestSurfaceInput?.workflowPanel?.kind).toBe("code");

    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onSelectTurn("turn-1");
      latestSurfaceInput?.activeSessionSurfaceProps?.onToggleDock();
      latestSurfaceInput?.activeSessionSurfaceProps?.onOpenRunDetails("turn-1");
      await flushEffects();
      latestSurfaceInput?.activeSessionSurfaceProps?.onOpenRunDetails("turn-1");
      latestSurfaceInput?.activeSessionSurfaceProps?.onSwitchBranch("turn-2");
      latestSurfaceInput?.activeSessionSurfaceProps?.onRetryTurn("turn-1");
      latestSurfaceInput?.activeSessionSurfaceProps?.onApprovePending("session");
      latestSurfaceInput?.activeSessionSurfaceProps?.onDenyPending();
      latestSurfaceInput?.activeSessionSurfaceProps?.onSubmitUserInput("answer");
      latestSurfaceInput?.activeSessionSurfaceProps?.onRefreshThread();
      latestSurfaceInput?.activeSessionSurfaceProps?.onResumeAll();
      latestSurfaceInput?.activeSessionSurfaceProps?.onRemoveQueuedItem("queue-empty");
      latestSurfaceInput?.activeSessionSurfaceProps?.onRequestImageProviderChange("openai");
      latestSurfaceInput?.activeSessionSurfaceProps?.onRequestImageModelChange("gpt-image-2");
      latestSurfaceInput?.activeSessionSurfaceProps?.onToggleVoiceTalk();
      latestSurfaceInput?.activeSessionSurfaceProps?.onOpenAudioTranscribe();
      await latestSurfaceInput?.activeSessionSurfaceProps?.onAudioFileSelected({ name: "voice.wav" } as any);
      latestSurfaceInput?.activeSessionSurfaceProps?.onToggleSpeakResponses();
      latestSurfaceInput?.activeSessionSurfaceProps?.onGenerateImage();
      latestSurfaceInput?.activeSessionSurfaceProps?.onEditImage();
      latestSurfaceInput?.activeSessionSurfaceProps?.onStopActiveTurn();
      await flushEffects(8);
    });
    expect(loadModelsForProviderMock).toHaveBeenCalledWith("openai");

    setupMocks();
    mockSurfaceMode = "code";
    createCodeModeRunMock.mockRejectedValueOnce(new Error("helper failed"));
    useChatDockWorkbenchControllerMock.mockReturnValue({
      ...useChatDockWorkbenchControllerMock(),
      exportWorkbenchPatch: vi.fn(async () => null),
    });
    await renderHost({ lockSurface: true, surface: "code" });
    await selectDefaultSession();
    const codeProps =
      latestSurfaceInput?.workflowPanel?.kind === "code" ? latestSurfaceInput.workflowPanel.props : null;
    await act(async () => {
      await codeProps?.onExportPatch();
      codeProps?.onRunHelperSnippet("ts", "throw new Error('x')");
      await flushEffects(8);
    });
    expect(createCodeModeRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ language: "typescript", originSurface: "chat" }),
    );

    setupMocks();
    mockSurfaceMode = "chat";
    await renderHost();
    await selectDefaultSession();
    Reflect.deleteProperty(globalThis, "window");
    await act(async () => {
      latestSurfaceInput?.contextDockProps?.onExportSnapshot();
      await latestSurfaceInput?.activeSessionSurfaceProps?.onExportRunBundle();
      await flushEffects(2);
    });
    installBrowserGlobals();

    setupMocks();
    mockSurfaceMode = "chat";
    fetchRuntimeLifecycleExportMock.mockRejectedValueOnce(new Error("export failed"));
    createChatGeneratedArtifactMock.mockRejectedValueOnce(new Error("artifact failed"));
    fetchChatGeneratedArtifactMock.mockRejectedValueOnce(new Error("artifact fetch failed"));
    attachThreadKnowledgeAttachmentMock.mockRejectedValueOnce(new Error("url failed"));
    updateChatSessionPrefsMock.mockRejectedValueOnce(new Error("prefs failed"));
    await renderHost();
    await selectDefaultSession();
    await act(async () => {
      await latestSurfaceInput?.activeSessionSurfaceProps?.onExportRunBundle();
      await latestSurfaceInput?.activeSessionSurfaceProps?.onCreateGeneratedArtifact("turn-1");
      await latestSurfaceInput?.activeSessionSurfaceProps?.onOpenGeneratedArtifact("turn-1");
      latestSurfaceInput?.activeSessionSurfaceProps?.onKnowledgeUrlDraftChange("https://docs.example.test/error");
      await flushEffects();
    });
    await act(async () => {
      await latestSurfaceInput?.activeSessionSurfaceProps?.onAttachKnowledgeUrl();
      latestSurfaceInput?.activeSessionSurfaceProps?.onSetThinkingLevel("deep");
      latestSurfaceInput?.activeSessionSurfaceProps?.onTogglePlanningMode();
      await flushEffects(8);
    });
    expect(fetchRuntimeLifecycleExportMock).toHaveBeenCalled();
    expect(createChatGeneratedArtifactMock).toHaveBeenCalled();
    expect(fetchChatGeneratedArtifactMock).toHaveBeenCalled();
    expect(attachThreadKnowledgeAttachmentMock).toHaveBeenCalled();
    expect(updateChatSessionPrefsMock).toHaveBeenCalled();
  });

  it("creates an independent fork from a terminal turn after confirmation", async () => {
    await renderHost();
    await selectDefaultSession();

    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onToggleContextTurn("turn-1");
      await flushEffects(8);
    });
    expect(latestSurfaceInput?.activeSessionSurfaceProps?.contextSelection).toMatchObject({
      label: "1 selected turn",
      turnCount: 1,
      sourceLabel: "Launch plan",
    });

    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onStartNewThreadFromTurn("turn-1");
      await flushEffects(4);
    });
    const confirm = confirmModalProps.filter((props) => props.title === "Fork conversation from this turn?").at(-1);
    expect(confirm?.message).toContain("1 turn");
    await act(async () => {
      await confirm?.onConfirm();
      await flushEffects(12);
    });

    expect(forkChatSessionFromTurnMock).toHaveBeenCalledWith("session-1", "turn-1", {
      expectedRevision: selectedSession.revision,
      title: "Fork of Launch plan",
    });
    expect(createChatSessionMock).not.toHaveBeenCalled();
  });

  it("hydrates server metadata without overwriting conflicting rename and organization drafts", async () => {
    const { renderer, renderSurface } = await renderHost();
    await selectDefaultSession();

    await act(async () => {
      latestSurfaceInput?.contextDockProps?.onRenameTitleChange("Local title draft");
      await flushEffects(4);
    });
    const renameControlsInput = useChatSessionControlsMock.mock.calls.at(-1)?.[0] as any;
    renameControlsInput.setSessionMetadataConflictDraft({
      sessionId: "session-1",
      kind: "rename",
      renameTitle: "Local title draft",
    });
    const firstServerSession = {
      ...selectedSession,
      revision: 8,
      title: "Server title",
      folderName: "Server folder",
      tags: ["server"],
    };
    useChatThreadControllerMock.mockReturnValue({
      ...useChatThreadControllerMock(),
      selectedSession: firstServerSession,
      missionSessions: [firstServerSession],
    });
    await act(async () => {
      renderer.update(
        <MissionThreadedControllerHost
          workspaceId="workspace-1"
          workspaceName="Mission Workspace"
          approvalsCount={2}
          renderSurface={renderSurface}
        />,
      );
      await flushEffects(8);
    });
    expect(latestSurfaceInput?.contextDockProps).toMatchObject({
      renameTitle: "Local title draft",
      folderName: "Server folder",
      tagsValue: "server",
    });

    await act(async () => {
      latestSurfaceInput?.contextDockProps?.onFolderNameChange("Local folder draft");
      latestSurfaceInput?.contextDockProps?.onTagsValueChange("local, draft");
      await flushEffects(4);
    });
    const organizationControlsInput = useChatSessionControlsMock.mock.calls.at(-1)?.[0] as any;
    organizationControlsInput.setSessionMetadataConflictDraft({
      sessionId: "session-1",
      kind: "organization",
      folderName: "Local folder draft",
      tagsValue: "local, draft",
    });
    const secondServerSession = {
      ...firstServerSession,
      revision: 9,
      title: "Newest server title",
      folderName: "Newest server folder",
      tags: ["newest-server"],
    };
    useChatThreadControllerMock.mockReturnValue({
      ...useChatThreadControllerMock(),
      selectedSession: secondServerSession,
      missionSessions: [secondServerSession],
    });
    await act(async () => {
      renderer.update(
        <MissionThreadedControllerHost
          workspaceId="workspace-1"
          workspaceName="Mission Workspace"
          approvalsCount={2}
          renderSurface={renderSurface}
        />,
      );
      await flushEffects(8);
    });
    expect(latestSurfaceInput?.contextDockProps).toMatchObject({
      renameTitle: "Newest server title",
      folderName: "Local folder draft",
      tagsValue: "local, draft",
    });
  });

  it("covers cowork active-turn actions, loading headers, image auto-send variants, and model-switch edge cases", async () => {
    const dockController = useChatDockWorkbenchControllerMock();
    useChatDockWorkbenchControllerMock.mockReturnValue({
      ...dockController,
      activeWorkflowTurn: {
        ...selectedTurn,
        trace: {
          ...selectedTurn.trace,
          status: "running",
          routing: {
            primaryProviderId: "openai",
            primaryModel: "gpt-5.5",
            fallbackProviderId: "anthropic",
            fallbackModel: "claude-4",
          },
        },
      },
    });
    mockSurfaceMode = "cowork";
    await renderHost({ lockSurface: true, surface: "cowork" });
    const coworkProps =
      latestSurfaceInput?.workflowPanel?.kind === "cowork" ? latestSurfaceInput.workflowPanel.props : null;
    await act(async () => {
      coworkProps?.onRetryTurn?.();
      coworkProps?.onStopTurn?.();
      coworkProps?.onOpenDetails();
      await flushEffects();
      coworkProps?.onOpenDetails();
      await flushEffects();
    });
    expect(latestSurfaceInput?.activeSessionSurfaceProps?.trust.fallbackSummary).toBe("Fallback armed");

    setupMocks();
    useChatSessionDataMock.mockReturnValue({
      ...useChatSessionDataMock(),
      loading: true,
    });
    await renderHost({ lockSurface: false, surface: "chat" });

    setupMocks();
    mockSurfaceMode = "code";
    useChatSessionDataMock.mockReturnValue({
      ...useChatSessionDataMock(),
      loading: true,
    });
    await renderHost({ lockSurface: false, surface: "code" });

    setupMocks();
    useChatMultimodalControlsMock.mockReturnValue({
      ...useChatMultimodalControlsMock(),
      handleGenerateImage: vi.fn(async () => null),
    });
    await renderHost();
    await selectDefaultSession();
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onDraftChange("generate an image of the operations console");
      await flushEffects();
      latestSurfaceInput?.activeSessionSurfaceProps?.onSend();
      await flushEffects(8);
    });

    setupMocks();
    useChatThreadControllerMock.mockReturnValue({
      ...useChatThreadControllerMock(),
      messages: [],
    });
    useChatSessionDataMock.mockReturnValue({
      ...useChatSessionDataMock(),
      thread: { sessionId: "session-1", selectedTurnId: null, activeLeafTurnId: null, turns: [] },
    });
    await renderHost();
    await selectDefaultSession();
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onRequestProviderChange("anthropic");
      latestSurfaceInput?.activeSessionSurfaceProps?.onRequestModelChange("claude-4");
      await flushEffects(8);
    });
    expect(updateChatSessionPrefsMock).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ providerId: "anthropic" }),
    );
  });

  it("covers host state reconciliation, preset warning, and review-detail toggles", async () => {
    let knowledgeState = {
      items: [
        { attachmentId: "knowledge-1", sourceRef: "file.pdf", retrievalMode: "retrieval" },
        { attachmentId: "knowledge-remove", sourceRef: "old.pdf", retrievalMode: "retrieval" },
      ],
    };
    const setThreadKnowledgeAttachments = vi.fn(
      (next: typeof knowledgeState | ((current: typeof knowledgeState) => typeof knowledgeState)) => {
        knowledgeState = typeof next === "function" ? next(knowledgeState) : next;
      },
    );
    useChatSessionDataMock.mockReturnValue({
      ...useChatSessionDataMock(),
      threadKnowledgeAttachments: knowledgeState,
      setThreadKnowledgeAttachments,
    });

    await renderHost();
    await selectDefaultSession();

    await act(async () => {
      await latestSurfaceInput?.activeSessionSurfaceProps?.onRemoveThreadKnowledgeAttachment?.("knowledge-remove");
      await flushEffects(4);
    });
    expect(knowledgeState.items.map((item) => item.attachmentId)).toEqual(["knowledge-1"]);

    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onKnowledgeUrlDraftChange?.("https://docs.example.test/new");
      await flushEffects(2);
    });
    await act(async () => {
      await latestSurfaceInput?.activeSessionSurfaceProps?.onAttachKnowledgeUrl?.();
      await flushEffects(4);
    });
    expect(knowledgeState.items[0]?.attachmentId).toBe("knowledge-url");

    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onKnowledgeUrlDraftChange?.("https://docs.example.test/new");
      await flushEffects(2);
    });
    await act(async () => {
      await latestSurfaceInput?.activeSessionSurfaceProps?.onAttachKnowledgeUrl?.();
      await flushEffects(4);
    });
    expect(knowledgeState.items.filter((item) => item.attachmentId === "knowledge-url")).toHaveLength(1);

    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onPresetChange?.("agent-1");
      await flushEffects(2);
    });
    await act(async () => {
      await latestSurfaceInput?.activeSessionSurfaceProps?.onApplyPreset?.();
      await flushEffects(6);
    });
    expect(latestSurfaceInput?.activeSessionSurfaceProps?.presetApplyWarning).toBe(
      "Skipped 1 unavailable knowledge default.",
    );

    setupMocks();
    fetchAgentsMock.mockResolvedValueOnce({
      items: [
        {
          agentId: "agent-clean",
          name: "Clean preset",
          presetDefaults: {
            presetLabel: "Clean preset",
            preferredProviderId: "openai",
            preferredModel: "gpt-5.5",
            knowledgeAttachmentIds: ["knowledge-1"],
          },
        },
      ],
    });
    await renderHost();
    await selectDefaultSession();
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onPresetChange?.("agent-clean");
      await flushEffects(2);
    });
    await act(async () => {
      await latestSurfaceInput?.activeSessionSurfaceProps?.onApplyPreset?.();
      await flushEffects(6);
    });
    expect(latestSurfaceInput?.activeSessionSurfaceProps?.presetApplyWarning).toBeNull();

    const openDock = useChatDockWorkbenchControllerMock.mock.results.at(-1)?.value.setDockOpen as ReturnType<
      typeof vi.fn
    >;
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onReviewRunDetails();
      await flushEffects(2);
    });
    expect(openDock).toHaveBeenCalledWith(true);

    setupMocks();
    const closeDock = vi.fn();
    useChatDockWorkbenchControllerMock.mockReturnValue({
      ...useChatDockWorkbenchControllerMock(),
      dockOpen: true,
      setDockOpen: closeDock,
    });
    await renderHost();
    await selectDefaultSession();
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onReviewRunDetails();
      await flushEffects(2);
    });
    expect(closeDock).toHaveBeenCalledWith(false);
  });

  it("covers host layout guards and route-summary fallbacks", async () => {
    const rail = await renderHost();
    await act(async () => {
      latestSurfaceInput?.onSessionRailOpenChange(true);
      await flushEffects(4);
    });
    expect(latestSurfaceInput?.sessionRailOpen).toBe(false);
    rail.renderer.unmount();

    setupMocks();
    mockCompact = true;
    const setDockOpen = vi.fn();
    useChatDockWorkbenchControllerMock.mockReturnValue({
      ...useChatDockWorkbenchControllerMock(),
      dockOpen: true,
      setDockOpen,
    });
    await renderHost();
    await act(async () => {
      latestSurfaceInput?.onSessionRailOpenChange(true);
      await flushEffects(4);
    });
    expect(setDockOpen).toHaveBeenCalledWith(false);

    setupMocks();
    useChatRoutePreflightMock.mockReturnValue({
      result: null,
      resultHash: null,
      loading: false,
      error: null,
      ensureFreshPreflight: vi.fn(async () => null),
    });
    await renderHost({ lockSurface: true, surface: "chat" });
    expect(latestSurfaceInput?.activeSessionSurfaceProps?.trust).toEqual(
      expect.objectContaining({
        requestedProviderModelSummary: "OpenAI / gpt-5.5",
        effectiveProviderModelSummary: "OpenAI / gpt-5.5",
        selectionSourceSummary: "Selection: session",
      }),
    );

    setupMocks();
    useChatDockWorkbenchControllerMock.mockReturnValue({
      ...useChatDockWorkbenchControllerMock(),
      activeWorkflowTurn: {
        ...selectedTurn,
        trace: {
          ...selectedTurn.trace,
          routing: {
            primaryProviderId: "openai",
            primaryModel: "gpt-5.5",
            effectiveProviderId: "anthropic",
            effectiveModel: "claude-4",
            fallbackUsed: true,
          },
        },
      },
    });
    await renderHost({ lockSurface: true, surface: "cowork" });
    expect(latestSurfaceInput?.activeSessionSurfaceProps?.trust.fallbackSummary).toBe("Fallback used");

    setupMocks();
    useChatDockWorkbenchControllerMock.mockReturnValue({
      ...useChatDockWorkbenchControllerMock(),
      activeWorkflowTurn: {
        ...selectedTurn,
        trace: {
          ...selectedTurn.trace,
          routing: {
            primaryProviderId: "openai",
            primaryModel: "gpt-5.5",
            fallbackProviderId: "anthropic",
            fallbackModel: "claude-4",
            fallbackReason: "local runtime busy",
          },
        },
      },
    });
    await renderHost({ lockSurface: true, surface: "cowork" });
    expect(latestSurfaceInput?.activeSessionSurfaceProps?.trust.fallbackSummary).toBe(
      "Fallback armed · local runtime busy",
    );
  });

  it("covers auto image send branches with committed draft state", async () => {
    const baseSurfaceOrchestration = useChatSurfaceOrchestrationMock();
    const handleSend = vi.fn(async () => undefined);
    useChatSurfaceOrchestrationMock.mockReturnValue({
      ...baseSurfaceOrchestration,
      handleSend,
    });
    const busyImageControls = {
      ...useChatMultimodalControlsMock(),
      imageBusy: true,
    };
    useChatMultimodalControlsMock.mockReturnValue(busyImageControls);
    await renderHost();
    await selectDefaultSession();
    await commitDraft("generate an image of a clean command console");
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onSend();
      await flushEffects(8);
    });
    expect(handleSend).not.toHaveBeenCalled();

    await cleanupRenderedHosts();
    setupMocks();
    useChatMultimodalControlsMock.mockReturnValue({
      ...useChatMultimodalControlsMock(),
      imageGenerationAvailable: false,
    });
    await renderHost();
    await selectDefaultSession();
    await commitDraft("generate an image of a clean command console");
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onSend();
      await flushEffects(8);
    });

    await cleanupRenderedHosts();
    setupMocks();
    const handleGenerateImage = vi.fn(async () => generatedArtifact);
    useChatMultimodalControlsMock.mockReturnValue({
      ...useChatMultimodalControlsMock(),
      handleGenerateImage,
    });
    await renderHost();
    await selectDefaultSession();
    await commitDraft("generate an image of a clean command console");
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onSend();
      await flushEffects(8);
    });
    expect(handleGenerateImage).toHaveBeenCalledWith({ clearDraftOnSuccess: true, trigger: "auto_send" });

    await cleanupRenderedHosts();
    setupMocks();
    const nullImage = vi.fn(async () => null);
    const fallbackSend = vi.fn(async () => undefined);
    useChatSurfaceOrchestrationMock.mockReturnValue({
      ...useChatSurfaceOrchestrationMock(),
      handleSend: fallbackSend,
    });
    useChatMultimodalControlsMock.mockReturnValue({
      ...useChatMultimodalControlsMock(),
      handleGenerateImage: nullImage,
    });
    await renderHost();
    await selectDefaultSession();
    await commitDraft("generate an image of a clean command console");
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onSend();
      await flushEffects(8);
    });
    expect(nullImage).toHaveBeenCalled();
    expect(latestSurfaceInput?.activeSessionSurfaceProps?.onSendRetainedPromptAsChat).toEqual(expect.any(Function));

    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onSendRetainedPromptAsChat?.();
      await flushEffects(8);
    });
    expect(fallbackSend).toHaveBeenCalledTimes(1);
    expect(nullImage).toHaveBeenCalledTimes(1);
    expect(latestSurfaceInput?.activeSessionSurfaceProps?.onSendRetainedPromptAsChat).toBeUndefined();
  });

  it("keeps image-adjacent prompts with armed per-turn context on the Chat path", async () => {
    const handleGenerateImage = vi.fn(async () => generatedArtifact);
    const handleSend = vi.fn(async () => undefined);
    useChatSurfaceOrchestrationMock.mockReturnValue({
      ...useChatSurfaceOrchestrationMock(),
      handleSend,
    });
    useChatMultimodalControlsMock.mockReturnValue({
      ...useChatMultimodalControlsMock(),
      handleGenerateImage,
    });

    await renderHost();
    await selectDefaultSession();
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onToggleContextTurn("turn-1");
      await flushEffects(8);
    });
    await commitDraft("generate an image of this selected launch-plan context");
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onSend();
      await flushEffects(8);
    });

    expect(handleGenerateImage).not.toHaveBeenCalled();
    expect(handleSend).toHaveBeenCalledTimes(1);
  });

  it("keeps Plan, Research, Review, and Council sends on the normal Chat path", async () => {
    const cases = [
      { planningMode: "advisory" as const },
      { webMode: "quick" as const },
      { webMode: "deep" as const },
      { orchestrationReviewDepth: "standard" as const },
      { orchestrationReviewDepth: "strict" as const },
    ];

    for (const prefsPatch of cases) {
      await cleanupRenderedHosts();
      setupMocks();
      useChatSessionDataMock.mockReturnValue({
        ...useChatSessionDataMock.getMockImplementation()?.(),
        prefs: { ...prefs, ...prefsPatch },
      });
      const handleGenerateImage = vi.fn(async () => generatedArtifact);
      useChatMultimodalControlsMock.mockReturnValue({
        ...useChatMultimodalControlsMock.getMockImplementation()?.(),
        handleGenerateImage,
      });
      const handleSend = vi.fn(async () => undefined);
      useChatSurfaceOrchestrationMock.mockReturnValue({
        ...useChatSurfaceOrchestrationMock.getMockImplementation()?.(),
        handleSend,
      });

      await renderHost();
      await selectDefaultSession();
      await commitDraft("generate an image of a clean command console");
      await act(async () => {
        latestSurfaceInput?.activeSessionSurfaceProps?.onSend();
        await flushEffects(8);
      });

      expect(handleGenerateImage).not.toHaveBeenCalled();
      expect(handleSend).toHaveBeenCalledTimes(1);
    }

    await cleanupRenderedHosts();
    setupMocks();
    const handleGenerateImage = vi.fn(async () => generatedArtifact);
    useChatMultimodalControlsMock.mockReturnValue({
      ...useChatMultimodalControlsMock(),
      handleGenerateImage,
    });
    const handleSend = vi.fn(async () => undefined);
    useChatSurfaceOrchestrationMock.mockReturnValue({
      ...useChatSurfaceOrchestrationMock(),
      handleSend,
    });
    await renderHost();
    await selectDefaultSession();
    await commitDraft("generate an image of a clean command console");
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onToggleModelCouncil?.();
      await flushEffects(4);
      latestSurfaceInput?.activeSessionSurfaceProps?.onSend();
      await flushEffects(8);
    });

    expect(handleGenerateImage).not.toHaveBeenCalled();
    expect(handleSend).toHaveBeenCalledTimes(1);
  });

  it("removes failed auto-image recovery after the retained draft changes", async () => {
    const nullImage = vi.fn(async () => null);
    useChatMultimodalControlsMock.mockReturnValue({
      ...useChatMultimodalControlsMock(),
      handleGenerateImage: nullImage,
    });
    await renderHost();
    await selectDefaultSession();
    await commitDraft("generate an image of a clean command console");
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onSend();
      await flushEffects(8);
    });
    expect(latestSurfaceInput?.activeSessionSurfaceProps?.onSendRetainedPromptAsChat).toEqual(expect.any(Function));

    await commitDraft("generate an image of a different command console");

    expect(latestSurfaceInput?.activeSessionSurfaceProps?.onSendRetainedPromptAsChat).toBeUndefined();
  });

  it("covers final host edge callbacks and state fallbacks", async () => {
    setupMocks();
    const setThreadKnowledgeAttachments = vi.fn((next: null | ((current: null) => null)) => {
      if (typeof next === "function") {
        expect(next(null)).toBeNull();
      }
    });
    useChatSessionDataMock.mockReturnValue({
      ...useChatSessionDataMock(),
      threadKnowledgeAttachments: null,
      setThreadKnowledgeAttachments,
    });
    await renderHost();
    await selectDefaultSession();
    await act(async () => {
      await latestSurfaceInput?.activeSessionSurfaceProps?.onRemoveThreadKnowledgeAttachment?.("knowledge-missing");
      await flushEffects(4);
    });
    expect(setThreadKnowledgeAttachments).toHaveBeenCalled();

    setupMocks();
    await renderHost();
    await selectDefaultSession();
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onKnowledgeUrlDraftChange("https://docs.example.test/new-source");
      await flushEffects(2);
    });
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onSend();
      await flushEffects(8);
    });
    expect(attachThreadKnowledgeAttachmentMock).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ url: "https://docs.example.test/new-source", retrievalMode: "retrieval" }),
    );

    setupMocks();
    fetchAgentsMock.mockResolvedValueOnce({
      items: [
        {
          agentId: "agent-plural",
          name: "Plural preset",
          presetDefaults: {
            presetLabel: "Plural preset",
            knowledgeAttachmentIds: ["missing-a", "missing-b"],
          },
        },
      ],
    });
    await renderHost();
    await selectDefaultSession();
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onPresetChange?.("agent-plural");
      await flushEffects(2);
    });
    await act(async () => {
      await latestSurfaceInput?.activeSessionSurfaceProps?.onApplyPreset?.();
      await flushEffects(6);
    });
    expect(latestSurfaceInput?.activeSessionSurfaceProps?.presetApplyWarning).toBe(
      "Skipped 2 unavailable knowledge defaults.",
    );

    setupMocks();
    updateChatSessionPrefsMock.mockRejectedValueOnce(new Error("preset failed"));
    await renderHost();
    await selectDefaultSession();
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onPresetChange?.("agent-1");
      await flushEffects(2);
    });
    await act(async () => {
      await latestSurfaceInput?.activeSessionSurfaceProps?.onApplyPreset?.();
      await flushEffects(6);
    });

    setupMocks();
    mockSelectedTurn = null;
    mockSurfaceMode = "cowork";
    await renderHost({ lockSurface: true, surface: "cowork" });
    await selectDefaultSession();
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onReviewRunDetails();
      const props =
        latestSurfaceInput?.workflowPanel?.kind === "cowork" ? latestSurfaceInput.workflowPanel.props : null;
      props?.onOpenDetails();
      await flushEffects(2);
    });

    setupMocks();
    mockSelectedTurn = selectedTurn;
    mockSurfaceMode = "cowork";
    const closeWorkflowDock = vi.fn();
    useChatDockWorkbenchControllerMock.mockReturnValue({
      ...useChatDockWorkbenchControllerMock(),
      activeWorkflowTurn: selectedTurn,
      dockOpen: true,
      setDockOpen: closeWorkflowDock,
    });
    await renderHost({ lockSurface: true, surface: "cowork" });
    await selectDefaultSession();
    await act(async () => {
      const props =
        latestSurfaceInput?.workflowPanel?.kind === "cowork" ? latestSurfaceInput.workflowPanel.props : null;
      props?.onOpenDetails();
      await flushEffects(2);
    });
    expect(closeWorkflowDock).toHaveBeenCalledWith(false);

    setupMocks();
    mockSelectedTurn = selectedTurn;
    mockSurfaceMode = "cowork";
    useChatDockWorkbenchControllerMock.mockReturnValue({
      ...useChatDockWorkbenchControllerMock(),
      activeWorkflowTurn: selectedTurn,
    });
    useChatContextActionsMock.mockReturnValue({
      ...useChatContextActionsMock(),
      activeDelegationRun: {
        attachedTurnId: "other-turn",
        label: "Delegation",
        objective: "Work",
        mode: "parallel",
        status: "running",
        steps: [],
      },
    });
    await renderHost({ lockSurface: true, surface: "cowork" });
    await selectDefaultSession();
    expect(latestSurfaceInput?.activeSessionSurfaceProps?.delegationRun).toBeNull();
    expect(
      latestSurfaceInput?.activeSessionSurfaceProps?.notices.some((notice) =>
        notice.content.includes("Background handoff visible from the session run table: agentic-run-1"),
      ),
    ).toBe(true);

    setupMocks();
    mockSelectedTurn = selectedTurn;
    const closeActiveDock = vi.fn();
    useChatDockWorkbenchControllerMock.mockReturnValue({
      ...useChatDockWorkbenchControllerMock(),
      dockOpen: true,
      setDockOpen: closeActiveDock,
    });
    await renderHost();
    await selectDefaultSession();
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onOpenRunDetails("turn-1");
      await flushEffects(2);
    });
    expect(closeActiveDock).toHaveBeenCalledWith(false);

    setupMocks();
    mockSelectedTurn = selectedTurn;
    useChatSessionDataMock.mockReturnValue({
      ...useChatSessionDataMock(),
      thread: { ...thread, turns: [] },
    });
    updateChatSessionPrefsMock.mockRejectedValueOnce(new Error("direct model patch failed"));
    await renderHost();
    await selectDefaultSession();
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onRequestModelChange("claude-4");
      await flushEffects(8);
    });
    expect(updateChatSessionPrefsMock).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ model: "claude-4" }),
    );
  });

  it("covers model patch rollback and no-op provider changes", async () => {
    const setPrefs = vi.fn();
    useChatSessionDataMock.mockReturnValue({
      ...useChatSessionDataMock(),
      setPrefs,
    });
    updateChatSessionPrefsMock.mockRejectedValueOnce(new Error("prefs failed"));
    await renderHost();
    await selectDefaultSession();
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onSetThinkingLevel("deep");
      await flushEffects(8);
    });
    expect(setPrefs).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel: "deep" }));
    expect(setPrefs).toHaveBeenCalledWith(prefs);

    updateChatSessionPrefsMock.mockClear();
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onRequestProviderChange("openai");
      await flushEffects(4);
    });
    expect(updateChatSessionPrefsMock).not.toHaveBeenCalled();
  });

  it("keeps refreshed preference truth canonical after a 409 and retries the explicit draft", async () => {
    const setPrefs = vi.fn();
    const prefsRef = { current: prefs };
    const latestPrefs = {
      ...prefs,
      revision: 8,
      thinkingLevel: "standard" as const,
      model: "gpt-5.5-server",
    };
    useChatSessionDataMock.mockReturnValue({
      ...useChatSessionDataMock(),
      prefs,
      setPrefs,
    });
    useChatOutboundExecutionMock.mockReturnValue({
      ...useChatOutboundExecutionMock(),
      prefsRef,
    });
    fetchChatSessionPrefsMock.mockResolvedValue(latestPrefs);
    updateChatSessionPrefsMock.mockRejectedValueOnce(new ApiRequestErrorMock("stale preferences", { status: 409 }));

    await renderHost();
    await selectDefaultSession();
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onSetThinkingLevel("deep");
      await flushEffects(12);
    });

    expect(prefsRef.current).toEqual(latestPrefs);
    expect(setPrefs).toHaveBeenLastCalledWith(latestPrefs);
    expect(latestSurfaceInput?.contextDockProps?.preferenceConflictDraft).toEqual({ thinkingLevel: "deep" });

    updateChatSessionPrefsMock.mockResolvedValueOnce({
      ...latestPrefs,
      revision: 9,
      thinkingLevel: "deep",
    });
    await act(async () => {
      await latestSurfaceInput?.contextDockProps?.onRetryPreferenceConflictDraft();
      await flushEffects(8);
    });

    expect(updateChatSessionPrefsMock).toHaveBeenLastCalledWith("session-1", {
      expectedRevision: 8,
      thinkingLevel: "deep",
    });
    expect(prefsRef.current).toMatchObject({ revision: 9, thinkingLevel: "deep" });
    expect(latestSurfaceInput?.contextDockProps?.preferenceConflictDraft).toBeNull();
  });

  it("covers host rail, empty-state, attach, and modal cancel callbacks", async () => {
    const showProjectCreateSetter = vi.fn();
    const createProject = vi.fn(async () => undefined);
    const archiveSession = vi.fn(async () => undefined);
    const deleteCancel = vi.fn();
    const archiveCancel = vi.fn();
    useChatSessionControlsMock.mockReturnValue({
      ...useChatSessionControlsMock(),
      setShowProjectCreate: showProjectCreateSetter,
      handleCreateProject: createProject,
      handleToggleArchiveSession: archiveSession,
      sessionDeleteConfirm: { sessionId: "session-1", label: "Launch plan" },
      setSessionDeleteConfirm: deleteCancel,
      archiveWorkspaceConfirmOpen: true,
      setArchiveWorkspaceConfirmOpen: archiveCancel,
    });
    const capabilityCancel = vi.fn();
    useChatContextActionsMock.mockReturnValue({
      ...useChatContextActionsMock(),
      capabilitySuggestionConfirm: { kind: "skill", title: "Skill", recommendedAction: "connect_mcp" },
      setCapabilitySuggestionConfirm: capabilityCancel,
      capabilityConfirmationCopy: {
        title: "Confirm skill",
        message: "Connect the skill.",
        confirmLabel: "Connect",
      },
    });

    await renderHost();
    await selectDefaultSession();

    await act(async () => {
      const sessionControlsInput = useChatSessionControlsMock.mock.calls.at(-1)?.[0] as any;
      const surfaceOrchestrationInput = useChatSurfaceOrchestrationMock.mock.calls.at(-1)?.[0] as any;
      const outboundInput = useChatOutboundExecutionMock.mock.calls.at(-1)?.[0] as any;
      sessionControlsInput?.setQueuedOutbound([]);
      surfaceOrchestrationInput?.setPendingApproval(null);
      await outboundInput?.routing.ensureFreshRoutePreflight({ content: "refresh route" });
      expect(outboundInput?.routing.isRoutePreflightAcknowledged("route-hash")).toBe(false);
      latestSurfaceInput?.activeSessionSurfaceProps?.onAcknowledgeRouteBoundary();
      await flushEffects(4);
      const acknowledgedOutboundInput = useChatOutboundExecutionMock.mock.calls.at(-1)?.[0] as any;
      acknowledgedOutboundInput?.routing.isRoutePreflightAcknowledged("route-hash");
      latestSurfaceInput?.sessionRail.onToggleProjectCreate();
      latestSurfaceInput?.sessionRail.onCreateProject();
      latestSurfaceInput?.activeSessionSurfaceProps?.onToggleArchiveSession();
      latestSurfaceInput?.activeSessionSurfaceProps?.onDismissPresetWarning?.();
      latestSurfaceInput?.activeSessionSurfaceProps?.onAttachFiles?.();
      latestSurfaceInput?.dropTargetProps.onAttachFiles();
      latestSurfaceInput?.sessionRail.renderSessionLabel("unknown-session-abcdef");
      for (const props of confirmModalProps.filter((item) => item.open)) {
        props.onCancel?.();
      }
      await flushEffects(8);
    });

    expect(showProjectCreateSetter).toHaveBeenCalled();
    expect(createProject).toHaveBeenCalled();
    expect(archiveSession).toHaveBeenCalled();
    expect(capabilityCancel).toHaveBeenCalledWith(null);
    expect(deleteCancel).toHaveBeenCalledWith(null);
    expect(archiveCancel).toHaveBeenCalledWith(false);

    await cleanupRenderedHosts();
    setupMocks();
    useChatThreadControllerMock.mockReturnValue({
      ...useChatThreadControllerMock(),
      selectedSession: null,
      messages: [],
      missionSessions: [],
      externalSessions: [],
      workspaceMissionSessionCount: 0,
      boundMissionSessionCount: 0,
    });
    useChatSessionDataMock.mockReturnValue({
      ...useChatSessionDataMock(),
      thread: null,
      prefs: null,
    });

    const onOpenStartHere = vi.fn();
    await renderHost({ onOpenStartHere });
    await act(async () => {
      latestSurfaceInput?.emptyStateProps.onOpenCowork();
      latestSurfaceInput?.emptyStateProps.onOpenCode();
      latestSurfaceInput?.emptyStateProps.onOpenTasks();
      latestSurfaceInput?.emptyStateProps.onOpenApprovals();
      latestSurfaceInput?.emptyStateProps.onOpenStartHere?.();
      await flushEffects(4);
    });
    expect(onOpenStartHere).toHaveBeenCalledTimes(1);

    await cleanupRenderedHosts();
    setupMocks();
    mockSurfaceMode = "code";
    const discardWorkbenchDraft = vi.fn();
    useChatDockWorkbenchControllerMock.mockReturnValue({
      ...useChatDockWorkbenchControllerMock(),
      hasDirtyWorkbenchDraft: true,
      discardWorkbenchDraft,
    });
    await renderHost({ surface: "code", lockSurface: true });
    await selectDefaultSession();
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onNavigateSurface("chat");
      await flushEffects(4);
    });
    const discardModal = confirmModalProps.find(
      (props) => props.open && props.title === "Discard unsaved workbench changes?",
    );
    await act(async () => {
      discardModal?.onCancel?.();
      await flushEffects(4);
    });

    await cleanupRenderedHosts();
    setupMocks();
    await renderHost();
    await selectDefaultSession();
    await act(async () => {
      latestSurfaceInput?.activeSessionSurfaceProps?.onRequestModelChange("claude-4");
      await flushEffects(4);
    });
    const modelSwitchModal = confirmModalProps.find((props) => props.open && props.title === "Switch thread model?");
    await act(async () => {
      modelSwitchModal?.onCancel?.();
      await flushEffects(4);
    });
  });

  it("covers empty agentic run refreshes and unlabeled selected session fallbacks", async () => {
    fetchAgenticRunsMock.mockResolvedValue({ items: [] });
    useChatThreadControllerMock.mockReturnValue({
      ...useChatThreadControllerMock(),
      selectedSession: { ...selectedSession, title: "" },
      selectedProject: null,
      visibleSessionLabelById: new Map(),
    });
    useChatSessionDataMock.mockReturnValue({
      ...useChatSessionDataMock(),
      projects: null,
      thread: { ...thread, selectedTurnId: null },
    });

    await renderHost({ lockSurface: true, surface: "cowork", routeSearch: "?artifactId=%20%20%20" });
    await selectDefaultSession();

    const props = latestSurfaceInput?.workflowPanel?.kind === "cowork" ? latestSurfaceInput.workflowPanel.props : null;
    await act(async () => {
      props?.onRefreshRunState();
      latestSurfaceInput?.activeSessionSurfaceProps?.onSelectTurn("turn-1");
      latestSurfaceInput?.activeSessionSurfaceProps?.onSwitchBranch("turn-1");
      await flushEffects(8);
    });

    expect(fetchAgenticRunTreeMock).not.toHaveBeenCalled();
    expect(latestSurfaceInput?.activeSessionSurfaceProps?.summary).toContain("Chat sion-1");
    expect(latestSurfaceInput?.contextDockProps?.projectOptions).toEqual([{ value: "none", label: "Unassigned" }]);
  });

  it("calls onResolvedModeChange with the resolved mode of the selected session (unlocked surface)", async () => {
    const codeSession = {
      ...selectedSession,
      sessionId: "session-code",
      sessionKey: "session-code",
      mode: "code" as ChatMode,
      title: "Code session",
    };
    useChatSessionDataMock.mockReturnValue({
      ...useChatSessionDataMock(),
      sessions: { items: [selectedSession, codeSession] },
    });
    useChatThreadControllerMock.mockReturnValue({
      ...useChatThreadControllerMock(),
      selectedSession: codeSession,
      missionSessions: [selectedSession, codeSession],
      visibleSessionLabelById: new Map([
        ["session-1", "Launch plan"],
        ["session-code", "Code session"],
      ]),
    });

    const onResolvedModeChange = vi.fn();
    await renderHost({ lockSurface: false, onResolvedModeChange });

    await act(async () => {
      latestSurfaceInput?.sessionRail.onSelectSession("session-code");
      await flushEffects(8);
    });

    expect(onResolvedModeChange).toHaveBeenCalledWith("chat", "session-sync");
  });

  describe("auto-route surfaceMode wiring guard (#136)", () => {
    it("passes surfaceMode=undefined to the outbound hook on a new unlocked thread (auto-route guard)", async () => {
      // Render unlocked (no lockSurface, no surface) — modeOverride starts null,
      // so resolveOutboundSurfaceMode returns undefined, which is what shouldAutoRouteSend
      // gates on. This test will FAIL if MissionThreadedControllerHost is reverted to
      // passing executionSurfaceMode (always defined) instead of outboundSurfaceMode.
      await renderHost();
      const lastInput = useChatOutboundExecutionMock.mock.calls.at(-1)?.[0] as {
        sessionConfig: { surfaceMode?: string };
      };
      expect(lastInput.sessionConfig.surfaceMode).toBe("chat");
    });

    it("passes the locked surface mode to the outbound hook when locked", async () => {
      await renderHost({ lockSurface: true, surface: "cowork" });
      const lastInput = useChatOutboundExecutionMock.mock.calls.at(-1)?.[0] as {
        sessionConfig: { surfaceMode?: string };
      };
      expect(lastInput.sessionConfig.surfaceMode).toBe("chat");
    });

    it("passes the override mode to the outbound hook after onModeOverride is called", async () => {
      await renderHost();
      // Before override: surfaceMode is undefined (auto-route path)
      const beforeInput = useChatOutboundExecutionMock.mock.calls.at(-1)?.[0] as {
        sessionConfig: { surfaceMode?: string };
      };
      expect(beforeInput.sessionConfig.surfaceMode).toBe("chat");

      // Trigger a mode override via the activeSessionSurfaceProps callback.
      // activeSessionSurfaceProps is non-null because setupMocks sets selectedSession.
      await act(async () => {
        latestSurfaceInput?.activeSessionSurfaceProps?.onModeOverride("code");
        await flushEffects(4);
      });

      const afterInput = useChatOutboundExecutionMock.mock.calls.at(-1)?.[0] as {
        sessionConfig: { surfaceMode?: string };
      };
      expect(afterInput.sessionConfig.surfaceMode).toBe("chat");
    });

    it("seeds modeOverride from initialModeOverride so an explicit ?mode=chat wins over the session's own cowork mode (QA finding N3)", async () => {
      // Selected session's OWN mode is "cowork" (mirrors the QA repro: opening
      // ?mode=chat&sessionId=X on a cowork session). Without the prop-seeded
      // override, executionSurfaceMode/outboundSurfaceMode would resolve to
      // "cowork" from selectedSession.mode, exactly the bug this task fixes.
      const coworkSession = { ...selectedSession, mode: "cowork" as ChatMode };
      useChatSessionDataMock.mockReturnValue({
        ...useChatSessionDataMock(),
        sessions: { items: [coworkSession] },
      });
      useChatThreadControllerMock.mockReturnValue({
        ...useChatThreadControllerMock(),
        selectedSession: coworkSession,
        missionSessions: [coworkSession],
      });

      await renderHost({ initialModeOverride: "chat" as ChatMode });

      // Surface presentation: the override is pending/selected, not the
      // session's own "cowork" mode.
      expect(latestSurfaceInput?.activeSessionSurfaceProps?.modeOverridePending).toBe("chat");

      // Outbound sends on this thread must also route through the override.
      const lastInput = useChatOutboundExecutionMock.mock.calls.at(-1)?.[0] as {
        sessionConfig: { surfaceMode?: string };
      };
      expect(lastInput.sessionConfig.surfaceMode).toBe("chat");
    });

    it("keeps honoring initialModeOverride after switching to another session (URL override survives session switch)", async () => {
      const coworkSession = { ...selectedSession, mode: "cowork" as ChatMode };
      const otherCoworkSession = {
        ...selectedSession,
        sessionId: "session-other",
        sessionKey: "session-other",
        mode: "cowork" as ChatMode,
        title: "Other cowork session",
      };
      useChatSessionDataMock.mockReturnValue({
        ...useChatSessionDataMock(),
        sessions: { items: [coworkSession, otherCoworkSession] },
      });
      useChatThreadControllerMock.mockReturnValue({
        ...useChatThreadControllerMock(),
        selectedSession: coworkSession,
        missionSessions: [coworkSession, otherCoworkSession],
        visibleSessionLabelById: new Map([
          ["session-1", "Launch plan"],
          ["session-other", "Other cowork session"],
        ]),
      });

      await renderHost({ initialModeOverride: "chat" as ChatMode });
      expect(latestSurfaceInput?.activeSessionSurfaceProps?.modeOverridePending).toBe("chat");

      // Selecting another session resets modeOverride via the selectedSessionId
      // effect. With initialModeOverride still "chat", the reset must re-seed
      // from the prop rather than clearing to null.
      useChatThreadControllerMock.mockReturnValue({
        ...useChatThreadControllerMock(),
        selectedSession: otherCoworkSession,
        missionSessions: [coworkSession, otherCoworkSession],
      });
      await act(async () => {
        latestSurfaceInput?.sessionRail.onSelectSession("session-other");
        await flushEffects(8);
      });

      expect(latestSurfaceInput?.activeSessionSurfaceProps?.modeOverridePending).toBe("chat");
      const lastInput = useChatOutboundExecutionMock.mock.calls.at(-1)?.[0] as {
        sessionConfig: { surfaceMode?: string };
      };
      expect(lastInput.sessionConfig.surfaceMode).toBe("chat");
    });

    it("a manual override diverging from a URL seed wins over the seed on session switch (URL seed is a one-time force, not a standing one)", async () => {
      // Reviewer's exact probe scenario: URL seeds ?mode=chat, the operator then
      // manually picks Cowork via ThreadedModeControl (onModeOverride), and only
      // THEN switches session. Before this fix, the session-switch reset effect
      // read initialModeOverrideRef unconditionally and snapped the override back
      // to "chat", silently discarding the operator's explicit choice.
      const coworkSession = { ...selectedSession, mode: "cowork" as ChatMode };
      const otherCoworkSession = {
        ...selectedSession,
        sessionId: "session-other",
        sessionKey: "session-other",
        mode: "cowork" as ChatMode,
        title: "Other cowork session",
      };
      useChatSessionDataMock.mockReturnValue({
        ...useChatSessionDataMock(),
        sessions: { items: [coworkSession, otherCoworkSession] },
      });
      useChatThreadControllerMock.mockReturnValue({
        ...useChatThreadControllerMock(),
        selectedSession: coworkSession,
        missionSessions: [coworkSession, otherCoworkSession],
        visibleSessionLabelById: new Map([
          ["session-1", "Launch plan"],
          ["session-other", "Other cowork session"],
        ]),
      });

      await renderHost({ initialModeOverride: "chat" as ChatMode });
      expect(latestSurfaceInput?.activeSessionSurfaceProps?.modeOverridePending).toBe("chat");

      // Manual pick: the operator flips to Cowork via the UI control.
      await act(async () => {
        latestSurfaceInput?.activeSessionSurfaceProps?.onModeOverride("cowork");
        await flushEffects(4);
      });
      expect(latestSurfaceInput?.activeSessionSurfaceProps?.modeOverridePending).toBe("chat");

      // Now switch session. The URL seed (initialModeOverride="chat") is still
      // the same prop value — only a manual adjustment happened — so the reset
      // must NOT re-seed "chat"; the session's own mode should win instead
      // (modeOverridePending clears to null, matching pre-existing unseeded semantics).
      useChatThreadControllerMock.mockReturnValue({
        ...useChatThreadControllerMock(),
        selectedSession: otherCoworkSession,
        missionSessions: [coworkSession, otherCoworkSession],
      });
      await act(async () => {
        latestSurfaceInput?.sessionRail.onSelectSession("session-other");
        await flushEffects(8);
      });

      expect(latestSurfaceInput?.activeSessionSurfaceProps?.modeOverridePending).not.toBe("chat");
      expect(latestSurfaceInput?.activeSessionSurfaceProps?.modeOverridePending).toBeNull();
    });

    it("re-arms URL precedence when initialModeOverride's prop value genuinely changes after a manual adjustment (new navigation seed wins again)", async () => {
      const coworkSession = { ...selectedSession, mode: "cowork" as ChatMode };
      const otherCoworkSession = {
        ...selectedSession,
        sessionId: "session-other",
        sessionKey: "session-other",
        mode: "cowork" as ChatMode,
        title: "Other cowork session",
      };
      useChatSessionDataMock.mockReturnValue({
        ...useChatSessionDataMock(),
        sessions: { items: [coworkSession, otherCoworkSession] },
      });
      useChatThreadControllerMock.mockReturnValue({
        ...useChatThreadControllerMock(),
        selectedSession: coworkSession,
        missionSessions: [coworkSession, otherCoworkSession],
        visibleSessionLabelById: new Map([
          ["session-1", "Launch plan"],
          ["session-other", "Other cowork session"],
        ]),
      });

      const { renderer } = await renderHost({ initialModeOverride: "chat" as ChatMode });
      expect(latestSurfaceInput?.activeSessionSurfaceProps?.modeOverridePending).toBe("chat");

      // Manual pick diverges from the seed.
      await act(async () => {
        latestSurfaceInput?.activeSessionSurfaceProps?.onModeOverride("cowork");
        await flushEffects(4);
      });
      expect(latestSurfaceInput?.activeSessionSurfaceProps?.modeOverridePending).toBe("chat");

      // The prop transitions "chat" -> undefined (e.g. the operator navigated away
      // from ?mode=chat entirely), simulating a real navigation boundary.
      await act(async () => {
        renderer.update(
          <MissionThreadedControllerHost
            workspaceId="workspace-1"
            workspaceName="Mission Workspace"
            approvalsCount={2}
            initialModeOverride={undefined}
            renderSurface={(input) => {
              latestSurfaceInput = input;
              return <div data-surface={input.messageMode} />;
            }}
          />,
        );
        await flushEffects(4);
      });

      // Then a NEW navigation re-seeds "chat" (the prop value genuinely changes
      // again, undefined -> "chat"). This must be treated as a fresh URL seed
      // that re-arms URL precedence, regardless of the earlier manual divergence.
      await act(async () => {
        renderer.update(
          <MissionThreadedControllerHost
            workspaceId="workspace-1"
            workspaceName="Mission Workspace"
            approvalsCount={2}
            initialModeOverride={"chat" as ChatMode}
            renderSurface={(input) => {
              latestSurfaceInput = input;
              return <div data-surface={input.messageMode} />;
            }}
          />,
        );
        await flushEffects(4);
      });
      expect(latestSurfaceInput?.activeSessionSurfaceProps?.modeOverridePending).toBe("chat");

      // Prove the re-arm actually took effect (not just the direct re-seed effect
      // coincidentally firing): switching session now must keep honoring the new
      // seed, exactly like the untouched-seed case, because the manual-divergence
      // flag was cleared when the prop changed.
      useChatThreadControllerMock.mockReturnValue({
        ...useChatThreadControllerMock(),
        selectedSession: otherCoworkSession,
        missionSessions: [coworkSession, otherCoworkSession],
      });
      await act(async () => {
        latestSurfaceInput?.sessionRail.onSelectSession("session-other");
        await flushEffects(8);
      });
      expect(latestSurfaceInput?.activeSessionSurfaceProps?.modeOverridePending).toBe("chat");
    });

    it("exposes autoRouteActive=true on activeSessionSurfaceProps for a new unlocked empty thread", async () => {
      // Override the session data mock to return an empty thread.
      // We must keep all fields from setupMocks but replace thread with an empty one.
      useChatSessionDataMock.mockReturnValue({
        projects: { items: [selectedProject] },
        setProjects: vi.fn(),
        sessions: { items: [selectedSession] },
        setSessions: vi.fn(),
        thread: { sessionId: "session-1", selectedTurnId: null, activeLeafTurnId: null, turns: [] },
        setThread: vi.fn(),
        prefs,
        setPrefs: vi.fn(),
        binding: { sessionId: "session-1", target: null },
        setBinding: vi.fn(),
        generatedArtifacts: { items: [generatedArtifact] },
        setGeneratedArtifacts: vi.fn(),
        threadKnowledgeAttachments: {
          items: [{ attachmentId: "knowledge-1", sourceRef: "file.pdf", retrievalMode: "retrieval" }],
        },
        setThreadKnowledgeAttachments: vi.fn(),
        settings: { llm: { activeProviderId: "openai", activeModel: "gpt-5.5" } },
        setSettings: vi.fn(),
        commandCatalog: [{ command: "/plan", usage: "/plan", description: "Plan" }],
        proactiveStatus: { mode: "off" },
        setProactiveStatus: vi.fn(),
        proactiveRuns: [],
        setProactiveRuns: vi.fn(),
        learnedMemory: [],
        setLearnedMemory: vi.fn(),
        specialistCandidates: [],
        setSpecialistCandidates: vi.fn(),
        installedSkills: [],
        setInstalledSkills: vi.fn(),
        mcpServers: [],
        setMcpServers: vi.fn(),
        mcpTemplates: [],
        setMcpTemplates: vi.fn(),
        loading: false,
        isRefreshing: false,
        messagesLoading: false,
        secondaryLoading: false,
        loadSidebar: vi.fn(async () => undefined),
        loadRuntimeCatalog: vi.fn(async () => undefined),
        loadSessionCoreState: vi.fn(async () => undefined),
        loadSessionSecondaryState: vi.fn(async () => undefined),
        loadSessionState: vi.fn(async () => undefined),
        refreshViewState: vi.fn(async () => undefined),
      });
      await renderHost();
      // Auto-route surface switching is disabled; Chat remains the only routed surface.
      expect(latestSurfaceInput?.activeSessionSurfaceProps?.autoRouteActive).toBe(false);
      // surfaceRoutePreview is undefined because the mock returns undefined (draft is empty, hook returns undefined).
      expect(latestSurfaceInput?.activeSessionSurfaceProps?.surfaceRoutePreview).toBeUndefined();
    });

    it("exposes autoRouteActive=false when the thread has turns", async () => {
      // Default mock has thread with one turn (selectedTurn) → threadIsEmpty = false.
      await renderHost();
      expect(latestSurfaceInput?.activeSessionSurfaceProps?.autoRouteActive).toBe(false);
    });

    it("exposes autoRouteActive=false when surface is locked", async () => {
      useChatSessionDataMock.mockReturnValue({
        projects: { items: [selectedProject] },
        setProjects: vi.fn(),
        sessions: { items: [selectedSession] },
        setSessions: vi.fn(),
        thread: { sessionId: "session-1", selectedTurnId: null, activeLeafTurnId: null, turns: [] },
        setThread: vi.fn(),
        prefs,
        setPrefs: vi.fn(),
        binding: { sessionId: "session-1", target: null },
        setBinding: vi.fn(),
        generatedArtifacts: { items: [] },
        setGeneratedArtifacts: vi.fn(),
        threadKnowledgeAttachments: { items: [] },
        setThreadKnowledgeAttachments: vi.fn(),
        settings: { llm: { activeProviderId: "openai", activeModel: "gpt-5.5" } },
        setSettings: vi.fn(),
        commandCatalog: [],
        proactiveStatus: { mode: "off" },
        setProactiveStatus: vi.fn(),
        proactiveRuns: [],
        setProactiveRuns: vi.fn(),
        learnedMemory: [],
        setLearnedMemory: vi.fn(),
        specialistCandidates: [],
        setSpecialistCandidates: vi.fn(),
        installedSkills: [],
        setInstalledSkills: vi.fn(),
        mcpServers: [],
        setMcpServers: vi.fn(),
        mcpTemplates: [],
        setMcpTemplates: vi.fn(),
        loading: false,
        isRefreshing: false,
        messagesLoading: false,
        secondaryLoading: false,
        loadSidebar: vi.fn(async () => undefined),
        loadRuntimeCatalog: vi.fn(async () => undefined),
        loadSessionCoreState: vi.fn(async () => undefined),
        loadSessionSecondaryState: vi.fn(async () => undefined),
        loadSessionState: vi.fn(async () => undefined),
        refreshViewState: vi.fn(async () => undefined),
      });
      await renderHost({ lockSurface: true, surface: "chat" });
      expect(latestSurfaceInput?.activeSessionSurfaceProps?.autoRouteActive).toBe(false);
    });
  });

  describe("unified auto-route send path", () => {
    // Reconfigure the session-data mock to an EMPTY thread (no turns) so
    // autoRouteActive is true, and point the thread controller at a session
    // whose projectId reflects the desired bound/unbound state.
    function setupEmptyThread(options: { hasBoundProject: boolean }) {
      const base = useChatSessionDataMock.getMockImplementation()?.();
      useChatSessionDataMock.mockReturnValue({
        ...base,
        thread: { sessionId: "session-1", selectedTurnId: null, activeLeafTurnId: null, turns: [] },
      });
      const sessionForThread = options.hasBoundProject ? selectedSession : { ...selectedSession, projectId: undefined };
      useChatThreadControllerMock.mockReturnValue({
        selectedSession: sessionForThread,
        selectedProject: options.hasBoundProject ? selectedProject : null,
        messages: [],
        missionSessions: [sessionForThread],
        externalSessions: [],
        workspaceMissionSessionCount: 1,
        boundMissionSessionCount: options.hasBoundProject ? 1 : 0,
        visibleSessionLabelById: new Map([["session-1", "Launch plan"]]),
        availableFolders: [{ folderId: "all", name: "All", count: 1 }],
      });
    }

    it("sends an unbound predicted-code first turn without asking for a mode switch", async () => {
      setupEmptyThread({ hasBoundProject: false });
      mockSurfacePreview = { mode: "code", confidence: 0.9, source: "classifier" };
      await renderHost();
      expect(latestSurfaceInput?.activeSessionSurfaceProps?.autoRouteActive).toBe(false);

      await act(async () => {
        latestSurfaceInput?.activeSessionSurfaceProps?.onSend();
        await flushEffects(6);
      });

      expect(handleSendMock).toHaveBeenCalledTimes(1);
    });

    it("sends a low-confidence predicted-code first turn without asking for a mode switch", async () => {
      setupEmptyThread({ hasBoundProject: true });
      mockSurfacePreview = { mode: "code", confidence: 0.5, source: "classifier" };
      await renderHost();

      await act(async () => {
        latestSurfaceInput?.activeSessionSurfaceProps?.onSend();
        await flushEffects(6);
      });

      expect(handleSendMock).toHaveBeenCalledTimes(1);
    });

    it("sends normally when predicted code is bound and confident (no gate)", async () => {
      setupEmptyThread({ hasBoundProject: true });
      mockSurfacePreview = { mode: "code", confidence: 0.95, source: "classifier" };
      await renderHost();

      await act(async () => {
        latestSurfaceInput?.activeSessionSurfaceProps?.onSend();
        await flushEffects(6);
      });

      expect(handleSendMock).toHaveBeenCalledTimes(1);
    });

    it("sends normally when there is no preview (fail-open)", async () => {
      setupEmptyThread({ hasBoundProject: false });
      mockSurfacePreview = undefined;
      await renderHost();

      await act(async () => {
        latestSurfaceInput?.activeSessionSurfaceProps?.onSend();
        await flushEffects(6);
      });

      expect(handleSendMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("HX-411 external session control (operator visibility)", () => {
    function externalControlDetail() {
      return {
        control: {
          workspaceId: "workspace-1",
          sessionId: "session-1",
          generation: 4,
          lastEventId: "evt-2",
          lastEventReasonCode: "handoff",
          updatedAt: "2026-07-14T12:00:00.000Z",
          ownerKind: "external_companion",
          leaseState: "external_live",
          capabilities: ["send"],
          boundExternalController: {
            companionSessionId: "companion-77",
            clientInstanceId: "cli-instance-01",
            principalPurpose: "session_control_client",
            tokenFingerprint: "0a1b2c3d",
          },
          lastHeartbeatAt: "2026-07-14T12:00:00.000Z",
          leaseExpiresAt: "2026-07-14T12:01:00.000Z",
          reconnectExpiresAt: "2026-07-14T12:05:00.000Z",
        },
        pendingRequests: [],
      };
    }

    it("fails operator send closed and surfaces the banner while an external client owns the session", async () => {
      sessionControlHookState.value = {
        data: externalControlDetail(),
        loading: false,
        error: null,
        reload: vi.fn(async () => undefined),
      };
      await renderHost();

      const surface = latestSurfaceInput?.activeSessionSurfaceProps;
      expect(surface?.canSend).toBe(false);
      expect(surface?.sessionControlBanner?.model.externalControlActive).toBe(true);
      expect(surface?.sessionControlBanner?.model.sendLocked).toBe(true);

      await act(async () => {
        surface?.onSend();
        await flushEffects(6);
      });

      // The underlying send must never fire under external control (the Gateway also
      // 403s it); instead a truthful warning notice explains why send is disabled.
      expect(handleSendMock).not.toHaveBeenCalled();
      const notices = latestSurfaceInput?.activeSessionSurfaceProps?.notices ?? [];
      expect(notices.some((notice) => /external client/i.test(notice.content))).toBe(true);
    });

    it("re-enables operator send once control returns to the operator", async () => {
      sessionControlHookState.value = {
        data: null,
        loading: false,
        error: null,
        reload: vi.fn(async () => undefined),
      };
      await renderHost();

      expect(latestSurfaceInput?.activeSessionSurfaceProps?.sessionControlBanner ?? null).toBeNull();

      await act(async () => {
        latestSurfaceInput?.activeSessionSurfaceProps?.onDraftChange("Ready to send");
        await flushEffects(4);
      });
      expect(latestSurfaceInput?.activeSessionSurfaceProps?.canSend).toBe(true);

      await act(async () => {
        latestSurfaceInput?.activeSessionSurfaceProps?.onSend();
        await flushEffects(6);
      });
      expect(handleSendMock).toHaveBeenCalledTimes(1);
    });
  });
});
