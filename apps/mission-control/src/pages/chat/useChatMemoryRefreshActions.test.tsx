import React, { useState } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatMemoryRefreshActions } from "./useChatMemoryRefreshActions";

const apiMocks = vi.hoisted(() => ({
  rebuildChatLearnedMemory: vi.fn(),
  updateChatLearnedMemoryItem: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  rebuildChatLearnedMemory: apiMocks.rebuildChatLearnedMemory,
  updateChatLearnedMemoryItem: apiMocks.updateChatLearnedMemoryItem,
}));

type HarnessState = ReturnType<typeof useChatMemoryRefreshActions> & {
  error: string | null;
  learnedMemory: any[];
  sending: boolean;
};

let latest: HarnessState | null = null;

const selectedSession = {
  sessionId: "session-1",
  sessionKey: "mission:operator:chat_1",
  workspaceId: "default",
  scope: "mission",
  origin: "operator",
  includeInHistory: true,
  pinned: false,
  lifecycleStatus: "active",
  channel: "mission",
  account: "operator",
  updatedAt: "2026-04-14T00:00:00.000Z",
  lastActivityAt: "2026-04-14T00:00:00.000Z",
  tokenTotal: 0,
  costUsdTotal: 0,
};

function Harness(props: { session?: any | null; initialSending?: boolean }) {
  const [sending, setSending] = useState(props.initialSending ?? false);
  const [error, setError] = useState<string | null>(null);
  const [learnedMemory, setLearnedMemory] = useState<any[]>([
    { itemId: "memory-1", status: "active", text: "First memory" },
    { itemId: "memory-2", status: "active", text: "Second memory" },
  ]);

  const hook = useChatMemoryRefreshActions({
    selectedSession: props.session === undefined ? (selectedSession as any) : props.session,
    sending,
    setSending,
    setError,
    setLearnedMemory,
  });

  latest = {
    ...hook,
    error,
    learnedMemory,
    sending,
  };
  return null;
}

describe("useChatMemoryRefreshActions", () => {
  beforeEach(() => {
    latest = null;
    apiMocks.rebuildChatLearnedMemory.mockReset();
    apiMocks.updateChatLearnedMemoryItem.mockReset();
    apiMocks.updateChatLearnedMemoryItem.mockResolvedValue({
      itemId: "memory-2",
      status: "disabled",
      text: "Second memory",
    });
    apiMocks.rebuildChatLearnedMemory.mockResolvedValue({
      items: [{ itemId: "memory-3", status: "active", text: "Rebuilt memory" }],
    });
  });

  it("updates only the matching learned memory item status", async () => {
    create(<Harness />);

    await act(async () => {
      await latest?.handleMemoryStatusUpdate("memory-2", "disabled");
    });

    expect(apiMocks.updateChatLearnedMemoryItem).toHaveBeenCalledWith("session-1", "memory-2", {
      status: "disabled",
    });
    expect(latest?.learnedMemory).toEqual([
      { itemId: "memory-1", status: "active", text: "First memory" },
      { itemId: "memory-2", status: "disabled", text: "Second memory" },
    ]);
    expect(latest?.error).toBeNull();
  });

  it("surfaces update failures without clearing current learned memory", async () => {
    apiMocks.updateChatLearnedMemoryItem.mockRejectedValue(new Error("memory update failed"));
    create(<Harness />);

    await act(async () => {
      await latest?.handleMemoryStatusUpdate("memory-1", "conflict");
    });

    expect(latest?.error).toBe("memory update failed");
    expect(latest?.learnedMemory).toEqual([
      { itemId: "memory-1", status: "active", text: "First memory" },
      { itemId: "memory-2", status: "active", text: "Second memory" },
    ]);
  });

  it("rebuilds learned memory with sending state cleanup", async () => {
    let resolveRebuild: ((value: { items: any[] }) => void) | undefined;
    apiMocks.rebuildChatLearnedMemory.mockReturnValue(
      new Promise((resolve) => {
        resolveRebuild = resolve;
      }),
    );
    create(<Harness />);

    let rebuildPromise: Promise<void> | undefined;
    await act(async () => {
      rebuildPromise = latest?.handleRebuildLearnedMemory();
      await Promise.resolve();
    });
    expect(latest?.sending).toBe(true);

    await act(async () => {
      resolveRebuild?.({ items: [{ itemId: "memory-3", status: "active", text: "Rebuilt memory" }] });
      await rebuildPromise;
    });

    expect(apiMocks.rebuildChatLearnedMemory).toHaveBeenCalledWith("session-1");
    expect(latest?.learnedMemory).toEqual([{ itemId: "memory-3", status: "active", text: "Rebuilt memory" }]);
    expect(latest?.sending).toBe(false);
  });

  it("does not call memory APIs without an active session or while already sending", async () => {
    create(<Harness session={null} />);
    await act(async () => {
      await latest?.handleMemoryStatusUpdate("memory-1", "disabled");
      await latest?.handleRebuildLearnedMemory();
    });

    create(<Harness initialSending />);
    await act(async () => {
      await latest?.handleRebuildLearnedMemory();
    });

    expect(apiMocks.updateChatLearnedMemoryItem).not.toHaveBeenCalled();
    expect(apiMocks.rebuildChatLearnedMemory).not.toHaveBeenCalled();
  });
});
