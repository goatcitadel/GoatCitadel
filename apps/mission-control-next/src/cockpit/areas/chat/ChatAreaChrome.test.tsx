// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESPONSIVE_QUERIES } from "@goatcitadel/mission-control-shared/hooks/responsive-breakpoints";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { ChatHeaderSubtitle, ChatSessionHeader } from "./ChatAreaChrome";

const media = vi.hoisted(() => ({ phone: false }));
vi.mock("@goatcitadel/mission-control-shared/hooks/useMediaQuery", () => ({
  useMediaQuery: (query: string) =>
    media.phone && (query === RESPONSIVE_QUERIES.phone || query === RESPONSIVE_QUERIES.belowDesktop),
}));

vi.mock("../../data/use-model-label", () => ({
  useModelLabel: (providerId?: string, modelId?: string) =>
    providerId === "anthropic" && modelId === "claude-sonnet" ? "Claude Sonnet · Anthropic" : "Unknown model",
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  media.phone = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const session = {
  sessionId: "session-1",
  workspaceId: "workspace-a",
  title: "Release notes",
  lifecycleStatus: "active",
  activity: {
    turnCounts: { queued: 0, running: 0, waiting_for_tool: 0, waiting_for_approval: 0, waiting_for_user_input: 0 },
    latestTurn: null,
    observedAt: "2026-10-10T08:00:00.000Z",
  },
} as unknown as ChatSessionRecord;

function input(): MissionThreadedRenderSurfaceInput {
  return {
    sessionRail: {
      missionSessions: [session],
      externalSessions: [],
      selectedSessionId: "session-1",
      historyView: "active",
      loading: false,
      creatingSession: false,
      hasMoreSessions: false,
      loadingMoreSessions: false,
      renderSessionLabel: (sessionId: string) => sessionId,
      onSelectSession: vi.fn(),
      onHistoryViewChange: vi.fn(),
      onCreateSession: vi.fn(),
    },
    contextDockProps: null,
    activeSessionSurfaceProps: null,
  } as unknown as MissionThreadedRenderSurfaceInput;
}

function renderHeader(build = false) {
  const view = input();
  const onOpenProjects = vi.fn();
  const onToggle = vi.fn();
  const onOpenConversations = vi.fn();
  act(() =>
    root.render(
      <ChatSessionHeader
        input={view}
        active={null}
        session={session}
        selectedSessionId="session-1"
        buildEditor={build ? { open: false, onToggle } : null}
        onOpenProjects={onOpenProjects}
        onOpenConversations={onOpenConversations}
        onInspect={vi.fn()}
      />,
    ),
  );
  const header = container.querySelector("header") as HTMLElement;
  return { header, onOpenProjects, onOpenConversations, onToggle, rail: view.sessionRail };
}

describe("ChatSessionHeader", () => {
  it("keeps the way back from an open build editor as a visible header button", () => {
    const view = input();
    const onToggle = vi.fn();
    const onOpenConversations = vi.fn();
    act(() =>
      root.render(
        <ChatSessionHeader
          input={view}
          active={null}
          session={session}
          selectedSessionId="session-1"
          buildEditor={{ open: true, onToggle }}
          onOpenProjects={vi.fn()}
          onOpenConversations={onOpenConversations}
          onInspect={vi.fn()}
        />,
      ),
    );
    const back = container.querySelector('button[aria-label="Back to conversation"]') as HTMLButtonElement;
    act(() => back.click());
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("keeps the single-row header above phone width with a Conversations button below the rail", async () => {
    const { header, onOpenConversations } = renderHeader(true);
    const conversations = [...header.querySelectorAll("button")].find(
      (button) => button.textContent === "Conversations",
    )!;
    expect(conversations.parentElement).toBe(header);
    expect(conversations.className).toContain("md:hidden");
    expect(conversations.getAttribute("aria-haspopup")).toBe("dialog");
    expect(header.querySelector("select")).toBeNull();
    expect(header.querySelector('button[aria-label="New conversation"]')?.parentElement).toBe(header);
    // A closed build editor lives in the overflow menu, so the header carries no "Build editor" button.
    expect(header.querySelector('button[aria-label="Open code workbench"]')).toBeNull();
    expect(header.querySelector('button[aria-label="Conversation actions"]')).not.toBeNull();
    await act(async () => conversations.click());
    expect(onOpenConversations).toHaveBeenCalledOnce();
  });

  it("accessible name starts with the visible text", () => {
    const { header, rail } = renderHeader();
    const create = header.querySelector<HTMLButtonElement>('button[aria-label="New conversation"]')!;
    expect(create.getAttribute("aria-label")).toMatch(new RegExp(`^${create.textContent!.trim()}`));
    act(() => create.click());
    expect(rail.onCreateSession).toHaveBeenCalledOnce();
    // Projects opens from the conversation list's project filter, not from the header.
    expect([...header.querySelectorAll("button")].some((button) => button.textContent === "Projects")).toBe(false);
  });

  it("keeps the phone header to one row: title, Conversations and the actions menu", async () => {
    media.phone = true;
    const { header, onOpenProjects, onOpenConversations, onToggle } = renderHeader(true);
    expect(header.querySelector("h1")?.textContent).toBe("Chat");
    expect(header.textContent).toContain("No messages yet");
    expect(header.querySelector("h1")?.closest(".min-w-0.flex-1")?.parentElement).toBe(header);
    const buttons = [...header.querySelectorAll(":scope > button")];
    expect(buttons.map((button) => button.textContent || button.getAttribute("aria-label"))).toEqual([
      "Conversations",
      "Conversation actions",
    ]);
    expect(header.querySelector("select")).toBeNull();
    expect(header.querySelector('button[aria-label="New conversation"]')).toBeNull();
    expect([...header.querySelectorAll("button")].some((button) => button.textContent === "Projects")).toBe(false);
    await act(async () => (buttons[0] as HTMLButtonElement).click());
    expect(onOpenConversations).toHaveBeenCalledOnce();

    const items = await openPhoneMenu(buttons[1] as HTMLButtonElement);
    expect(items.map((item) => item.textContent)).toEqual(["New conversation", "Projects", "Open code workbench"]);
    await act(async () => items[1]!.click());
    expect(onOpenProjects).toHaveBeenCalledOnce();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("starts a new conversation from the phone actions menu", async () => {
    media.phone = true;
    const { header, rail } = renderHeader(false);
    const items = await openPhoneMenu(
      header.querySelector<HTMLButtonElement>('button[aria-label="Conversation actions"]')!,
    );
    expect(items.map((item) => item.textContent)).toEqual(["New conversation", "Projects"]);
    await act(async () => items[0]!.click());
    expect(rail.onCreateSession).toHaveBeenCalledOnce();
  });
});

async function openPhoneMenu(trigger: HTMLButtonElement) {
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
    trigger.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }));
    trigger.click();
  });
  return vi.waitFor(() => {
    const items = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.length).toBeGreaterThan(0);
    return items;
  });
}

it("names the model and run status in plain words, never their wire values", () => {
  const active = {
    activePersonality: { name: "Researcher" },
    selectedProviderId: "anthropic",
    selectedModel: "claude-sonnet",
    delegationRun: { status: "waiting_for_approval" },
  } as unknown as Parameters<typeof ChatHeaderSubtitle>[0]["active"];
  act(() => root.render(<ChatHeaderSubtitle active={active} projectName="Launch" />));
  expect(container.textContent).toBe("Launch · Researcher · Claude Sonnet · Anthropic · Run · Waiting on you");
  expect(container.textContent).not.toContain("waiting_for_approval");
  expect(container.textContent).not.toContain("claude-sonnet");
});
