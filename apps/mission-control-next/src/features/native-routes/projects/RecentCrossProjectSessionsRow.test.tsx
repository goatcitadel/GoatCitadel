// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RecentCrossProjectSessionsRow } from "./RecentCrossProjectSessionsRow";

vi.mock("@goatcitadel/mission-control-shared/hooks/useCrossProjectRecentSessions", () => ({
  useCrossProjectRecentSessions: () => ({
    loading: false,
    error: null,
    items: [
      {
        sessionId: "session-1",
        projectId: "project-1",
        projectLabel: "Mission Control",
        title: "Continue review",
        sessionKey: "session-key",
        mode: "chat",
        lastActivityAt: "2026-07-12T12:00:00.000Z",
        lifecycleStatus: "active",
      },
    ],
  }),
}));

describe("RecentCrossProjectSessionsRow", () => {
  it("keeps list-item structure outside the actionable button", () => {
    const markup = renderToStaticMarkup(
      <RecentCrossProjectSessionsRow workspaceId="workspace-1" route={{ area: "projects" }} navigate={vi.fn()} />,
    );

    expect(markup).toContain('role="list"');
    expect(markup).toContain('role="listitem"');
    expect(markup).toContain("<button");
    expect(markup).not.toMatch(/<button[^>]*role="listitem"/u);
  });
});
