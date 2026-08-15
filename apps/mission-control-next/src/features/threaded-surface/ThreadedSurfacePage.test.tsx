import { readFileSync } from "node:fs";
import React from "react";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";

const mediaQueryMock = vi.hoisted(() => ({
  matches: new Map<string, boolean>(),
}));

vi.mock("@goatcitadel/mission-control-shared/hooks/useMediaQuery", () => ({
  useMediaQuery: (query: string) => mediaQueryMock.matches.get(query) ?? false,
}));

import {
  ThreadedSurfacePage,
  formatRelativeTime,
  formatThreadedPermissionSummary,
  getDrawerFocusableElements,
  getArchiveActionLabel,
  panelOwnsActiveFocus,
  resolveDrawerTabTarget,
} from "./ThreadedSurfacePage";

vi.mock("./ThreadedWorkflowPanel", () => ({
  ThreadedWorkflowPanel: ({ panel }: { panel: { kind: string } }) => (
    <div className="mock-threaded-workflow-panel">{panel.kind}</div>
  ),
}));

vi.mock("./ThreadedContextDrawer", () => ({
  ThreadedContextDrawer: ({ surface }: { surface: string }) => (
    <div className="mock-threaded-context-drawer">{surface}</div>
  ),
}));

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
    btwSideChatProps: {
      open: false,
      workspaceId: "default",
      parentSessionId: "parent-1",
      parentTitle: "Main Plan run",
      childSessionId: null,
      thread: null,
      draft: "",
      loading: false,
      sending: false,
      error: null,
      onClose: noop,
      onDraftChange: noop,
      onSend: noop,
    },
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
      onOpenStartHere: noop,
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
          title: "Main Plan run",
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
    onModeOverride: noop,
    onRequestProviderChange: noop,
    onRequestModelChange: noop,
    loading: false,
    historicalWindow: null,
    historicalWindowLoading: false,
    historicalWindowError: null,
    onReturnToLatest: noop,
    historicalContinuationLoading: null,
    historicalContinuationError: null,
    onLoadHistoricalContinuation: noop,
    historicalReadOnly: false,
    thread: { sessionId: "session-1", turns: [] },
    selectedTurnId: null,
    selectedContextTurnIds: [],
    outboundContext: null,
    contextSelection: null,
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
    onToggleContextTurn: noop,
    onClearContextSelection: noop,
    onStartNewThreadFromTurn: noop,
    onSwitchBranch: noop,
    onRetryTurn: noop,
    onEditTurn: noop,
    onOpenRunDetails: noop,
    onExportRunBundle: noop,
    onOpenGeneratedArtifact: noop,
    onCreateGeneratedArtifact: noop,
    onCreateGeneratedArtifactVersion: noop,
    onOpenPersonalitiesSettings: noop,
    onOpenLibraryArtifacts: noop,
    onOpenOpsRuntime: noop,
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
    currentReviewDepth: "off",
    fullWebAccess: false,
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
    onToggleResearchMode: noop,
    onToggleReviewMode: noop,
    onSetDeepMode: noop,
    onFullWebAccessChange: noop,
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

function collectText(node: ReactTestInstance): string {
  return node.children
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") {
        return String(child);
      }
      return collectText(child);
    })
    .join(" ");
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const normalizedLabel = normalizeText(label);
  const button = root.findAll(
    (node) => node.type === "button" && normalizeText(collectText(node)).includes(normalizedLabel),
  )[0];
  if (!button) {
    const available = root
      .findAll((node) => node.type === "button")
      .map((node) => collectText(node) || node.props["aria-label"])
      .join(", ");
    throw new Error(`Unable to find button: ${label}. Available: ${available}`);
  }
  return button;
}

function findExactButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const button = root.findAll((node) => node.type === "button" && normalizeText(collectText(node)) === label)[0];
  if (!button) {
    throw new Error(`Unable to find exact button: ${label}`);
  }
  return button;
}

function findButtonByAriaLabel(root: ReactTestInstance, ariaLabel: string): ReactTestInstance {
  return root.findByProps({ "aria-label": ariaLabel });
}

function findSessionRailTrigger(root: ReactTestInstance): ReactTestInstance {
  const button = root.findAll(
    (node) => node.type === "button" && node.props["aria-controls"] === "mc-next-threaded-session-rail",
  )[0];
  if (!button) {
    throw new Error("Unable to find the Threads trigger");
  }
  return button;
}

function setMediaQuery(query: string, matches: boolean) {
  mediaQueryMock.matches.set(query, matches);
}

beforeEach(() => {
  mediaQueryMock.matches.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ThreadedSurfacePage", () => {
  it("assigns Escape to the panel that contains the active element when both desktop panels are open", () => {
    const activityFocusTarget = {} as Node;
    const railFocusTarget = {} as Node;
    const rail = { contains: (node: Node | null) => node === railFocusTarget } as Pick<HTMLElement, "contains">;
    const activity = { contains: (node: Node | null) => node === activityFocusTarget } as Pick<HTMLElement, "contains">;

    expect(panelOwnsActiveFocus(rail, activityFocusTarget)).toBe(false);
    expect(panelOwnsActiveFocus(activity, activityFocusTarget)).toBe(true);
    expect(panelOwnsActiveFocus(rail, railFocusTarget)).toBe(true);
    expect(panelOwnsActiveFocus(activity, railFocusTarget)).toBe(false);
  });

  it("keeps mobile drawer tabbing inside reachable controls, including a closed details summary", () => {
    const closedDetails = {} as HTMLElement;
    const hiddenAncestor = {} as Element;
    const createFocusable = ({
      tagName = "BUTTON",
      parentElement = null,
      closed = null,
      hidden = false,
    }: {
      tagName?: string;
      parentElement?: HTMLElement | null;
      closed?: Element | null;
      hidden?: boolean;
    }) =>
      ({
        tabIndex: 0,
        tagName,
        parentElement,
        closest: (selector: string) => {
          if (selector === '[hidden], [aria-hidden="true"], [inert]') {
            return hidden ? hiddenAncestor : null;
          }
          if (selector === "details:not([open])") {
            return closed;
          }
          return null;
        },
      }) as unknown as HTMLElement;
    const summary = createFocusable({ tagName: "SUMMARY", parentElement: closedDetails, closed: closedDetails });
    const closedDetailButton = createFocusable({ closed: closedDetails });
    const hiddenButton = createFocusable({ hidden: true });
    const firstButton = createFocusable({});
    const lastButton = createFocusable({});
    const filterPanel = {
      querySelectorAll: vi.fn(() => [summary, closedDetailButton, hiddenButton, firstButton, lastButton]),
    } as unknown as HTMLElement;

    const focusable = getDrawerFocusableElements(filterPanel);
    expect(focusable).toEqual([summary, firstButton, lastButton]);

    const outside = {} as Node;
    const staleClosedDetailControl = {} as Node;
    const modalPanel = {
      contains: (node: Node | null) =>
        node === modalPanel || node === staleClosedDetailControl || focusable.includes(node as HTMLElement),
      focus: vi.fn(),
    } as unknown as HTMLElement;
    expect(resolveDrawerTabTarget({ activeElement: modalPanel, focusable, modalPanel, shiftKey: true })).toBe(
      lastButton,
    );
    expect(resolveDrawerTabTarget({ activeElement: summary, focusable, modalPanel, shiftKey: true })).toBe(lastButton);
    expect(resolveDrawerTabTarget({ activeElement: lastButton, focusable, modalPanel, shiftKey: false })).toBe(summary);
    expect(resolveDrawerTabTarget({ activeElement: outside, focusable, modalPanel, shiftKey: false })).toBe(summary);
    expect(
      resolveDrawerTabTarget({ activeElement: staleClosedDetailControl, focusable, modalPanel, shiftKey: true }),
    ).toBe(lastButton);
  });

  it("keeps desktop Threads closed until requested, then exposes a visible close control", async () => {
    setMediaQuery("(width < 1180px)", false);
    const input = buildInput() as any;
    input.sessionRailOpen = false;
    input.sessionRail.onCreateSession = vi.fn();

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<ThreadedSurfacePage surface="cowork" input={input} />);
    });

    let rail = renderer!.root.findByProps({ "aria-label": "Threads" });
    expect(rail.props.className).toBe("mc-next-threaded-rail");
    expect(rail.props["aria-hidden"]).toBe(true);
    expect(rail.props.inert).toBe(true);
    expect(rail.props.hidden).toBe(true);
    expect(renderer!.root.findByProps({ className: "mc-next-threaded-scrim" }).props.tabIndex).toBe(-1);
    expect(renderer!.root.findAllByProps({ "aria-label": "Resize session rail" })).toHaveLength(0);

    await act(async () => {
      findSessionRailTrigger(renderer!.root).props.onClick();
    });

    const root = renderer!.root.findByProps({ className: "mc-next-threaded-surface unified session-rail-open" });
    rail = renderer!.root.findByProps({ "aria-label": "Threads" });
    expect(root.props.style["--mc-session-rail-width"]).toBe("216px");
    expect(rail.props["aria-hidden"]).toBe(false);
    expect(rail.props.inert).toBe(false);
    expect(rail.props.hidden).toBe(false);
    expect(findButtonByAriaLabel(renderer!.root, "Close session rail").type).toBe("button");
    expect(findButtonByAriaLabel(renderer!.root, "Resize session rail").type).toBe("button");

    await act(async () => {
      findButton(renderer!.root, "New chat").props.onClick();
    });
    expect(input.sessionRail.onCreateSession).toHaveBeenCalledTimes(1);
    expect(input.onSessionRailOpenChange).not.toHaveBeenCalled();
    expect(renderer!.root.findByProps({ className: "mc-next-threaded-surface unified" })).toBeDefined();
  });

  it("only marks the mobile drawer rail inert while it is closed", async () => {
    setMediaQuery("(width < 1180px)", true);
    const input = buildInput() as any;
    input.sessionRailOpen = false;

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<ThreadedSurfacePage surface="cowork" input={input} />);
    });

    let rail = renderer!.root.findByProps({ "aria-label": "Threads" });
    expect(rail.props.className).toBe("mc-next-threaded-rail");
    expect(rail.props["aria-hidden"]).toBe(true);
    expect(rail.props.inert).toBe(true);
    expect(renderer!.root.findByProps({ className: "mc-next-threaded-scrim" }).props.tabIndex).toBe(-1);

    await act(async () => {
      renderer!.update(<ThreadedSurfacePage surface="cowork" input={{ ...input, sessionRailOpen: true }} />);
    });
    rail = renderer!.root.findByProps({ "aria-label": "Threads" });
    expect(rail.props.className).toBe("mc-next-threaded-rail open");
    expect(rail.props["aria-hidden"]).toBe(false);
    expect(rail.props.inert).toBe(false);
    expect(renderer!.root.findByProps({ className: "mc-next-threaded-scrim open" }).props.tabIndex).toBe(-1);
  });

  it("closes the mobile session drawer after starting a new chat", async () => {
    setMediaQuery("(width < 1180px)", true);
    const input = buildInput() as any;
    input.sessionRailOpen = true;
    input.onSessionRailOpenChange = vi.fn();
    input.sessionRail.onCreateSession = vi.fn();

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<ThreadedSurfacePage surface="chat" input={input} />);
    });

    await act(async () => {
      findButton(renderer!.root, "New chat").props.onClick();
    });

    expect(input.sessionRail.onCreateSession).toHaveBeenCalledTimes(1);
    expect(input.onSessionRailOpenChange).toHaveBeenCalledWith(false);
  });

  it("opens Activity as a modal mobile sheet and keeps it exclusive with Threads", async () => {
    setMediaQuery("(width < 1180px)", true);
    const input = {
      ...buildInput(),
      sessionRailOpen: false,
      dockOpen: false,
      activeSessionSurfaceProps: buildActiveSessionProps(),
      contextDockProps: {},
      onSessionRailOpenChange: vi.fn(),
      onDockOpenChange: vi.fn(),
    } as any;

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<ThreadedSurfacePage surface="chat" input={input} />);
    });

    await act(async () => {
      findExactButton(renderer!.root, "Activity").props.onClick();
    });
    const activity = renderer!.root.findByProps({ "aria-label": "Thread utility drawer" });
    expect(activity.props.role).toBe("dialog");
    expect(activity.props["aria-modal"]).toBe(true);
    expect(renderer!.root.findByProps({ className: "mc-next-threaded-context-scrim open" }).props.tabIndex).toBe(-1);
    // The desktop-only separator must not be present in the modal focus trap.
    expect(renderer!.root.findAllByProps({ "aria-label": "Resize right drawer" })).toHaveLength(0);

    await act(async () => {
      findButton(renderer!.root, "Threads").props.onClick();
    });
    expect(input.onDockOpenChange).toHaveBeenCalledWith(false);
    expect(input.onSessionRailOpenChange).toHaveBeenCalledWith(true);
    expect(renderer!.root.findAllByProps({ "aria-label": "Thread utility drawer" })).toHaveLength(0);
  });

  it("closes the mobile drawer with Escape or scrim and restores focus to the opener", async () => {
    setMediaQuery("(width < 1180px)", true);
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const openerFocus = vi.fn();
    class FakeHTMLElement {
      focus = openerFocus;
    }
    const opener = new FakeHTMLElement();
    vi.stubGlobal("HTMLElement", FakeHTMLElement);
    vi.stubGlobal("document", {
      activeElement: opener,
      contains: (node: unknown) => node === opener,
      addEventListener,
      removeEventListener,
    });

    const input = buildInput() as any;
    input.sessionRailOpen = false;
    input.onSessionRailOpenChange = vi.fn();

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<ThreadedSurfacePage surface="cowork" input={input} />);
    });

    await act(async () => {
      findButton(renderer!.root, "Threads").props.onClick();
    });
    expect(input.onSessionRailOpenChange).toHaveBeenCalledWith(true);

    await act(async () => {
      renderer!.update(<ThreadedSurfacePage surface="cowork" input={{ ...input, sessionRailOpen: true }} />);
    });
    const escapeHandler = addEventListener.mock.calls.find(([type]) => type === "keydown")?.[1] as
      | ((event: { key: string; preventDefault: () => void; stopPropagation: () => void }) => void)
      | undefined;
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    await act(async () => {
      escapeHandler?.({ key: "Escape", preventDefault, stopPropagation });
      await Promise.resolve();
    });
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
    expect(input.onSessionRailOpenChange).toHaveBeenCalledWith(false);
    expect(openerFocus).toHaveBeenCalledTimes(1);

    input.onSessionRailOpenChange.mockClear();
    openerFocus.mockClear();
    await act(async () => {
      renderer!.update(<ThreadedSurfacePage surface="cowork" input={{ ...input, sessionRailOpen: false }} />);
      await Promise.resolve();
    });
    await act(async () => {
      findButton(renderer!.root, "Threads").props.onClick();
    });
    await act(async () => {
      renderer!.update(<ThreadedSurfacePage surface="cowork" input={{ ...input, sessionRailOpen: true }} />);
    });
    await act(async () => {
      renderer!.root.findByProps({ className: "mc-next-threaded-scrim open" }).props.onClick();
      await Promise.resolve();
    });
    expect(input.onSessionRailOpenChange).toHaveBeenCalledWith(false);
    expect(openerFocus).toHaveBeenCalledTimes(1);
  });

  it("keeps high-specificity context grid selectors in both responsive collapse blocks", () => {
    const css = readFileSync(new URL("./styles/mobile.css", import.meta.url), "utf8");
    const selectors = [
      ".mc-next-threaded-stage.mode-chat.has-context",
      ".mc-next-threaded-stage.has-cowork-panel.has-context",
      ".mc-next-threaded-stage.has-code-panel.has-context",
    ];

    for (const blockHeader of ["@media (width < 1180px)", "@media (max-width: 1023px)"]) {
      const start = css.indexOf(blockHeader);
      const next = css.indexOf("@media", start + 1);
      const block = css.slice(start, next === -1 ? undefined : next);
      expect(start).toBeGreaterThanOrEqual(0);
      for (const selector of selectors) {
        expect(block).toContain(selector);
      }
    }
  });

  it("keeps the mobile drawer and chat status chips visible at the active breakpoint", () => {
    const css = readFileSync(new URL("./styles/mobile.css", import.meta.url), "utf8");
    const breakpointStart = css.indexOf("@media (width < 1180px)");
    const breakpointEnd = css.indexOf("@media", breakpointStart + 1);
    const block = css.slice(breakpointStart, breakpointEnd === -1 ? undefined : breakpointEnd);

    expect(breakpointStart).toBeGreaterThanOrEqual(0);
    expect(block).toContain(".mc-next-threaded-surface.unified .mc-next-threaded-rail");
    expect(block).toContain("width: min(100%, calc(100vw - 1.75rem))");
    expect(block).toContain("position: fixed");
    expect(block).toContain("visibility: hidden");
    expect(block).toContain("pointer-events: none");
    expect(block).toContain(".mc-next-threaded-surface.unified .mc-next-threaded-rail.open");
    expect(block).toContain("visibility: visible");
    expect(block).toContain("pointer-events: auto");
    expect(block).toContain(".mc-next-threaded-scrim.open");
    expect(block).toContain("z-index: var(--z-side-sheet)");
    expect(block).toContain("background: var(--bg-scrim)");
    expect(css).not.toContain(
      '.mc-next-threaded-surface.unified[data-mode="chat"] .mc-next-threaded-header-meta {\n    display: none;',
    );
  });

  it("keeps the composer in a dedicated anchored row while desktop panels stay bounded", () => {
    const workspaceCss = readFileSync(new URL("./styles/conversation-workspace.css", import.meta.url), "utf8");
    const timelineCss = readFileSync(new URL("./styles/timeline-frame.css", import.meta.url), "utf8");
    const markup = renderToStaticMarkup(
      <ThreadedSurfacePage
        surface="chat"
        input={
          {
            ...buildInput(),
            messageMode: "chat",
            activeSessionSurfaceProps: buildActiveSessionProps(),
            emptyStateProps: null,
          } as any
        }
      />,
    );

    expect(workspaceCss).toContain("grid-template-rows: minmax(0, 1fr) auto;");
    expect(workspaceCss).toContain(".mc-next-threaded-timeline-region");
    expect(workspaceCss).toContain("minmax(680px, 1fr)");
    expect(workspaceCss).toContain(".session-rail-open .mc-next-threaded-rail-head");
    expect(timelineCss).not.toContain(
      ".mc-next-surface-host-work .mc-next-threaded-surface.unified .mc-next-threaded-composer-card",
    );
    expect(markup.indexOf("mc-next-threaded-timeline-region")).toBeLessThan(
      markup.indexOf("mc-next-threaded-composer-card"),
    );
  });

  it("gives a compact model receipt its own slot above the one scrollable timeline", () => {
    const css = readFileSync(new URL("./styles/conversation-workspace.css", import.meta.url), "utf8");
    const timelineCss = readFileSync(new URL("./styles/timeline-frame.css", import.meta.url), "utf8");

    expect(css).toMatch(
      /\.mc-next-threaded-surface\.unified \.mc-next-threaded-thread-card\s*\{[\s\S]*?display: flex;[\s\S]*?flex-direction: column;[\s\S]*?overflow: hidden;/u,
    );
    // timeline-frame still owns a host-qualified grid baseline. The focused
    // workspace override must match that specificity; otherwise its generic
    // flex declaration loses and a receipt creates implicit, clipped grid rows.
    expect(timelineCss).toMatch(
      /\.mc-next-surface-host-work \.mc-next-threaded-surface\.unified \.mc-next-threaded-thread-card\s*\{[\s\S]*?display: grid;/u,
    );
    expect(css).toMatch(
      /\.mc-next-surface-host-work \.mc-next-threaded-surface\.unified \.mc-next-threaded-thread-card\s*\{[\s\S]*?display: flex;[\s\S]*?flex-direction: column;[\s\S]*?overflow: hidden;/u,
    );
    expect(css).toMatch(
      /\.mc-next-threaded-surface\.unified \.mc-next-threaded-thread-card > \.chat-change-plan-card\s*\{\s*flex: 0 0 auto;/u,
    );
    expect(css).toMatch(
      /\.mc-next-threaded-thread-card\s*> \.mc-next-thread-shell\s*\{[\s\S]*?flex: 1 1 auto;[\s\S]*?min-height: 0;[\s\S]*?height: auto;/u,
    );
    expect(css).toContain("@media (max-width: 1680px) and (max-height: 699px), (width < 1180px)");
  });

  it("keeps Activity and current-plan disclosure bodies out of layout until opened", () => {
    const workspaceCss = readFileSync(new URL("./styles/conversation-workspace.css", import.meta.url), "utf8");
    const headerCss = readFileSync(new URL("./styles/header.css", import.meta.url), "utf8");

    expect(workspaceCss).toContain(".mc-next-work-record-history:not([open]) > div,");
    expect(workspaceCss).toContain(".mc-next-work-record-session-actions:not([open]) > div,");
    expect(workspaceCss).toContain(".mc-next-work-record-history-item > details:not([open]) > div");
    expect(headerCss).toContain(".mc-next-threaded-execution-overview:not([open]) > div");
  });

  it("collapses narrow Cowork side-panel sections before text can overlap", () => {
    const css = readFileSync(new URL("./styles/composer.css", import.meta.url), "utf8");
    const start = css.indexOf("@container (max-width: 36rem)");
    const next = css.indexOf("@container", start + 1);
    const block = css.slice(start, next === -1 ? undefined : next);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(block).toContain(".mc-next-cowork-command-center");
    expect(block).toContain(".mc-next-cowork-command-action");
    expect(block).toContain("grid-column: auto");
    expect(block).toContain(".mc-next-cowork-intervention");
    expect(block).toContain("position: static");
    expect(block).toContain(".mc-next-cowork-checkpoint-list summary");
    expect(block).toContain("grid-template-columns: minmax(0, 1fr)");
  });

  it("keeps the compact turn-context label at the mobile touch-target floor", () => {
    const css = readFileSync(new URL("./styles/conversation-workspace.css", import.meta.url), "utf8");

    expect(css).toMatch(
      /\.mc-next-threaded-surface\.unified \.mc-next-thread-context-toggle\s*\{[\s\S]*?min-height: 1\.5rem;/u,
    );
  });

  it("keeps focused desktop header controls visible", () => {
    const css = readFileSync(new URL("./styles/conversation-workspace.css", import.meta.url), "utf8");

    expect(css).toContain(
      "> .mc-next-threaded-secondary:not(.mc-next-threaded-work-record):not(.mc-next-threaded-threads),",
    );
  });

  it("formats archive labels and session relative-time fallbacks", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00.000Z"));

    expect(getArchiveActionLabel("active", false)).toBe("Archive");
    expect(getArchiveActionLabel("archived", false)).toBe("Restore");
    expect(getArchiveActionLabel("active", true)).toBe("Archiving...");
    expect(getArchiveActionLabel("archived", true)).toBe("Restoring...");
    expect(formatRelativeTime()).toBe("Recent");
    expect(formatRelativeTime("not-a-date")).toBe("Recent");
    expect(formatRelativeTime("2026-05-14T11:45:00.000Z")).toBe("15m ago");
    expect(formatRelativeTime("2026-05-14T09:00:00.000Z")).toBe("3h ago");
    expect(formatRelativeTime("2026-05-12T12:00:00.000Z")).toBe("2d ago");
    expect(formatThreadedPermissionSummary({ profileLabel: "Safe", approvalMode: "approve_all" })).toBe(
      "Policy: Safe · asks every time",
    );
    expect(
      formatThreadedPermissionSummary({
        profileLabel: "Trusted Local Power",
        approvalMode: "bypass",
        localOperatorOverrideId: "override-1",
        overrideExpiresAt: "2026-05-17T20:30:00.000Z",
      }),
    ).toBe("Policy: Trusted Local Power · skips normal prompts · override until 20:30 UTC");
  });

  it("hides delegated child sessions under a collapsed parent by default", () => {
    const markup = renderToStaticMarkup(<ThreadedSurfacePage surface="cowork" input={buildInput() as any} />);

    expect(markup).toContain("Main Plan run");
    expect(markup).toContain("Expand delegated chats");
    expect(markup).toContain('aria-controls="mc-next-threaded-session-children-parent-1"');
    expect(markup).not.toContain("Delegate · Work");
  });

  it("keeps archive out of the focused header", () => {
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

    expect(markup).toContain(">Threads<");
    expect(markup).toContain(">Activity<");
    expect(markup).not.toContain(">Archive<");
  });

  it("normalizes Conversation, Plan, and Build stage posture into Chat", () => {
    const expectations = [
      ["chat", "chat", "Chat workspace stage"],
      ["cowork", "chat", "Chat workspace stage"],
      ["code", "chat", "Chat workspace stage"],
    ] as const;

    for (const [surface, posture, stageLabel] of expectations) {
      const markup = renderToStaticMarkup(
        <ThreadedSurfacePage
          surface={surface}
          input={
            {
              ...buildInput(),
              messageMode: surface,
              activeSessionSurfaceProps: buildActiveSessionProps({ mode: surface }),
              emptyStateProps: null,
            } as any
          }
        />,
      );

      expect(markup).toContain(`data-surface-intent="${posture}"`);
      expect(markup).toContain(`data-stage-posture="${posture}"`);
      expect(markup).toContain(`aria-label="${stageLabel}"`);
    }
  });

  it("keeps header status chips compact and session-specific", () => {
    const markup = renderToStaticMarkup(
      <ThreadedSurfacePage
        surface="code"
        permissionState={{
          profileLabel: "Trusted Local Power",
          approvalMode: "bypass",
          localOperatorOverrideId: "override-1",
        }}
        input={
          {
            ...buildInput(),
            messageMode: "code",
            activeSessionSurfaceProps: buildActiveSessionProps({ mode: "code" }),
            emptyStateProps: null,
          } as any
        }
      />,
    );

    // The composer-policy chip was deduplicated against the header chip; the
    // header now keeps only compact session-specific status, while full policy
    // and security wording lives in the context drawer.
    expect(markup).not.toContain('aria-label="Composer policy state"');
    expect(markup).not.toContain("Gateway ready");
    expect(markup).not.toContain("Gateway state unavailable");
    expect(markup).not.toContain("skips normal prompts");
    const policyChipMatches = markup.match(/title="Session policy posture"/g) ?? [];
    expect(policyChipMatches.length).toBe(1);
    expect(markup).toContain('aria-label="Model: OpenAI / gpt-test"');
    expect(markup).toContain('aria-label="Route: Selection: session"');
    expect(markup).toContain('aria-label="Runtime: Runtime ready · Run: completed"');
    expect(markup).not.toContain("Runtime detail");
    expect(markup).toContain('aria-label="Approvals: Decisions clear"');
    expect(markup).toContain("OpenAI / gpt-test");
    expect(markup).toContain("Selection: session");
    expect(markup).toContain("0 tokens");
    expect(markup).toContain("$0.00");
    expect(markup).toContain("Runtime ready");
    expect(markup).toContain("Decisions clear");
  });

  it("keeps persisted approval navigation while rendering one canonical decision card", () => {
    const markup = renderToStaticMarkup(
      <ThreadedSurfacePage
        surface="chat"
        input={
          {
            ...buildInput(),
            messageMode: "chat",
            activeSessionSurfaceProps: buildActiveSessionProps({
              approvalsCount: 1,
              pendingApproval: {
                approvalId: "11111111-2222-3333-4444-555555555555",
                kind: "tool_call",
                toolName: "filesystem.write",
              },
              trust: {
                ...buildActiveSessionProps().trust,
                approvalsSummary: "1 approval pending",
                runStateSummary: "Run: waiting for approval",
              },
            }),
            emptyStateProps: null,
          } as any
        }
      />,
    );

    expect(markup.match(/Approval required/g)).toHaveLength(1);
    expect(markup).toContain("Approvals (1)");
    expect(markup).toContain('aria-label="Approval identifier: 11111111-2222-3333-4444-555555555555"');
    expect(markup).not.toContain("mc-next-composer-blocked-actions");
  });

  it("keeps restore out of the focused header", () => {
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

    expect(markup).toContain(">Threads<");
    expect(markup).toContain(">Activity<");
    expect(markup).not.toContain(">Restore<");
  });

  it("wires session rail filters, project creation, file upload, and archive confirmation", async () => {
    setMediaQuery("(width < 1180px)", true);
    const input = buildInput() as any;
    input.onSessionRailOpenChange = vi.fn();
    input.dropTargetProps.onUploadFiles = vi.fn();
    Object.assign(input.sessionRail, {
      onToggleProjectCreate: vi.fn(),
      onCreateSession: vi.fn(),
      onSearchChange: vi.fn(),
      onProjectNameChange: vi.fn(),
      onProjectPathChange: vi.fn(),
      onCreateProject: vi.fn(),
      onHistoryViewChange: vi.fn(),
      onSelectProjectId: vi.fn(),
      onSelectFolderId: vi.fn(),
      onSelectTag: vi.fn(),
    });
    input.sessionRail.showProjectCreate = true;
    input.sessionRail.availableFolders = [{ folderId: "folder-1", name: "Ops", count: 2 }];
    input.sessionRail.selectedFolderId = "folder-1";
    input.sessionRail.selectedTag = "release";
    input.sessionRail.archiveWorkspaceEnabled = true;
    input.sessionRail.archiveWorkspaceCount = 3;
    input.sessionRail.archiveWorkspacePending = false;
    input.sessionRail.onConfirmArchiveWorkspace = vi.fn();

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<ThreadedSurfacePage surface="cowork" input={input} />);
    });

    expect(findButtonByAriaLabel(renderer!.root, "Hide project form").type).toBe("button");

    await act(async () => {
      renderer!.root.findByProps({ className: "mc-next-threaded-scrim open" }).props.onClick();
      findButtonByAriaLabel(renderer!.root, "Close session rail").props.onClick();
      findButton(renderer!.root, "New chat").props.onClick();
      findButton(renderer!.root, "Hide project").props.onClick();
      findButton(renderer!.root, "Active").props.onClick();
      findButton(renderer!.root, "Archived").props.onClick();
      findButton(renderer!.root, "All projects").props.onClick();
      findButton(renderer!.root, "Unassigned").props.onClick();
      findButton(renderer!.root, "All folders").props.onClick();
      findButton(renderer!.root, "No folder").props.onClick();
      findButton(renderer!.root, "Ops").props.onClick();
      findButton(renderer!.root, "release").props.onClick();
      findButton(renderer!.root, "Create project").props.onClick();
      findButton(renderer!.root, "Archive workspace threads").props.onClick();
    });

    const archiveConfirm = renderer!.root.findAllByType(ConfirmModal).find((modal) => modal.props.open);
    expect(archiveConfirm?.props.title).toBe("Archive workspace chats?");
    expect(archiveConfirm?.props.message).toContain("Archive 3 active mission chats");
    await act(async () => {
      archiveConfirm?.props.onConfirm();
    });

    const inputs = renderer!.root.findAllByType("input");
    await act(async () => {
      inputs
        .find((inputNode) => inputNode.props.placeholder === "Search threads")
        ?.props.onChange({
          target: { value: "deploy" },
        });
      inputs
        .find((inputNode) => inputNode.props.placeholder === "Project name")
        ?.props.onChange({
          target: { value: "Release" },
        });
      inputs
        .find((inputNode) => inputNode.props.placeholder === "Project path (optional)")
        ?.props.onChange({
          target: { value: "F:/code/release" },
        });
      inputs
        .find((inputNode) => inputNode.props.type === "file")
        ?.props.onChange({
          target: { files: ["artifact"] },
        });
    });

    expect(input.onSessionRailOpenChange).toHaveBeenCalledWith(false);
    expect(input.sessionRail.onCreateSession).toHaveBeenCalledTimes(1);
    expect(input.sessionRail.onToggleProjectCreate).toHaveBeenCalledTimes(1);
    expect(input.sessionRail.onSearchChange).toHaveBeenCalledWith("deploy");
    expect(input.sessionRail.onProjectNameChange).toHaveBeenCalledWith("Release");
    expect(input.sessionRail.onProjectPathChange).toHaveBeenCalledWith("F:/code/release");
    expect(input.sessionRail.onCreateProject).toHaveBeenCalledTimes(1);
    expect(input.sessionRail.onHistoryViewChange).toHaveBeenCalledWith("active");
    expect(input.sessionRail.onHistoryViewChange).toHaveBeenCalledWith("archived");
    expect(input.sessionRail.onSelectProjectId).toHaveBeenCalledWith("all");
    expect(input.sessionRail.onSelectProjectId).toHaveBeenCalledWith("none");
    expect(input.sessionRail.onSelectFolderId).toHaveBeenCalledWith("all");
    expect(input.sessionRail.onSelectFolderId).toHaveBeenCalledWith("none");
    expect(input.sessionRail.onSelectFolderId).toHaveBeenCalledWith("folder-1");
    expect(input.sessionRail.onSelectTag).toHaveBeenCalledWith(null);
    expect(input.dropTargetProps.onUploadFiles).toHaveBeenCalledWith(["artifact"]);
    expect(input.sessionRail.onConfirmArchiveWorkspace).toHaveBeenCalledTimes(1);
  });

  it("keeps archive disabled when confirmation is declined or unavailable", async () => {
    const declined = buildInput() as any;
    declined.sessionRail.archiveWorkspaceEnabled = true;
    declined.sessionRail.archiveWorkspaceCount = 0;
    declined.sessionRail.onConfirmArchiveWorkspace = vi.fn();

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<ThreadedSurfacePage surface="cowork" input={declined} />);
    });
    await act(async () => {
      findButton(renderer!.root, "Archive workspace threads").props.onClick();
    });
    const declinedConfirm = renderer!.root.findAllByType(ConfirmModal).find((modal) => modal.props.open);
    expect(declinedConfirm?.props.title).toBe("Archive workspace chats?");
    await act(async () => {
      declinedConfirm?.props.onCancel();
    });
    expect(declined.sessionRail.onConfirmArchiveWorkspace).not.toHaveBeenCalled();

    const unavailable = buildInput() as any;
    unavailable.sessionRail.archiveWorkspaceEnabled = true;
    unavailable.sessionRail.archiveWorkspacePending = true;
    unavailable.sessionRail.onConfirmArchiveWorkspace = vi.fn();
    await act(async () => {
      renderer = create(<ThreadedSurfacePage surface="cowork" input={unavailable} />);
    });
    await act(async () => {
      findButton(renderer!.root, "Archiving...").props.onClick();
    });
    // While pending, the button click is a no-op (handleArchiveWorkspace bails
    // before opening the modal), so no ConfirmModal becomes open and the
    // archive callback never fires.
    const unavailableConfirm = renderer!.root.findAllByType(ConfirmModal).find((modal) => modal.props.open);
    expect(unavailableConfirm).toBeUndefined();
    expect(unavailable.sessionRail.onConfirmArchiveWorkspace).not.toHaveBeenCalled();
  });

  it("wires active conversation route actions, dock toggles, uploads, and empty-state actions", async () => {
    vi.stubGlobal("HTMLElement", class HTMLElement {});
    const activeProps = buildActiveSessionProps({
      mode: "code",
      dockOpen: false,
      trust: {
        ...buildActiveSessionProps().trust,
        fallbackSummary: "Fallback in use",
        selectionSourceSummary: null,
        runStateSummary: null,
      },
      activeGeneratedArtifact: {
        artifactId: "artifact-1",
        title: "Run report",
        kind: "markdown",
        content: "# Report",
        sourceSurface: "code",
        version: 1,
      },
      onCloseGeneratedArtifact: vi.fn(),
      onNavigateSurface: vi.fn(),
      onToggleArchiveSession: vi.fn(),
    });
    const input = {
      ...buildInput(),
      messageMode: "code",
      dockOpen: false,
      activeSessionSurfaceProps: activeProps,
      emptyStateProps: null,
      contextDockProps: {},
      dropTargetProps: {
        ...(buildInput() as any).dropTargetProps,
        isDragActive: true,
        onDragEnter: vi.fn(),
        onDragOver: vi.fn(),
        onDragLeave: vi.fn(),
        onDrop: vi.fn(),
      },
    } as any;

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<ThreadedSurfacePage surface="code" input={input} />);
    });

    // The old cross-area nav buttons are replaced by a read-only Chat surface
    // readout. Verify the current control is present and the remaining header
    // actions still wire correctly.
    await act(async () => {
      findExactButton(renderer!.root, "Activity").props.onClick();
      const dropzone = renderer!.root.findAll(
        (node) =>
          typeof node.props.className === "string" && node.props.className.includes("mc-next-threaded-dropzone"),
      )[0]!;
      dropzone.props.onDragEnter();
      dropzone.props.onDragOver();
      dropzone.props.onDragLeave();
      dropzone.props.onDrop();
    });

    const modeControl = renderer!.root.findAll(
      (n) => typeof n.props.className === "string" && n.props.className.includes("mc-next-threaded-mode-control"),
    );
    expect(modeControl.length).toBeGreaterThan(0);
    expect(modeControl[0]!.props["data-mode"]).toBe("chat");
    findExactButton(renderer!.root, "Archive").props.onClick();
    expect(activeProps.onToggleArchiveSession).toHaveBeenCalledTimes(1);
    expect(input.onDockOpenChange).toHaveBeenCalledWith(true);
    expect(input.dropTargetProps.onDragEnter).toHaveBeenCalledTimes(1);
    expect(input.dropTargetProps.onDragOver).toHaveBeenCalledTimes(1);
    expect(input.dropTargetProps.onDragLeave).toHaveBeenCalledTimes(1);
    expect(input.dropTargetProps.onDrop).toHaveBeenCalledTimes(1);

    const emptyInput = {
      ...buildInput(),
      messageMode: "chat",
      activeSessionSurfaceProps: null,
      emptyStateProps: {
        ...(buildInput() as any).emptyStateProps,
        mode: "chat",
        onCreateSession: vi.fn(),
        onOpenCowork: vi.fn(),
        onOpenCode: vi.fn(),
        onOpenStartHere: vi.fn(),
      },
      dropTargetProps: {
        ...(buildInput() as any).dropTargetProps,
        isDragActive: true,
        onAttachFiles: vi.fn(),
      },
    } as any;
    await act(async () => {
      renderer = create(<ThreadedSurfacePage surface="chat" input={emptyInput} />);
    });
    expect(normalizeText(collectText(renderer!.root))).toContain("1 Sessions");
    expect(normalizeText(collectText(renderer!.root))).toContain("0 Projects");
    expect(normalizeText(collectText(renderer!.root))).toContain("0 Approvals");
    await act(async () => {
      findButton(renderer!.root, "Start chat").props.onClick();
      findButton(renderer!.root, "Open Start Here").props.onClick();
      findButton(renderer!.root, "Attach files").props.onClick();
    });

    expect(emptyInput.emptyStateProps.onCreateSession).toHaveBeenCalledTimes(1);
    expect(emptyInput.emptyStateProps.onOpenStartHere).toHaveBeenCalledTimes(1);
    expect(emptyInput.dropTargetProps.onAttachFiles).toHaveBeenCalledTimes(1);
    expect(emptyInput.emptyStateProps.onOpenCowork).not.toHaveBeenCalled();
    expect(emptyInput.emptyStateProps.onOpenCode).not.toHaveBeenCalled();
  });

  it("opens exact rail hits and renders an anchored, send-locked historical window", async () => {
    vi.stubGlobal("HTMLElement", class HTMLElement {});
    const input = buildInput() as any;
    const hit = {
      workspaceId: "default",
      sessionId: "parent-1",
      messageId: "history-anchor",
      sequence: 7,
      excerpt: "the exact deployment decision",
      score: 1,
    };
    input.sessionRail.missionSessions[0].searchHits = [hit];
    const onReturnToLatest = vi.fn();
    input.activeSessionSurfaceProps = buildActiveSessionProps({
      canSend: false,
      historicalReadOnly: true,
      draft: "must not send from history",
      onReturnToLatest,
      historicalWindow: {
        anchor: { ...hit, state: "found" },
        items: [
          {
            sequence: 6,
            isAnchor: false,
            message: {
              messageId: "history-before",
              sessionId: "parent-1",
              role: "user",
              actorType: "user",
              actorId: "operator",
              content: "Before the decision",
              timestamp: "2026-05-03T15:59:00.000Z",
            },
          },
          {
            sequence: 7,
            isAnchor: true,
            message: {
              messageId: "history-anchor",
              sessionId: "parent-1",
              role: "assistant",
              actorType: "agent",
              actorId: "assistant",
              content: "The exact deployment decision",
              timestamp: "2026-05-03T16:00:00.000Z",
            },
          },
        ],
        snapshotMaxSequence: 9,
        hasOlder: true,
        hasNewer: true,
        olderCursor: { messageId: "history-before", sequence: 6, snapshotMaxSequence: 9 },
        newerCursor: { messageId: "history-anchor", sequence: 7, snapshotMaxSequence: 9 },
        truncated: false,
        droppedItems: 0,
        byteLength: 512,
      },
    });
    input.emptyStateProps = null;

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<ThreadedSurfacePage surface="chat" input={input} />);
    });

    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Open exact search result" }).props.onClick();
    });
    expect(input.sessionRail.onSelectSession).toHaveBeenCalledWith("parent-1", { searchHit: hit });
    expect(normalizeText(collectText(renderer!.root))).toContain("Viewing history around search result");
    expect(normalizeText(collectText(renderer!.root))).toContain("The exact deployment decision");
    expect(renderer!.root.findByProps({ "aria-current": "true" }).props["aria-label"]).toBe("Exact search result");
    expect(renderer!.root.findByProps({ className: "mc-next-threaded-history-banner" }).props["aria-live"]).toBe(
      "polite",
    );
    expect(renderer!.root.findByProps({ className: "mc-next-threaded-history-send-lock" }).props.role).toBeUndefined();
    expect(
      renderer!.root.findByProps({ className: "mc-next-threaded-history-send-lock" }).props["aria-live"],
    ).toBeUndefined();
    expect(findExactButton(renderer!.root, "Send").props.disabled).toBe(true);
    expect(renderer!.root.findByProps({ "aria-label": "Message composer" }).props.disabled).toBe(true);
    await act(async () => {
      findExactButton(renderer!.root, "Load older messages").props.onClick();
      findExactButton(renderer!.root, "Load newer messages").props.onClick();
    });
    expect(input.activeSessionSurfaceProps.onLoadHistoricalContinuation).toHaveBeenNthCalledWith(1, "older");
    expect(input.activeSessionSurfaceProps.onLoadHistoricalContinuation).toHaveBeenNthCalledWith(2, "newer");
    await act(async () => {
      findExactButton(renderer!.root, "Return to latest").props.onClick();
    });
    expect(onReturnToLatest).toHaveBeenCalledTimes(1);
  });

  it("opens the session rail from mobile while keeping legacy routes in Chat", async () => {
    setMediaQuery("(width < 1180px)", true);
    vi.stubGlobal("HTMLElement", class HTMLElement {});
    const activeProps = buildActiveSessionProps({
      mode: "chat",
      onNavigateSurface: vi.fn(),
    });
    const input = {
      ...buildInput(),
      messageMode: "chat",
      sessionRailOpen: false,
      onSessionRailOpenChange: vi.fn(),
      activeSessionSurfaceProps: activeProps,
      emptyStateProps: null,
    } as any;

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<ThreadedSurfacePage surface="chat" input={input} />);
    });

    await act(async () => {
      findSessionRailTrigger(renderer!.root).props.onClick();
    });

    // Rail toggle still works; the old mode switcher is now a read-only Chat readout.
    expect(input.onSessionRailOpenChange).toHaveBeenCalledWith(true);
    const modeControl = renderer!.root.findAll(
      (n) => typeof n.props.className === "string" && n.props.className.includes("mc-next-threaded-mode-control"),
    );
    expect(modeControl.length).toBeGreaterThan(0);
    expect(modeControl[0]!.props["data-mode"]).toBe("chat");
  });

  it("keeps Activity and the build editor mutually exclusive from either entry point", async () => {
    vi.stubGlobal("HTMLElement", class HTMLElement {});
    vi.stubGlobal("window", {
      matchMedia: vi.fn((query: string) => ({
        matches: query.includes("1180px"),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    const activeProps = buildActiveSessionProps({
      mode: "chat",
      onNavigateSurface: vi.fn(),
      onExportRunBundle: vi.fn(),
    });
    const input = {
      ...buildInput(),
      messageMode: "chat",
      activeSessionSurfaceProps: activeProps,
      emptyStateProps: null,
      workflowPanel: {
        kind: "code",
        props: {},
      },
      contextDockProps: {
        session: null,
        memory: null,
        runTrace: null,
        suggestions: null,
      },
      dockOpen: false,
      onDockOpenChange: vi.fn(),
    } as any;

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<ThreadedSurfacePage surface="chat" input={input} />);
      await Promise.resolve();
    });

    await act(async () => {
      findExactButton(renderer!.root, "Activity").props.onClick();
    });
    expect(collectText(renderer!.root)).toContain("Work Record");

    await act(async () => {
      findExactButton(renderer!.root, "Export proof").props.onClick();
    });
    expect(activeProps.onExportRunBundle).toHaveBeenCalledTimes(1);

    await act(async () => {
      findExactButton(renderer!.root, "Build editor").props.onClick();
    });
    expect(input.onDockOpenChange).toHaveBeenLastCalledWith(false);
    expect(renderer!.root.findAllByProps({ className: "mc-next-utility-panel" })).toHaveLength(0);
    expect(
      renderer!.root.findByProps({ className: "mc-next-threaded-stage mode-chat has-workbench has-code-panel" }),
    ).toBeDefined();
    expect(collectText(renderer!.root)).toContain("Hide build editor");

    await act(async () => {
      findExactButton(renderer!.root, "Activity").props.onClick();
    });
    expect(renderer!.root.findByProps({ className: "mc-next-threaded-stage mode-chat has-context" })).toBeDefined();

    await act(async () => {
      findExactButton(renderer!.root, "Open build editor").props.onClick();
    });
    expect(input.onDockOpenChange).toHaveBeenLastCalledWith(false);
    expect(renderer!.root.findAllByProps({ className: "mc-next-utility-panel" })).toHaveLength(0);
    expect(
      renderer!.root.findByProps({ className: "mc-next-threaded-stage mode-chat has-workbench has-code-panel" }),
    ).toBeDefined();
  });

  it("opens Activity as the single entry point to inspect right-panel work", async () => {
    const onDockOpenChange = vi.fn();
    const onSelectFile = vi.fn();
    const onOpenTasks = vi.fn();
    const activeProps = buildActiveSessionProps({
      mode: "code",
      queueItems: [{ id: "queue-1", action: "retry", label: "Retry latest turn", createdAt: "2026-05-23T10:00:00Z" }],
      queuedCount: 1,
      streamStatus: "queued",
    });
    const input = {
      ...buildInput(),
      messageMode: "code",
      activeSessionSurfaceProps: activeProps,
      emptyStateProps: {
        ...(buildInput() as any).emptyStateProps,
        onOpenTasks,
      },
      workflowPanel: {
        kind: "code",
        props: {
          workbenchTree: {
            changedFiles: ["src/app.ts"],
            items: [{ path: "src/app.ts", name: "app.ts", kind: "file", depth: 1, changed: true }],
          },
          workbenchState: { validationStatus: "passed", worktreeStatus: "ready" },
          selectedFile: { path: "src/app.ts", language: "typescript", content: "console.log('old');" },
          selectedFileDiff: null,
          diff: {
            changedFiles: ["src/app.ts"],
            diff: "diff --git a/src/app.ts b/src/app.ts\n+console.log('next');",
            summary: { changedFiles: 1, additions: 1, deletions: 0 },
          },
          output: {
            helperRuns: [
              { runId: "run-1", status: "succeeded", language: "typescript", createdAt: "2026-05-23T10:00:00Z" },
            ],
            output: "Validation passed.",
          },
          hasDirtyDraft: false,
          onSelectFile,
        },
      },
      contextDockProps: {
        routePreflight: { selectionSource: "manual" },
      },
      dockOpen: false,
      onDockOpenChange,
    } as any;

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<ThreadedSurfacePage surface="code" input={input} />);
      await Promise.resolve();
    });

    await act(async () => {
      findExactButton(renderer!.root, "Activity").props.onClick();
    });
    expect(collectText(renderer!.root)).toContain("Work Record");

    await act(async () => {
      findExactButton(renderer!.root, "Diff").props.onClick();
    });
    expect(onDockOpenChange).toHaveBeenCalledWith(true);
    expect(collectText(renderer!.root)).toContain("Repo diff");
    expect(collectText(renderer!.root)).toContain("src/app.ts");

    await act(async () => {
      findExactButton(renderer!.root, "Run log").props.onClick();
    });
    expect(collectText(renderer!.root)).toContain("Run log");
    expect(collectText(renderer!.root)).toContain("Validation passed.");

    await act(async () => {
      findExactButton(renderer!.root, "Files").props.onClick();
    });
    await act(async () => {
      findButton(renderer!.root, "src/app.ts").props.onClick();
    });
    expect(onSelectFile).toHaveBeenCalledWith("src/app.ts");

    await act(async () => {
      findExactButton(renderer!.root, "Background tasks").props.onClick();
    });
    await act(async () => {
      findButton(renderer!.root, "Open task board").props.onClick();
    });
    expect(onOpenTasks).toHaveBeenCalledTimes(1);
  });

  it("keeps dismissed model receipts inspectable through Activity history", async () => {
    const plan = {
      schemaVersion: 1,
      planId: "plan-model-1",
      origin: { surface: "chat", workspaceId: "default", sessionId: "session-1" },
      adapter: { adapterId: "chat", version: 1 },
      kind: "session_model",
      scope: "current_chat",
      status: "completed",
      phase: "terminal",
      revision: 4,
      request: { kind: "session_model", providerId: "openai-codex", model: "gpt-5.6-terra" },
      intentHash: "intent-1",
      target: { ownerId: "session-1", resourceId: "session-1" },
      title: "Use gpt-5.6-terra in this chat",
      summary: "Model changed for this chat.",
      impact: "This chat now uses gpt-5.6-terra.",
      risk: "safe",
      approvalRefs: [],
      evidenceRefs: ["chat_session:session-1:revision:4"],
      rollbackRefs: [],
      result: { summary: "Model changed." },
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
    } as any;
    const input = {
      ...buildInput(),
      messageMode: "chat",
      activeSessionSurfaceProps: buildActiveSessionProps(),
      contextDockProps: {},
      changePlans: [plan],
      changePlanReceipt: { plan, onDismiss: vi.fn(), onOpenDetails: vi.fn() },
      activityOpenRequest: 1,
    } as any;

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<ThreadedSurfacePage surface="chat" input={input} />);
      await Promise.resolve();
    });

    expect(
      renderer!.root.findByProps({ "aria-label": "Change plan receipt: Use gpt-5.6-terra in this chat" }),
    ).toBeTruthy();
    expect(collectText(renderer!.root)).toMatch(/Activity history\s*\(\s*1\s*\)/u);
    expect(collectText(renderer!.root)).toContain(
      "Completed receipts stay here after you dismiss them from the conversation.",
    );
  });

  it("launches Work Record destinations through host callbacks", async () => {
    const onOpenLibraryArtifacts = vi.fn();
    const onOpenOpsRuntime = vi.fn();
    const activeProps = buildActiveSessionProps({
      onOpenLibraryArtifacts,
      onOpenOpsRuntime,
      selectedTurn: {
        turnId: "turn-record",
        userMessage: { role: "user", content: "Find the proof" },
        assistantMessage: { role: "assistant", content: "Proof is ready." },
        toolRuns: [],
        citations: [],
        generatedArtifacts: [],
        trace: { status: "completed" },
      },
      thread: {
        sessionId: "session-1",
        turns: [],
      },
    });
    const input = {
      ...buildInput(),
      activeSessionSurfaceProps: activeProps,
      contextDockProps: {},
      dockOpen: false,
    } as any;

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<ThreadedSurfacePage surface="chat" input={input} />);
      await Promise.resolve();
    });

    const workRecordButton = renderer!.root.findByProps({
      className: "mc-next-threaded-secondary mc-next-threaded-work-record",
    });
    expect(workRecordButton.props["aria-controls"]).toBe("mc-next-threaded-context-panel");
    expect(workRecordButton.props["aria-expanded"]).toBe(false);

    await act(async () => {
      workRecordButton.props.onClick();
    });

    expect(
      renderer!.root.findByProps({
        className: "mc-next-threaded-secondary mc-next-threaded-work-record",
      }).props["aria-expanded"],
    ).toBe(true);

    await act(async () => {
      findButton(renderer!.root, "Library").props.onClick();
      findButton(renderer!.root, "Ops").props.onClick();
    });

    expect(onOpenLibraryArtifacts).toHaveBeenCalledTimes(1);
    expect(onOpenOpsRuntime).toHaveBeenCalledTimes(1);
    expect(renderer!.root.findAll((node) => node.type === "a" && String(node.props.href).startsWith("/"))).toEqual([]);
  });

  it("selects the focused recovery turn before opening its Activity record", async () => {
    const onSelectTurn = vi.fn();
    const previousTurn = {
      turnId: "turn-previous",
      userMessage: {
        messageId: "user-previous",
        sessionId: "session-1",
        role: "user",
        actorType: "operator",
        actorId: "operator",
        content: "Earlier request",
        timestamp: "2026-08-15T00:00:00.000Z",
        attachments: [],
      },
      assistantMessage: {
        messageId: "assistant-previous",
        sessionId: "session-1",
        role: "assistant",
        actorType: "agent",
        actorId: "assistant",
        content: "Earlier answer",
        timestamp: "2026-08-15T00:00:01.000Z",
      },
      trace: {
        turnId: "turn-previous",
        sessionId: "session-1",
        userMessageId: "user-previous",
        branchKind: "append",
        status: "completed",
        mode: "chat",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "standard",
        startedAt: "2026-08-15T00:00:00.000Z",
        toolRuns: [],
        citations: [],
        routing: {},
      },
      toolRuns: [],
      citations: [],
      branch: {
        siblingTurnIds: ["turn-previous"],
        siblingCount: 1,
        activeSiblingIndex: 0,
        isSelectedPath: false,
        newestLeafTurnId: "turn-focused-failure",
      },
    };
    const focusedFailureTurn = {
      ...previousTurn,
      turnId: "turn-focused-failure",
      userMessage: {
        ...previousTurn.userMessage,
        messageId: "user-focused-failure",
        content: "Current request",
      },
      assistantMessage: undefined,
      trace: {
        ...previousTurn.trace,
        turnId: "turn-focused-failure",
        userMessageId: "user-focused-failure",
        status: "failed",
        failure: {
          failureClass: "provider_timeout",
          message: "Provider timed out.",
          retryable: true,
        },
      },
      branch: {
        siblingTurnIds: ["turn-focused-failure"],
        siblingCount: 1,
        activeSiblingIndex: 0,
        isSelectedPath: true,
        newestLeafTurnId: "turn-focused-failure",
      },
    };
    const activeProps = buildActiveSessionProps({
      onSelectTurn,
      selectedTurn: previousTurn,
      selectedTurnId: previousTurn.turnId,
      thread: {
        sessionId: "session-1",
        selectedTurnId: focusedFailureTurn.turnId,
        activeLeafTurnId: focusedFailureTurn.turnId,
        turns: [previousTurn, focusedFailureTurn],
      },
    });
    const input = {
      ...buildInput(),
      messageMode: "chat",
      activeSessionSurfaceProps: activeProps,
      contextDockProps: {},
      sessionRailOpen: false,
      dockOpen: false,
    } as any;

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<ThreadedSurfacePage surface="chat" input={input} />);
      await Promise.resolve();
    });

    await act(async () => {
      findExactButton(renderer!.root, "View activity").props.onClick();
    });

    expect(onSelectTurn).toHaveBeenCalledWith("turn-focused-failure");
    expect(collectText(renderer!.root)).toContain("Work Record");
  });

  /**
   * Exercises the Activity drawer's Escape claim against useEscapeToStopStream in
   * both possible registration orders. `document.addEventListener` dispatch
   * is registration-order (both listeners are bubble-phase, so whichever
   * registered first also runs first), and which one registers first depends
   * on whether the operator opened the menu before or after the stream went
   * active. useEscapeToStopStream now defers its decision to a microtask that
   * re-checks `event.defaultPrevented` after every listener in the simulated
   * dispatch below has run, so the outcome must be identical either way.
   */
  async function runActivityEscapeOrderingCase(order: "activity-opens-first" | "stream-starts-first") {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("document", {
      activeElement: null,
      contains: () => false,
      querySelector: () => null,
      addEventListener,
      removeEventListener,
    });

    const onStopActiveTurn = vi.fn();
    const activeProps = buildActiveSessionProps({ mode: "chat", onStopActiveTurn });
    const input = {
      ...buildInput(),
      messageMode: "chat",
      activeSessionSurfaceProps: activeProps,
      // Keep the capture-phase rail drawer and context dock closed so the only
      // "keydown" listeners registered on `document` are the Activity drawer's own
      // bubble-phase Escape handler and useEscapeToStopStream's (both of those
      // other capture-phase handlers are gated behind `railDrawerOpen`/`dockOpen`
      // and would otherwise also call `addEventListener`, making the assertions
      // below ambiguous).
      sessionRailOpen: false,
      dockOpen: false,
      contextDockProps: {},
    } as any;

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<ThreadedSurfacePage surface="chat" input={input} />);
    });

    const openActivity = async () => {
      await act(async () => {
        findExactButton(renderer!.root, "Activity").props.onClick();
      });
    };
    const startStream = async () => {
      await act(async () => {
        renderer!.update(
          <ThreadedSurfacePage
            surface="chat"
            input={{
              ...input,
              activeSessionSurfaceProps: { ...activeProps, sending: true, hasActiveStream: true },
            }}
          />,
        );
      });
    };

    if (order === "activity-opens-first") {
      await openActivity();
      await startStream();
    } else {
      await startStream();
      await openActivity();
    }

    const keydownHandlers = addEventListener.mock.calls
      .filter(([type]) => type === "keydown")
      .map(([, handler]) => handler as (event: unknown) => void);
    // The focus trap, Activity drawer handler, and stream-stop hook can all
    // observe Escape. The drawer must claim it before the stream-stop hook.
    expect(keydownHandlers.length).toBeGreaterThanOrEqual(2);

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    // A single dispatched Escape reaches every bubble-phase listener with the
    // SAME event object, in registration order — mirror that here by invoking
    // every captured handler, in that same order, against one shared fake
    // event.
    const sharedEvent = {
      key: "Escape",
      defaultPrevented: false,
      isComposing: false,
      target: null,
      preventDefault: () => {
        preventDefault();
        sharedEvent.defaultPrevented = true;
      },
      stopPropagation,
    };
    await act(async () => {
      for (const handler of keydownHandlers) {
        handler(sharedEvent);
      }
      // Flush the microtask useEscapeToStopStream defers its decision into:
      // it re-reads event.defaultPrevented only after every handler above has
      // had its turn, which is what makes the outcome independent of which
      // handler ran first.
      await Promise.resolve();
    });

    // Activity closed...
    expect(collectText(renderer!.root)).not.toContain("Work Record");
    // ...claimed the event so the document-bubble useEscapeToStopStream hook
    // (which only fires when `!event.defaultPrevented`) would skip it...
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
    // ...and, wired end-to-end, the stream was never cancelled by this keypress.
    expect(onStopActiveTurn).not.toHaveBeenCalled();
  }

  it("claims Escape to close Activity without leaking it to the stream-stop hook (Activity opens, then stream starts)", async () => {
    await runActivityEscapeOrderingCase("activity-opens-first");
  });

  it("claims Escape to close Activity without leaking it to the stream-stop hook (stream starts, then Activity opens)", async () => {
    await runActivityEscapeOrderingCase("stream-starts-first");
  });

  it("does not touch the Escape event when the Panels menu is closed", async () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("document", {
      activeElement: null,
      contains: () => false,
      querySelector: () => null,
      addEventListener,
      removeEventListener,
    });

    const activeProps = buildActiveSessionProps({ mode: "chat" });
    const input = {
      ...buildInput(),
      messageMode: "chat",
      activeSessionSurfaceProps: activeProps,
      sessionRailOpen: false,
      dockOpen: false,
    } as any;

    await act(async () => {
      create(<ThreadedSurfacePage surface="chat" input={input} />);
    });

    // Activity was never opened, so its `useEffect` never registers a
    // "keydown" listener at all (it early-returns while `open` is false).
    expect(addEventListener.mock.calls.find(([type]) => type === "keydown")).toBeUndefined();
  });

  it("exposes keyboard-adjustable resize handles for the rail and right drawer", async () => {
    const activeProps = buildActiveSessionProps({ mode: "chat" });
    const input = {
      ...buildInput(),
      messageMode: "chat",
      activeSessionSurfaceProps: activeProps,
      emptyStateProps: null,
      contextDockProps: {
        routePreflight: null,
      },
      dockOpen: true,
    } as any;

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<ThreadedSurfacePage surface="chat" input={input} />);
      await Promise.resolve();
    });

    let root = renderer!.root.findByProps({ className: "mc-next-threaded-surface unified" });
    expect(root.props.style["--mc-session-rail-width"]).toBe("216px");

    await act(async () => {
      findSessionRailTrigger(renderer!.root).props.onClick();
    });
    const railHandle = findButtonByAriaLabel(renderer!.root, "Resize session rail");
    await act(async () => {
      railHandle.props.onKeyDown({ key: "ArrowRight", preventDefault: vi.fn() });
    });
    root = renderer!.root.findByProps({ className: "mc-next-threaded-surface unified session-rail-open" });
    expect(root.props.style["--mc-session-rail-width"]).toBe("240px");

    await act(async () => {
      railHandle.props.onKeyDown({ key: "End", preventDefault: vi.fn() });
    });
    root = renderer!.root.findByProps({ className: "mc-next-threaded-surface unified session-rail-open" });
    expect(root.props.style["--mc-session-rail-width"]).toBe("300px");

    const drawerHandle = findButtonByAriaLabel(renderer!.root, "Resize right drawer");
    await act(async () => {
      drawerHandle.props.onKeyDown({ key: "End", preventDefault: vi.fn() });
    });
    const stage = renderer!.root.findByProps({ className: "mc-next-threaded-stage mode-chat has-context" });
    expect(stage.props.style["--mc-context-panel-width"]).toBe("420px");
  });

  it("wires cowork active-session actions, project drafts, tag filters, and compact artifact dismissal", async () => {
    setMediaQuery("(max-width: 840px)", true);
    vi.stubGlobal("HTMLElement", class HTMLElement {});
    vi.stubGlobal("window", {
      matchMedia: vi.fn((query: string) => ({
        matches: query.includes("840px"),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    const activeProps = buildActiveSessionProps({
      mode: "cowork",
      activeGeneratedArtifact: {
        artifactId: "artifact-2",
        title: "Compact brief",
        kind: "markdown",
        content: "# Compact",
        sourceSurface: "cowork",
        version: 2,
      },
      onCloseGeneratedArtifact: vi.fn(),
      onNavigateSurface: vi.fn(),
    });
    const input = {
      ...buildInput(),
      showProjectCreate: true,
      activeSessionSurfaceProps: activeProps,
      emptyStateProps: null,
      sessionRail: {
        ...(buildInput() as any).sessionRail,
        showProjectCreate: true,
        selectedTag: "coverage",
        availableFolders: [{ folderId: "folder-1", name: "Pinned", count: 2 }],
        onProjectNameChange: vi.fn(),
        onProjectPathChange: vi.fn(),
        onCreateProject: vi.fn(),
        onSelectTag: vi.fn(),
        onSelectFolderId: vi.fn(),
      },
    } as any;

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<ThreadedSurfacePage surface="cowork" input={input} />);
      await Promise.resolve();
    });

    // The old cross-area nav buttons are replaced by a read-only Chat surface readout.
    const modeControl = renderer!.root.findAll(
      (n) => typeof n.props.className === "string" && n.props.className.includes("mc-next-threaded-mode-control"),
    );
    expect(modeControl.length).toBeGreaterThan(0);
    expect(modeControl[0]!.props["data-mode"]).toBe("chat");

    const projectInputs = renderer!.root.findAllByType("input");
    await act(async () => {
      projectInputs
        .find((inputNode) => inputNode.props.placeholder === "Project name")
        ?.props.onChange({
          target: { value: "Coverage Project" },
        });
      projectInputs
        .find((inputNode) => inputNode.props.placeholder?.includes("Project path"))
        ?.props.onChange({
          target: { value: "F:\\code\\coverage" },
        });
      findButton(renderer!.root, "Create project").props.onClick();
      findButton(renderer!.root, "coverage").props.onClick();
    });
    expect(input.sessionRail.onProjectNameChange).toHaveBeenCalledWith("Coverage Project");
    expect(input.sessionRail.onProjectPathChange).toHaveBeenCalledWith("F:\\code\\coverage");
    expect(input.sessionRail.onCreateProject).toHaveBeenCalledTimes(1);
    expect(input.sessionRail.onSelectTag).toHaveBeenCalledWith(null);

    const sheet = renderer!.root.findAll(
      (node) => node.props.open === true && typeof node.props.onOpenChange === "function",
    )[0];
    expect(sheet).toBeDefined();
    await act(async () => {
      sheet!.props.onOpenChange(false);
    });
    expect((activeProps as any).onCloseGeneratedArtifact).toHaveBeenCalledTimes(1);
  });

  it("auto-expands the selected delegated session and renders orphan delegated tasks", async () => {
    const input = buildInput() as any;
    input.sessionRail.selectedSessionId = "child-1";
    input.sessionRail.missionSessions = [
      ...input.sessionRail.missionSessions,
      {
        sessionId: "orphan-1",
        sessionKey: "mission:operator:orphan",
        scope: "mission",
        mode: "code",
        includeInHistory: true,
        title: "",
        pinned: false,
        lifecycleStatus: "active",
        channel: "",
        account: "operator",
        updatedAt: "not-a-date",
        lastActivityAt: "not-a-date",
        tokenTotal: 0,
        costUsdTotal: 0,
        delegationParent: {
          parentSessionId: "missing-parent",
          runId: "run-2",
          stepId: "step-2",
          role: "coder",
          label: "",
          index: 1,
        },
      },
    ];
    input.sessionRail.renderSessionLabel = (sessionId: string) =>
      sessionId === "orphan-1" ? "Rendered orphan label" : sessionId;

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<ThreadedSurfacePage surface="cowork" input={input} />);
      await Promise.resolve();
    });

    expect(collectText(renderer!.root)).toContain("Delegate · Work");
    expect(collectText(renderer!.root)).toContain("Delegated tasks");
    expect(collectText(renderer!.root)).toContain("Rendered orphan label");
    expect(collectText(renderer!.root)).toContain("Delegated task · coder");

    await act(async () => {
      renderer!.root.findByProps({ title: "Delegate · Work" }).props.onClick();
      renderer!.root.findByProps({ title: "Rendered orphan label" }).props.onClick();
      findButtonByAriaLabel(renderer!.root, "Collapse delegated chats").props.onClick();
    });
    expect(input.sessionRail.onSelectSession).toHaveBeenCalledWith("child-1");
    expect(input.sessionRail.onSelectSession).toHaveBeenCalledWith("orphan-1");
    expect(collectText(renderer!.root)).not.toContain("Delegate · Work");

    input.sessionRail.missionSessions = [];
    input.sessionRail.externalSessions = [];
    await act(async () => {
      renderer!.update(<ThreadedSurfacePage surface="cowork" input={input} />);
      await Promise.resolve();
    });
    expect(collectText(renderer!.root)).toContain("No sessions in this lane yet.");
  });
});
