// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import type { MissionThreadedSessionRailData } from "@goatcitadel/threaded-surface-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadList } from "./ThreadList";

// The rail windows its rows; render them all so the test can read each row's status.
vi.mock("../../ui/WindowedRecordList", () => ({
  WindowedRecordList: <T,>({
    items,
    itemKey,
    children,
  }: {
    items: readonly T[];
    itemKey: (item: T) => string;
    children: (item: T) => ReactNode;
  }) => (
    <ul>
      {items.map((item) => (
        <li key={itemKey(item)}>{children(item)}</li>
      ))}
    </ul>
  ),
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ThreadList status for searched conversations", () => {
  it("shows the status a search result carries instead of 'Status unavailable'", async () => {
    const searched = {
      sessionId: "searched",
      lifecycleStatus: "active",
      searchHits: [{ source: "title", excerpt: "Deploy plan" }],
      activity: {
        observedAt: "2026-10-05T10:00:00.000Z",
        latestTurn: { turnId: "turn-1", status: "waiting_for_approval", startedAt: "2026-10-05T09:59:00.000Z" },
        turnCounts: { queued: 0, running: 0, waiting_for_tool: 0, waiting_for_approval: 1, waiting_for_user_input: 0 },
      },
    } as unknown as ChatSessionRecord;
    const withoutActivity = { sessionId: "older", lifecycleStatus: "active" } as unknown as ChatSessionRecord;
    const rail = {
      missionSessions: [searched, withoutActivity],
      availableFolders: [],
      selectedFolderId: "all",
      selectedProjectId: "all",
      selectedSessionId: null,
      search: "deploy",
      historyView: "active",
      creatingSession: false,
      onCreateSession: vi.fn(),
      onSearchChange: vi.fn(),
      onHistoryViewChange: vi.fn(),
      onSelectFolderId: vi.fn(),
      onSelectSession: vi.fn(),
      renderSessionLabel: (sessionId: string) => (sessionId === "searched" ? "Deploy plan" : "Older chat"),
    } as unknown as MissionThreadedSessionRailData;
    await act(async () => root.render(<ThreadList rail={rail} />));
    const rows = [...container.querySelectorAll('nav[aria-label="Conversations"] li')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Deploy plan");
    expect(rows[0]?.textContent).toContain("Waiting on you");
    expect(rows[0]?.textContent).not.toContain("Status unavailable");
    expect(rows[1]?.textContent).toContain("Status unavailable");
  });
});
