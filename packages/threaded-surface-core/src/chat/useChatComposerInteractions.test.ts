import React, { useState } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyComposerSuggestion,
  isPlanningModeToggleShortcut,
  useChatComposerInteractions,
} from "./useChatComposerInteractions";
import type { CommandSuggestionItem } from "../chat-command-suggestions";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const uploadChatAttachmentMock = vi.hoisted(() => vi.fn());
const handleSendMock = vi.fn(async () => undefined);

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  uploadChatAttachment: (...args: unknown[]) => uploadChatAttachmentMock(...args),
}));

type ComposerHarnessApi = ReturnType<typeof useChatComposerInteractions>;

let latest: ComposerHarnessApi | null = null;
let latestState: {
  archiveOpen: boolean;
  commandIndex: number;
  dockOpen: boolean;
  draft: string;
  dragActive: boolean;
  editingTurnId: string | null;
  error: string | null;
  pendingAttachmentIds: string[];
  sending: boolean;
} | null = null;

function makeFile(name = "notes.txt") {
  return { name, size: 12, type: "text/plain" } as File;
}

function makeKeyEvent(key: string, options: Partial<React.KeyboardEvent<HTMLTextAreaElement>> = {}) {
  return {
    key,
    preventDefault: vi.fn(),
    ...options,
  } as unknown as React.KeyboardEvent<HTMLTextAreaElement>;
}

function makeDragEvent(types: string[], files: File[] = []) {
  return {
    preventDefault: vi.fn(),
    dataTransfer: {
      dropEffect: "none",
      files,
      types,
    },
  } as unknown as React.DragEvent<HTMLDivElement>;
}

function makeFileList(files: File[]) {
  return Object.assign([...files], { item: (index: number) => files[index] ?? null }) as unknown as FileList;
}

function ComposerHarness(
  props: {
    commandSuggestions?: CommandSuggestionItem[];
    initialDockOpen?: boolean;
    initialDraft?: string;
    lastEditableDraft?: string | null;
    sending?: boolean;
  } = {},
) {
  const [draft, setDraft] = useState(props.initialDraft ?? "Review this with $rea");
  const [commandIndex, setCommandIndex] = useState(0);
  const [pendingAttachments, setPendingAttachments] = useState<any[]>([
    { attachmentId: "keep", fileName: "keep.txt" },
    { attachmentId: "remove", fileName: "remove.txt" },
  ]);
  const [dragActive, setIsDragActive] = useState(false);
  const [editingTurnId, setEditingTurnId] = useState<string | null>("turn-1");
  const [dockOpen, setDockOpen] = useState(Boolean(props.initialDockOpen));
  const [archiveOpen, setArchiveWorkspaceConfirmOpen] = useState(false);
  const [sending, setSending] = useState(Boolean(props.sending));
  const [error, setError] = useState<string | null>("initial error");

  latest = useChatComposerInteractions({
    draft,
    lastEditableDraft: props.lastEditableDraft ?? null,
    commandSuggestions: props.commandSuggestions ?? [
      { key: "skill", command: "$react-expert", applyValue: "$react-expert", description: "React" },
      { key: "plan", command: "/plan", applyValue: "/plan on", description: "Plan" },
    ],
    commandIndex,
    error,
    dockOpen,
    sending,
    selectedSession: { sessionId: "session-1", projectId: "project-1" } as any,
    messageMode: "cowork",
    ensureSession: vi.fn(async () => ({ sessionId: "session-1" }) as any),
    handleSend: handleSendMock,
    handleCreateSession: vi.fn(async () => undefined),
    handleArchiveWorkspaceMissionChats: vi.fn(async () => undefined),
    handleRunQuickResearch: vi.fn(async () => undefined),
    handlePrefPatch: vi.fn(async () => undefined),
    handleTogglePlanningMode: vi.fn(),
    handleRevealSelectedTurnDetails: vi.fn(),
    confirmCapabilitySuggestionAction: vi.fn(async () => undefined),
    confirmDeleteSession: vi.fn(async () => undefined),
    setSending,
    setError,
    setDraft,
    setCommandIndex,
    setPendingAttachments,
    setIsDragActive,
    setEditingTurnId,
    setDockOpen,
    setArchiveWorkspaceConfirmOpen,
  });
  latestState = {
    archiveOpen,
    commandIndex,
    dockOpen,
    draft,
    dragActive,
    editingTurnId,
    error,
    pendingAttachmentIds: pendingAttachments.map((attachment) => attachment.attachmentId),
    sending,
  };
  return null;
}

describe("useChatComposerInteractions", () => {
  beforeEach(() => {
    latest = null;
    latestState = null;
    handleSendMock.mockClear();
    uploadChatAttachmentMock.mockReset();
    uploadChatAttachmentMock.mockResolvedValue({ attachmentId: "uploaded", fileName: "notes.txt" });
  });

  it("uploads files and drives keyboard command interactions", async () => {
    await act(async () => {
      create(React.createElement(ComposerHarness));
    });

    await act(async () => {
      await latest?.uploadAttachments([]);
      await latest?.uploadAttachments([makeFile()]);
    });
    expect(uploadChatAttachmentMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", projectId: "project-1" }),
    );
    expect(latestState?.pendingAttachmentIds).toContain("uploaded");
    expect(latestState?.sending).toBe(false);
    expect(latestState?.error).toBeNull();

    await act(async () => {
      latest?.handleComposerKeyDown(makeKeyEvent("ArrowDown"));
      latest?.handleComposerKeyDown(makeKeyEvent("ArrowUp"));
      latest?.handleComposerKeyDown(makeKeyEvent("Tab"));
      latest?.handleComposerKeyDown(makeKeyEvent("Enter"));
      latest?.handleComposerKeyDown(makeKeyEvent("Enter", { shiftKey: true } as any));
      latest?.handleComposerKeyDown(makeKeyEvent("Tab", { shiftKey: true } as any));
    });
    expect(latestState?.draft).toContain("$react-expert");
  });

  it("supports send escape and previous-draft composer shortcuts", async () => {
    await act(async () => {
      create(
        React.createElement(ComposerHarness, {
          commandSuggestions: [],
          initialDockOpen: true,
          initialDraft: "",
          lastEditableDraft: "Refine the previous answer",
        }),
      );
    });

    const recallEvent = makeKeyEvent("ArrowUp");
    await act(async () => {
      latest?.handleComposerKeyDown(recallEvent);
    });
    expect(recallEvent.preventDefault).toHaveBeenCalled();
    expect(latestState?.draft).toBe("Refine the previous answer");

    const escapeEvent = makeKeyEvent("Escape");
    await act(async () => {
      latest?.handleComposerKeyDown(escapeEvent);
    });
    expect(escapeEvent.preventDefault).toHaveBeenCalled();
    expect(latestState?.dockOpen).toBe(false);
    expect(latestState?.error).toBeNull();

    const sendEvent = makeKeyEvent("Enter", { ctrlKey: true } as any);
    await act(async () => {
      latest?.handleComposerKeyDown(sendEvent);
    });
    expect(sendEvent.preventDefault).toHaveBeenCalled();
    expect(handleSendMock).toHaveBeenCalledTimes(1);
  });

  describe("Escape fallthrough to the document-level stream-stop shortcut", () => {
    it("resets the command-suggestion index and prevents default when suggestions are open", async () => {
      await act(async () => {
        create(
          React.createElement(ComposerHarness, {
            commandSuggestions: [
              { key: "skill", command: "$react-expert", applyValue: "$react-expert", description: "React" },
              { key: "plan", command: "/plan", applyValue: "/plan on", description: "Plan" },
            ],
            initialDockOpen: false,
          }),
        );
      });
      // Move the suggestion index off zero so the Escape reset is observable.
      await act(async () => {
        latest?.handleComposerKeyDown(makeKeyEvent("ArrowDown"));
      });
      expect(latestState?.commandIndex).toBe(1);

      const escapeEvent = makeKeyEvent("Escape");
      await act(async () => {
        latest?.handleComposerKeyDown(escapeEvent);
      });
      expect(latestState?.commandIndex).toBe(0);
      expect(escapeEvent.preventDefault).toHaveBeenCalled();
    });

    it("clears a composer error and prevents default when an error is present", async () => {
      await act(async () => {
        create(
          React.createElement(ComposerHarness, {
            commandSuggestions: [],
            initialDockOpen: false,
          }),
        );
      });
      // ComposerHarness seeds error to "initial error" by default.
      expect(latestState?.error).toBe("initial error");

      const escapeEvent = makeKeyEvent("Escape");
      await act(async () => {
        latest?.handleComposerKeyDown(escapeEvent);
      });
      expect(latestState?.error).toBeNull();
      expect(escapeEvent.preventDefault).toHaveBeenCalled();
    });

    it("closes the dock and prevents default when the dock is open", async () => {
      await act(async () => {
        create(
          React.createElement(ComposerHarness, {
            commandSuggestions: [],
            initialDockOpen: true,
          }),
        );
      });
      // Clear the seeded error out of band so the dock is the only thing Escape can act on.
      await act(async () => {
        latest?.handleDismissError();
      });
      expect(latestState?.error).toBeNull();
      expect(latestState?.dockOpen).toBe(true);

      const escapeEvent = makeKeyEvent("Escape");
      await act(async () => {
        latest?.handleComposerKeyDown(escapeEvent);
      });
      expect(latestState?.dockOpen).toBe(false);
      expect(escapeEvent.preventDefault).toHaveBeenCalled();
    });

    it("does NOT preventDefault when there is nothing to close, letting Escape fall through to the document-level stream-stop shortcut", async () => {
      await act(async () => {
        create(
          React.createElement(ComposerHarness, {
            commandSuggestions: [],
            initialDockOpen: false,
          }),
        );
      });
      // Clear the seeded error and confirm there are no suggestions and no open dock:
      // Escape has nothing left to do in the composer.
      await act(async () => {
        latest?.handleDismissError();
      });
      expect(latestState?.error).toBeNull();
      expect(latestState?.dockOpen).toBe(false);

      const escapeEvent = makeKeyEvent("Escape");
      await act(async () => {
        latest?.handleComposerKeyDown(escapeEvent);
      });
      expect(escapeEvent.preventDefault).not.toHaveBeenCalled();
      expect(latestState?.commandIndex).toBe(0);
      expect(latestState?.dockOpen).toBe(false);
      expect(latestState?.error).toBeNull();
    });
  });

  it("handles paste drag drop and command callbacks", async () => {
    await act(async () => {
      create(React.createElement(ComposerHarness));
    });

    const pastedFile = makeFile("paste.txt");
    const pasteEvent = {
      preventDefault: vi.fn(),
      clipboardData: { files: [pastedFile], items: [] },
    } as unknown as React.ClipboardEvent<HTMLTextAreaElement>;
    await act(async () => {
      latest?.handleComposerPaste(pasteEvent);
      await Promise.resolve();
    });
    expect(pasteEvent.preventDefault).toHaveBeenCalled();

    const itemPasteEvent = {
      preventDefault: vi.fn(),
      clipboardData: {
        files: [],
        items: [{ kind: "file", getAsFile: () => makeFile("item.txt") }],
      },
    } as unknown as React.ClipboardEvent<HTMLTextAreaElement>;
    await act(async () => {
      latest?.handleComposerPaste(itemPasteEvent);
      await Promise.resolve();
    });
    expect(itemPasteEvent.preventDefault).toHaveBeenCalled();

    const ignoredDrag = makeDragEvent(["text/plain"]);
    const dragEnter = makeDragEvent(["Files"]);
    const dragOver = makeDragEvent(["Files"]);
    const dragLeave = makeDragEvent(["Files"]);
    const drop = makeDragEvent(["Files"], [makeFile("drop.txt")]);
    await act(async () => {
      latest?.handleDragEnter(ignoredDrag);
      latest?.handleDragEnter(dragEnter);
      latest?.handleDragOver(dragOver);
      latest?.handleDragLeave(dragLeave);
      latest?.handleDrop(drop);
      await Promise.resolve();
    });
    expect(ignoredDrag.preventDefault).not.toHaveBeenCalled();
    expect(dragEnter.preventDefault).toHaveBeenCalled();
    expect(dragOver.dataTransfer.dropEffect).toBe("copy");
    expect(drop.preventDefault).toHaveBeenCalled();
    expect(latestState?.dragActive).toBe(false);

    await act(async () => {
      latest?.handleDismissError();
      latest?.handleCancelEdit();
      latest?.handleToggleDock();
      latest?.handleCreateCurrentModeSession();
      latest?.handleArchiveWorkspace();
      latest?.handleConfirmCapabilitySuggestion();
      latest?.handleConfirmDeleteSession();
      latest?.handleConfirmArchiveWorkspace();
      latest?.handleSetDeepMode();
      latest?.handleRunQuickResearch();
      latest?.handleRevealSelectedTurnDetails();
      latest?.handleApplyDraftCommand("/plan on");
      latest?.handleRemoveAttachment("remove");
      latest?.handleUploadFiles(null);
      latest?.handleUploadFiles(makeFileList([makeFile("manual.txt")]));
      await Promise.resolve();
    });
    expect(latestState).toMatchObject({
      archiveOpen: false,
      dockOpen: true,
      editingTurnId: null,
      error: null,
    });
    expect(latestState?.draft).toBe("/plan on ");
    expect(latestState?.pendingAttachmentIds).not.toContain("remove");
  });

  it("reports upload failures and ignores uploads while already sending", async () => {
    uploadChatAttachmentMock.mockRejectedValueOnce(new Error("upload failed"));
    await act(async () => {
      create(React.createElement(ComposerHarness));
    });
    await act(async () => {
      await latest?.uploadAttachments([makeFile("bad.txt")]);
    });
    expect(latestState?.error).toBe("upload failed");

    uploadChatAttachmentMock.mockClear();
    await act(async () => {
      create(React.createElement(ComposerHarness, { sending: true }));
    });
    await act(async () => {
      await latest?.uploadAttachments([makeFile("ignored.txt")]);
    });
    expect(uploadChatAttachmentMock).not.toHaveBeenCalled();
  });
});

describe("isPlanningModeToggleShortcut", () => {
  it("matches the Codex-style Shift+Tab planning toggle", () => {
    expect(isPlanningModeToggleShortcut({ key: "Tab", shiftKey: true })).toBe(true);
  });

  it("ignores plain tab and modified tab chords", () => {
    expect(isPlanningModeToggleShortcut({ key: "Tab" })).toBe(false);
    expect(isPlanningModeToggleShortcut({ key: "Tab", shiftKey: true, ctrlKey: true })).toBe(false);
    expect(isPlanningModeToggleShortcut({ key: "Enter", shiftKey: true })).toBe(false);
  });
});

describe("applyComposerSuggestion", () => {
  it("replaces the active dollar skill token without discarding the prompt", () => {
    expect(applyComposerSuggestion("Review this with $rea", "$react-expert")).toBe("Review this with $react-expert ");
  });

  it("keeps slash command suggestions as full composer replacements", () => {
    expect(applyComposerSuggestion("ignored", "/plan on")).toBe("/plan on ");
  });
});
