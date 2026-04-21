import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ChatSessionRail } from "./ChatSessionRail";

vi.mock("react-virtuoso", () => ({
  Virtuoso: (props: { data?: unknown[]; itemContent?: (index: number, item: any) => React.ReactNode }) => (
    <div>
      {(props.data ?? []).map((item, index) => (
        <div key={index}>{props.itemContent ? props.itemContent(index, item) : null}</div>
      ))}
    </div>
  ),
}));

describe("ChatSessionRail", () => {
  it("renders grouped cowork session metadata with stronger selection and preview state", () => {
    const markup = renderToStaticMarkup(
      <ChatSessionRail
        missionSessions={[
          {
            sessionId: "mission-1",
            projectName: "Atlas",
            pinned: true,
            lastActivityAt: new Date().toISOString(),
          },
        ]}
        externalSessions={[
          {
            sessionId: "external-1",
            channel: "slack",
            account: "ops",
            lastActivityAt: new Date().toISOString(),
          },
        ]}
        selectedSessionId="mission-1"
        onSelectSession={vi.fn()}
        selectedTag={null}
        onSelectTag={vi.fn()}
        renderSessionLabel={(sessionId) => `Session ${sessionId}`}
        mode="cowork"
      />,
    );

    expect(markup).toContain("Mission");
    expect(markup).toContain("External");
    expect(markup).toContain("Session mission-1");
    expect(markup).toContain("Atlas ·");
    expect(markup).toContain("Coordination source");
    expect(markup).toContain("Pinned");
    expect(markup).toContain('class="gc-button chat-v11-session-row-button active"');
  });

  it("surfaces code-mode binding hints when sessions are unbound", () => {
    const markup = renderToStaticMarkup(
      <ChatSessionRail
        missionSessions={[
          {
            sessionId: "mission-2",
            lastActivityAt: new Date().toISOString(),
          },
        ]}
        externalSessions={[
          {
            sessionId: "external-2",
            channel: "github",
            account: "repo",
            lastActivityAt: new Date().toISOString(),
          },
        ]}
        selectedSessionId={null}
        onSelectSession={vi.fn()}
        selectedTag={null}
        onSelectTag={vi.fn()}
        renderSessionLabel={() => "Implementation review"}
        mode="code"
      />,
    );

    expect(markup).toContain("No project binding");
    expect(markup).toContain("Readback context");
    expect(markup).toContain("github / repo");
  });

  it("renders tag filters as separate buttons from the session row control", () => {
    const onSelectSession = vi.fn();
    const onSelectTag = vi.fn();
    const renderer = create(
      <ChatSessionRail
        missionSessions={[
          {
            sessionId: "mission-3",
            projectName: "Atlas",
            folderName: "Launch",
            tags: ["release", "urgent"],
            lastActivityAt: new Date().toISOString(),
          },
        ]}
        externalSessions={[]}
        selectedSessionId={null}
        onSelectSession={onSelectSession}
        selectedTag={null}
        onSelectTag={onSelectTag}
        renderSessionLabel={() => "Release review"}
        mode="chat"
      />,
    );

    const rowButton = renderer.root.find(
      (node) =>
        node.type === "button" &&
        typeof node.props.className === "string" &&
        node.props.className.includes("chat-v11-session-row-button"),
    );
    const tagButtons = renderer.root.findAll(
      (node) =>
        node.type === "button" &&
        typeof node.props.className === "string" &&
        node.props.className.includes("chat-v11-session-tag"),
    );

    expect(tagButtons).toHaveLength(2);

    act(() => {
      rowButton.props.onClick();
    });
    expect(onSelectSession).toHaveBeenCalledWith("mission-3");

    act(() => {
      tagButtons[0]?.props.onClick();
    });
    expect(onSelectTag).toHaveBeenCalledWith("release");
  });
});
