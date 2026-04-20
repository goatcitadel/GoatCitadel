import React from "react";
import { create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("./ActivityPage", () => ({
  ActivityPage: () => <div>activity-page</div>,
}));

vi.mock("./CronPage", () => ({
  CronPage: () => <div>cron-page</div>,
}));

vi.mock("./ImprovementPage", () => ({
  ImprovementPage: ({ workspaceId }: { workspaceId?: string }) => <div>improvement-page:{workspaceId ?? "none"}</div>,
}));

vi.mock("./SessionsPage", () => ({
  SessionsPage: () => <div>sessions-page</div>,
}));

import { TimelinePage } from "./TimelinePage";

describe("TimelinePage", () => {
  it("renders the interactive sessions surface for the sessions tab", () => {
    const renderer = create(<TimelinePage activeTab="sessions" workspaceId="default" onTabChange={() => undefined} />);

    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Sessions");
    expect(text).toContain("sessions-page");
    expect(text).not.toContain("cron-page");
  });

  it("renders the cron workspace for the scheduler tab", () => {
    const renderer = create(<TimelinePage activeTab="scheduler" workspaceId="default" onTabChange={() => undefined} />);

    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Scheduler");
    expect(text).toContain("cron-page");
    expect(text).not.toContain("activity-page");
  });

  it("passes the workspace to the improvement surface", () => {
    const renderer = create(
      <TimelinePage activeTab="improvement" workspaceId="workspace-1" onTabChange={() => undefined} />,
    );

    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("improvement-page:");
    expect(text).toContain("workspace-1");
  });
});
