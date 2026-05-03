import React, { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ThreadedComposer } from "./ThreadedComposer";

function buildMarkup(overrides: Partial<any> = {}) {
  const props = {
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
    ...overrides,
  };

  return renderToStaticMarkup(<ThreadedComposer props={props as any} />);
}

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

  it("shows a default planning toggle when planning mode is off", () => {
    const markup = buildMarkup({
      planningMode: "off",
    });

    expect(markup).toContain("Shift+Tab");
    expect(markup).toContain("Plan");
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).not.toContain("Planning mode is on");
  });

  it("shows an explicit action to leave planning mode", () => {
    const markup = buildMarkup({
      planningMode: "advisory",
    });

    expect(markup).toContain("Planning mode is on");
    expect(markup).toContain("Turn planning off");
    expect(markup).toContain("Plan on");
    expect(markup).toContain('aria-pressed="true"');
  });
});
