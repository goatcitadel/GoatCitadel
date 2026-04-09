import React, { useState } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { useChatComposerInteractions } from "./useChatComposerInteractions";

type HarnessState = {
  draft: string;
  commandIndex: number;
  onKeyDown: (event: any) => void;
};

let latest: HarnessState | null = null;

function Harness() {
  const [draft, setDraft] = useState("");
  const [commandIndex, setCommandIndex] = useState(0);
  const [pendingAttachments, setPendingAttachments] = useState<any[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const [dockOpen, setDockOpen] = useState(false);
  const [archiveWorkspaceConfirmOpen, setArchiveWorkspaceConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const interactions = useChatComposerInteractions({
    draft,
    commandSuggestions: [
      {
        key: "plan-on",
        command: "/plan on",
        description: "Enable advisory planning",
        applyValue: "/plan on",
      },
      {
        key: "plan-off",
        command: "/plan off",
        description: "Disable advisory planning",
        applyValue: "/plan off",
      },
    ],
    commandIndex,
    sending,
    selectedSession: {
      sessionId: "session-1",
      projectId: "project-1",
    } as any,
    messageMode: "chat",
    ensureSession: vi.fn(async () => ({ sessionId: "session-1" }) as any),
    handleSend: vi.fn(async () => undefined),
    handleCreateSession: vi.fn(async () => undefined),
    handleArchiveWorkspaceMissionChats: vi.fn(async () => undefined),
    handleRunQuickResearch: vi.fn(async () => undefined),
    handlePrefPatch: vi.fn(async () => undefined),
    handleRevealSelectedTurnDetails: vi.fn(),
    confirmCapabilitySuggestionAction: vi.fn(async () => undefined),
    confirmDeleteSession: vi.fn(async () => undefined),
    setSending,
    setError,
    setDraft,
    setCommandIndex,
    setPendingAttachments,
    setIsDragActive,
    setEditingTurnId: vi.fn(),
    setDockOpen,
    setArchiveWorkspaceConfirmOpen,
  });

  void pendingAttachments;
  void isDragActive;
  void dockOpen;
  void archiveWorkspaceConfirmOpen;
  void error;

  latest = {
    draft,
    commandIndex,
    onKeyDown: interactions.handleComposerKeyDown,
  };

  return null;
}

describe("useChatComposerInteractions", () => {
  it("applies the highlighted command suggestion on Tab", () => {
    create(<Harness />);

    const event = {
      key: "Tab",
      preventDefault: vi.fn(),
    };

    act(() => {
      latest?.onKeyDown(event);
    });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(latest?.draft).toBe("/plan on ");
  });

  it("moves the highlighted command suggestion with arrow keys", () => {
    create(<Harness />);

    const downEvent = {
      key: "ArrowDown",
      preventDefault: vi.fn(),
    };

    act(() => {
      latest?.onKeyDown(downEvent);
    });

    expect(downEvent.preventDefault).toHaveBeenCalled();
    expect(latest?.commandIndex).toBe(1);
  });
});
