import React from "react";
import { create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSessionRail } from "./ChatSessionRail";

function renderedText(renderer: ReturnType<typeof create>): string {
  return renderer.root
    .findAll((node) => Array.isArray(node.children))
    .map((node) => node.children.join(""))
    .join(" ");
}

describe("ChatSessionRail tail coverage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders code-mode fallbacks for future, immediate, hourly, and missing activity metadata", () => {
    const renderer = create(
      <ChatSessionRail
        missionSessions={[
          {
            sessionId: "future",
            projectName: null,
            lastActivityAt: "2026-01-01T12:01:00.000Z",
          },
          {
            sessionId: "just-now",
            projectName: "Atlas",
            lastActivityAt: "2026-01-01T11:59:45.000Z",
          },
          {
            sessionId: "hours",
            projectName: "Forge",
            lastActivityAt: "2026-01-01T09:10:00.000Z",
          },
        ]}
        externalSessions={[
          {
            sessionId: "external-default",
            channel: null,
            account: null,
          },
        ]}
        selectedSessionId={null}
        selectedTag={null}
        onSelectSession={vi.fn()}
        onSelectTag={vi.fn()}
        renderSessionLabel={(sessionId) => `Session ${sessionId}`}
        mode="code"
      />,
    );

    const text = renderedText(renderer);
    expect(text).toContain("No project binding · Recently active");
    expect(text).toContain("Bound to Atlas · Just now");
    expect(text).toContain("Bound to Forge · 3h ago");
    expect(text).toContain("External connection · Readback context · Recently active");
    expect(text).toContain("External session");
  });
});
