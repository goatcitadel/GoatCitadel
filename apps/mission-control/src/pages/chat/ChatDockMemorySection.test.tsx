import React from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ChatDockMemorySection } from "./ChatDockMemorySection";
import { ChatLearnedMemoryPanel } from "./ChatLearnedMemoryPanel";

function buildProps(overrides: Partial<Parameters<typeof ChatDockMemorySection>[0]> = {}) {
  return {
    learnedMemory: [
      {
        itemId: "memory-1",
        itemType: "preference",
        confidence: 0.91,
        status: "active",
        content: "Prefers release evidence with command output.",
      },
    ] as any,
    secondaryLoading: false,
    sending: false,
    selectedSessionId: "session-1",
    onRebuildLearnedMemory: vi.fn(async () => undefined),
    onUpdateMemoryStatus: vi.fn(async () => undefined),
    ...overrides,
  } satisfies Parameters<typeof ChatDockMemorySection>[0];
}

describe("ChatDockMemorySection", () => {
  it("routes learned-memory rebuild and status decisions through the memory panel", async () => {
    const props = buildProps();
    const renderer = create(<ChatDockMemorySection {...props} />);

    const panel = renderer.root.findByType(ChatLearnedMemoryPanel);
    expect(panel.props.learnedMemory).toHaveLength(1);
    expect(panel.props.selectedSessionId).toBe("session-1");

    await act(async () => {
      await panel.props.onRebuild();
      await panel.props.onUpdateStatus("memory-1", "superseded");
      await panel.props.onUpdateStatus("memory-1", "disabled");
    });

    expect(props.onRebuildLearnedMemory).toHaveBeenCalledTimes(1);
    expect(props.onUpdateMemoryStatus).toHaveBeenNthCalledWith(1, "memory-1", "superseded");
    expect(props.onUpdateMemoryStatus).toHaveBeenNthCalledWith(2, "memory-1", "disabled");
  });
});
