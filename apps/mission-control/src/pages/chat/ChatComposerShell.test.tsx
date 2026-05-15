import React, { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ChatComposerShell } from "./ChatComposerShell";

function buildComposerElement(overrides: Partial<Parameters<typeof ChatComposerShell>[0]> = {}) {
  return (
    <ChatComposerShell
      mode="chat"
      isDragActive={false}
      queueItems={[]}
      editingTurnId={null}
      planningMode="off"
      effectiveToolAutonomy="safe_auto"
      error={null}
      errorSource={null}
      draft=""
      commandSuggestions={[]}
      commandIndex={0}
      pendingAttachments={[]}
      selectedTurnRecovery={null}
      selectedTurn={null}
      selectedSessionId="session-1"
      currentWebMode="auto"
      routePreflight={null}
      routeBoundaryAckRequired={false}
      routeBoundaryAcknowledged={false}
      sending={false}
      canSend={true}
      hasActiveStream={false}
      activeStreamTurnAssigned={false}
      composerRef={createRef<HTMLTextAreaElement>()}
      fileInputRef={createRef<HTMLInputElement>()}
      onDragEnter={vi.fn()}
      onDragOver={vi.fn()}
      onDragLeave={vi.fn()}
      onDrop={vi.fn()}
      onResumeAll={vi.fn()}
      onRemoveQueuedItem={vi.fn()}
      onCancelEdit={vi.fn()}
      onDismissError={vi.fn()}
      onAcknowledgeRouteBoundary={vi.fn()}
      onRetryTurn={vi.fn()}
      onSetDeepMode={vi.fn()}
      onReviewRunDetails={vi.fn()}
      onDraftChange={vi.fn()}
      onComposerKeyDown={vi.fn()}
      onComposerPaste={vi.fn()}
      onApplyDraftCommand={vi.fn()}
      onRemoveAttachment={vi.fn()}
      onAttachFiles={vi.fn()}
      onUploadFiles={vi.fn()}
      onRunQuickResearch={vi.fn()}
      onStopActiveTurn={vi.fn()}
      onSend={vi.fn()}
      {...overrides}
    />
  );
}

function buildComposerMarkup(overrides: Partial<Parameters<typeof ChatComposerShell>[0]> = {}) {
  return renderToStaticMarkup(buildComposerElement(overrides));
}

function buildComposerRenderer(overrides: Partial<Parameters<typeof ChatComposerShell>[0]> = {}): ReactTestRenderer {
  return create(buildComposerElement(overrides));
}

function findButtonByText(renderer: ReactTestRenderer, text: string) {
  return findButtonsContaining(renderer, text)[0];
}

function nodeText(value: unknown): string {
  if (value == null || typeof value === "boolean") {
    return "";
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => nodeText(item)).join(" ");
  }
  if (typeof value === "object" && "children" in value) {
    return nodeText((value as { children?: unknown }).children);
  }
  if (typeof value === "object" && "props" in value) {
    return nodeText((value as { props?: { children?: unknown } }).props?.children);
  }
  return "";
}

function findButtonsContaining(renderer: ReactTestRenderer, text: string) {
  return renderer.root.findAllByType("button").filter((node) => nodeText(node.props.children).includes(text));
}

function findButtonContaining(renderer: ReactTestRenderer, text: string) {
  return findButtonsContaining(renderer, text)[0];
}

function createDocumentAttachment(overrides: Record<string, unknown> = {}) {
  return {
    attachmentId: "attachment-doc-1",
    sessionId: "session-1",
    fileName: "brief.pdf",
    mimeType: "application/pdf",
    mediaType: "document",
    sizeBytes: 2048,
    sha256: "hash",
    storageRelPath: "chat/default/brief.pdf",
    extractStatus: "pending",
    createdAt: "2026-04-22T00:00:00.000Z",
    ...overrides,
  } as any;
}

function createImageAttachment(overrides: Record<string, unknown> = {}) {
  return {
    attachmentId: "attachment-image-auth",
    sessionId: "session-1",
    fileName: "preview.png",
    mimeType: "image/png",
    mediaType: "image",
    sizeBytes: 1024,
    sha256: "hash",
    storageRelPath: "chat/default/preview.png",
    extractStatus: "ready",
    createdAt: "2026-04-22T00:00:00.000Z",
    ...overrides,
  } as any;
}

describe("ChatComposerShell", () => {
  it("renders code-mode prompt ergonomics and helper copy", () => {
    const markup = buildComposerMarkup({ mode: "code" });

    expect(markup).toContain("Describe the implementation task, constraints, or review goal");
    expect(markup).toContain("Paste larger prompts, drag files, and keep heavier implementation context in one place.");
    expect(markup).toContain("Code");
  });

  it("renders queue, edit, and recovery affordances together", () => {
    const markup = buildComposerMarkup({
      queueItems: [
        {
          id: "queued-1",
          action: "edit",
          label: "Tighten the diff before send",
          createdAt: "2026-04-04T00:00:00.000Z",
        },
      ],
      editingTurnId: "turn-abcdef",
      selectedTurnRecovery: {
        action: "retry",
        label: "Retry with narrower scope",
        summary: "The previous run failed after tool execution drifted outside the intended boundary.",
      },
      selectedTurn: {
        turnId: "turn-abcdef",
        trace: {
          status: "failed",
        },
      } as any,
    });

    expect(markup).toContain("Queue");
    expect(markup).toContain("Tighten the diff before send");
    expect(markup).toContain("Editing branch from turn abcdef.");
    expect(markup).toContain("Retry with narrower scope");
    expect(markup).toContain("Retry turn");
    expect(markup).toContain("Review run details");
  });

  it("renders Cowork preflight warnings and fallback acknowledgement", () => {
    const markup = buildComposerMarkup({
      mode: "cowork",
      routePreflight: {
        normalizationReason: "Model changed from gpt-4.1 to llama3.2 because provider Ollama cannot run gpt-4.1.",
        degradedReason: "Fallback may move this run from local to cloud if the primary route fails.",
      } as any,
      routeBoundaryAckRequired: true,
    });

    expect(markup).toContain("Model normalized before execution");
    expect(markup).toContain("Fallback can cross the current runtime boundary");
    expect(markup).toContain("Acknowledge fallback");
  });

  it("renders the preset picker trigger with the selected preset label", () => {
    const markup = buildComposerMarkup({
      presetOptions: [
        {
          value: "preset-reviewer",
          label: "Reviewer",
          summary: "Bias the surface toward review and verification.",
          routeHint: "code",
          toolsPosture: "manual",
        },
      ],
      selectedPresetId: "preset-reviewer",
    });

    expect(markup).toContain("Preset");
    expect(markup).toContain("Reviewer");
  });

  it("renders a pending image preview shell for image attachments", () => {
    const markup = buildComposerMarkup({
      pendingAttachments: [
        {
          attachmentId: "attachment-image-1",
          sessionId: "session-1",
          fileName: "generated-horse.png",
          mimeType: "image/png",
          mediaType: "image",
          sizeBytes: 1024,
          sha256: "hash",
          storageRelPath: "chat/default/generated-horse.png",
          extractStatus: "ready",
          createdAt: "2026-04-22T00:00:00.000Z",
        },
      ] as any,
    });

    expect(markup).toContain("generated-horse.png");
    expect(markup).toContain("chat-v11-pending-image-preview-shell");
    expect(markup).toContain("/api/v1/chat/attachments/attachment-image-1/content?disposition=inline");
  });

  it("still treats loosely formatted image metadata as previewable", () => {
    const markup = buildComposerMarkup({
      pendingAttachments: [
        {
          attachmentId: "attachment-image-2",
          sessionId: "session-1",
          fileName: "generated-creature.PNG",
          mimeType: " image/png ",
          mediaType: "binary",
          sizeBytes: 1024,
          sha256: "hash",
          storageRelPath: "chat/default/generated-creature.PNG",
          extractStatus: "ready",
          createdAt: "2026-04-22T00:00:00.000Z",
        },
      ] as any,
    });

    expect(markup).toContain("chat-v11-pending-image-preview-shell");
    expect(markup).toContain("/api/v1/chat/attachments/attachment-image-2/content?disposition=inline");
  });

  it("shows retry guidance for send failures", () => {
    const markup = buildComposerMarkup({
      error:
        'API error 500: {"error":"image generation failed (500 Internal Server Error): {\\"error\\": {\\"message\\": \\"Upstream timeout while contacting the provider.\\"}}"}',
      errorSource: "send",
    });

    expect(markup).toContain("Upstream timeout while contacting the provider.");
    expect(markup).toContain("Your prompt was kept in the composer so you can edit and resend it.");
  });

  it("does not show retry guidance for approval failures", () => {
    const markup = buildComposerMarkup({
      error:
        'API error 400: {"error":"approval failed (400 Bad Request): {\\"error\\": {\\"message\\": \\"Approval could not be recorded.\\"}}"}',
      errorSource: "approval",
    });

    expect(markup).toContain("Approval could not be recorded.");
    expect(markup).not.toContain("Your prompt was kept in the composer so you can edit and resend it.");
  });

  it("labels Cowork send actions for fresh runs, blockers, instructions, and active streams", () => {
    expect(buildComposerMarkup({ mode: "cowork", selectedTurn: null })).toContain("Start Cowork run");

    expect(
      buildComposerMarkup({
        mode: "cowork",
        selectedTurn: {
          turnId: "turn-blocked",
          trace: { status: "waiting_for_user_input" },
        } as any,
      }),
    ).toContain("Resolve blocker");

    expect(
      buildComposerMarkup({
        mode: "cowork",
        selectedTurn: {
          turnId: "turn-orchestrated",
          trace: { status: "completed", orchestration: { strategy: "delegated" } },
        } as any,
      }),
    ).toContain("Send instruction");

    expect(
      buildComposerMarkup({
        mode: "cowork",
        sending: true,
        hasActiveStream: false,
      }),
    ).toContain("Sending...");

    expect(
      buildComposerMarkup({
        sending: true,
        hasActiveStream: true,
        activeStreamTurnAssigned: false,
      }),
    ).toContain("Stop stream");

    expect(
      buildComposerMarkup({
        sending: true,
        hasActiveStream: true,
        activeStreamTurnAssigned: true,
      }),
    ).toContain("Stop turn");

    expect(
      buildComposerMarkup({
        sending: true,
        hasActiveStream: false,
      }),
    ).toContain("Sending...");

    expect(
      buildComposerMarkup({
        mode: "cowork",
        editingTurnId: "turn-editing",
      }),
    ).toContain("Edit and resend");
  });

  it("renders web posture, planning, preset, blocked route, and voice warning branches", () => {
    expect(buildComposerMarkup({ selectedSessionId: null })).toContain("New thread");
    expect(buildComposerMarkup({ currentWebMode: "off" })).not.toContain("Web auto");
    expect(buildComposerMarkup({ currentWebMode: "quick" })).toContain("Quick web");
    expect(buildComposerMarkup({ currentWebMode: "deep" })).toContain("Deep web");
    expect(
      buildComposerMarkup({
        planningMode: "advisory",
        effectiveToolAutonomy: "manual",
      }),
    ).toContain("Manual tool execution is enforced for this turn.");
    expect(
      buildComposerMarkup({
        presetApplyWarning: "Provider defaults were skipped because the route is locked.",
      }),
    ).toContain("Preset applied with skipped defaults");
    expect(
      buildComposerMarkup({
        mode: "cowork",
        routePreflight: {
          blockedReason: "The selected route is unavailable.",
        } as any,
      }),
    ).toContain("The selected route is unavailable.");
    expect(
      buildComposerMarkup({
        voiceStatusLabel: "Voice disabled",
        voiceUnavailableReason: "No speech provider is configured.",
      }),
    ).toContain("No speech provider is configured.");
  });

  it("delegates recovery, dismiss, file upload, and multimodal callbacks", () => {
    const onDismissPresetWarning = vi.fn();
    const onRetryTurn = vi.fn();
    const onSetDeepMode = vi.fn();
    const onReviewRunDetails = vi.fn();
    const onRemoveAttachment = vi.fn();
    const onSetAttachmentMode = vi.fn();
    const onUploadFiles = vi.fn();
    const onAudioFileSelected = vi.fn();
    const onKnowledgeUrlModeChange = vi.fn();
    const renderer = buildComposerRenderer({
      mode: "cowork",
      draft: "Create a launch image",
      presetApplyWarning: "Some defaults were skipped.",
      selectedTurnRecovery: {
        action: "retry_narrower",
        label: "Retry narrower",
        summary: "Use a smaller scope.",
      },
      selectedTurn: {
        turnId: "turn-retry",
        trace: { status: "failed" },
      } as any,
      pendingAttachments: [
        createDocumentAttachment({
          extractStatus: "ready",
          attachmentId: "attachment-doc-actions",
          extractPreview: "Document text",
        }),
      ],
      pendingAttachmentModes: {
        "attachment-doc-actions": "retrieval",
      },
      knowledgeUrlDraft: "https://example.test/reference",
      knowledgeUrlMode: "retrieval",
      imageGenerationAvailable: true,
      imageEditAvailable: true,
      imageRouteLabel: null,
      onDismissPresetWarning,
      onRetryTurn,
      onSetDeepMode,
      onReviewRunDetails,
      onRemoveAttachment,
      onSetAttachmentMode,
      onUploadFiles,
      onAudioFileSelected,
      onKnowledgeUrlModeChange,
    });

    act(() => {
      findButtonByText(renderer, "Dismiss")?.props.onClick();
      findButtonByText(renderer, "Retry run step")?.props.onClick();
      findButtonByText(renderer, "Open run details")?.props.onClick();
      findButtonByText(renderer, "Remove")?.props.onClick();
      findButtonByText(renderer, "Use retrieval")?.props.onClick();
      const readButtons = findButtonsContaining(renderer, "Read in full");
      readButtons[readButtons.length - 1]?.props.onClick();
      renderer.root
        .findAllByType("input")
        .find((node) => node.props.multiple)
        ?.props.onChange({ target: { files: ["brief.pdf"] } });
      renderer.root
        .findAllByType("input")
        .find((node) => node.props.accept === "audio/*")
        ?.props.onChange({ target: { files: ["voice.wav"] } });
    });

    expect(onDismissPresetWarning).toHaveBeenCalledTimes(1);
    expect(onRetryTurn).toHaveBeenCalledWith("turn-retry");
    expect(onReviewRunDetails).toHaveBeenCalledTimes(1);
    expect(onRemoveAttachment).toHaveBeenCalledWith("attachment-doc-actions");
    expect(onSetAttachmentMode).toHaveBeenCalledWith("attachment-doc-actions", "retrieval");
    expect(onUploadFiles).toHaveBeenCalledWith(["brief.pdf"]);
    expect(onAudioFileSelected).toHaveBeenCalledWith(["voice.wav"]);
    expect(onKnowledgeUrlModeChange).toHaveBeenCalledWith("full_text");

    renderer.update(
      buildComposerElement({
        selectedTurnRecovery: {
          action: "switch_to_deep_mode",
          label: "Use deep mode",
          summary: "Search needs a deeper pass.",
        },
        selectedTurn: {
          turnId: "turn-deep",
          trace: { status: "completed" },
        } as any,
        currentWebMode: "quick",
        onSetDeepMode,
      }),
    );

    act(() => {
      findButtonByText(renderer, "Set Deep mode")?.props.onClick();
    });

    expect(onSetDeepMode).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it("delegates composer text, command, attachment mode, knowledge source, and send callbacks", () => {
    const onDraftChange = vi.fn();
    const onComposerKeyDown = vi.fn();
    const onComposerPaste = vi.fn();
    const onApplyDraftCommand = vi.fn();
    const onSetAttachmentMode = vi.fn();
    const onKnowledgeUrlDraftChange = vi.fn();
    const onKnowledgeUrlModeChange = vi.fn();
    const onAttachKnowledgeUrl = vi.fn();
    const onSend = vi.fn();
    const renderer = buildComposerRenderer({
      draft: "/he",
      commandSuggestions: [
        {
          key: "help",
          command: "/help",
          description: "Show available chat commands.",
          applyValue: "/help ",
        },
      ],
      pendingAttachments: [
        createDocumentAttachment({
          extractStatus: "ready",
          extractPreview: "Extracted brief",
        }),
      ],
      pendingAttachmentModes: {
        "attachment-doc-1": "message",
      },
      knowledgeUrlDraft: "https://example.test/spec",
      knowledgeUrlMode: "retrieval",
      onDraftChange,
      onComposerKeyDown,
      onComposerPaste,
      onApplyDraftCommand,
      onSetAttachmentMode,
      onKnowledgeUrlDraftChange,
      onKnowledgeUrlModeChange,
      onAttachKnowledgeUrl,
      onSend,
    });

    act(() => {
      renderer.root.findByType("textarea").props.onChange({ target: { value: "/help" } });
      renderer.root.findByType("textarea").props.onKeyDown({ key: "Enter" });
      renderer.root.findByType("textarea").props.onPaste({ clipboardData: {} });
      findButtonContaining(renderer, "/help")?.props.onClick();
      findButtonByText(renderer, "Read in full")?.props.onClick();
      renderer.root.findByProps({ "aria-label": "Thread knowledge URL" }).props.onChange({
        target: { value: "https://example.test/updated" },
      });
      const retrievalButtons = findButtonsContaining(renderer, "Use retrieval");
      retrievalButtons[retrievalButtons.length - 1]?.props.onClick();
      findButtonByText(renderer, "Attach source")?.props.onClick();
      findButtonByText(renderer, "Send message")?.props.onClick();
    });

    expect(onDraftChange).toHaveBeenCalledWith("/help");
    expect(onComposerKeyDown).toHaveBeenCalledWith({ key: "Enter" });
    expect(onComposerPaste).toHaveBeenCalledWith({ clipboardData: {} });
    expect(onApplyDraftCommand).toHaveBeenCalledWith("/help ");
    expect(onSetAttachmentMode).toHaveBeenCalledWith("attachment-doc-1", "full_text");
    expect(onKnowledgeUrlDraftChange).toHaveBeenCalledWith("https://example.test/updated");
    expect(onKnowledgeUrlModeChange).toHaveBeenCalledWith("retrieval");
    expect(onAttachKnowledgeUrl).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it("keeps pending document full-text disabled until extraction data is available", () => {
    const renderer = buildComposerRenderer({
      pendingAttachments: [createDocumentAttachment()],
    });

    expect(findButtonByText(renderer, "Read in full")?.props.disabled).toBe(true);

    renderer.unmount();
  });

  it("recognizes document-like OCR and transcript attachments plus file-extension image fallbacks", () => {
    const markup = buildComposerMarkup({
      pendingAttachments: [
        createDocumentAttachment({
          attachmentId: "attachment-ocr",
          fileName: "scan.bin",
          mimeType: "application/octet-stream",
          mediaType: "binary",
          ocrText: "Detected OCR text",
        }),
        createDocumentAttachment({
          attachmentId: "attachment-transcript",
          fileName: "audio.bin",
          mimeType: "application/octet-stream",
          mediaType: "binary",
          transcriptText: "Detected transcript",
        }),
        createImageAttachment({
          attachmentId: "attachment-file-extension",
          fileName: "diagram.SVG",
          mimeType: "application/octet-stream",
          mediaType: "binary",
        }),
      ] as any,
    });

    expect(markup).toContain("Attachment mode for scan.bin");
    expect(markup).toContain("Attachment mode for audio.bin");
    expect(markup).toContain("/api/v1/chat/attachments/attachment-file-extension/content?disposition=inline");
  });

  it("renders thread knowledge chips and routes removal through the attachment id", () => {
    const onRemoveThreadKnowledgeAttachment = vi.fn();
    const renderer = buildComposerRenderer({
      threadKnowledgeAttachments: [
        {
          attachmentId: "knowledge-1",
          title: "Architecture notes",
          retrievalMode: "full_text",
          ingestStatus: "failed",
          errorMessage: "Could not fetch source.",
        },
      ] as any,
      onRemoveThreadKnowledgeAttachment,
    });

    expect(nodeText(renderer.toJSON())).toContain("Architecture notes");
    expect(nodeText(renderer.toJSON())).toContain("Could not fetch source.");

    act(() => {
      findButtonByText(renderer, "Remove")?.props.onClick();
    });

    expect(onRemoveThreadKnowledgeAttachment).toHaveBeenCalledWith("knowledge-1");

    renderer.unmount();
  });

  it("keeps omitted optional callbacks safe across visible composer controls", () => {
    const renderer = buildComposerRenderer({
      draft: "Create a launch image",
      pendingAttachments: [
        createDocumentAttachment({
          extractStatus: "ready",
          attachmentId: "attachment-doc-defaults",
          extractPreview: "Document text",
        }),
      ],
      threadKnowledgeAttachments: [
        {
          attachmentId: "knowledge-defaults",
          title: "Reference URL",
          retrievalMode: "retrieval",
          ingestStatus: "ready",
        },
      ] as any,
      knowledgeUrlDraft: "https://example.test/reference",
      knowledgeUrlMode: "full_text",
      voiceInputAvailable: true,
      voiceOutputAvailable: true,
      voiceStatusLabel: "Voice ready",
      imageGenerationAvailable: true,
      imageEditAvailable: true,
      imageProviderOptions: [
        {
          providerId: "openai",
          label: "OpenAI",
          models: ["gpt-image-2"],
        },
      ],
      selectedImageProviderId: "openai",
      selectedImageModel: "gpt-image-2",
      imageRouteLabel: "OpenAI / gpt-image-2",
    });

    act(() => {
      findButtonByText(renderer, "Message only")?.props.onClick();
      findButtonByText(renderer, "Read in full")?.props.onClick();
      const removeButtons = findButtonsContaining(renderer, "Remove");
      removeButtons[removeButtons.length - 1]?.props.onClick();
      renderer.root.findByProps({ "aria-label": "Thread knowledge URL" }).props.onChange({
        target: { value: "https://example.test/next" },
      });
      const retrievalButtons = findButtonsContaining(renderer, "Use retrieval");
      retrievalButtons[retrievalButtons.length - 1]?.props.onClick();
      findButtonByText(renderer, "Attach source")?.props.onClick();
      renderer.root.findByProps({ "aria-label": "Provider" }).props.onChange({ target: { value: "openai" } });
      renderer.root
        .findAllByType("input")
        .find((node) => node.props.accept === "audio/*")
        ?.props.onChange({ target: { files: ["voice.wav"] } });
      findButtonByText(renderer, "Start talk")?.props.onClick();
      findButtonByText(renderer, "Insert transcript")?.props.onClick();
      findButtonByText(renderer, "Speak replies off")?.props.onClick();
      findButtonByText(renderer, "Create image")?.props.onClick();
      findButtonByText(renderer, "Edit image")?.props.onClick();
    });

    expect(nodeText(renderer.toJSON())).toContain("OpenAI / gpt-image-2");
    expect(nodeText(renderer.toJSON())).toContain("Voice ready");

    renderer.unmount();
  });

  it("falls back to authenticated image preview loading after direct image errors", async () => {
    const originalFetch = globalThis.fetch;
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => "auth required",
    }));
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(() => "blob:preview"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });

    try {
      const renderer = buildComposerRenderer({
        pendingAttachments: [createImageAttachment()],
      });

      await act(async () => {
        renderer.root.findByType("img").props.onError();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(nodeText(renderer.toJSON())).toContain("Preview unavailable: API error 401: auth required");

      renderer.unmount();
    } finally {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        writable: true,
        value: originalCreateObjectUrl,
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        writable: true,
        value: originalRevokeObjectUrl,
      });
    }
  });

  it("uses authenticated image preview blobs and revokes them on cleanup", async () => {
    const originalFetch = globalThis.fetch;
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["image"], { type: "image/png" }),
    }));
    const createObjectUrl = vi.fn(() => "blob:preview");
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: revokeObjectUrl,
    });

    try {
      const renderer = buildComposerRenderer({
        pendingAttachments: [createImageAttachment({ attachmentId: "attachment-image-success" })],
      });

      await act(async () => {
        renderer.root.findByType("img").props.onError();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(createObjectUrl).toHaveBeenCalledTimes(1);
      expect(renderer.root.findByType("img").props.src).toBe("blob:preview");

      act(() => {
        renderer.root.findByType("img").props.onError();
      });

      expect(nodeText(renderer.toJSON())).toContain("Preview unavailable: Preview unavailable.");

      act(() => {
        renderer.unmount();
      });

      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:preview");
    } finally {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        writable: true,
        value: originalCreateObjectUrl,
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        writable: true,
        value: originalRevokeObjectUrl,
      });
    }
  });
});
