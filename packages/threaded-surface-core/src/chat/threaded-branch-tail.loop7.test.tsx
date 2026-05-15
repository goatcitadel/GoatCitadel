import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyComposerSuggestion, useChatComposerInteractions } from "./useChatComposerInteractions";
import {
  applyDelegationStreamFailure,
  createSeedDelegationSteps,
  inferDelegationRunStatus,
  resolveDelegationRoute,
  resolveSelectedTurn,
} from "./useChatDelegationPolicyActions";
import { updateThreadFromStreamChunk } from "../chat-thread-reducer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const uploadChatAttachmentMock = vi.hoisted(() => vi.fn());

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  uploadChatAttachment: (...args: unknown[]) => uploadChatAttachmentMock(...args),
}));

type ComposerApi = ReturnType<typeof useChatComposerInteractions>;

let latestComposer: ComposerApi | null = null;
let latestDraft = "";
let latestDragActive = false;

function makeKeyboardEvent(key: string, patch: Partial<React.KeyboardEvent<HTMLTextAreaElement>> = {}) {
  return {
    key,
    preventDefault: vi.fn(),
    ...patch,
  } as unknown as React.KeyboardEvent<HTMLTextAreaElement>;
}

function makePasteEvent(data: Partial<ClipboardEvent["clipboardData"]>) {
  return {
    preventDefault: vi.fn(),
    clipboardData: data,
  } as unknown as React.ClipboardEvent<HTMLTextAreaElement>;
}

function makeDragEvent(types: string[], files?: File[]) {
  return {
    preventDefault: vi.fn(),
    dataTransfer: {
      dropEffect: "none",
      files,
      types,
    },
  } as unknown as React.DragEvent<HTMLDivElement>;
}

function ComposerHarness(props: {
  commandIndex?: number;
  commandSuggestions?: Array<{ applyValue: string }>;
  selectedSession?: unknown;
}) {
  const [draft, setDraft] = React.useState("");
  const [dragActive, setIsDragActive] = React.useState(false);
  latestComposer = useChatComposerInteractions({
    draft,
    lastEditableDraft: "Previous draft",
    commandSuggestions: (props.commandSuggestions ?? []) as never,
    commandIndex: props.commandIndex ?? 0,
    sending: false,
    selectedSession: (props.selectedSession ?? null) as never,
    messageMode: "chat",
    ensureSession: vi.fn(async () => ({ sessionId: "session-loop7" }) as never),
    handleSend: vi.fn(async () => undefined),
    handleCreateSession: vi.fn(async () => undefined),
    handleArchiveWorkspaceMissionChats: vi.fn(async () => undefined),
    handleRunQuickResearch: vi.fn(async () => undefined),
    handlePrefPatch: vi.fn(async () => undefined),
    handleTogglePlanningMode: vi.fn(),
    handleRevealSelectedTurnDetails: vi.fn(),
    confirmCapabilitySuggestionAction: vi.fn(async () => undefined),
    confirmDeleteSession: vi.fn(async () => undefined),
    setSending: vi.fn(),
    setError: vi.fn(),
    setDraft,
    setCommandIndex: vi.fn(),
    setPendingAttachments: vi.fn(),
    setIsDragActive,
    setEditingTurnId: vi.fn(),
    setDockOpen: vi.fn(),
    setArchiveWorkspaceConfirmOpen: vi.fn(),
  });
  latestDraft = draft;
  latestDragActive = dragActive;
  return null;
}

function baseUserMessage(content = "Investigate this branch") {
  return {
    messageId: "user-loop7",
    sessionId: "session-loop7",
    role: "user",
    actorType: "user",
    actorId: "operator",
    content,
    timestamp: "2026-05-14T10:00:00.000Z",
  };
}

function baseTurn() {
  return {
    turnId: "turn-loop7",
    userMessage: baseUserMessage(),
    assistantMessage: {
      messageId: "assistant-loop7",
      sessionId: "session-loop7",
      role: "assistant",
      actorType: "agent",
      actorId: "assistant",
      content: "Existing",
      timestamp: "2026-05-14T10:00:01.000Z",
    },
    trace: {
      turnId: "turn-loop7",
      sessionId: "session-loop7",
      userMessageId: "user-loop7",
      assistantMessageId: "assistant-loop7",
      status: "running",
      mode: "chat",
      toolRuns: [],
      citations: [
        {
          citationId: "cite-existing",
          url: "https://example.test/doc",
        },
      ],
      routing: { primaryProviderId: "openai" },
    },
    toolRuns: [],
    citations: [
      {
        citationId: "cite-existing",
        url: "https://example.test/doc",
      },
    ],
    branch: {
      siblingTurnIds: ["turn-loop7"],
      activeSiblingIndex: 0,
      siblingCount: 1,
      isSelectedPath: true,
      newestLeafTurnId: "turn-loop7",
    },
  };
}

describe("threaded branch-tail coverage", () => {
  beforeEach(() => {
    latestComposer = null;
    latestDraft = "";
    latestDragActive = false;
    uploadChatAttachmentMock.mockReset();
  });

  it("covers composer suggestion and clipboard/drop guard branches", async () => {
    expect(applyComposerSuggestion("No active token", "$reviewer")).toBe("$reviewer ");
    expect(applyComposerSuggestion("$rev", "plain command")).toBe("plain command ");

    await act(async () => {
      create(<ComposerHarness commandIndex={5} commandSuggestions={[{ applyValue: "$reviewer" }]} />);
    });

    const tabWithoutSuggestion = makeKeyboardEvent("Tab");
    await act(async () => {
      latestComposer?.handleComposerKeyDown(tabWithoutSuggestion);
    });
    expect(tabWithoutSuggestion.preventDefault).toHaveBeenCalled();
    expect(latestDraft).toBe("");

    const pasteWithoutFiles = makePasteEvent({});
    await act(async () => {
      latestComposer?.handleComposerPaste(pasteWithoutFiles);
    });
    expect(pasteWithoutFiles.preventDefault).not.toHaveBeenCalled();

    const ignoredDrag = makeDragEvent(["text/plain"]);
    const emptyDrop = makeDragEvent(["Files"]);
    await act(async () => {
      latestComposer?.handleDragEnter(ignoredDrag);
      latestComposer?.handleDragOver(ignoredDrag);
      latestComposer?.handleDragLeave(ignoredDrag);
      latestComposer?.handleDrop(emptyDrop);
      await Promise.resolve();
    });
    expect(ignoredDrag.preventDefault).not.toHaveBeenCalled();
    expect(emptyDrop.preventDefault).toHaveBeenCalled();
    expect(uploadChatAttachmentMock).not.toHaveBeenCalled();
    expect(latestDragActive).toBe(false);
  });

  it("covers attachment upload project scoping and drag-depth branches", async () => {
    uploadChatAttachmentMock.mockResolvedValue({ attachmentId: "attachment-loop11" });
    await act(async () => {
      create(<ComposerHarness selectedSession={{ projectId: "project-loop11" }} />);
    });

    const file = new File(["branch tail"], "tail.txt", { type: "text/plain" });
    const filesDrag = makeDragEvent(["Files"], [file]);
    await act(async () => {
      latestComposer?.handleDragEnter(filesDrag);
      latestComposer?.handleDragOver(filesDrag);
    });
    expect(filesDrag.preventDefault).toHaveBeenCalled();
    expect(latestDragActive).toBe(true);

    const leave = makeDragEvent(["Files"], [file]);
    await act(async () => {
      latestComposer?.handleDragLeave(leave);
    });
    expect(leave.preventDefault).toHaveBeenCalled();
    expect(latestDragActive).toBe(false);

    const drop = makeDragEvent(["Files"], [file]);
    await act(async () => {
      latestComposer?.handleDrop(drop);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(drop.preventDefault).toHaveBeenCalled();
    expect(uploadChatAttachmentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-loop7",
        projectId: "project-loop11",
        file,
      }),
    );
  });

  it("covers reducer defaults, trace fallbacks, and citation merge branches", () => {
    const started = updateThreadFromStreamChunk(
      null,
      {
        type: "message_start",
        sessionId: "session-loop7",
        turnId: "turn-loop7",
      } as never,
      {
        userMessage: baseUserMessage(),
        mode: "send",
      } as never,
      "session-loop7",
      null,
    )!;

    expect(started.turns[0]?.trace).toMatchObject({
      mode: "chat",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      speedMode: "standard",
      subagentPolicy: "ask_when_useful",
    });
    expect(started.turns[0]?.assistantMessage?.messageId).toBeUndefined();

    const current = {
      sessionId: "session-loop7",
      selectedTurnId: "turn-loop7",
      activeLeafTurnId: "turn-loop7",
      turns: [baseTurn()],
    };
    const withDeltaFallback = updateThreadFromStreamChunk(
      current as never,
      {
        type: "delta",
        sessionId: "session-loop7",
        turnId: "turn-loop7",
        delta: " tail",
      } as never,
      null,
      "session-loop7",
      null,
    )!;
    expect(withDeltaFallback.turns[0]?.assistantMessage?.messageId).toBe("assistant-loop7");
    expect(withDeltaFallback.turns[0]?.assistantMessage?.content).toBe("Existing tail");

    const withMergedCitation = updateThreadFromStreamChunk(
      withDeltaFallback as never,
      {
        type: "trace_update",
        sessionId: "session-loop7",
        turnId: "turn-loop7",
        trace: {
          citations: [
            {
              citationId: "cite-new",
              url: "https://example.test/doc",
              title: "Merged title",
              snippet: "Merged snippet",
              sourceType: "web",
            },
          ],
        },
      } as never,
      null,
      "session-loop7",
      null,
    )!;
    expect(withMergedCitation.turns[0]?.citations).toEqual([
      {
        citationId: "cite-new",
        url: "https://example.test/doc",
        title: "Merged title",
        snippet: "Merged snippet",
        sourceType: "web",
      },
    ]);
  });

  it("covers delegation helper branch matrices", () => {
    expect(inferDelegationRunStatus([], undefined)).toBe("running");
    expect(inferDelegationRunStatus([{ status: "completed" }] as never, "running")).toBe("completed");
    expect(inferDelegationRunStatus([{ status: "failed" }, { status: "completed" }] as never, "running")).toBe(
      "partial",
    );
    expect(inferDelegationRunStatus([{ status: "failed" }] as never, "running")).toBe("failed");
    expect(inferDelegationRunStatus([{ status: "running" }] as never, undefined)).toBe("running");

    expect(
      createSeedDelegationSteps({
        objective: "Role fallback",
        roles: ["Architect", "QA"],
      } as never),
    ).toEqual([
      { stepId: "delegation-step-1", role: "Architect", status: "pending", index: 0 },
      { stepId: "delegation-step-2", role: "QA", status: "pending", index: 1 },
    ]);

    expect(resolveDelegationRoute({ providerId: undefined, model: undefined } as never, undefined, undefined)).toEqual(
      {},
    );
    expect(resolveSelectedTurn({ turns: [baseTurn()] } as never, undefined)).toMatchObject({ turnId: "turn-loop7" });
    expect(applyDelegationStreamFailure({ status: "running", steps: [] } as never)).toMatchObject({
      status: "failed",
    });
  });
});
