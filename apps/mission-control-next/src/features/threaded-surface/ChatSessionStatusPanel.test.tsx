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
    attention: { availability: "available", value: { pendingApprovals: [], pendingUserInputs: [] } },
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
    const renderer = create(
      <ChatSessionStatusPanel
        panel={{ open: true, loading: false, error: null, status: status(), onRefresh, onClose }}
      />,
    );
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
    const renderer = create(
      <ChatSessionStatusPanel
        panel={{ open: true, loading: false, error: "offline", status: null, onRefresh: vi.fn(), onClose: vi.fn() }}
      />,
    );
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain("offline");
    expect(renderer.root.findAllByType("strong")).toHaveLength(0);
  });
});
