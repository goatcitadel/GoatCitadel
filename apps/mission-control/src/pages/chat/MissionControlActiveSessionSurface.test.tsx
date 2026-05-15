import React, { createRef } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionControlActiveSessionSurfaceProps } from "./MissionControlActiveSessionSurface";

const mediaQueryMock = vi.hoisted(() => vi.fn());

vi.mock("../../hooks/useMediaQuery", () => ({
  useMediaQuery: mediaQueryMock,
}));

vi.mock("./MissionControlSurfaceHeader", () => ({
  MissionControlSurfaceHeader: ({ mode, sessionTitle, summary, dockOpen, onToggleDock, onNavigateSurface }: any) => (
    <header>
      <h1>
        {mode}:{sessionTitle}
      </h1>
      <p>{summary}</p>
      <span>{dockOpen ? "dock-open" : "dock-closed"}</span>
      <button type="button" onClick={onToggleDock}>
        toggle-dock
      </button>
      <button type="button" onClick={() => onNavigateSurface("code")}>
        navigate-code
      </button>
    </header>
  ),
}));

vi.mock("./ChatThreadShell", () => ({
  ChatThreadShell: ({
    mode,
    loading,
    selectedTurnId,
    queuedCount,
    streamError,
    workspaceId,
    onRefresh,
    onSelectTurn,
  }: any) => (
    <section>
      <h2>thread-{mode}</h2>
      <p>{loading ? "loading" : "ready"}</p>
      <p>selected:{selectedTurnId ?? "none"}</p>
      <p>queued:{queuedCount}</p>
      <p>workspace:{workspaceId}</p>
      {streamError ? <p>{streamError}</p> : null}
      <button type="button" onClick={onRefresh}>
        refresh-thread
      </button>
      <button type="button" onClick={() => onSelectTurn("turn-2")}>
        select-turn
      </button>
    </section>
  ),
}));

vi.mock("./ChatComposerShell", () => ({
  ChatComposerShell: ({
    mode,
    draft,
    canSend,
    sending,
    routeBoundaryAckRequired,
    onDraftChange,
    onSend,
    onStopActiveTurn,
  }: any) => (
    <footer>
      <h2>composer-{mode}</h2>
      <p>{draft}</p>
      <p>{canSend ? "can-send" : "cannot-send"}</p>
      <p>{sending ? "sending" : "idle"}</p>
      <p>{routeBoundaryAckRequired ? "ack-required" : "ack-clear"}</p>
      <button type="button" onClick={() => onDraftChange("updated draft")}>
        change-draft
      </button>
      <button type="button" onClick={onSend}>
        send
      </button>
      <button type="button" onClick={onStopActiveTurn}>
        stop
      </button>
    </footer>
  ),
}));

vi.mock("../../components/ui", () => ({
  Sheet: ({
    open,
    onOpenChange,
    children,
  }: {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    children?: React.ReactNode;
  }) =>
    open ? (
      <aside>
        <button type="button" onClick={() => onOpenChange?.(false)}>
          close-sheet
        </button>
        {children}
      </aside>
    ) : null,
  SheetContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children?: React.ReactNode }) => <p>{children}</p>,
  SheetHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children?: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("../../components/chat/GeneratedArtifactViewer", () => ({
  GeneratedArtifactViewer: ({ artifact, compact }: any) => (
    <div>
      artifact:{artifact.artifactId}:{artifact.title}:{compact ? "compact" : "full"}
    </div>
  ),
}));

import { MissionControlActiveSessionSurface } from "./MissionControlActiveSessionSurface";

function rendererText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON()).replaceAll('","', "");
}

function findButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find((button) => button.props.children === label);
}

function buildProps(overrides: Partial<MissionControlActiveSessionSurfaceProps> = {}) {
  return {
    mode: "code",
    sessionTitle: "Legacy Mission Control",
    summary: "Reduce strict coverage debt.",
    trust: { label: "Verified", tone: "success", description: "Runtime evidence is available." },
    providerOptions: [],
    selectedProviderId: "openai",
    selectedModel: "gpt-5.4-mini",
    modelSwitchDisabled: false,
    dockOpen: true,
    onToggleDock: vi.fn(),
    onNavigateSurface: vi.fn(),
    onRequestProviderChange: vi.fn(),
    onRequestModelChange: vi.fn(),
    loading: false,
    thread: null,
    selectedTurnId: "turn-1",
    delegationRun: null,
    notices: [],
    followOutput: true,
    streamStatus: "idle",
    queuedCount: 2,
    streamError: "stream paused",
    streamErrorSource: "send",
    pendingApproval: null,
    pendingUserInput: null,
    workspaceId: "workspace-1",
    approvalPending: false,
    userInputPending: false,
    eventStreamStatus: "connected",
    onBottomStateChange: vi.fn(),
    onSelectTurn: vi.fn(),
    onSwitchBranch: vi.fn(),
    onRetryTurn: vi.fn(),
    onEditTurn: vi.fn(),
    onOpenRunDetails: vi.fn(),
    onOpenGeneratedArtifact: vi.fn(),
    onCreateGeneratedArtifact: vi.fn(),
    onCreateGeneratedArtifactVersion: vi.fn(),
    onApprovePending: vi.fn(),
    onDenyPending: vi.fn(),
    onSubmitUserInput: vi.fn(),
    onRefreshThread: vi.fn(),
    isDragActive: false,
    queueItems: [],
    editingTurnId: null,
    planningMode: "off",
    effectiveToolAutonomy: "manual",
    draft: "Ship focused tests",
    commandSuggestions: [],
    commandIndex: 0,
    pendingAttachments: [],
    pendingAttachmentModes: {},
    threadKnowledgeAttachments: [],
    presetOptions: [],
    selectedPresetId: null,
    presetApplyWarning: null,
    selectedTurnRecovery: null,
    selectedTurn: null,
    selectedSessionId: "session-1",
    currentWebMode: "auto",
    routePreflight: null,
    routeBoundaryAckRequired: true,
    routeBoundaryAcknowledged: false,
    sending: false,
    canSend: true,
    hasActiveStream: false,
    activeStreamTurnAssigned: false,
    composerRef: createRef<HTMLTextAreaElement>(),
    fileInputRef: createRef<HTMLInputElement>(),
    audioInputRef: createRef<HTMLInputElement>(),
    onDragEnter: vi.fn(),
    onDragOver: vi.fn(),
    onDragLeave: vi.fn(),
    onDrop: vi.fn(),
    onResumeAll: vi.fn(),
    onRemoveQueuedItem: vi.fn(),
    onCancelEdit: vi.fn(),
    onDismissError: vi.fn(),
    onAcknowledgeRouteBoundary: vi.fn(),
    onSetDeepMode: vi.fn(),
    onReviewRunDetails: vi.fn(),
    onDraftChange: vi.fn(),
    onComposerKeyDown: vi.fn(),
    onComposerPaste: vi.fn(),
    onApplyDraftCommand: vi.fn(),
    onPresetChange: vi.fn(),
    onApplyPreset: vi.fn(),
    onDismissPresetWarning: vi.fn(),
    onSetAttachmentMode: vi.fn(),
    onRemoveThreadKnowledgeAttachment: vi.fn(),
    knowledgeUrlDraft: "",
    knowledgeUrlMode: "url",
    onKnowledgeUrlDraftChange: vi.fn(),
    onKnowledgeUrlModeChange: vi.fn(),
    onAttachKnowledgeUrl: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onAttachFiles: vi.fn(),
    onUploadFiles: vi.fn(),
    onRunQuickResearch: vi.fn(),
    voiceBusy: false,
    voiceInputAvailable: false,
    voiceOutputAvailable: false,
    voiceTalkActive: false,
    voiceStatusLabel: "Voice off",
    voiceUnavailableReason: "No device",
    speakResponsesEnabled: false,
    imageBusy: false,
    imageGenerationAvailable: false,
    imageEditAvailable: false,
    imageProviderOptions: [],
    selectedImageProviderId: undefined,
    selectedImageModel: undefined,
    imageRouteSwitchDisabled: false,
    imageRouteLabel: "Images",
    onRequestImageProviderChange: vi.fn(),
    onRequestImageModelChange: vi.fn(),
    onToggleVoiceTalk: vi.fn(),
    onOpenAudioTranscribe: vi.fn(),
    onAudioFileSelected: vi.fn(),
    onToggleSpeakResponses: vi.fn(),
    onGenerateImage: vi.fn(),
    onEditImage: vi.fn(),
    activeGeneratedArtifact: null,
    onCloseGeneratedArtifact: vi.fn(),
    onStopActiveTurn: vi.fn(),
    onSend: vi.fn(),
    ...overrides,
  } as MissionControlActiveSessionSurfaceProps;
}

describe("MissionControlActiveSessionSurface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mediaQueryMock.mockReturnValue(false);
  });

  it("renders the active session header, thread shell, composer shell, and forwards primary actions", () => {
    const props = buildProps();
    const renderer = create(<MissionControlActiveSessionSurface {...props} />);

    const text = rendererText(renderer);
    expect(text).toContain("code:Legacy Mission Control");
    expect(text).toContain("Reduce strict coverage debt.");
    expect(text).toContain("thread-code");
    expect(text).toContain("queued:2");
    expect(text).toContain("workspace:workspace-1");
    expect(text).toContain("composer-code");
    expect(text).toContain("Ship focused tests");
    expect(text).toContain("ack-required");
    expect(text).not.toContain("artifact:");

    act(() => {
      findButton(renderer, "toggle-dock")?.props.onClick();
      findButton(renderer, "navigate-code")?.props.onClick();
      findButton(renderer, "refresh-thread")?.props.onClick();
      findButton(renderer, "select-turn")?.props.onClick();
      findButton(renderer, "change-draft")?.props.onClick();
      findButton(renderer, "send")?.props.onClick();
      findButton(renderer, "stop")?.props.onClick();
    });

    expect(props.onToggleDock).toHaveBeenCalledTimes(1);
    expect(props.onNavigateSurface).toHaveBeenCalledWith("code");
    expect(props.onRefreshThread).toHaveBeenCalledTimes(1);
    expect(props.onSelectTurn).toHaveBeenCalledWith("turn-2");
    expect(props.onDraftChange).toHaveBeenCalledWith("updated draft");
    expect(props.onSend).toHaveBeenCalledTimes(1);
    expect(props.onStopActiveTurn).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it("opens the generated artifact sheet on compact layouts and closes it through Sheet state", () => {
    mediaQueryMock.mockReturnValue(true);
    const props = buildProps({
      activeGeneratedArtifact: {
        artifactId: "artifact-1",
        kind: "markdown",
        title: "Review handoff",
        sourceSurface: "code",
      } as any,
    });
    const renderer = create(<MissionControlActiveSessionSurface {...props} />);

    const text = rendererText(renderer);
    expect(text).toContain("Review handoff");
    expect(text).toContain("Generated markdown artifact from code.");
    expect(text).toContain("artifact:artifact-1:Review handoff:compact");

    act(() => {
      findButton(renderer, "close-sheet")?.props.onClick();
    });

    expect(props.onCloseGeneratedArtifact).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });
});
