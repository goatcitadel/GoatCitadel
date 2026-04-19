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
        onCreateSession={vi.fn()}
        onOpenCowork={vi.fn()}
        onOpenCode={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenApprovals={vi.fn()}
      />,
    );

    expect(markup).toContain("Chat");
    expect(markup).toContain("Start with the thing you actually need");
    expect(markup).toContain("Start chat session");
    expect(markup).toContain("Draft a launch update from my notes");
    expect(markup).toContain("Primary Ops");
    expect(markup).toContain("2 approvals waiting");
    expect(markup).toContain("Open Cowork");
    expect(markup).toContain("Open Code");
  });

  it("renders code-specific callouts and action labels", () => {
    const markup = renderToStaticMarkup(
      <MissionControlEmptyState
        mode="code"
        sessionCount={0}
        projectCount={4}
        workspaceName="Repo Bound"
        approvalsCount={0}
        onCreateSession={vi.fn()}
        onOpenCowork={vi.fn()}
        onOpenCode={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenApprovals={vi.fn()}
      />,
    );

    expect(markup).toContain("Code");
    expect(markup).toContain("Anchor the implementation before you execute");
    expect(markup).toContain("Start code session");
    expect(markup).toContain("4 projects");
    expect(markup).toContain("Repo Bound");
    expect(markup).toContain("Approvals clear");
    expect(markup).toContain("Open Tasks");
  });
});
