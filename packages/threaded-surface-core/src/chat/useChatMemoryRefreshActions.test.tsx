import React, { useState } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LearnedMemoryItemRecord } from "@goatcitadel/contracts";
import { useChatMemoryRefreshActions } from "./useChatMemoryRefreshActions";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  rebuildChatLearnedMemory: vi.fn(),
  updateChatLearnedMemoryItem: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  rebuildChatLearnedMemory: apiMocks.rebuildChatLearnedMemory,
  updateChatLearnedMemoryItem: apiMocks.updateChatLearnedMemoryItem,
}));

interface HarnessApi {
  actions: ReturnType<typeof useChatMemoryRefreshActions>;
  snapshot: () => {
    learnedMemory: LearnedMemoryItemRecord[];
    sendingChanges: boolean[];
    errors: Array<string | null>;
  };
}

const baseMemory: LearnedMemoryItemRecord = {
  itemId: "memory-1",
  sessionId: "session-1",
  kind: "fact",
  content: "Use the release branch.",
  status: "active",
  sourceTurnId: null,
  confidence: 0.8,
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
} as LearnedMemoryItemRecord;

let latest: HarnessApi | null = null;

function Harness(props: { hasSession?: boolean; sending?: boolean }) {
  const [learnedMemory, setLearnedMemory] = useState<LearnedMemoryItemRecord[]>([baseMemory]);
  const sendingChangesRef = React.useRef<boolean[]>([]);
  const errorsRef = React.useRef<Array<string | null>>([]);
  const actions = useChatMemoryRefreshActions({
    selectedSession: props.hasSession === false ? null : ({ sessionId: "session-1" } as never),
    sending: props.sending ?? false,
    setSending: (value) => {
      sendingChangesRef.current.push(value);
    },
    setError: (value) => {
      errorsRef.current.push(value);
    },
    setLearnedMemory,
  });

  latest = {
    actions,
    snapshot: () => ({
      learnedMemory,
      sendingChanges: sendingChangesRef.current,
      errors: errorsRef.current,
    }),
  };
  return null;
}

describe("useChatMemoryRefreshActions", () => {
  beforeEach(() => {
    latest = null;
    apiMocks.rebuildChatLearnedMemory.mockReset();
    apiMocks.updateChatLearnedMemoryItem.mockReset();
  });

  it("updates a learned memory item status and reports update failures", async () => {
    const updated = { ...baseMemory, status: "disabled" as const };
    apiMocks.updateChatLearnedMemoryItem.mockResolvedValueOnce(updated);
    await act(async () => {
      create(<Harness />);
    });

    await act(async () => {
      await latest!.actions.handleMemoryStatusUpdate("memory-1", "disabled");
    });

    expect(apiMocks.updateChatLearnedMemoryItem).toHaveBeenCalledWith("session-1", "memory-1", {
      status: "disabled",
    });
    expect(latest!.snapshot().learnedMemory).toEqual([updated]);

    apiMocks.updateChatLearnedMemoryItem.mockRejectedValueOnce(new Error("memory update failed"));
    await act(async () => {
      await latest!.actions.handleMemoryStatusUpdate("memory-1", "conflict");
    });
    expect(latest!.snapshot().errors).toContain("memory update failed");
  });

  it("rebuilds learned memory with sending guards and clears the sending flag", async () => {
    const rebuilt = [{ ...baseMemory, itemId: "memory-2", content: "Rebuilt memory" }];
    apiMocks.rebuildChatLearnedMemory.mockResolvedValueOnce({ items: rebuilt });
    await act(async () => {
      create(<Harness />);
    });

    await act(async () => {
      await latest!.actions.handleRebuildLearnedMemory();
    });

    expect(apiMocks.rebuildChatLearnedMemory).toHaveBeenCalledWith("session-1");
    expect(latest!.snapshot().learnedMemory).toEqual(rebuilt);
    expect(latest!.snapshot().sendingChanges).toEqual([true, false]);

    apiMocks.rebuildChatLearnedMemory.mockRejectedValueOnce(new Error("rebuild failed"));
    await act(async () => {
      await latest!.actions.handleRebuildLearnedMemory();
    });
    expect(latest!.snapshot().errors).toContain("rebuild failed");
    expect(latest!.snapshot().sendingChanges.slice(-2)).toEqual([true, false]);
  });

  it("ignores memory actions without a selected session or while already sending", async () => {
    await act(async () => {
      create(<Harness hasSession={false} />);
    });
    await act(async () => {
      await latest!.actions.handleMemoryStatusUpdate("memory-1", "superseded");
      await latest!.actions.handleRebuildLearnedMemory();
    });
    expect(apiMocks.updateChatLearnedMemoryItem).not.toHaveBeenCalled();
    expect(apiMocks.rebuildChatLearnedMemory).not.toHaveBeenCalled();

    await act(async () => {
      create(<Harness sending />);
    });
    await act(async () => {
      await latest!.actions.handleRebuildLearnedMemory();
    });
    expect(apiMocks.rebuildChatLearnedMemory).not.toHaveBeenCalled();
  });
});
