import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
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
    expect(markup).toContain("Start chat");
    expect(markup).toContain("Draft a launch update from my notes");
    expect(markup).toContain("Primary Ops");
    expect(markup).toContain("2 approvals waiting");
    expect(markup).toContain("1 project • 3 sessions");
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
    expect(markup).toContain("4 projects • 0 sessions");
    expect(markup).toContain("Repo Bound");
    expect(markup).toContain("Approvals clear");
    expect(markup).toContain("Open Tasks");
  });

  it("renders cowork-specific actions and forwards route callbacks", async () => {
    const onCreateSession = vi.fn();
    const onOpenTasks = vi.fn();
    const onOpenApprovals = vi.fn();
    const renderer = create(
      <MissionControlEmptyState
        mode="cowork"
        sessionCount={1}
        projectCount={2}
        workspaceName="Ops Desk"
        approvalsCount={0}
        onCreateSession={onCreateSession}
        onOpenCowork={vi.fn()}
        onOpenCode={vi.fn()}
        onOpenTasks={onOpenTasks}
        onOpenApprovals={onOpenApprovals}
      />,
    );

    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Cowork");
    expect(text).toContain("Start cowork session");
    expect(text).toContain("Open Tasks");
    expect(text).toContain("Review Approvals");
    expect(text).not.toContain("Draft a launch update from my notes");

    const buttonByLabel = (label: string) =>
      renderer.root.findAllByType("button").find((button) => button.props.children === label);

    await act(async () => {
      buttonByLabel("Start cowork session")?.props.onClick();
      buttonByLabel("Open Tasks")?.props.onClick();
      buttonByLabel("Review Approvals")?.props.onClick();
    });

    expect(onCreateSession).toHaveBeenCalledTimes(1);
    expect(onOpenTasks).toHaveBeenCalledTimes(1);
    expect(onOpenApprovals).toHaveBeenCalledTimes(1);
  });
});
