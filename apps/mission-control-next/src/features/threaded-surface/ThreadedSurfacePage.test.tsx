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
  getArchiveActionLabel,
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

function findExactButtons(root: ReactTestInstance, label: string): ReactTestInstance[] {
  return root.findAll((node) => node.type === "button" && normalizeText(collectText(node)) === label);
}

function findButtonByAriaLabel(root: ReactTestInstance, ariaLabel: string): ReactTestInstance {
  return root.findByProps({ "aria-label": ariaLabel });
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
  it("keeps the persistent desktop session rail interactive when drawer state is closed", async () => {
    setMediaQuery("(width < 1180px)", false);
    const input = buildInput() as any;
    input.sessionRailOpen = false;
    input.sessionRail.onCreateSession = vi.fn();

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<ThreadedSurfacePage surface="cowork" input={input} />);
    });

    const rail = renderer!.root.findByProps({ "aria-label": "Sessions" });
    expect(rail.props.className).toBe("mc-next-threaded-rail");
    expect(rail.props["aria-hidden"]).toBe(false);
    expect(rail.props.inert).toBe(false);
    expect(renderer!.root.findByProps({ className: "mc-next-threaded-scrim" }).props.tabIndex).toBe(-1);
    const group = renderer!.root
      .findAllByProps({ className: "mc-next-threaded-session-group" })
      .find((node) => node.props["aria-label"] === "Recent threads");
    expect(group).toBeDefined();
    expect(group!.props["aria-label"]).toBe("Recent threads");
    const groupHead = group!.findByProps({ className: "mc-next-threaded-group-head" });
    expect(groupHead.findByType("h3").children).toEqual(["Recent threads"]);
    expect(groupHead.findByType("span").props["aria-hidden"]).toBe("true");

    await act(async () => {
      findButton(renderer!.root, "New thread").props.onClick();
    });
    expect(input.sessionRail.onCreateSession).toHaveBeenCalledTimes(1);
  });

  it("only marks the mobile drawer rail inert while it is closed", async () => {
    setMediaQuery("(width < 1180px)", true);
    const input = buildInput() as any;
    input.sessionRailOpen = false;

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<ThreadedSurfacePage surface="cowork" input={input} />);
    });

    let rail = renderer!.root.findByProps({ "aria-label": "Sessions" });
    expect(rail.props.className).toBe("mc-next-threaded-rail");
    expect(rail.props["aria-hidden"]).toBe(true);
    expect(rail.props.inert).toBe(true);
    expect(renderer!.root.findByProps({ className: "mc-next-threaded-scrim" }).props.tabIndex).toBe(-1);

    await act(async () => {
      renderer!.update(<ThreadedSurfacePage surface="cowork" input={{ ...input, sessionRailOpen: true }} />);
    });
    rail = renderer!.root.findByProps({ "aria-label": "Sessions" });
    expect(rail.props.className).toBe("mc-next-threaded-rail open");
    expect(rail.props["aria-hidden"]).toBe(false);
    expect(rail.props.inert).toBe(false);
    expect(renderer!.root.findByProps({ className: "mc-next-threaded-scrim open" }).props.tabIndex).toBe(0);
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
      findButton(renderer!.root, "Sessions").props.onClick();
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
      findButton(renderer!.root, "Sessions").props.onClick();
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
    expect(markup).toContain('aria-label="Tokens: 0 tokens"');
    expect(markup).toContain('aria-label="Cost: $0.00"');
    expect(markup).toContain('aria-label="Approvals: Decisions clear"');
    expect(markup).toContain("OpenAI / gpt-test");
    expect(markup).toContain("Selection: session");
    expect(markup).toContain("0 tokens");
    expect(markup).toContain("$0.00");
    expect(markup).toContain("Runtime ready");
    expect(markup).toContain("Decisions clear");
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
      findButton(renderer!.root, "New thread").props.onClick();
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
      findExactButton(renderer!.root, "Archive").props.onClick();
      findButton(renderer!.root, "Show context").props.onClick();
      findButton(renderer!.root, "Context").props.onClick();
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

  it("opens the session rail from mobile while keeping legacy routes in Chat", async () => {
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
      findButton(renderer!.root, "Sessions").props.onClick();
    });

    // Rail toggle still works; the old mode switcher is now a read-only Chat readout.
    expect(input.onSessionRailOpenChange).toHaveBeenCalledWith(true);
    const modeControl = renderer!.root.findAll(
      (n) => typeof n.props.className === "string" && n.props.className.includes("mc-next-threaded-mode-control"),
    );
    expect(modeControl.length).toBeGreaterThan(0);
    expect(modeControl[0]!.props["data-mode"]).toBe("chat");
  });

  it("toggles the code workbench from mobile and conversation controls", async () => {
    vi.stubGlobal("HTMLElement", class HTMLElement {});
    vi.stubGlobal("window", {
      matchMedia: vi.fn((query: string) => ({
        matches: query.includes("1180px"),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    const activeProps = buildActiveSessionProps({
      mode: "code",
      onNavigateSurface: vi.fn(),
      onExportRunBundle: vi.fn(),
    });
    const input = {
      ...buildInput(),
      messageMode: "code",
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
      dockOpen: true,
      onDockOpenChange: vi.fn(),
    } as any;

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<ThreadedSurfacePage surface="code" input={input} />);
      await Promise.resolve();
    });

    expect(collectText(renderer!.root)).toContain("Hide build editor");
    await act(async () => {
      findButton(renderer!.root, "Hide build editor").props.onClick();
    });
    expect(collectText(renderer!.root)).toContain("Build editor");

    await act(async () => {
      const conversationWorkbenchButton = findExactButtons(renderer!.root, "Build editor").find(
        (button) => button.props.className === "mc-next-threaded-secondary",
      );
      expect(conversationWorkbenchButton).toBeDefined();
      conversationWorkbenchButton!.props.onClick();
      findButton(renderer!.root, "Hide context").props.onClick();
      findButton(renderer!.root, "Export run bundle").props.onClick();
    });

    expect(activeProps.onExportRunBundle).toHaveBeenCalledTimes(1);
    expect(input.onDockOpenChange).toHaveBeenCalledWith(false);
  });

  it("opens Claude-style right-panel choices from the active-session header", async () => {
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
      findButtonByAriaLabel(renderer!.root, "Open right panel menu").props.onClick();
    });
    expect(collectText(renderer!.root)).toContain("Background tasks");

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

    expect(findButton(renderer!.root, "Work Record").props["aria-expanded"]).toBe(true);

    await act(async () => {
      findButton(renderer!.root, "Library").props.onClick();
      findButton(renderer!.root, "Ops").props.onClick();
    });

    expect(onOpenLibraryArtifacts).toHaveBeenCalledTimes(1);
    expect(onOpenOpsRuntime).toHaveBeenCalledTimes(1);
    expect(renderer!.root.findAll((node) => node.type === "a" && String(node.props.href).startsWith("/"))).toEqual([]);
  });

  /**
   * Exercises the Panels menu's Escape claim against useEscapeToStopStream in
   * both possible registration orders. `document.addEventListener` dispatch
   * is registration-order (both listeners are bubble-phase, so whichever
   * registered first also runs first), and which one registers first depends
   * on whether the operator opened the menu before or after the stream went
   * active. useEscapeToStopStream now defers its decision to a microtask that
   * re-checks `event.defaultPrevented` after every listener in the simulated
   * dispatch below has run, so the outcome must be identical either way.
   */
  async function runPanelsMenuEscapeOrderingCase(order: "menu-opens-first" | "stream-starts-first") {
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
      // "keydown" listeners registered on `document` are the Panels menu's own
      // bubble-phase Escape handler and useEscapeToStopStream's (both of those
      // other capture-phase handlers are gated behind `railDrawerOpen`/`dockOpen`
      // and would otherwise also call `addEventListener`, making the assertions
      // below ambiguous).
      sessionRailOpen: false,
      dockOpen: false,
    } as any;

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<ThreadedSurfacePage surface="chat" input={input} />);
    });

    const openMenu = async () => {
      await act(async () => {
        findButtonByAriaLabel(renderer!.root, "Open right panel menu").props.onClick();
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

    if (order === "menu-opens-first") {
      await openMenu();
      await startStream();
    } else {
      await startStream();
      await openMenu();
    }

    const keydownHandlers = addEventListener.mock.calls
      .filter(([type]) => type === "keydown")
      .map(([, handler]) => handler as (event: unknown) => void);
    // Exactly two bubble-phase "keydown" listeners should be live at this
    // point: the Panels menu's own handler and useEscapeToStopStream's
    // document-level hook, in whichever order this case registered them.
    expect(keydownHandlers).toHaveLength(2);

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

    // The menu closed...
    expect(collectText(renderer!.root)).not.toContain("Background tasks");
    // ...claimed the event so the document-bubble useEscapeToStopStream hook
    // (which only fires when `!event.defaultPrevented`) would skip it...
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    // ...and, wired end-to-end, the stream was never cancelled by this keypress.
    expect(onStopActiveTurn).not.toHaveBeenCalled();
  }

  it("claims Escape to close the Panels menu without leaking it to the document-bubble stream-stop hook (menu opens, then stream starts)", async () => {
    await runPanelsMenuEscapeOrderingCase("menu-opens-first");
  });

  it("claims Escape to close the Panels menu without leaking it to the document-bubble stream-stop hook (stream starts, then menu opens)", async () => {
    await runPanelsMenuEscapeOrderingCase("stream-starts-first");
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

    // The Panels menu was never opened, so its `useEffect` never registers a
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

    const railHandle = findButtonByAriaLabel(renderer!.root, "Resize session rail");
    await act(async () => {
      railHandle.props.onKeyDown({ key: "ArrowRight", preventDefault: vi.fn() });
    });
    root = renderer!.root.findByProps({ className: "mc-next-threaded-surface unified" });
    expect(root.props.style["--mc-session-rail-width"]).toBe("240px");

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
