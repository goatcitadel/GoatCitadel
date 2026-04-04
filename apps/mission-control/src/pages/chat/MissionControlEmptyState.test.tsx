import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MissionControlEmptyState } from "./MissionControlEmptyState";

describe("MissionControlEmptyState", () => {
  it("renders chat-specific empty-state framing", () => {
    const markup = renderToStaticMarkup(
      <MissionControlEmptyState
        mode="chat"
        sessionCount={3}
        projectCount={1}
        onCreateSession={vi.fn()}
      />,
    );

    expect(markup).toContain("Conversation lane");
    expect(markup).toContain("Start with the thing you actually need");
    expect(markup).toContain("Start chat session");
    expect(markup).toContain("Draft a launch update from my notes");
  });

  it("renders code-specific callouts and action labels", () => {
    const markup = renderToStaticMarkup(
      <MissionControlEmptyState
        mode="code"
        sessionCount={0}
        projectCount={4}
        onCreateSession={vi.fn()}
      />,
    );

    expect(markup).toContain("Implementation lane");
    expect(markup).toContain("Anchor the implementation before you execute");
    expect(markup).toContain("Start code session");
    expect(markup).toContain("Review this area for bugs and missing tests");
    expect(markup).toContain("4 projects");
  });
});
