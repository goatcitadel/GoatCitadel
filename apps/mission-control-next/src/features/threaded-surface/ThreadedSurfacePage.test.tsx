import React from "react";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ThreadedSurfacePage } from "./ThreadedSurfacePage";

function buildInput() {
  const noop = vi.fn();
  return {
    messageMode: "cowork",
    sessionRailOpen: true,
    onSessionRailOpenChange: noop,
    dockOpen: false,
    onDockOpenChange: noop,
    activeSessionSurfaceProps: null,
    workflowPanel: null,
    contextDockProps: null,
    emptyStateProps: {
      mode: "cowork",
      sessionCount: 1,
      projectCount: 0,
      workspaceName: "Default workspace",
      approvalsCount: 0,
      onCreateSession: noop,
      onOpenCowork: noop,
      onOpenCode: noop,
      onOpenTasks: noop,
      onOpenApprovals: noop,
    },
    dropTargetProps: {
      isDragActive: false,
      fileInputRef: createRef<HTMLInputElement>(),
      onAttachFiles: noop,
      onUploadFiles: noop,
      onDragEnter: noop,
      onDragOver: noop,
      onDragLeave: noop,
      onDrop: noop,
    },
    sessionRail: {
      mode: "cowork",
      showProjectCreate: false,
      creatingSession: false,
      search: "",
      projectName: "",
      projectPath: "",
      historyView: "active",
      selectedProjectId: "all",
      availableFolders: [],
      selectedFolderId: "all",
      selectedTag: null,
      missionSessions: [
        {
          sessionId: "parent-1",
          sessionKey: "mission:operator:parent",
          scope: "mission",
          mode: "cowork",
          includeInHistory: true,
          title: "Main Cowork run",
          pinned: false,
          lifecycleStatus: "active",
          channel: "mission",
          account: "operator",
          updatedAt: "2026-05-03T16:00:00.000Z",
          lastActivityAt: "2026-05-03T16:00:00.000Z",
          tokenTotal: 0,
          costUsdTotal: 0,
        },
        {
          sessionId: "child-1",
          sessionKey: "mission:operator:child",
          scope: "mission",
          mode: "cowork",
          includeInHistory: true,
          title: "Delegate · Work",
          pinned: false,
          lifecycleStatus: "active",
          channel: "mission",
          account: "operator",
          updatedAt: "2026-05-03T16:01:00.000Z",
          lastActivityAt: "2026-05-03T16:01:00.000Z",
          tokenTotal: 0,
          costUsdTotal: 0,
          delegationParent: {
            parentSessionId: "parent-1",
            runId: "run-1",
            stepId: "step-1",
            role: "worker",
            label: "Work",
            index: 0,
          },
        },
      ],
      externalSessions: [],
      selectedSessionId: "parent-1",
      summaryTitle: "Cowork",
      summaryCopy: "Runs",
      workspaceSummaryCards: [],
      onToggleProjectCreate: noop,
      onCreateSession: noop,
      onSearchChange: noop,
      onProjectNameChange: noop,
      onProjectPathChange: noop,
      onCreateProject: noop,
      onHistoryViewChange: noop,
      onSelectProjectId: noop,
      onSelectFolderId: noop,
      onSelectTag: noop,
      onSelectSession: noop,
      renderSessionLabel: (sessionId: string) => sessionId,
    },
  };
}

function buildActiveSessionProps(overrides: Partial<any> = {}) {
  const noop = vi.fn();
  return {
    mode: "chat",
    sessionTitle: "Smoke Chat Session",
    summary: "Current session: Smoke Chat Session.",
    trust: {
      workspaceLabel: "Default workspace",
      gatewayTone: "muted",
      gatewayLabel: "Gateway ready",
      approvalsSummary: "Decisions clear",
      activeModeLabel: "Chat",
      providerModelSummary: "OpenAI / gpt-test",
      runtimeTone: "muted",
      runtimeSummary: "Runtime ready",
      fallbackSummary: null,
      fallbackTone: "warning",
      selectionSourceSummary: "Selection: session",
      runStateSummary: "Run: completed",
    },
    providerOptions: [],
    selectedProviderId: "",
    selectedModel: "",
    modelSwitchDisabled: false,
    sessionLifecycleStatus: "active",
    sessionArchivePending: false,
    dockOpen: false,
    onToggleDock: noop,
    onToggleArchiveSession: noop,
    onNavigateSurface: noop,
    onRequestProviderChange: noop,
    onRequestModelChange: noop,
    loading: false,
    thread: { sessionId: "session-1", turns: [] },
    selectedTurnId: null,
    delegationRun: null,
    notices: [],
    followOutput: false,
    streamStatus: "idle",
    queuedCount: 0,
    streamError: null,
    streamErrorSource: null,
    pendingApproval: null,
    pendingUserInput: null,
    workspaceId: "default",
    approvalPending: false,
    userInputPending: false,
    eventStreamStatus: { state: "open", reconnectAttempts: 0 },
    onBottomStateChange: noop,
    onSelectTurn: noop,
    onSwitchBranch: noop,
    onRetryTurn: noop,
    onEditTurn: noop,
    onOpenRunDetails: noop,
    onExportRunBundle: noop,
    onOpenGeneratedArtifact: noop,
    onCreateGeneratedArtifact: noop,
    onCreateGeneratedArtifactVersion: noop,
    onApprovePending: noop,
    onDenyPending: noop,
    onSubmitUserInput: noop,
    onRefreshThread: noop,
    isDragActive: false,
    queueItems: [],
    editingTurnId: null,
    planningMode: "off",
    draft: "",
    commandSuggestions: [],
    commandIndex: 0,
    pendingAttachments: [],
    threadKnowledgeAttachments: [],
    presetOptions: [],
    selectedPresetId: "",
    presetApplyWarning: null,
    selectedTurnRecovery: null,
    selectedTurn: null,
    selectedSessionId: "session-1",
    currentWebMode: "auto",
    routePreflight: null,
    routePreflightLoading: false,
    routePreflightError: null,
    routeBoundaryAckRequired: false,
    routeBoundaryAcknowledged: false,
    sending: false,
    canSend: true,
    hasActiveStream: false,
    activeStreamTurnAssigned: false,
    composerRef: createRef<HTMLTextAreaElement>(),
    fileInputRef: createRef<HTMLInputElement>(),
    audioInputRef: createRef<HTMLInputElement>(),
    onDragEnter: noop,
    onDragOver: noop,
    onDragLeave: noop,
    onDrop: noop,
    onResumeAll: noop,
    onRemoveQueuedItem: noop,
    onCancelEdit: noop,
    onDismissError: noop,
    onAcknowledgeRouteBoundary: noop,
    onTogglePlanningMode: noop,
    onSetDeepMode: noop,
    onReviewRunDetails: noop,
    onDraftChange: noop,
    onComposerKeyDown: noop,
    onComposerPaste: noop,
    onApplyDraftCommand: noop,
    onPresetChange: noop,
    onApplyPreset: noop,
    onDismissPresetWarning: noop,
    onSetAttachmentMode: noop,
    onRemoveThreadKnowledgeAttachment: noop,
    knowledgeUrlDraft: "",
    knowledgeUrlMode: "retrieval",
    onKnowledgeUrlDraftChange: noop,
    onKnowledgeUrlModeChange: noop,
    onAttachKnowledgeUrl: noop,
    onRemoveAttachment: noop,
    onAttachFiles: noop,
    onUploadFiles: noop,
    onRunQuickResearch: noop,
    voiceInputAvailable: false,
    voiceOutputAvailable: false,
    voiceBusy: false,
    voiceTalkActive: false,
    speakResponsesEnabled: false,
    imageGenerationAvailable: true,
    imageEditAvailable: true,
    imageBusy: false,
    onAudioFileSelected: noop,
    onToggleVoiceTalk: noop,
    onOpenAudioTranscribe: noop,
    onToggleSpeakResponses: noop,
    onGenerateImage: noop,
    onEditImage: noop,
    activeGeneratedArtifact: null,
    onStopActiveTurn: noop,
    onSend: noop,
    ...overrides,
  };
}

describe("ThreadedSurfacePage", () => {
  it("hides delegated child sessions under a collapsed parent by default", () => {
    const markup = renderToStaticMarkup(<ThreadedSurfacePage surface="cowork" input={buildInput() as any} />);

    expect(markup).toContain("Main Cowork run");
    expect(markup).toContain("Expand delegated chats");
    expect(markup).not.toContain("Delegate · Work");
  });

  it("renders a quick archive action for active sessions", () => {
    const markup = renderToStaticMarkup(
      <ThreadedSurfacePage
        surface="chat"
        input={
          {
            ...buildInput(),
            messageMode: "chat",
            activeSessionSurfaceProps: buildActiveSessionProps({ sessionLifecycleStatus: "active" }),
            emptyStateProps: null,
          } as any
        }
      />,
    );

    expect(markup).toContain(">Archive<");
  });

  it("renders a quick restore action for archived sessions", () => {
    const markup = renderToStaticMarkup(
      <ThreadedSurfacePage
        surface="chat"
        input={
          {
            ...buildInput(),
            messageMode: "chat",
            activeSessionSurfaceProps: buildActiveSessionProps({ sessionLifecycleStatus: "archived" }),
            emptyStateProps: null,
          } as any
        }
      />,
    );

    expect(markup).toContain(">Restore<");
  });
});
