import React, { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
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
    presetOptions: [],
    selectedPresetId: "",
    presetApplyWarning: null,
    selectedTurnRecovery: null,
    selectedTurn: null,
    selectedSessionId: "session-1",
    thread: { sessionId: "session-1", turns: [] },
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
    onRetryTurn: vi.fn(),
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

describe("ThreadedComposer steering chips", () => {
  it("renders a Steering chip when an active stream and disposition is steer", () => {
    const markup = buildMarkup({
      hasActiveStream: true,
      midTurnDisposition: "steer",
    });

    expect(markup).toContain("Steering");
    expect(markup).toContain("mc-next-composer-chip emphasis");
  });

  it("renders a Queued chip when an active stream and disposition is queue", () => {
    const markup = buildMarkup({
      hasActiveStream: true,
      midTurnDisposition: "queue",
    });

    expect(markup).toContain(">Queued<");
  });

  it("renders a Goal chip when pinnedGoal is set", () => {
    const markup = buildMarkup({
      pinnedGoal: "ship kanban",
    });

    expect(markup).toContain("Goal: ship kanban");
    expect(markup).toContain("mc-next-composer-chip emphasis");
  });

  it("omits steering chips when there is no active stream", () => {
    const markup = buildMarkup({
      hasActiveStream: false,
      midTurnDisposition: "steer",
    });

    expect(markup).not.toContain(">Steering<");
    expect(markup).not.toContain(">Queued<");
  });
});
