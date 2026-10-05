// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import type { MissionThreadedSessionRailData } from "@goatcitadel/threaded-surface-core";
import { ThreadList } from "./ThreadList";
import { SelectedThreadActivity } from "./SelectedThreadActivity";

const mocks = vi.hoisted(() => ({
  width: 1280,
  status: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({ fetchChatSessionStatus: mocks.status }));
vi.mock("@goatcitadel/mission-control-shared/hooks/useMediaQuery", () => ({
  useMediaQuery: (query: string) =>
    query === "(width >= 1024px)" ? mocks.width >= 1024 : query === "(width < 1024px)" && mocks.width < 1024,
}));
vi.mock("../../ui/WindowedRecordList", () => ({
  WindowedRecordList: ({
    items,
    children,
  }: {
    items: ChatSessionRecord[];
    children: (item: ChatSessionRecord) => ReactNode;
  }) => (
    <ul aria-label="Rendered test window">
      {items.map((item) => (
        <li key={item.sessionId}>{children(item)}</li>
      ))}
    </ul>
  ),
}));
vi.mock("./ChatConversationFilters", () => ({ ChatConversationFilters: () => null }));

const counts = { queued: 0, running: 0, waiting_for_tool: 0, waiting_for_approval: 0, waiting_for_user_input: 0 };
const observedAt = "2026-10-05T10:00:00.000Z";
const sessions = [
  {
    sessionId: "running",
    lifecycleStatus: "active",
    activity: { observedAt, latestTurn: null, turnCounts: { ...counts, running: 1 } },
  },
  {
    sessionId: "asking",
    lifecycleStatus: "active",
    activity: { observedAt, latestTurn: null, turnCounts: { ...counts, waiting_for_approval: 1 } },
  },
  { sessionId: "unknown", lifecycleStatus: "active" },
] as unknown as ChatSessionRecord[];
const rail = {
  missionSessions: sessions,
  historyView: "active",
  selectedSessionId: "asking",
  creatingSession: false,
  onCreateSession: vi.fn(),
  onHistoryViewChange: vi.fn(),
  onSelectSession: vi.fn(),
  renderSessionLabel: (id: string) => id,
} as unknown as MissionThreadedSessionRailData;

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  mocks.width = 1280;
  mocks.status.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("shows each conversation's status from the sessions list without a status read per row", async () => {
  await act(async () => root.render(<ThreadList rail={rail} />));
  const rows = [...host.querySelectorAll("li")].map((row) => row.textContent);
  expect(rows[0]).toContain("Working");
  expect(rows[1]).toContain("Waiting on you");
  expect(rows[2]).toContain("Status unavailable");
  expect(mocks.status).not.toHaveBeenCalled();
});

it("shows the selected conversation's status on narrow screens from the same list", async () => {
  mocks.width = 800;
  await act(async () => root.render(<SelectedThreadActivity session={sessions[1]} />));
  expect(host.querySelector('[aria-label="Selected conversation activity"]')?.textContent).toBe("Waiting on you");
  mocks.width = 1280;
  await act(async () => root.render(<SelectedThreadActivity session={sessions[1]} />));
  expect(host.textContent).toBe("");
  expect(mocks.status).not.toHaveBeenCalled();
});
