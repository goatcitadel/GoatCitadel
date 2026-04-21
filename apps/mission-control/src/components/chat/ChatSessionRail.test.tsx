import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
    expect(markup).toContain('class="gc-button active"');
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
});
