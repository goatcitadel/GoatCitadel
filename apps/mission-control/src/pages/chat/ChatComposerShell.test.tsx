import React, { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatComposerShell } from "./ChatComposerShell";

function buildComposerMarkup(overrides: Partial<Parameters<typeof ChatComposerShell>[0]> = {}) {
  return renderToStaticMarkup(
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
      canSend
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
    />,
  );
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
});
