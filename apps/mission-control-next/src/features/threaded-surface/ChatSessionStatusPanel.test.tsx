import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { ChatSessionStatusResponse } from "@goatcitadel/contracts";
import { ChatSessionStatusPanel } from "./ChatSessionStatusPanel";

const unavailable = { availability: "unavailable" as const, reason: "Canonical evidence is unavailable." };

function status(): ChatSessionStatusResponse {
  return {
    schemaVersion: "chat.session-status.v1",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    generatedAt: "2026-07-27T01:00:00.000Z",
    model: {
      availability: "available",
      value: { providerId: "openai", model: "gpt-status", selectionSource: "turn_trace" },
    },
    context: unavailable,
    work: {
      availability: "available",
      value: {
        turnCounts: { queued: 0, running: 1, waiting_for_tool: 0, waiting_for_approval: 0, waiting_for_user_input: 0 },
        durableRuns: [],
      },
    },
    attention: {
      availability: "available",
      value: {
        pendingApprovals: [],
        pendingUserInputs: [],
        backgroundTasks: [],
        backgroundTaskProjection: { complete: true },
      },
    },
    orchestration: { availability: "available", value: { runs: [] } },
    capabilities: unavailable,
    usage: unavailable,
    build: unavailable,
  };
}

describe("ChatSessionStatusPanel", () => {
  it("renders canonical values and calls explicit refresh and close actions", () => {
    const onRefresh = vi.fn();
    const onClose = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <ChatSessionStatusPanel
          panel={{ open: true, loading: false, error: null, status: status(), onRefresh, onClose }}
        />,
      );
    });
    expect(renderer.root.findByProps({ "aria-label": "Chat session status" })).toBeTruthy();
    expect(
      renderer.root.findAllByType("strong").some((node) => String(node.children.join(" ")).includes("gpt-status")),
    ).toBe(true);
    expect(
      renderer.root.findAllByType("strong").filter((node) => node.children.includes("Unavailable")).length,
    ).toBeGreaterThan(0);
    act(() => renderer.root.findByProps({ children: "Refresh" }).props.onClick());
    act(() => renderer.root.findByProps({ "aria-label": "Close session status" }).props.onClick());
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows offline Gateway errors without inventing zero values", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <ChatSessionStatusPanel
          panel={{ open: true, loading: false, error: "offline", status: null, onRefresh: vi.fn(), onClose: vi.fn() }}
        />,
      );
    });
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain("offline");
    expect(renderer.root.findAllByType("strong")).toHaveLength(0);
  });

  it("announces persisted background blockers through the canonical attention section", () => {
    const value = status();
    if (value.attention.availability !== "available") throw new Error("attention fixture unavailable");
    value.attention.value.backgroundTasks.push({
      watcherId: "watcher-1",
      childRunId: "child-1",
      label: "Workspace explorer",
      canonicalStatus: "waiting",
      attention: {
        state: "background",
        reason: "operator_continued_in_background",
        updatedAt: "2026-07-27T01:00:00.000Z",
        required: true,
        requiredReason: "approval_required",
      },
      blockers: [{ kind: "approval_required", message: "Approval required." }],
      links: [],
    });
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <ChatSessionStatusPanel
          panel={{ open: true, loading: false, error: null, status: value, onRefresh: vi.fn(), onClose: vi.fn() }}
        />,
      );
    });
    expect(renderer.root.findByProps({ role: "status" }).children.join("")).toContain(
      "Workspace explorer: approval required",
    );
  });
});
