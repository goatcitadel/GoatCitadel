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
      draft=""
      commandSuggestions={[]}
      commandIndex={0}
      pendingAttachments={[]}
      selectedTurnRecovery={null}
      selectedTurn={null}
      selectedSessionId="session-1"
      currentWebMode="auto"
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
});
