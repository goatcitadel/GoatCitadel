import React, { useMemo, useState } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatComposerInteractions } from "./useChatComposerInteractions";

const apiMocks = vi.hoisted(() => ({
  uploadChatAttachment: vi.fn(async ({ file }: { file: File }) => ({
    attachmentId: `att-${file.name}`,
    sessionId: "session-1",
    filename: file.name,
    contentType: "text/plain",
    sizeBytes: 12,
    createdAt: "2026-05-14T10:00:00.000Z",
  })),
}));

vi.mock("../../api/client", () => ({
  uploadChatAttachment: apiMocks.uploadChatAttachment,
}));

type Interactions = ReturnType<typeof useChatComposerInteractions>;

type HarnessMocks = {
  ensureSession: ReturnType<typeof vi.fn>;
  handleSend: ReturnType<typeof vi.fn>;
  handleCreateSession: ReturnType<typeof vi.fn>;
  handleArchiveWorkspaceMissionChats: ReturnType<typeof vi.fn>;
  handleRunQuickResearch: ReturnType<typeof vi.fn>;
  handlePrefPatch: ReturnType<typeof vi.fn>;
  handleRevealSelectedTurnDetails: ReturnType<typeof vi.fn>;
  confirmCapabilitySuggestionAction: ReturnType<typeof vi.fn>;
  confirmDeleteSession: ReturnType<typeof vi.fn>;
  setEditingTurnId: ReturnType<typeof vi.fn>;
};

type HarnessState = {
  draft: string;
  commandIndex: number;
  pendingAttachments: any[];
  isDragActive: boolean;
  dockOpen: boolean;
  archiveWorkspaceConfirmOpen: boolean;
  sending: boolean;
  error: string | null;
  interactions: Interactions;
  mocks: HarnessMocks;
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
  const mocks = useMemo<HarnessMocks>(
    () => ({
      ensureSession: vi.fn(async () => ({ sessionId: "session-1" }) as any),
      handleSend: vi.fn(async () => undefined),
      handleCreateSession: vi.fn(async () => undefined),
      handleArchiveWorkspaceMissionChats: vi.fn(async () => undefined),
      handleRunQuickResearch: vi.fn(async () => undefined),
      handlePrefPatch: vi.fn(async () => undefined),
      handleRevealSelectedTurnDetails: vi.fn(),
      confirmCapabilitySuggestionAction: vi.fn(async () => undefined),
      confirmDeleteSession: vi.fn(async () => undefined),
      setEditingTurnId: vi.fn(),
    }),
    [],
  );

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
    ensureSession: mocks.ensureSession,
    handleSend: mocks.handleSend,
    handleCreateSession: mocks.handleCreateSession,
    handleArchiveWorkspaceMissionChats: mocks.handleArchiveWorkspaceMissionChats,
    handleRunQuickResearch: mocks.handleRunQuickResearch,
    handlePrefPatch: mocks.handlePrefPatch,
    handleRevealSelectedTurnDetails: mocks.handleRevealSelectedTurnDetails,
    confirmCapabilitySuggestionAction: mocks.confirmCapabilitySuggestionAction,
    confirmDeleteSession: mocks.confirmDeleteSession,
    setSending,
    setError,
    setDraft,
    setCommandIndex,
    setPendingAttachments,
    setIsDragActive,
    setEditingTurnId: mocks.setEditingTurnId,
    setDockOpen,
    setArchiveWorkspaceConfirmOpen,
  });

  latest = {
    draft,
    commandIndex,
    pendingAttachments,
    isDragActive,
    dockOpen,
    archiveWorkspaceConfirmOpen,
    sending,
    error,
    interactions,
    mocks,
    onKeyDown: interactions.handleComposerKeyDown,
  };

  return null;
}

describe("useChatComposerInteractions", () => {
  beforeEach(() => {
    apiMocks.uploadChatAttachment.mockClear();
    latest = null;
  });

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

  it("sends on Enter and preserves multiline drafts on Shift+Enter", () => {
    create(<Harness />);

    const enterEvent = {
      key: "Enter",
      shiftKey: false,
      preventDefault: vi.fn(),
    };
    const shiftEnterEvent = {
      key: "Enter",
      shiftKey: true,
      preventDefault: vi.fn(),
    };

    act(() => {
      latest?.onKeyDown(enterEvent);
      latest?.onKeyDown(shiftEnterEvent);
    });

    expect(enterEvent.preventDefault).toHaveBeenCalled();
    expect(shiftEnterEvent.preventDefault).not.toHaveBeenCalled();
    expect(latest?.mocks.handleSend).toHaveBeenCalledTimes(1);
  });

  it("uploads pasted and dropped files, tracks drag state, and removes attachments", async () => {
    create(<Harness />);
    const pastedFile = { name: "pasted.txt" } as File;
    const droppedFile = { name: "dropped.txt" } as File;
    const pasteEvent = {
      clipboardData: {
        files: [pastedFile],
        items: [],
      },
      preventDefault: vi.fn(),
    };

    await act(async () => {
      latest?.interactions.handleComposerPaste(pasteEvent as any);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(pasteEvent.preventDefault).toHaveBeenCalled();
    expect(apiMocks.uploadChatAttachment).toHaveBeenCalledWith({
      sessionId: "session-1",
      projectId: "project-1",
      file: pastedFile,
    });
    expect(latest?.pendingAttachments.map((attachment) => attachment.attachmentId)).toEqual(["att-pasted.txt"]);
    expect(latest?.sending).toBe(false);
    expect(latest?.error).toBeNull();

    const dragEnterEvent = {
      dataTransfer: { types: ["Files"] },
      preventDefault: vi.fn(),
    };
    act(() => {
      latest?.interactions.handleDragEnter(dragEnterEvent as any);
    });
    expect(dragEnterEvent.preventDefault).toHaveBeenCalled();
    expect(latest?.isDragActive).toBe(true);

    const dropEvent = {
      dataTransfer: {
        types: ["Files"],
        files: [droppedFile],
      },
      preventDefault: vi.fn(),
    };
    await act(async () => {
      latest?.interactions.handleDrop(dropEvent as any);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dropEvent.preventDefault).toHaveBeenCalled();
    expect(latest?.isDragActive).toBe(false);
    expect(latest?.pendingAttachments.map((attachment) => attachment.attachmentId)).toEqual([
      "att-pasted.txt",
      "att-dropped.txt",
    ]);

    act(() => {
      latest?.interactions.handleRemoveAttachment("att-pasted.txt");
    });

    expect(latest?.pendingAttachments.map((attachment) => attachment.attachmentId)).toEqual(["att-dropped.txt"]);
  });

  it("wires secondary composer actions without mutating unrelated state", async () => {
    create(<Harness />);

    act(() => {
      latest?.interactions.handleToggleDock();
      latest?.interactions.handleApplyDraftCommand("/memory rebuild");
      latest?.interactions.handleCancelEdit();
      latest?.interactions.handleArchiveWorkspace();
      latest?.interactions.handleDismissError();
    });

    expect(latest?.dockOpen).toBe(true);
    expect(latest?.draft).toBe("/memory rebuild ");
    expect(latest?.archiveWorkspaceConfirmOpen).toBe(true);
    expect(latest?.mocks.setEditingTurnId).toHaveBeenCalledWith(null);

    await act(async () => {
      latest?.interactions.handleCreateCurrentModeSession();
      latest?.interactions.handleConfirmCapabilitySuggestion();
      latest?.interactions.handleConfirmDeleteSession();
      latest?.interactions.handleSetDeepMode();
      latest?.interactions.handleRunQuickResearch();
      latest?.interactions.handleConfirmArchiveWorkspace();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latest?.mocks.handleCreateSession).toHaveBeenCalledWith("chat");
    expect(latest?.mocks.confirmCapabilitySuggestionAction).toHaveBeenCalledTimes(1);
    expect(latest?.mocks.confirmDeleteSession).toHaveBeenCalledTimes(1);
    expect(latest?.mocks.handlePrefPatch).toHaveBeenCalledWith({ webMode: "deep" });
    expect(latest?.mocks.handleRunQuickResearch).toHaveBeenCalledTimes(1);
    expect(latest?.mocks.handleArchiveWorkspaceMissionChats).toHaveBeenCalledTimes(1);
    expect(latest?.archiveWorkspaceConfirmOpen).toBe(false);
  });
});
