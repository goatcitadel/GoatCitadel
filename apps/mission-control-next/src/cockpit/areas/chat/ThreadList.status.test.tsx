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
    // A row without a readable status says nothing rather than "Status unavailable".
    expect(rows[1]?.textContent).not.toContain("Status unavailable");
  });

  it("shows status only for running, waiting and failed rows", async () => {
    const counts = { queued: 0, running: 0, waiting_for_tool: 0, waiting_for_approval: 0, waiting_for_user_input: 0 };
    const observedAt = "2026-10-05T10:00:00.000Z";
    const latest = (status: string) => ({ turnId: `turn-${status}`, status, startedAt: "2026-10-05T09:59:00.000Z" });
    const session = (sessionId: string, activity?: object) =>
      ({ sessionId, lifecycleStatus: "active", activity }) as unknown as ChatSessionRecord;
    const sessions = [
      session("running", { observedAt, latestTurn: null, turnCounts: { ...counts, running: 1 } }),
      session("waiting", { observedAt, latestTurn: null, turnCounts: { ...counts, waiting_for_approval: 1 } }),
      session("failed", { observedAt, latestTurn: latest("failed"), turnCounts: counts }),
      session("completed", { observedAt, latestTurn: latest("completed"), turnCounts: counts }),
      session("cancelled", { observedAt, latestTurn: latest("cancelled"), turnCounts: counts }),
      session("empty", { observedAt, latestTurn: null, turnCounts: counts }),
      session("unknown"),
    ];
    const rail = {
      missionSessions: sessions,
      availableFolders: [],
      selectedFolderId: "all",
      selectedProjectId: "all",
      selectedSessionId: null,
      search: "",
      historyView: "active",
      creatingSession: false,
      onCreateSession: vi.fn(),
      onSearchChange: vi.fn(),
      onHistoryViewChange: vi.fn(),
      onSelectFolderId: vi.fn(),
      onSelectSession: vi.fn(),
      renderSessionLabel: (sessionId: string) => `Chat ${sessionId}`,
    } as unknown as MissionThreadedSessionRailData;
    await act(async () => root.render(<ThreadList rail={rail} />));
    const rows = [...container.querySelectorAll('nav[aria-label="Conversations"] li')].map((row) => row.textContent);
    expect(rows[0]).toContain("Working");
    expect(rows[1]).toContain("Waiting on you");
    expect(rows[2]).toContain("Last response failed");
    expect(rows[3]).not.toContain("Last response completed");
    expect(rows[4]).not.toContain("Last response cancelled");
    // #500: each row's explicit name keeps the status it shows.
    const names = [...container.querySelectorAll('nav[aria-label="Conversations"] li > div > button')].map((row) =>
      row.getAttribute("aria-label"),
    );
    expect(names[0]).toMatch(/^Chat \S+, .+, Working\b/);
    expect(names[0]).toContain(rows[0]?.slice(rows[0].indexOf("Working")) ?? "missing status");
    expect(names[2]).toContain("Last response failed");
    expect(names[3]).not.toContain("Last response completed");
    const text = container.textContent ?? "";
    expect(text).not.toContain("Status unavailable");
    expect(text).not.toContain("No messages yet");
  });
});
