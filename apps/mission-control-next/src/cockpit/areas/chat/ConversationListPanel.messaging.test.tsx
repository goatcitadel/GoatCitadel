// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MissionThreadedSessionRailData } from "@goatcitadel/threaded-surface-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatConversationsSheet } from "./ChatConversationsSheet";
import { ThreadList } from "./ThreadList";

vi.mock("../../ui/WindowedRecordList", () => ({
  WindowedRecordList: ({
    items,
    children,
    itemKey,
  }: {
    items: unknown[];
    children: (item: unknown) => ReactNode;
    itemKey: (item: unknown) => string;
  }) => (
    <div>
      {items.map((item) => (
        <div key={itemKey(item)}>{children(item)}</div>
      ))}
    </div>
  ),
}));
vi.mock("./use-thread-activity", () => ({ useThreadActivity: () => ({}) }));
vi.mock("../../ui/Sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
}));
// The section itself is covered by MessagingSection.test.tsx; these tests cover where the lists mount it.
vi.mock("./MessagingSection", () => ({
  MessagingSection: (props: {
    workspaceId: string;
    selectedSessionId?: string;
    onSelectSession: (sessionId: string) => void;
    onOpenChannel: (connectionId: string) => void;
    onNavigate?: () => void;
  }) => (
    <section data-testid="messaging" data-workspace={props.workspaceId} data-selected={props.selectedSessionId ?? ""}>
      <button type="button" onClick={() => props.onSelectSession("channel-session")}>
        pick conversation
      </button>
      <button type="button" onClick={() => props.onOpenChannel("conn-1")}>
        pick channel
      </button>
      <button type="button" onClick={() => props.onNavigate?.()}>
        add a channel
      </button>
    </section>
  ),
}));

let root: Root;
let container: HTMLDivElement;

function makeRail(overrides: Record<string, unknown> = {}) {
  return {
    missionSessions: [],
    externalSessions: [],
    availableFolders: [],
    selectedSessionId: null,
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
    ...overrides,
  } as unknown as MissionThreadedSessionRailData;
}

function click(label: string) {
  const found = [...container.querySelectorAll("button")].find((button) => button.textContent === label);
  if (!found) throw new Error(`No button reads "${label}"`);
  return act(async () => found.click());
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Messaging in the conversation list", () => {
  it("mounts Messaging under the desktop rail's list and routes its choices", async () => {
    const rail = makeRail({ selectedSessionId: "channel-session" });
    const onOpenChannel = vi.fn();
    await act(async () => root.render(<ThreadList rail={rail} messaging={{ workspaceId: "ws-1", onOpenChannel }} />));
    const section = container.querySelector<HTMLElement>('[data-testid="messaging"]');
    expect(section?.dataset.workspace).toBe("ws-1");
    expect(section?.dataset.selected).toBe("channel-session");
    const list = container.querySelector('nav[aria-label="Conversations"]')!;
    expect(list.compareDocumentPosition(section!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await click("pick conversation");
    expect(rail.onSelectSession).toHaveBeenCalledWith("channel-session");
    await click("pick channel");
    expect(onOpenChannel).toHaveBeenCalledWith("conn-1");
  });

  it("mounts it in the phone sheet and closes the sheet after a choice", async () => {
    const rail = makeRail();
    const onOpenChannel = vi.fn();
    const onOpenChange = vi.fn();
    await act(async () =>
      root.render(
        <ChatConversationsSheet
          open
          onOpenChange={onOpenChange}
          rail={rail as never}
          messaging={{ workspaceId: "ws-1", onOpenChannel }}
        />,
      ),
    );
    expect(container.querySelector('[data-testid="messaging"]')).not.toBeNull();
    await click("pick conversation");
    expect(rail.onSelectSession).toHaveBeenCalledWith("channel-session");
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    onOpenChange.mockClear();
    await click("pick channel");
    expect(onOpenChannel).toHaveBeenCalledWith("conn-1");
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    onOpenChange.mockClear();
    // "+ Add" leaves for the channel picker inside Chat, so it closes the sheet too.
    await click("add a channel");
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("gives the desktop rail nothing to close when Add takes the operator on", async () => {
    await act(async () =>
      root.render(<ThreadList rail={makeRail()} messaging={{ workspaceId: "ws-1", onOpenChannel: vi.fn() }} />),
    );
    await expect(click("add a channel")).resolves.toBeUndefined();
  });

  it("leaves Messaging out when the list is given no channel destination", async () => {
    await act(async () => root.render(<ThreadList rail={makeRail()} />));
    expect(container.querySelector('[data-testid="messaging"]')).toBeNull();
  });
});
