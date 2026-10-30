// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MissionThreadedActiveSessionSurfaceProps,
  MissionThreadedRenderSurfaceInput,
} from "@goatcitadel/threaded-surface-core";
import { buildEditorTurnId, ChatAreaView } from "./ChatArea";
import { InspectorProvider } from "../../app/inspector";

const messaging = vi.hoisted(() => ({
  overview: undefined as import("@goatcitadel/contracts").ChatMessagingOverview | undefined,
  requests: [] as Array<{ workspaceId: string; enabled: boolean | undefined }>,
}));

vi.mock("./ThreadList", () => ({ ThreadList: () => null }));
// The Conversations sheet mounts Messaging, which reads its own overview; this suite is not about it.
vi.mock("./MessagingSection", () => ({ MessagingSection: () => null }));
// The open channel conversation reads the same overview; the tests decide what it says.
vi.mock("./use-messaging-overview", () => ({
  useMessagingOverview: (workspaceId: string, options?: { enabled?: boolean }) => {
    messaging.requests.push({ workspaceId, enabled: options?.enabled });
    return { data: messaging.overview };
  },
}));
vi.mock("./ChatTranscript", () => ({
  ChatTranscript: ({ channel }: { channel?: { channelLabel: string; title: string } }) => (
    <p data-testid="transcript">
      {channel ? `${channel.channelLabel} conversation: ${channel.title}` : "Conversation"}
    </p>
  ),
}));
vi.mock("./ChatTextComposer", () => ({ ChatTextComposer: () => null }));
vi.mock("./ProjectAssignmentReview", () => ({ ProjectAssignmentReview: () => null }));
vi.mock("./ChatBuildEditor", () => ({ ChatBuildEditor: () => <p>Build editor body</p> }));
vi.mock("../../ui/Sheet", () => ({
  Sheet: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
    open ? (
      <section role="dialog" aria-label={title}>
        {children}
      </section>
    ) : null,
}));

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(() => {
  messaging.overview = undefined;
  messaging.requests = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient();
  queryClient.setQueryData(["system", "onboarding"], { completed: true });
});

afterEach(() => {
  container.remove();
});

function input(sessionId: string | null): MissionThreadedRenderSurfaceInput {
  return {
    sessionRail: {
      selectedSessionId: sessionId,
      missionSessions: [],
      onCreateSession: vi.fn(),
      creatingSession: false,
    },
    activeSessionSurfaceProps: null,
  } as unknown as MissionThreadedRenderSurfaceInput;
}

function view(
  surface: MissionThreadedRenderSurfaceInput,
  onVisibleSessionChange?: (sessionId: string | undefined) => void,
) {
  return (
    <QueryClientProvider client={queryClient}>
      <InspectorProvider>
        <ChatAreaView input={surface} onVisibleSessionChange={onVisibleSessionChange} />
      </InspectorProvider>
    </QueryClientProvider>
  );
}

describe("visible Chat session", () => {
  it("shows conversation discovery immediately without claiming the history is empty or ready", async () => {
    const surface = input(null);
    surface.sessionRail.loading = true;
    await act(async () => root.render(view(surface)));
    expect(container.querySelector('section[aria-label="Chat"]')).toBeTruthy();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading conversations…");
    expect(container.textContent).not.toContain("Choose a conversation");
    expect(container.textContent).not.toContain("Conversation ready");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="New conversation"]')?.disabled).toBe(true);
    expect(conversationsButton().disabled).toBe(true);
    await act(async () => root.unmount());
  });

  it("opens the build editor on the selected path turn and falls back to the latest turn", () => {
    const active = {
      selectedTurnId: "hidden",
      thread: {
        turns: [
          { turnId: "older", branch: { isSelectedPath: true } },
          { turnId: "hidden", branch: { isSelectedPath: false } },
          { turnId: "latest", branch: { isSelectedPath: true } },
        ],
      },
    } as unknown as MissionThreadedActiveSessionSurfaceProps;
    expect(buildEditorTurnId(active)).toBe("latest");
    active.selectedTurnId = "older";
    expect(buildEditorTurnId(active)).toBe("older");
    expect(buildEditorTurnId(null)).toBeUndefined();
  });

  it("requests workbench state only while the build editor is open", async () => {
    const onWorkbenchOpenChange = vi.fn();
    const surface = (sessionId: string) =>
      ({
        ...input(sessionId),
        workflowPanel: { kind: "code" },
        onWorkbenchOpenChange,
      }) as unknown as MissionThreadedRenderSurfaceInput;
    const button = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
    // The build editor opens from the conversation actions menu; the way back is a visible header button.
    const openBuildEditor = async () => {
      await act(async () => {
        const trigger = button("Conversation actions");
        trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
        trigger.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }));
        trigger.click();
      });
      const item = await vi.waitFor(() => {
        const found = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
          (node) => node.textContent === "Open code workbench",
        );
        expect(found).toBeDefined();
        return found!;
      });
      await act(async () => item.click());
    };
    await act(async () => root.render(view(surface("session-1"))));
    expect(onWorkbenchOpenChange).not.toHaveBeenCalledWith(true);
    await openBuildEditor();
    expect(onWorkbenchOpenChange).toHaveBeenLastCalledWith(true);
    await act(async () => button("Back to conversation").click());
    expect(onWorkbenchOpenChange).toHaveBeenLastCalledWith(false);
    await openBuildEditor();
    expect(onWorkbenchOpenChange).toHaveBeenLastCalledWith(true);
    await act(async () => root.render(view(surface("session-2"))));
    expect(onWorkbenchOpenChange).toHaveBeenLastCalledWith(false);
    await openBuildEditor();
    expect(onWorkbenchOpenChange).toHaveBeenLastCalledWith(true);
    await act(async () => root.unmount());
    expect(onWorkbenchOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("reports the selected conversation and clears it when Chat leaves the cockpit", async () => {
    const onVisibleSessionChange = vi.fn();
    await act(async () => root.render(view(input("session-1"), onVisibleSessionChange)));
    expect(onVisibleSessionChange).toHaveBeenLastCalledWith("session-1");
    await act(async () => root.render(view(input("session-2"), onVisibleSessionChange)));
    expect(onVisibleSessionChange).toHaveBeenLastCalledWith("session-2");
    await act(async () => root.unmount());
    expect(onVisibleSessionChange).toHaveBeenLastCalledWith(undefined);
  });

  it("offers a new conversation in the phone header", async () => {
    const surface = input(null);
    await act(async () => root.render(view(surface)));
    const button = container.querySelector('button[aria-label="New conversation"]') as HTMLButtonElement;
    expect(button).toBeTruthy();
    await act(async () => button.click());
    expect(surface.sessionRail.onCreateSession).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });

  it("lets the phone conversations sheet reach archived conversations and return to recent history", async () => {
    const surface = input("session-1");
    const onHistoryViewChange = vi.fn();
    const onSelectSession = vi.fn();
    Object.assign(surface.sessionRail, {
      historyView: "active",
      search: "",
      onHistoryViewChange,
      onSelectSession,
      availableFolders: [],
      missionSessions: [{ sessionId: "session-1" }],
      renderSessionLabel: () => "Recent conversation",
    });
    await act(async () => root.render(view(surface)));
    expect(container.querySelector('select[aria-label="Choose conversation"]')).toBeNull();
    await act(async () => conversationsButton().click());
    expect(conversationsButton().getAttribute("aria-expanded")).toBe("true");
    await act(async () => sheetButton("Archived").click());
    expect(onHistoryViewChange).toHaveBeenCalledWith("archived");

    Object.assign(surface.sessionRail, {
      historyView: "archived",
      missionSessions: [{ sessionId: "session-2" }],
      renderSessionLabel: () => "Archived conversation",
    });
    await act(async () => root.render(view({ ...surface, sessionRail: { ...surface.sessionRail } })));
    expect(sheetButton("Archived").getAttribute("aria-pressed")).toBe("true");
    await act(async () => sheetButton("Recent").click());
    expect(onHistoryViewChange).toHaveBeenCalledWith("active");
    // Choosing a conversation selects it and closes the sheet.
    await act(async () => sheetButton("Archived conversation").click());
    expect(onSelectSession).toHaveBeenCalledWith("session-2");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it("keeps the shared filters inside the phone conversations sheet without selecting a conversation", async () => {
    const surface = input("session-1");
    const onSelectSession = vi.fn();
    const onSelectProjectId = vi.fn();
    Object.assign(surface.sessionRail, {
      historyView: "active",
      onHistoryViewChange: vi.fn(),
      onSelectSession,
      availableFolders: [],
      selectedFolderId: "all",
      onSelectFolderId: vi.fn(),
      selectedProjectId: "all",
      onSelectProjectId,
      search: "retained",
      onSearchChange: vi.fn(),
      missionSessions: [{ sessionId: "session-1" }],
      renderSessionLabel: () => "Conversation",
    });
    surface.contextDockProps = { projectOptions: [{ value: "project-a", label: "Project A" }] } as NonNullable<
      MissionThreadedRenderSurfaceInput["contextDockProps"]
    >;
    await act(async () => root.render(view(surface)));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => conversationsButton().click());
    const sheet = document.querySelector('[role="dialog"][aria-label="Conversations"]')!;
    const projects = sheet.querySelector<HTMLSelectElement>('select[aria-label="Project"]')!;
    await act(async () => {
      projects.value = "project-a";
      projects.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onSelectProjectId).toHaveBeenCalledWith("project-a");
    expect(sheet.querySelector<HTMLInputElement>("input")?.value).toBe("retained");
    expect(onSelectSession).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("lets the phone conversations sheet load another owner page without selecting a conversation", async () => {
    const surface = input("session-1"),
      onLoadMoreSessions = vi.fn(),
      onSelectSession = vi.fn();
    Object.assign(surface.sessionRail, {
      historyView: "active",
      search: "",
      availableFolders: [],
      hasMoreSessions: true,
      loadingMoreSessions: false,
      onLoadMoreSessions,
      onSelectSession,
      missionSessions: [{ sessionId: "session-1" }],
      renderSessionLabel: () => "Current conversation",
    });
    await act(async () => root.render(view(surface)));
    await act(async () => conversationsButton().click());
    await act(async () => sheetButton("Load more").click());
    expect(onLoadMoreSessions).toHaveBeenCalledOnce();
    expect(onSelectSession).not.toHaveBeenCalled();
    Object.assign(surface.sessionRail, { loadingMoreSessions: true });
    await act(async () => root.render(view({ ...surface, sessionRail: { ...surface.sessionRail } })));
    expect(sheetButton("Loading…").disabled).toBe(true);
    await act(async () => root.unmount());
  });

  describe("a selected channel conversation", () => {
    const telegramOverview = {
      workspaceId: "default",
      channels: [
        {
          connectionId: "conn-1",
          channelKey: "telegram",
          label: "Telegram",
          status: "on",
          conversations: [
            { sessionId: "channel-1", title: "You", kind: "direct", own: true, lastActivityAt: "2026-10-25T10:00:00Z" },
          ],
        },
      ],
    } as const;

    function channelSurface(turnIds: string[], onFork = vi.fn()) {
      const surface = input("channel-1");
      Object.assign(surface.sessionRail, {
        missionSessions: [],
        // An external session is not in the mission list; the header still has to find it.
        externalSessions: [
          { sessionId: "channel-1", scope: "external", channelConnectionId: "conn-1", projectName: "Launch" },
        ],
      });
      surface.activeSessionSurfaceProps = {
        selectedSessionId: "channel-1",
        sessionTitle: "Telegram chat",
        notices: [],
        thread: {
          sessionId: "channel-1",
          turns: turnIds.map((turnId) => ({
            turnId,
            userMessage: { messageId: `user-${turnId}`, content: `User ${turnId}` },
            branch: { isSelectedPath: true },
            trace: { status: "completed" },
          })),
        },
        onStartNewThreadFromTurn: onFork,
      } as unknown as MissionThreadedActiveSessionSurfaceProps;
      return { surface, onFork };
    }

    it("shows the header for a selected channel conversation", async () => {
      messaging.overview = telegramOverview as never;
      const { surface } = channelSurface(["turn-1"]);
      await act(async () => root.render(view(surface)));
      const header = container.querySelector("header")!;
      expect(header.querySelector("h1")?.textContent).toBe("Telegram chat");
      // Project and channel come from the open conversation's own record, not a mission-only lookup.
      expect(header.textContent).toContain("Launch");
      expect(header.textContent).toContain("via Telegram");
      expect(container.querySelector('[data-testid="transcript"]')?.textContent).toBe("Telegram conversation: You");
      // The overview is read only for conversations a channel carries.
      expect(messaging.requests.at(-1)).toEqual({ workspaceId: "default", enabled: true });
      await act(async () => root.unmount());
    });

    it("reads no Messaging overview for an ordinary conversation", async () => {
      const surface = input("session-1");
      Object.assign(surface.sessionRail, { missionSessions: [{ sessionId: "session-1", scope: "mission" }] });
      surface.activeSessionSurfaceProps = {
        selectedSessionId: "session-1",
        sessionTitle: "Release notes",
        notices: [],
        thread: { sessionId: "session-1", turns: [] },
      } as unknown as MissionThreadedActiveSessionSurfaceProps;
      await act(async () => root.render(view(surface)));
      expect(messaging.requests.every((request) => request.enabled === false)).toBe(true);
      expect(container.querySelector('[data-testid="transcript"]')?.textContent).toBe("Conversation");
      expect(continueButton()).toBeUndefined();
      await act(async () => root.unmount());
    });

    it("offers Continue in a new chat and forks from the latest turn", async () => {
      messaging.overview = telegramOverview as never;
      const { surface, onFork } = channelSurface(["turn-1", "turn-2"]);
      await act(async () => root.render(view(surface)));
      await act(async () => continueButton()!.click());
      expect(onFork).toHaveBeenCalledExactlyOnceWith("turn-2");
      await act(async () => root.unmount());
    });

    it("hides Continue in a new chat until the conversation has a turn", async () => {
      messaging.overview = telegramOverview as never;
      await act(async () => root.render(view(channelSurface([]).surface)));
      expect(continueButton()).toBeUndefined();
      await act(async () => root.unmount());
    });
  });

  it("offers the conversations sheet from the empty state below the desktop rail", async () => {
    const surface = input(null);
    Object.assign(surface.sessionRail, { availableFolders: [], historyView: "active", search: "" });
    await act(async () => root.render(view(surface)));
    const show = [...container.querySelectorAll("button")].find((b) => b.textContent === "Show conversations")!;
    expect(show.className).toContain("md:hidden");
    await act(async () => show.click());
    expect(document.querySelector('[role="dialog"][aria-label="Conversations"]')).not.toBeNull();
    await act(async () => root.unmount());
  });
});

it("contains native compact side chat in the positioned conversation host with bound draft/actions", async () => {
  const surface = input("parent");
  const onDraftChange = vi.fn();
  const onSend = vi.fn();
  const onClose = vi.fn();
  surface.btwSideChatProps = {
    open: true,
    parentSessionId: "parent",
    workspaceId: "default",
    parentTitle: "Parent",
    childSessionId: "child",
    draft: "Side draft",
    thread: null,
    streamingPreview: null,
    loading: false,
    sending: false,
    error: null,
    onDraftChange,
    onSend,
    onClose,
  };
  await act(async () => root.render(view(surface)));
  const panel = container.querySelector('[data-testid="btw-side-chat-panel"]')!;
  expect(panel.parentElement?.classList.contains("relative")).toBe(true);
  expect(panel.closest('section[aria-label="Chat"]')).not.toBeNull();
  expect(panel.querySelector("textarea")?.value).toBe("Side draft");
  await act(async () => (panel.querySelector('[aria-label="Send side chat message"]') as HTMLButtonElement).click());
  expect(onSend).toHaveBeenCalledOnce();
  await act(async () => (panel.querySelector('[aria-label="Close side chat"]') as HTMLButtonElement).click());
  expect(onClose).toHaveBeenCalledOnce();
  expect(onDraftChange).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

function continueButton(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("header button")].find(
    (button) => button.textContent === "Continue in a new chat",
  );
}

function conversationsButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll("header button")].find((b) => b.textContent === "Conversations");
  if (!(button instanceof HTMLButtonElement)) throw new Error("Missing Conversations button");
  return button;
}

function sheetButton(text: string): HTMLButtonElement {
  const sheet = document.querySelector('[role="dialog"][aria-label="Conversations"]');
  const button = [...(sheet?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.startsWith(text));
  if (!(button instanceof HTMLButtonElement)) throw new Error("Missing sheet button " + text);
  return button;
}
