import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMode, ChatThreadResponse } from "@goatcitadel/contracts";
import {
  MissionThreadedControllerHost,
  formatFallbackSummary,
  formatRoutingTargetSummary,
  formatRuntimeSummary,
  formatThreadedRunStateLabel,
  formatThreadedRunStateSummary,
  reconcilePendingAttachmentModes,
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
const fetchAgentsMock = vi.fn();
const fetchChatGeneratedArtifactMock = vi.fn();
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

let mockSurfaceMode: ChatMode = "chat";
let mockCompact = false;
let latestSurfaceInput: MissionThreadedRenderSurfaceInput | null = null;
let confirmModalProps: any[] = [];
let mockSelectedTurn: any = null;
const mountedRenderers: ReactTestRenderer[] = [];

const selectedSession = {
  sessionId: "session-1",
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
  attachThreadKnowledgeAttachment: (...args: unknown[]) => attachThreadKnowledgeAttachmentMock(...args),
  createChatGeneratedArtifact: (...args: unknown[]) => createChatGeneratedArtifactMock(...args),
  createChatSideChat: (...args: unknown[]) => createChatSideChatMock(...args),
  createChatSession: (...args: unknown[]) => createChatSessionMock(...args),
  fetchAgents: (...args: unknown[]) => fetchAgentsMock(...args),
  fetchChatGeneratedArtifact: (...args: unknown[]) => fetchChatGeneratedArtifactMock(...args),
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
  useMediaQuery: () => mockCompact,
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
  updateChatSessionPrefsMock.mockImplementation(async (_sessionId, patch) => ({ ...prefs, ...patch }));
  fetchSkillsMock.mockResolvedValue({ items: [{ skillId: "skill-1", name: "Skill", state: "enabled" }] });
  fetchMcpServersMock.mockResolvedValue({ items: [{ serverId: "server-1", label: "Server", status: "connected" }] });
  fetchMcpTemplatesMock.mockResolvedValue({
    items: [{ templateId: "template-1", label: "Template", installed: false }],
  });
  parseChatCommandMock.mockResolvedValue({ ok: true, command: "/plan", prefs: { ...prefs, planningMode: "advisory" } });
  createCodeModeRunMock.mockResolvedValue({ runId: "code-run-1" });

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
    loadSidebar: vi.fn(async () => undefined),
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
    handleSend: vi.fn(async () => undefined),
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
    handleToggleVoiceTalk: vi.fn(async () => undefined),
    handleOpenAudioTranscribe: vi.fn(),
    handleAudioFileSelected: vi.fn(async () => undefined),
    handleGenerateImage: vi.fn(async () => generatedArtifact),
    handleEditImage: vi.fn(async () => generatedArtifact),
  });
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
    mockSelectedTurn = selectedTurn;
    installBrowserGlobals();
    setupMocks();
  });

  afterEach(async () => {
    await cleanupRenderedHosts();
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
      props?.onRunHelperSnippet("python", "print('x')");
      props?.onRunHelperSnippet("ts", "export const x = 1;");
      await flushEffects();
    });

    expect(createCodeModeRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        language: "typescript",
        source: "export const x = 1;",
        originSurface: "code",
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
      surface: "cowork",
      limit: 1,
    });
    expect(fetchAgenticRunTreeMock).toHaveBeenCalledWith("agentic-run-1", { workspaceId: "workspace-1" });
    expect(controlAgenticRunMock).toHaveBeenCalledWith(
      "agentic-run-1",
      expect.objectContaining({ action: "pause", reason: "Mission Control operator action." }),
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
      await outboundInput.handleCommandExecution("session-1", "/project Mission");
      await flushEffects();
    });
    expect(sessionData.setPrefs).toHaveBeenCalledWith(expect.objectContaining({ memoryMode: "workspace" }));
    expect(sessionData.loadSidebar).toHaveBeenCalled();

    parseChatCommandMock.mockResolvedValueOnce({ ok: true, command: "/skill" });
    await act(async () => {
      await outboundInput.handleCommandExecution("session-1", "/skill enable skill-1");
      await flushEffects();
    });
    expect(fetchSkillsMock).toHaveBeenCalled();
    expect(sessionData.setInstalledSkills).toHaveBeenCalledWith([
      { skillId: "skill-1", name: "Skill", state: "enabled" },
    ]);

    parseChatCommandMock.mockResolvedValueOnce({ ok: true, command: "/mcp" });
    await act(async () => {
      await outboundInput.handleCommandExecution("session-1", "/mcp connect server-1");
      await flushEffects();
    });
    expect(fetchMcpServersMock).toHaveBeenCalled();
    expect(fetchMcpTemplatesMock).toHaveBeenCalled();
    expect(sessionData.setMcpServers).toHaveBeenCalledWith([
      { serverId: "server-1", label: "Server", status: "connected" },
    ]);

    parseChatCommandMock.mockResolvedValueOnce({ ok: true, command: "/goal", message: "Goal paused." });
    await act(async () => {
      await outboundInput.handleCommandExecution("session-1", "/goal pause");
      await flushEffects();
    });
    expect(parseChatCommandMock).toHaveBeenLastCalledWith("session-1", "/goal pause", { surface: "cowork" });

    parseChatCommandMock.mockClear();
    await act(async () => {
      await outboundInput.handleCommandExecution("session-1", "/queue followup run focused tests");
      await flushEffects();
    });
    expect(parseChatCommandMock).not.toHaveBeenCalled();

    await act(async () => {
      await outboundInput.handleCommandExecution("session-1", "/btw quick aside");
      await flushEffects(4);
    });
    expect(parseChatCommandMock).not.toHaveBeenCalled();
    expect(createChatSideChatMock).toHaveBeenCalledWith(
      "session-1",
      { createdFromSurface: "cowork", sourceTurnId: undefined },
      { originSurface: "cowork" },
    );
    expect(streamAgentChatMessageMock).toHaveBeenCalledWith(
      "session-btw",
      expect.objectContaining({
        content: "quick aside",
        mode: "chat",
        sideChatContext: expect.objectContaining({
          parentSessionId: "session-1",
          originSurface: "cowork",
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

  it("handles compact drawers, dirty workbench confirms, and route acknowledgement guards", async () => {
    mockCompact = true;
    mockSurfaceMode = "code";
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

    const { renderer } = await renderHost({ lockSurface: true, surface: "code", onNavigateSurface: navigateSurface });
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

    await act(async () => {
      latestSurfaceInput?.sessionRail.onSelectSession("session-2", { turnId: "turn-2" });
      await flushEffects();
    });

    setupMocks();
    mockCompact = true;
    mockSurfaceMode = "code";
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
          surface="code"
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
      {
        attachmentId: "doc-ready",
        fileName: "notes.txt",
        mediaType: "text",
        mimeType: "text/plain",
        extractStatus: "ready",
        extractPreview: "Operator notes",
      },
      {
        attachmentId: "doc-pending",
        fileName: "paper.pdf",
        mediaType: "file",
        mimeType: "application/pdf",
        extractStatus: "pending",
      },
      {
        attachmentId: "image-1",
        fileName: "image.png",
        mediaType: "image",
        mimeType: "image/png",
      },
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
      await outboundInput.handleCommandExecution("session-1", "/plan advisory");
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
    expect(useChatRoutePreflightMock.mock.calls.at(-1)?.[0].prefs).toEqual(expect.objectContaining({ mode: "cowork" }));

    for (const item of [
      { mode: "chat" as ChatMode, lockSurface: true },
      { mode: "code" as ChatMode, lockSurface: false },
      { mode: "cowork" as ChatMode, lockSurface: false },
    ]) {
      setupMocks();
      mockSurfaceMode = item.mode;
      useChatThreadControllerMock.mockReturnValue({
        ...useChatThreadControllerMock(),
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
      { attachmentId: "doc-json", fileName: "data.json", mediaType: "file", mimeType: "application/json" },
      { attachmentId: "doc-xml", fileName: "data.xml", mediaType: "file", mimeType: "application/xml" },
      { attachmentId: "doc-yaml", fileName: "data.yaml", mediaType: "file", mimeType: "application/x-yaml" },
      { attachmentId: "doc-csv", fileName: "data.csv", mediaType: "file", mimeType: "text/csv" },
      { attachmentId: "doc-md", fileName: "notes.md", mediaType: "file", mimeType: "text/markdown" },
      {
        attachmentId: "doc-preview",
        fileName: "preview.bin",
        mediaType: "file",
        mimeType: "application/octet-stream",
        extractPreview: "preview",
      },
      { attachmentId: "doc-ocr", fileName: "scan.png", mediaType: "file", mimeType: "image/png", ocrText: "ocr" },
      {
        attachmentId: "doc-transcript",
        fileName: "call.mp3",
        mediaType: "file",
        mimeType: "audio/mpeg",
        transcriptText: "transcript",
      },
      { attachmentId: "doc-message", fileName: "message.txt", mediaType: "text", mimeType: "text/plain" },
      { attachmentId: "image-ignored", fileName: "image.png", mediaType: "image", mimeType: "image/png" },
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
      JSON.stringify([{ attachmentId: "doc-error", fileName: "error.txt", mediaType: "text", mimeType: "text/plain" }]),
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
      expect.objectContaining({ language: "typescript", originSurface: "code" }),
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

  it("starts a new thread with selected conversation context attached", async () => {
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
      await flushEffects(12);
    });

    expect(createChatSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        mode: "chat",
        projectId: "project-1",
        title: "Trail from Launch plan",
      }),
      { originSurface: "chat" },
    );
    expect(updateChatSessionPrefsMock).toHaveBeenCalledWith(
      "session-new",
      expect.objectContaining({
        providerId: "openai",
        model: "gpt-5.5",
        webMode: "auto",
      }),
    );
    expect(latestSurfaceInput?.activeSessionSurfaceProps?.outboundContext).toMatchObject({
      label: "1 selected turn",
      sourceLabel: "Launch plan",
      sessionId: "session-new",
      turnIds: ["turn-1"],
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
      await outboundInput?.ensureFreshRoutePreflight({ content: "refresh route" });
      expect(outboundInput?.isRoutePreflightAcknowledged("route-hash")).toBe(false);
      latestSurfaceInput?.activeSessionSurfaceProps?.onAcknowledgeRouteBoundary();
      await flushEffects(4);
      const acknowledgedOutboundInput = useChatOutboundExecutionMock.mock.calls.at(-1)?.[0] as any;
      acknowledgedOutboundInput?.isRoutePreflightAcknowledged("route-hash");
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

    await renderHost();
    await act(async () => {
      latestSurfaceInput?.emptyStateProps.onOpenCowork();
      latestSurfaceInput?.emptyStateProps.onOpenCode();
      latestSurfaceInput?.emptyStateProps.onOpenTasks();
      latestSurfaceInput?.emptyStateProps.onOpenApprovals();
      await flushEffects(4);
    });

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
});
