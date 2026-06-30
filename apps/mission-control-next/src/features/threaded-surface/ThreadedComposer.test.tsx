import React, { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { ThreadedComposer } from "./ThreadedComposer";

vi.mock("@goatcitadel/mission-control-shared/components/ChatComposerPlusMenu", async () => {
  const ReactModule = await import("react");
  return {
    ChatComposerPlusMenu: ({ disabled, onAttachFiles, actions = [], children }: any) =>
      ReactModule.createElement(
        "div",
        { className: "chat-plus-menu" },
        ReactModule.createElement(
          "button",
          { type: "button", disabled, "aria-label": "Open chat actions", onClick: () => undefined },
          "+",
        ),
        onAttachFiles
          ? ReactModule.createElement(
              "button",
              {
                type: "button",
                disabled,
                "aria-label": "Attach files",
                className: "chat-plus-action",
                onClick: () => {
                  if (!disabled) {
                    onAttachFiles();
                  }
                },
              },
              "Add files or photos",
            )
          : null,
        ...actions.map((action: any) =>
          ReactModule.createElement(
            "button",
            {
              key: action.label,
              type: "button",
              disabled: action.disabled,
              className: `chat-plus-action${action.active ? " active" : ""}`,
              onClick: action.onSelect,
            },
            action.label,
          ),
        ),
        children,
      ),
  };
});

function buildProps(overrides: Partial<any> = {}) {
  return {
    mode: "chat",
    queueItems: [],
    editingTurnId: null,
    planningMode: "off",
    streamError: null,
    streamErrorSource: null,
    draft: "",
    commandSuggestions: [],
    commandIndex: 0,
    pendingAttachments: [],
    threadKnowledgeAttachments: [],
    delegationSuggestion: null,
    presetOptions: [],
    selectedPresetId: "",
    presetApplyWarning: null,
    selectedTurnRecovery: null,
    selectedTurn: null,
    selectedSessionId: "session-1",
    thread: { sessionId: "session-1", turns: [] },
    selectedContextTurnIds: [],
    outboundContext: null,
    contextSelection: null,
    trust: {
      workspaceLabel: "Test workspace",
      gatewayTone: "muted",
      gatewayLabel: "Gateway ready",
      approvalsSummary: "Decisions clear",
      activeModeLabel: "Chat",
      providerModelSummary: "OpenAI / gpt-test",
      runtimeSummary: "Runtime ready",
    },
    currentWebMode: "auto",
    fullWebAccess: false,
    routePreflight: null,
    routePreflightLoading: false,
    routePreflightError: null,
    routeBoundaryAckRequired: false,
    routeBoundaryAcknowledged: false,
    pendingApproval: null,
    pendingUserInput: null,
    workspaceId: "default",
    approvalPending: false,
    userInputPending: false,
    sending: false,
    canSend: true,
    hasActiveStream: false,
    activeStreamTurnAssigned: false,
    composerRef: createRef<HTMLTextAreaElement>(),
    audioInputRef: createRef<HTMLInputElement>(),
    onResumeAll: vi.fn(),
    onRemoveQueuedItem: vi.fn(),
    onCancelEdit: vi.fn(),
    onDismissError: vi.fn(),
    onTogglePlanningMode: vi.fn(),
    onDismissPresetWarning: vi.fn(),
    onAcknowledgeRouteBoundary: vi.fn(),
    onApprovePending: vi.fn(),
    onDenyPending: vi.fn(),
    onSubmitUserInput: vi.fn(),
    onRetryTurn: vi.fn(),
    onToggleContextTurn: vi.fn(),
    onClearContextSelection: vi.fn(),
    onStartNewThreadFromTurn: vi.fn(),
    onSetDeepMode: vi.fn(),
    onFullWebAccessChange: vi.fn(),
    onReviewRunDetails: vi.fn(),
    onDraftChange: vi.fn(),
    onComposerKeyDown: vi.fn(),
    onComposerPaste: vi.fn(),
    onApplyDraftCommand: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onRemoveThreadKnowledgeAttachment: vi.fn(),
    onAttachFiles: vi.fn(),
    onRunQuickResearch: vi.fn(),
    onAudioFileSelected: vi.fn(),
    onToggleVoiceTalk: vi.fn(),
    onOpenAudioTranscribe: vi.fn(),
    onToggleSpeakResponses: vi.fn(),
    onGenerateImage: vi.fn(),
    onEditImage: vi.fn(),
    onAttachKnowledgeUrl: vi.fn(),
    onKnowledgeUrlDraftChange: vi.fn(),
    onKnowledgeUrlModeChange: vi.fn(),
    onPresetChange: vi.fn(),
    onApplyPreset: vi.fn(),
    onAcceptDelegation: vi.fn(async () => undefined),
    onDismissDelegationSuggestion: vi.fn(),
    onStopActiveTurn: vi.fn(),
    onSend: vi.fn(),
    voiceInputAvailable: false,
    voiceOutputAvailable: false,
    voiceBusy: false,
    voiceTalkActive: false,
    speakResponsesEnabled: false,
    imageGenerationAvailable: true,
    imageEditAvailable: true,
    imageBusy: false,
    knowledgeUrlDraft: "",
    knowledgeUrlMode: "retrieval",
    currentThinkingLevel: "standard",
    currentSpeedMode: "standard",
    currentSubagentPolicy: "off",
    onSetThinkingLevel: vi.fn(),
    onSetSpeedMode: vi.fn(),
    onSetSubagentPolicy: vi.fn(),
    ...overrides,
  } as any;
}

function buildMarkup(overrides: Partial<any> = {}) {
  const props = buildProps(overrides);

  return renderToStaticMarkup(<ThreadedComposer props={props as any} />);
}

async function renderComposer(overrides: Partial<any> = {}): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null;
  await act(async () => {
    renderer = create(<ThreadedComposer props={buildProps(overrides)} />);
  });
  return renderer!;
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

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const button = root.findAll((node) => node.type === "button" && collectText(node).includes(label))[0];
  if (!button) {
    const available = root
      .findAll((node) => node.type === "button")
      .map((node) => collectText(node) || node.props["aria-label"])
      .join(", ");
    throw new Error(`Unable to find button: ${label}. Available buttons: ${available}`);
  }
  return button;
}

function findButtons(root: ReactTestInstance, label: string): ReactTestInstance[] {
  return root.findAll((node) => node.type === "button" && collectText(node).includes(label));
}

async function click(node: ReactTestInstance): Promise<void> {
  await act(async () => {
    node.props.onClick({
      defaultPrevented: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
  });
}

function stubObjectUrls() {
  const createObjectURL = vi.fn(() => "blob:preview");
  const revokeObjectURL = vi.fn();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: createObjectURL,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revokeObjectURL,
  });
  return { createObjectURL, revokeObjectURL };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ThreadedComposer", () => {
  it("renders an inline preview shell for pending image attachments", () => {
    const markup = buildMarkup({
      pendingAttachments: [
        {
          attachmentId: "attachment-image-1",
          sessionId: "session-1",
          fileName: "generated-creature.png",
          mimeType: "image/png",
          mediaType: "image",
          sizeBytes: 1024,
          sha256: "hash",
          storageRelPath: "chat/default/generated-creature.png",
          extractStatus: "ready",
          createdAt: "2026-04-22T00:00:00.000Z",
        },
      ],
    });

    expect(markup).toContain("mc-next-composer-image-shell");
    expect(markup).toContain("/api/v1/chat/attachments/attachment-image-1/content?disposition=inline");
    expect(markup).toContain("Open");
    expect(markup).toContain("Download");
  });

  it("surfaces provider detail from the shared error mapper", () => {
    const markup = buildMarkup({
      streamError:
        'API error 500: {"error":"image generation failed (500 Internal Server Error): {\\"error\\": {\\"message\\": \\"Upstream timeout while contacting the provider.\\"}}"}',
      streamErrorSource: "send",
    });

    expect(markup).toContain("Upstream timeout while contacting the provider.");
    expect(markup).toContain("Your prompt was kept in the composer so you can edit and resend it.");
  });

  it("surfaces route preflight failures before send", () => {
    const markup = buildMarkup({
      canSend: false,
      routePreflightError: "No active provider configured.",
    });

    expect(markup).toContain("Route blocked");
    expect(markup).toContain("No active provider configured.");
  });

  it("renders the composer with the default chat affordances when planning mode is off", () => {
    const markup = buildMarkup({
      planningMode: "off",
    });

    // The Plan toggle, thinking-level/speed-mode/subagent-policy selectors moved
    // to the Context Drawer's Assist tab; the composer no longer hosts them.
    expect(markup).not.toContain("Shift+Tab");
    expect(markup).not.toContain(">Plan<");
    expect(markup).not.toContain("Subagent policy");
    expect(markup).not.toContain("Thinking level");
    expect(markup).toContain("OpenAI / gpt-test");
    expect(markup).toContain("0 tokens / $0.00");
    expect(markup).toContain("Attach files");
    expect(markup).toContain("Send");
    expect(markup).not.toContain(">Delegate<");
    expect(markup).not.toContain(">Implement<");
    expect(markup).not.toContain("Start talk");
    expect(markup).not.toContain("Planning mode is on");
  });

  it("surfaces memory as historical last-turn state and omits empty or in-progress memory", () => {
    const completedMemory = buildMarkup({
      thread: {
        sessionId: "session-1",
        turns: [{ turnId: "turn-1", trace: { status: "completed", memoryMode: "workspace" } }],
      },
    });
    expect(completedMemory).toContain("Last turn: workspace");

    const runningMemory = buildMarkup({
      thread: {
        sessionId: "session-1",
        turns: [{ turnId: "turn-1", trace: { status: "running", memoryMode: "workspace" } }],
      },
    });
    expect(runningMemory).not.toContain("Last turn: workspace");

    const emptyMemory = buildMarkup({
      thread: {
        sessionId: "session-1",
        turns: [{ turnId: "turn-1", trace: { status: "completed", memoryMode: "off" } }],
      },
    });
    expect(emptyMemory).not.toContain("Last turn:");
  });

  it("shows selected context and capability chips beside the composer title", async () => {
    const onClearContextSelection = vi.fn();
    const renderer = await renderComposer({
      selectedContextTurnIds: ["turn-1"],
      contextSelection: { label: "2 selected turns", turnCount: 2, sourceLabel: "Launch plan" },
      onClearContextSelection,
      thread: {
        sessionId: "session-1",
        turns: [
          {
            turnId: "turn-1",
            trace: { status: "completed" },
            toolRuns: [
              { toolRunId: "skill-run", toolName: "skill.run", args: { skillId: "planner" } },
              { toolRunId: "connector-run", toolName: "integration.send", args: { connectionId: "slack" } },
              { toolRunId: "mcp-run", toolName: "mcp.invoke", args: { serverId: "github" } },
            ],
          },
        ],
      },
    });

    const text = collectText(renderer.root);
    expect(text).toMatch(/Context:\s+2 selected turns/);
    expect(text).toContain("Skills: planner");
    expect(text).toContain("Connectors: slack");
    expect(text).toContain("MCP: github");

    await click(findButton(renderer.root, "Context:"));
    expect(onClearContextSelection).toHaveBeenCalledTimes(1);
  });

  it.each(["off", "false", "0", "no", "disabled", " OFF "])(
    "honors %s as a composer v2 kill switch false value",
    (value) => {
      const getItem = vi.fn(() => value);
      const previousWindow = globalThis.window;
      Object.defineProperty(globalThis, "window", {
        value: {
          localStorage: { getItem },
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        },
        configurable: true,
      });

      try {
        const markup = buildMarkup();
        expect(markup).not.toContain("mc-next-context-strip");
      } finally {
        Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
      }
    },
  );

  it("shows an explicit action to leave planning mode", () => {
    const markup = buildMarkup({
      planningMode: "advisory",
    });

    // The advisory-mode banner stays in the composer so the operator notices
    // the posture even while the underlying toggle now lives in the drawer.
    expect(markup).toContain("Planning mode is on");
    expect(markup).toContain("Turn planning off");
  });

  it("attaches approval blockers to the composer in compact form", () => {
    const markup = buildMarkup({
      pendingApproval: {
        approvalId: "approval-1",
        kind: "tool_call",
        toolName: "filesystem.write",
        reason: "Needs permission to update a file.",
        affectedResources: ["README.md"],
      },
    });

    expect(markup).toContain("mc-next-composer-blocking-prompt");
    expect(markup).toContain('data-blocker-kind="approval"');
    expect(markup).toContain('data-variant="compact"');
    expect(markup).toContain("Approval required");
    expect(markup).toContain("filesystem.write");
    expect(markup).toContain("Needs permission to update a file.");
    expect(markup).toContain("Allow once");
    expect(markup).toContain("Deny");
    expect(markup).toContain("Open persisted approval record");
    expect(markup).not.toContain("Action type: tool_call");
    expect(markup).not.toContain("Touches: README.md");
  });

  it("attaches user-input blockers to the composer in compact form", () => {
    const markup = buildMarkup({
      pendingUserInput: {
        turnId: "turn-1",
        promptId: "prompt-1",
        kind: "text",
        title: "Need a constraint",
        question: "What budget should Cowork optimize for?",
        placeholder: "Budget",
        dismissible: false,
      },
    });

    expect(markup).toContain("mc-next-composer-blocking-prompt");
    expect(markup).toContain('data-blocker-kind="user-input"');
    expect(markup).toContain('data-variant="compact"');
    expect(markup).toContain("Need a constraint");
    expect(markup).toContain("Answer required");
    expect(markup).toContain("Submit");
    expect(markup).not.toContain("Dismiss");
  });

  it("disables side-effecting composer controls while blockers are active", async () => {
    const callbacks = {
      onAttachFiles: vi.fn(),
      onAudioFileSelected: vi.fn(),
      onPresetChange: vi.fn(),
      onApplyPreset: vi.fn(),
      onKnowledgeUrlDraftChange: vi.fn(),
      onKnowledgeUrlModeChange: vi.fn(),
      onAttachKnowledgeUrl: vi.fn(),
    };
    const renderer = await renderComposer({
      draft: "Research this",
      pendingApproval: {
        approvalId: "approval-1",
        kind: "tool_call",
        toolName: "browser.search",
        reason: "Needs approval.",
      },
      presetOptions: [{ value: "review", label: "Review preset" }],
      selectedPresetId: "review",
      knowledgeUrlDraft: "https://example.test/source",
      knowledgeUrlMode: "retrieval",
      voiceInputAvailable: true,
      imageGenerationAvailable: true,
      ...callbacks,
    });

    expect(renderer.root.findByProps({ "aria-label": "Open chat actions" }).props.disabled).toBe(true);

    const attachFilesButton = renderer.root.findByProps({ "aria-label": "Attach files" });
    expect(attachFilesButton.props.disabled).toBe(true);
    await click(attachFilesButton);

    const presetSelect = renderer.root.findByProps({ id: "threaded-composer-preset" });
    const applyPresetButton = findButton(renderer.root, "Apply");
    const knowledgeInput = renderer.root.findByProps({ id: "threaded-composer-knowledge-url" });
    const knowledgeModeSelect = renderer.root.findAllByType("select").find((node) => node.props.value === "retrieval")!;
    const attachSourceButton = findButton(renderer.root, "Attach source");
    const audioInput = renderer.root.findByProps({ accept: "audio/*" });

    expect(presetSelect.props.disabled).toBe(true);
    expect(applyPresetButton.props.disabled).toBe(true);
    expect(knowledgeInput.props.disabled).toBe(true);
    expect(knowledgeModeSelect.props.disabled).toBe(true);
    expect(attachSourceButton.props.disabled).toBe(true);
    expect(audioInput.props.disabled).toBe(true);

    await act(async () => {
      presetSelect.props.onChange({ target: { value: "daily" } });
      knowledgeInput.props.onChange({ target: { value: "https://example.test/next" } });
      knowledgeModeSelect.props.onChange({ target: { value: "full_text" } });
      audioInput.props.onChange({ target: { files: ["audio-file"] } });
    });
    await click(applyPresetButton);
    await click(attachSourceButton);

    expect(callbacks.onAttachFiles).not.toHaveBeenCalled();
    expect(callbacks.onPresetChange).not.toHaveBeenCalled();
    expect(callbacks.onApplyPreset).not.toHaveBeenCalled();
    expect(callbacks.onKnowledgeUrlDraftChange).not.toHaveBeenCalled();
    expect(callbacks.onKnowledgeUrlModeChange).not.toHaveBeenCalled();
    expect(callbacks.onAttachKnowledgeUrl).not.toHaveBeenCalled();
    expect(callbacks.onAudioFileSelected).not.toHaveBeenCalled();

    await act(async () => {
      renderer.update(
        <ThreadedComposer
          props={buildProps({
            pendingApproval: null,
            pendingUserInput: {
              turnId: "turn-1",
              promptId: "prompt-1",
              kind: "text",
              title: "Need input",
              question: "Continue?",
            },
          })}
        />,
      );
    });
    expect(renderer.root.findByProps({ "aria-label": "Open chat actions" }).props.disabled).toBe(true);
  });

  it("uses the compact suggestion popover for dollar skill mentions", () => {
    const markup = buildMarkup({
      commandSuggestions: [
        {
          key: "mention-react-expert",
          command: "$react-expert",
          description: "enabled · React Expert",
          applyValue: "$react-expert",
        },
      ],
    });

    expect(markup).toContain('aria-label="Composer suggestions"');
    expect(markup).toContain("$react-expert");
  });

  it("uses surface-specific primary action labels", () => {
    expect(buildMarkup({ mode: "cowork" })).toContain("Delegate");
    expect(buildMarkup({ mode: "code" })).toContain("Implement");
  });

  it("renders subagent suggestions as an inline composer approval", async () => {
    const onAcceptDelegation = vi.fn(async () => undefined);
    const onDismissDelegationSuggestion = vi.fn();
    const renderer = await renderComposer({
      mode: "cowork",
      delegationSuggestion: {
        suggestionId: "suggestion-1",
        sessionId: "session-1",
        objective: "Research launch options, verify sources, and synthesize the final brief.",
        roles: ["Researcher", "QA"],
        mode: "parallel",
        confidence: 0.82,
        reason: "Independent research and verification can run side by side.",
        source: "heuristic",
        createdAt: "2026-05-16T00:00:00.000Z",
      },
      onAcceptDelegation,
      onDismissDelegationSuggestion,
    });

    const text = collectText(renderer.root);
    expect(text).toContain("Subagent approval");
    expect(text).toContain("Approve subagents for this run?");
    expect(text).toContain("2 subagents");
    expect(text).toContain("82% confidence");
    expect(text).toContain("Researcher");
    expect(text).toContain("QA");

    await click(findButton(renderer.root, "Approve subagents"));
    await click(findButton(renderer.root, "Keep single run"));

    expect(onAcceptDelegation).toHaveBeenCalledTimes(1);
    expect(onDismissDelegationSuggestion).toHaveBeenCalledTimes(1);
  });

  it("covers residual route, mode, and primary label branches", async () => {
    expect(buildMarkup({ editingTurnId: "turn-chat-edit" })).toContain("Send branch");
    expect(buildMarkup({ currentWebMode: "deep" })).toContain("Deep web");
    expect(buildMarkup({ currentWebMode: "quick" })).toContain("Quick web");
    expect(buildMarkup({ fullWebAccess: true })).toContain("Full web");
    expect(
      buildMarkup({
        routePreflight: {
          effectiveProviderId: "local",
          effectiveModel: "llama-3.1",
        },
      }),
    ).toContain("local / llama-3.1");
    expect(buildMarkup({ imageEditAvailable: false })).not.toContain("Edit image");

    const onRetryTurn = vi.fn();
    const onSetDeepMode = vi.fn();
    const withoutSelectedTurn = buildMarkup({
      selectedTurn: null,
      selectedTurnRecovery: {
        label: "Retry unavailable",
        summary: "No selected turn is available.",
        action: "retry_narrower",
      },
      onReviewRunDetails: undefined,
    });
    expect(withoutSelectedTurn).not.toContain("Retry turn");

    let renderer = await renderComposer({
      selectedTurn: {
        turnId: "turn-narrow",
        trace: { status: "completed" },
      },
      selectedTurnRecovery: {
        label: "Retry narrower",
        summary: "Try a narrower request.",
        action: "retry_narrower",
      },
      onRetryTurn,
      onReviewRunDetails: undefined,
    });
    await click(findButton(renderer.root, "Retry turn"));
    expect(onRetryTurn).toHaveBeenCalledWith("turn-narrow");

    renderer = await renderComposer({
      currentWebMode: "quick",
      selectedTurnRecovery: {
        label: "Deep mode needed",
        summary: "The next attempt needs broader retrieval.",
        action: "switch_to_deep_mode",
      },
      onSetDeepMode,
      onReviewRunDetails: undefined,
    });
    await click(findButton(renderer.root, "Set Deep mode"));
    expect(onSetDeepMode).toHaveBeenCalledTimes(1);

    renderer = await renderComposer({ fullWebAccess: true });
    expect(renderer.root.findAllByProps({ title: "Allow public-web search and page reads for this run" })).toHaveLength(
      0,
    );
  });

  it("wires queue, draft, suggestion, recovery, editing, and attachment actions", async () => {
    const callbacks = {
      onResumeAll: vi.fn(),
      onRemoveQueuedItem: vi.fn(),
      onCancelEdit: vi.fn(),
      onRetryTurn: vi.fn(),
      onReviewRunDetails: vi.fn(),
      onDraftChange: vi.fn(),
      onComposerKeyDown: vi.fn(),
      onComposerPaste: vi.fn(),
      onApplyDraftCommand: vi.fn(),
      onRemoveAttachment: vi.fn(),
      onRemoveThreadKnowledgeAttachment: vi.fn(),
      onSend: vi.fn(),
    };
    const renderer = await renderComposer({
      mode: "cowork",
      queueItems: [
        {
          id: "queue-1",
          action: "retry",
          label: "Retry the plan",
          createdAt: "2026-05-01T00:00:00.000Z",
          paused: true,
        },
      ],
      editingTurnId: "turn-edit-abcdef",
      draft: "Coordinate the work",
      commandSuggestions: [
        {
          key: "mention-research",
          command: "$researcher",
          description: "enabled · Researcher",
          applyValue: "$researcher",
        },
      ],
      selectedTurn: {
        turnId: "turn-failed-123456",
        trace: {
          status: "failed",
        },
      },
      selectedTurnRecovery: {
        label: "Recover this run",
        summary: "The previous step failed after a provider timeout.",
        action: "retry",
      },
      pendingAttachments: [
        {
          attachmentId: "attachment-note",
          sessionId: "session-1",
          fileName: "notes.txt",
          mimeType: "text/plain",
          mediaType: "file",
          sizeBytes: 300,
          sha256: "hash-note",
          storageRelPath: "chat/default/notes.txt",
          extractStatus: "ready",
          createdAt: "2026-04-22T00:00:00.000Z",
        },
      ],
      threadKnowledgeAttachments: [
        {
          attachmentId: "knowledge-1",
          title: "Project brief",
          retrievalMode: "full_text",
          ingestStatus: "ready",
        },
      ],
      thread: {
        sessionId: "session-1",
        turns: [
          {
            turnId: "turn-1",
            userMessage: { tokenInput: 1200, tokenOutput: 0, costUsd: 0.002 },
            assistantMessage: { tokenInput: 0, tokenOutput: 600, costUsd: 0.003 },
          },
        ],
      },
      ...callbacks,
    });

    expect(collectText(renderer.root)).toContain("Queued messages");
    // Sub-cent costs now report three significant figures instead of the
    // flat "<$0.01" placeholder, so a 0.005 total reads as $0.005.
    expect(collectText(renderer.root)).toContain("1,800 tokens / $0.005");
    expect(collectText(renderer.root)).toContain("Delegate branch");

    await click(findButton(renderer.root, "Resume queued messages"));
    await click(findButton(renderer.root, "Cancel branch"));
    await click(findButton(renderer.root, "Retry run step"));
    await click(findButton(renderer.root, "Review run details"));

    const textarea = renderer.root.findByType("textarea");
    await act(async () => {
      textarea.props.onChange({ target: { value: "Next prompt" } });
      textarea.props.onKeyDown({ key: "Enter" });
      textarea.props.onPaste({ clipboardData: "image" });
    });

    await click(findButton(renderer.root, "$researcher"));
    for (const button of findButtons(renderer.root, "Remove")) {
      await click(button);
    }
    await click(findButton(renderer.root, "Delegate branch"));

    expect(callbacks.onResumeAll).toHaveBeenCalledTimes(1);
    expect(callbacks.onRemoveQueuedItem).toHaveBeenCalledWith("queue-1");
    expect(callbacks.onCancelEdit).toHaveBeenCalledTimes(1);
    expect(callbacks.onRetryTurn).toHaveBeenCalledWith("turn-failed-123456");
    expect(callbacks.onReviewRunDetails).toHaveBeenCalledTimes(1);
    expect(callbacks.onDraftChange).toHaveBeenCalledWith("Next prompt");
    expect(callbacks.onComposerKeyDown).toHaveBeenCalledWith({ key: "Enter" });
    expect(callbacks.onComposerPaste).toHaveBeenCalledWith({ clipboardData: "image" });
    expect(callbacks.onApplyDraftCommand).toHaveBeenCalledWith("$researcher");
    expect(callbacks.onRemoveAttachment).toHaveBeenCalledWith("attachment-note");
    expect(callbacks.onRemoveThreadKnowledgeAttachment).toHaveBeenCalledWith("knowledge-1");
    expect(callbacks.onSend).toHaveBeenCalledTimes(1);
  });

  it("wires route banners, preset controls, plus-menu actions, and composer selectors", async () => {
    const callbacks = {
      onDismissPresetWarning: vi.fn(),
      onAcknowledgeRouteBoundary: vi.fn(),
      onToggleVoiceTalk: vi.fn(),
      onOpenAudioTranscribe: vi.fn(),
      onToggleSpeakResponses: vi.fn(),
      onGenerateImage: vi.fn(),
      onEditImage: vi.fn(),
      onRunQuickResearch: vi.fn(),
      onAttachFiles: vi.fn(),
      onAudioFileSelected: vi.fn(),
      onPresetChange: vi.fn(),
      onApplyPreset: vi.fn(),
      onKnowledgeUrlDraftChange: vi.fn(),
      onKnowledgeUrlModeChange: vi.fn(),
      onAttachKnowledgeUrl: vi.fn(),
      onSetThinkingLevel: vi.fn(),
      onSetSpeedMode: vi.fn(),
      onSetSubagentPolicy: vi.fn(),
      onTogglePlanningMode: vi.fn(),
    };
    const renderer = await renderComposer({
      draft: "Draw the diagram",
      selectedSessionId: null,
      currentWebMode: "off",
      routePreflightLoading: true,
      routeBoundaryAckRequired: true,
      routeBoundaryAcknowledged: false,
      presetApplyWarning: "Preset changed the composer.",
      presetOptions: [{ value: "review", label: "Review preset" }],
      selectedPresetId: "review",
      voiceInputAvailable: true,
      voiceOutputAvailable: true,
      speakResponsesEnabled: true,
      knowledgeUrlDraft: "https://example.test/source",
      knowledgeUrlMode: "retrieval",
      ...callbacks,
    });

    expect(collectText(renderer.root)).toContain("New thread");
    expect(collectText(renderer.root)).toContain("Checking the selected provider/model route before send.");

    await click(findButton(renderer.root, "Dismiss"));
    await click(findButton(renderer.root, "Acknowledge fallback"));
    await click(renderer.root.findByProps({ "aria-label": "Open chat actions" }));
    await click(findButton(renderer.root, "Start voice talk"));
    await click(findButton(renderer.root, "Transcribe audio"));
    await click(findButton(renderer.root, "Stop speaking replies"));
    await click(findButton(renderer.root, "Create image"));
    await click(findButton(renderer.root, "Edit image"));
    await click(findButton(renderer.root, "Quick web research"));
    await click(renderer.root.findByProps({ "aria-label": "Attach files" }));
    await click(findButton(renderer.root, "Apply"));
    await click(findButton(renderer.root, "Attach source"));

    const presetSelect = renderer.root.findByProps({ id: "threaded-composer-preset" });
    const knowledgeInput = renderer.root.findByProps({ id: "threaded-composer-knowledge-url" });
    const knowledgeModeSelect = renderer.root.findAllByType("select").find((node) => node.props.value === "retrieval")!;
    const audioInput = renderer.root.findByProps({ accept: "audio/*" });
    await act(async () => {
      presetSelect.props.onChange({ target: { value: "daily" } });
      knowledgeInput.props.onChange({ target: { value: "https://example.test/next" } });
      knowledgeModeSelect.props.onChange({ target: { value: "full_text" } });
      audioInput.props.onChange({ target: { files: ["audio-file"] } });
    });

    expect(callbacks.onDismissPresetWarning).toHaveBeenCalledTimes(1);
    expect(callbacks.onAcknowledgeRouteBoundary).toHaveBeenCalledTimes(1);
    expect(callbacks.onToggleVoiceTalk).toHaveBeenCalledTimes(1);
    expect(callbacks.onOpenAudioTranscribe).toHaveBeenCalledTimes(1);
    expect(callbacks.onToggleSpeakResponses).toHaveBeenCalledTimes(1);
    expect(callbacks.onGenerateImage).toHaveBeenCalledTimes(1);
    expect(callbacks.onEditImage).toHaveBeenCalledTimes(1);
    expect(callbacks.onRunQuickResearch).toHaveBeenCalledTimes(1);
    expect(callbacks.onAttachFiles).toHaveBeenCalledTimes(1);
    expect(callbacks.onPresetChange).toHaveBeenCalledWith("daily");
    expect(callbacks.onApplyPreset).toHaveBeenCalledTimes(1);
    expect(callbacks.onKnowledgeUrlDraftChange).toHaveBeenCalledWith("https://example.test/next");
    expect(callbacks.onKnowledgeUrlModeChange).toHaveBeenCalledWith("full_text");
    expect(callbacks.onAttachKnowledgeUrl).toHaveBeenCalledTimes(1);
    expect(callbacks.onAudioFileSelected).toHaveBeenCalledWith(["audio-file"]);
    // Thinking level, speed mode, subagent policy, and the planning toggle are
    // exercised in ThreadedContextDrawer.test.tsx now that they live in the
    // Assist tab.
  });

  it("uses blocker, sending, and stream-stop labels for primary actions", async () => {
    const onSend = vi.fn();
    const onStopActiveTurn = vi.fn();
    const waitingForApproval = {
      turnId: "turn-blocked",
      trace: { status: "waiting_for_approval" },
    };

    let renderer = await renderComposer({
      mode: "cowork",
      selectedTurn: waitingForApproval,
      onSend,
    });
    await click(findButton(renderer.root, "Resolve blocker"));
    expect(onSend).toHaveBeenCalledTimes(1);

    renderer = await renderComposer({
      mode: "code",
      editingTurnId: "turn-edit",
      onSend,
    });
    expect(collectText(renderer.root)).toContain("Implement branch");

    renderer = await renderComposer({
      mode: "code",
      sending: true,
      hasActiveStream: false,
      onSend,
    });
    expect(collectText(renderer.root)).toContain("Implementing...");

    renderer = await renderComposer({
      sending: true,
      hasActiveStream: true,
      activeStreamTurnAssigned: false,
      onStopActiveTurn,
    });
    await click(findButton(renderer.root, "Stop stream"));

    renderer = await renderComposer({
      sending: true,
      hasActiveStream: true,
      activeStreamTurnAssigned: true,
      onStopActiveTurn,
    });
    await click(findButton(renderer.root, "Stop turn"));
    expect(onStopActiveTurn).toHaveBeenCalledTimes(2);
  });

  it("surfaces a cowork Stop run control beside the composer with honest state-only copy", async () => {
    const onCoworkStopRun = vi.fn();
    const renderer = await renderComposer({
      mode: "cowork",
      coworkStopRunControl: {
        id: "cancel",
        action: "cancel",
        title: "Cancel",
        enabled: true,
        status: "available",
        runtimeEffect: "state_only",
        note: "Cowork run has no attached durable run; cancel records intent only.",
      },
      coworkStopRunPending: false,
      onCoworkStopRun,
    });

    const text = collectText(renderer.root);
    expect(text).toContain("Stop run");
    // The disabled-reason from the control's `note` is surfaced as helper text.
    expect(text).toContain("Cowork run has no attached durable run; cancel records intent only.");
    // State-only runs must be honest that this only records operator stop intent.
    expect(text).toContain("records operator stop intent");

    // Clicking opens a confirm modal rather than firing the control directly.
    await click(findButton(renderer.root, "Stop run"));
    expect(onCoworkStopRun).not.toHaveBeenCalled();

    const openConfirm = renderer.root.findAllByType(ConfirmModal).find((modal) => modal.props.open);
    expect(openConfirm).toBeTruthy();
    expect(String(openConfirm?.props.message)).toContain("does not terminate the worker");
    act(() => {
      openConfirm?.props.onConfirm();
    });
    expect(onCoworkStopRun).toHaveBeenCalledWith(expect.objectContaining({ action: "cancel" }));
  });

  it("disables the cowork Stop run control when the control is not enabled and reflects pending state", async () => {
    const onCoworkStopRun = vi.fn();
    const disabledRenderer = await renderComposer({
      mode: "cowork",
      coworkStopRunControl: {
        id: "cancel",
        action: "cancel",
        title: "Cancel",
        enabled: false,
        status: "disabled",
        runtimeEffect: "state_only",
        note: "No active run attached.",
      },
      onCoworkStopRun,
    });
    const disabledStop = findButton(disabledRenderer.root, "Stop run");
    expect(disabledStop.props.disabled).toBe(true);
    await click(disabledStop);
    expect(disabledRenderer.root.findAllByType(ConfirmModal).find((modal) => modal.props.open)).toBeFalsy();

    const pendingRenderer = await renderComposer({
      mode: "cowork",
      coworkStopRunPending: true,
      coworkStopRunControl: {
        id: "cancel",
        action: "cancel",
        title: "Cancel",
        enabled: true,
        status: "available",
        runtimeEffect: "state_only",
      },
      onCoworkStopRun,
    });
    expect(collectText(pendingRenderer.root)).toContain("Stopping...");
  });

  it("omits the cowork Stop run control outside cowork or without an active control", () => {
    expect(buildMarkup({ mode: "chat", coworkStopRunControl: null })).not.toContain("Stop run");
    expect(
      buildMarkup({
        mode: "cowork",
        coworkStopRunControl: null,
      }),
    ).not.toContain("Stop run");
  });

  it("falls back to authenticated image loading and surfaces preview failures", async () => {
    const { createObjectURL, revokeObjectURL } = stubObjectUrls();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["image"], { type: "image/png" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const renderer = await renderComposer({
      pendingAttachments: [
        {
          attachmentId: "attachment-image-2",
          sessionId: "session-1",
          fileName: "screenshot.png",
          mimeType: "",
          mediaType: "file",
          sizeBytes: 2048,
          sha256: "hash-image",
          storageRelPath: "chat/default/screenshot.png",
          extractStatus: "ready",
          createdAt: "2026-04-22T00:00:00.000Z",
        },
      ],
    });

    await act(async () => {
      renderer.root.findByType("img").props.onError();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/chat/attachments/attachment-image-2/content?disposition=inline"),
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByType("img").props.src).toBe("blob:preview");
    expect(revokeObjectURL).not.toHaveBeenCalledWith("blob:preview");

    await act(async () => {
      renderer.root.findByType("img").props.onError();
    });

    expect(collectText(renderer.root)).toContain("Preview unavailable: Preview unavailable.");
  });

  it("revokes active authenticated image object URLs on attachment removal", async () => {
    const { revokeObjectURL } = stubObjectUrls();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        blob: async () => new Blob(["image"], { type: "image/png" }),
      })),
    );

    const firstAttachment = {
      attachmentId: "attachment-image-active",
      sessionId: "session-1",
      fileName: "active.png",
      mimeType: "image/png",
      mediaType: "image",
      sizeBytes: 2048,
      sha256: "hash-image",
      storageRelPath: "chat/default/active.png",
      extractStatus: "ready",
      createdAt: "2026-04-22T00:00:00.000Z",
    };

    const renderer = await renderComposer({
      pendingAttachments: [firstAttachment],
    });

    await act(async () => {
      renderer.root.findByType("img").props.onError();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByType("img").props.src).toBe("blob:preview");
    expect(revokeObjectURL).not.toHaveBeenCalledWith("blob:preview");

    await act(async () => {
      renderer.update(<ThreadedComposer props={buildProps({ pendingAttachments: [] })} />);
      await Promise.resolve();
    });

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  });

  it("surfaces authenticated image fetch errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        text: async () => "preview unavailable",
      })),
    );

    const renderer = await renderComposer({
      pendingAttachments: [
        {
          attachmentId: "attachment-image-error",
          sessionId: "session-1",
          fileName: "failed.webp",
          mimeType: "image/webp",
          mediaType: "image",
          sizeBytes: 2048,
          sha256: "hash-image",
          storageRelPath: "chat/default/failed.webp",
          extractStatus: "ready",
          createdAt: "2026-04-22T00:00:00.000Z",
        },
      ],
    });

    await act(async () => {
      renderer.root.findByType("img").props.onError();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(collectText(renderer.root)).toContain("Preview unavailable: API error 503: preview unavailable");
  });

  it("revokes authenticated image object URLs when a preview resolves after unmount", async () => {
    const { revokeObjectURL } = stubObjectUrls();
    let resolveBlob: ((blob: Blob) => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        blob: () =>
          new Promise<Blob>((resolve) => {
            resolveBlob = resolve;
          }),
      })),
    );

    const renderer = await renderComposer({
      pendingAttachments: [
        {
          attachmentId: "attachment-image-late",
          sessionId: "session-1",
          fileName: "late.png",
          mimeType: "image/png",
          mediaType: "image",
          sizeBytes: 2048,
          sha256: "hash-image",
          storageRelPath: "chat/default/late.png",
          extractStatus: "ready",
          createdAt: "2026-04-22T00:00:00.000Z",
        },
      ],
    });

    await act(async () => {
      renderer.root.findByType("img").props.onError();
      await Promise.resolve();
    });
    await act(async () => {
      renderer.unmount();
    });
    await act(async () => {
      resolveBlob?.(new Blob(["late"], { type: "image/png" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  });
});
