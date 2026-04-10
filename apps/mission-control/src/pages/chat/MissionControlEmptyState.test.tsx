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
        workspaceName="Primary Ops"
        approvalsCount={2}
        providerLabel="OpenAI"
        modelLabel="gpt-4.1-mini"
        onCreateSession={vi.fn()}
        onOpenCowork={vi.fn()}
        onOpenCode={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenApprovals={vi.fn()}
      />,
    );

    expect(markup).toContain("Conversation lane");
    expect(markup).toContain("Start with the thing you actually need");
    expect(markup).toContain("Start chat session");
    expect(markup).toContain("Draft a launch update from my notes");
    expect(markup).toContain("Primary Ops");
    expect(markup).toContain("2 approvals waiting");
    expect(markup).toContain("Open Cowork");
  });

  it("renders code-specific callouts and action labels", () => {
    const markup = renderToStaticMarkup(
      <MissionControlEmptyState
        mode="code"
        sessionCount={0}
        projectCount={4}
        workspaceName="Repo Bound"
        approvalsCount={0}
        providerLabel="Anthropic"
        modelLabel="claude-sonnet"
        onCreateSession={vi.fn()}
        onOpenCowork={vi.fn()}
        onOpenCode={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenApprovals={vi.fn()}
      />,
    );

    expect(markup).toContain("Implementation lane");
    expect(markup).toContain("Anchor the implementation before you execute");
    expect(markup).toContain("Start code session");
    expect(markup).toContain("Review this area for bugs and missing tests");
    expect(markup).toContain("4 projects");
    expect(markup).toContain("Repo Bound");
    expect(markup).toContain("Approvals clear");
  });
});
