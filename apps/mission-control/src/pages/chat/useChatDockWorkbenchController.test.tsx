import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { defaultDockOpenForMode } from "./surface-config";
import { useChatDockWorkbenchController } from "./useChatDockWorkbenchController";

vi.mock("./useChatWorkbench", () => ({
  useChatWorkbench: vi.fn(() => ({
    workbenchState: { baseRef: "main" },
    workbenchTree: [],
    selectedWorkbenchFile: null,
    workbenchDiff: null,
    workbenchOutput: null,
    workbenchLoading: false,
    workbenchBusy: false,
    workbenchError: null,
    refreshWorkbench: vi.fn(),
    createWorkbenchWorktree: vi.fn(),
    openWorkbenchFile: vi.fn(),
  })),
}));

let latest: ReturnType<typeof useChatDockWorkbenchController> | null = null;

function Harness(props: { mode: "chat" | "cowork" | "code" }) {
  latest = useChatDockWorkbenchController({
    messageMode: props.mode,
    selectedSessionId: "session-1",
    selectedSession: { projectId: "project-1" },
    selectedTurn: {
      turnId: "turn-1",
      trace: {
        orchestration: { phase: "active", steps: [] },
      },
    } as any,
    thread: {
      turns: [],
    } as any,
    messages: [],
    localNotices: [],
    dockSectionOrder: ["workflow", "surface", "trace"],
  });
  return null;
}

describe("useChatDockWorkbenchController", () => {
  it("resets dock openness when the surface mode changes", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness mode="chat" />);
    });
    expect(latest?.dockOpen).toBe(false);

    await act(async () => {
      renderer.update(<Harness mode="code" />);
    });
    expect(latest?.dockOpen).toBe(defaultDockOpenForMode("code", undefined));
  });
});
