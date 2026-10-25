// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MissionThreadedSessionRailData } from "@goatcitadel/threaded-surface-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationListPanel } from "./ConversationListPanel";
import { ThreadList } from "./ThreadList";

const viewportContract = vi.hoisted(() => ({ threshold: -1, bounded: false }));
vi.mock("../../ui/WindowedRecordList", () => ({
  WindowedRecordList: ({
    items,
    children,
    itemKey,
    threshold,
    bounded,
  }: {
    items: unknown[];
    children: (item: unknown) => ReactNode;
    itemKey: (item: unknown) => string;
    threshold: number;
    bounded: boolean;
  }) => {
    viewportContract.threshold = threshold;
    viewportContract.bounded = bounded;
    return (
      <div>
        {items.map((item) => (
          <div key={itemKey(item)}>{children(item)}</div>
        ))}
      </div>
    );
  },
}));

vi.mock("./use-thread-activity", () => ({
  useThreadActivity: () => ({}),
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

describe("ThreadList folders", () => {
  it("places folders before recent threads and filters through the controller", async () => {
    const onSelectFolderId = vi.fn();
    const rail = {
      missionSessions: [],
      availableFolders: [{ folderId: "project-one", name: "Project One", count: 3 }],
      selectedFolderId: "all",
      selectedProjectId: "all",
      selectedSessionId: null,
      search: "",
      historyView: "active",
      creatingSession: false,
      onCreateSession: vi.fn(),
      onSearchChange: vi.fn(),
      onHistoryViewChange: vi.fn(),
      onSelectFolderId,
    } as unknown as MissionThreadedSessionRailData;
    await act(async () => root.render(<ThreadList rail={rail} />));
    const folders = container.querySelector("details");
    expect(folders?.open).toBe(false);
    await act(async () => {
      if (folders) {
        folders.open = true;
        folders.dispatchEvent(new Event("toggle"));
      }
    });
    expect(container.textContent?.indexOf("Folders")).toBeLessThan(container.textContent?.indexOf("Recent") ?? 0);
    const folder = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Project One"),
    );
    if (!folder) throw new Error("Folder button missing");
    await act(async () => folder.click());
    expect(onSelectFolderId).toHaveBeenCalledWith("project-one");
    await act(async () => root.render(<ThreadList rail={{ ...rail, selectedFolderId: "project-one" }} />));
    expect(folder.getAttribute("aria-pressed")).toBe("true");
    const clear = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "All conversations",
    );
    await act(async () => clear?.click());
    expect(onSelectFolderId).toHaveBeenLastCalledWith("all");
    await act(async () => root.render(<ThreadList rail={{ ...rail, selectedFolderId: "all" }} />));
    expect(clear?.getAttribute("aria-pressed")).toBe("true");
  });
});

it("says what a search found nothing for and offers to clear it", async () => {
  const onSearchChange = vi.fn();
  const rail = {
    missionSessions: [],
    externalSessions: [],
    selectedSessionId: null,
    availableFolders: [],
    selectedFolderId: "all",
    selectedProjectId: "all",
    search: "zzz",
    loading: false,
    onSearchChange,
    onHistoryViewChange: vi.fn(),
    onSelectProjectId: vi.fn(),
    onCreateSession: vi.fn(),
    historyView: "active",
  } as unknown as MissionThreadedSessionRailData;
  await act(async () => root.render(<ThreadList rail={rail} />));
  expect(container.textContent).toContain("No conversations match “zzz”.");
  expect(container.textContent).not.toContain("No conversations in this view.");
  const clear = [...container.querySelectorAll("button")].find((button) => button.textContent === "Clear search");
  await act(async () => clear?.click());
  expect(onSearchChange).toHaveBeenCalledWith("");
  await act(async () => root.render(<ThreadList rail={{ ...rail, search: "" }} />));
  expect(container.textContent).toContain("No conversations in this view.");
});

it("keeps full titles, server previews and exact search targets on desktop and phone", async () => {
  const hit = { messageId: "message-2", turnId: "turn-2", excerpt: "The matching result", sequence: 2 };
  const title = "A long conversation title with a distinct ending retained for assistive technology";
  const rail = {
    missionSessions: [
      {
        sessionId: "session-1",
        title,
        lifecycleStatus: "active",
        lastActivityAt: "2026-10-06T01:00:00Z",
        lastMessagePreview: "Visible server preview",
        searchHits: [hit],
      },
    ],
    externalSessions: [],
    selectedSessionId: "session-1",
    availableFolders: [],
    selectedFolderId: "all",
    search: "result",
    renderSessionLabel: () => title,
    onSelectSession: vi.fn(),
    onSearchChange: vi.fn(),
    onHistoryViewChange: vi.fn(),
    onSelectProjectId: vi.fn(),
    historyView: "active",
  } as unknown as MissionThreadedSessionRailData;
  await act(async () => root.render(<ThreadList rail={rail} />));
  // #500: the row has an explicit name that starts with its title and keeps its time, status and preview, rather
  // than the title alone or a name only some tools derive from its nested content.
  const row = [...container.querySelectorAll("button")].find((button) => button.textContent?.startsWith(title));
  const name = row?.getAttribute("aria-label") ?? "";
  expect(name.startsWith(`${title}, `)).toBe(true);
  expect(name).toContain(row?.querySelector("time")?.textContent ?? "missing time");
  expect(name.endsWith(", Visible server preview")).toBe(true);
  expect(row?.textContent).toContain("Visible server preview");
  expect(container.textContent).toContain("Visible server preview");
  // Each row is two lines: the title alone, then the time and preview; the search excerpt still wraps to two lines.
  const titleLine = row?.firstElementChild?.firstElementChild;
  expect(titleLine?.classList.contains("truncate")).toBe(true);
  expect(titleLine?.querySelector("time")).toBeNull();
  expect(row?.firstElementChild?.lastElementChild?.querySelector("time")).not.toBeNull();
  expect(row?.textContent).not.toContain("Active");
  expect(container.querySelectorAll(".line-clamp-2").length).toBeGreaterThanOrEqual(1);
  expect([...container.querySelectorAll(".line-clamp-2")].every((node) => !node.classList.contains("block"))).toBe(
    true,
  );
  expect(container.querySelector("time")?.dateTime).toBe("2026-10-06T01:00:00.000Z");
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Open matching message"))
      ?.click(),
  );
  expect(rail.onSelectSession).toHaveBeenLastCalledWith("session-1", { searchHit: hit });
  // The phone sheet lists the same rows and exact search targets as buttons, and a choice closes the sheet.
  const onDone = vi.fn();
  await act(async () => root.render(<ConversationListPanel rail={rail} inSheet onDone={onDone} />));
  expect(container.querySelector('select[aria-label="Choose conversation"]')).toBeNull();
  expect(container.querySelector("h2")).toBeNull();
  const match = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Open matching message"),
  )!;
  expect(match.textContent).toContain(hit.excerpt);
  expect(match.className).toContain("min-h-11");
  await act(async () => match.click());
  expect(rail.onSelectSession).toHaveBeenLastCalledWith("session-1", { searchHit: hit });
  expect(onDone).toHaveBeenCalledOnce();
});

it.each([0, 1, 99, 100, 1000])(
  "keeps the conversation rail bounded and delegates windowing only above100 for %s records",
  async (count) => {
    viewportContract.threshold = -1;
    viewportContract.bounded = false;
    const sessions = Array.from({ length: count }, (_, index) => ({
      sessionId: "rail-" + index,
      lifecycleStatus: "active",
      lastActivityAt: "2026-10-13T00:00:00Z",
    }));
    const rail = {
      missionSessions: sessions,
      externalSessions: [],
      availableFolders: [],
      selectedSessionId: count ? "rail-0" : null,
      selectedFolderId: "all",
      selectedProjectId: "all",
      search: "",
      historyView: "active",
      renderSessionLabel: (id: string) => id,
      onSelectSession: vi.fn(),
      onSearchChange: vi.fn(),
      onHistoryViewChange: vi.fn(),
      onSelectProjectId: vi.fn(),
      onCreateSession: vi.fn(),
    } as unknown as MissionThreadedSessionRailData;
    await act(async () => root.render(<ThreadList rail={rail} />));
    if (!count) {
      expect(container.textContent).toContain("No conversations in this view");
      return;
    }
    expect(viewportContract.threshold).toBe(100);
    expect(viewportContract.bounded).toBe(true);
    const selected = container.querySelector<HTMLButtonElement>('[aria-current="page"]')!;
    selected.focus();
    await act(async () =>
      root.render(
        <ThreadList rail={{ ...rail, missionSessions: sessions.map((record) => ({ ...record })) as never }} />,
      ),
    );
    expect(container.querySelector('[aria-current="page"]')).toBe(selected);
    expect(document.activeElement).toBe(selected);
    await act(async () => selected.click());
    expect(rail.onSelectSession).toHaveBeenCalledWith("rail-0");
  },
);

it("does not repeat channel conversations in the conversation list", async () => {
  const session = (sessionId: string, extra: Record<string, unknown> = {}) => ({
    sessionId,
    lifecycleStatus: "active",
    lastActivityAt: "2026-10-25T00:00:00Z",
    ...extra,
  });
  const rail = {
    missionSessions: [session("mission-1")],
    externalSessions: [
      session("channel-1", { channelConnectionId: "conn-1" }),
      session("channel-2", { channelConnectionId: "conn-2" }),
      session("external-1"),
    ],
    availableFolders: [],
    selectedSessionId: null,
    selectedFolderId: "all",
    selectedProjectId: "all",
    search: "",
    historyView: "active",
    renderSessionLabel: (id: string) => `Title of ${id}`,
    onSelectSession: vi.fn(),
    onSearchChange: vi.fn(),
    onHistoryViewChange: vi.fn(),
    onSelectProjectId: vi.fn(),
    onCreateSession: vi.fn(),
  } as unknown as MissionThreadedSessionRailData;
  await act(async () => root.render(<ThreadList rail={rail} />));
  const titles = [...container.querySelectorAll("nav[aria-label='Conversations'] button")].map((row) =>
    row.getAttribute("aria-label"),
  );
  // Mission sessions and external sessions without a channel stay; channel conversations belong to Messaging.
  expect(titles.some((name) => name?.startsWith("Title of mission-1"))).toBe(true);
  expect(titles.some((name) => name?.startsWith("Title of external-1"))).toBe(true);
  expect(titles.some((name) => name?.startsWith("Title of channel-"))).toBe(false);
  expect(titles).toHaveLength(2);
});
