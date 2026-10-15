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
  act(() =>
    root.render(
      <ChatSessionHeader
        input={view}
        active={null}
        session={session}
        selectedSessionId="session-1"
        buildEditor={build ? { open: false, onToggle } : null}
        onOpenProjects={onOpenProjects}
        onOpenFilters={vi.fn()}
        onInspect={vi.fn()}
      />,
    ),
  );
  const header = container.querySelector("header") as HTMLElement;
  return { header, onOpenProjects, onToggle, rail: view.sessionRail };
}

describe("ChatSessionHeader", () => {
  it("keeps the single-row header above phone width", () => {
    const { header } = renderHeader(true);
    const select = header.querySelector('select[aria-label="Choose conversation"]');
    expect(select?.closest("label")?.parentElement).toBe(header);
    expect(header.querySelector('button[aria-label="New conversation"]')?.parentElement).toBe(header);
    expect(header.querySelector('button[aria-label="Build editor"]')?.parentElement).toBe(header);
    expect(header.children.length).toBeGreaterThan(2);
  });

  it("splits the phone header into a title row and a full-width conversation row", async () => {
    media.phone = true;
    const { header, onOpenProjects, onToggle, rail } = renderHeader(true);
    expect(header.children).toHaveLength(2);
    const [titleRow, conversationRow] = [...header.children] as [HTMLElement, HTMLElement];
    expect(titleRow.querySelector("h1")?.textContent).toBe("Chat");
    expect(titleRow.textContent).toContain("No messages yet");
    expect(titleRow.querySelector('[aria-label="Selected conversation activity"]')?.parentElement?.className).toContain(
      "truncate",
    );
    expect(titleRow.querySelector("h1")?.closest(".min-w-0.flex-1")).not.toBeNull();

    const select = conversationRow.querySelector('select[aria-label="Choose conversation"]') as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.className).toContain("w-full");
    const wrapper = select.closest("label")?.parentElement as HTMLElement;
    expect(wrapper.className).toContain("flex-1");
    expect(wrapper.className).toContain("min-w-0");
    expect(wrapper.className).toContain("max-w-none");
    expect(conversationRow.querySelector('button[aria-label="New conversation"]')).not.toBeNull();
    expect(conversationRow.querySelector('button[aria-label="Build editor"]')).not.toBeNull();
    expect(conversationRow.querySelector('button[aria-label="Choose conversation"]')).toBeNull();

    const projects = [...titleRow.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Projects",
    );
    await act(async () => projects!.click());
    expect(onOpenProjects).toHaveBeenCalledOnce();
    await act(async () =>
      (conversationRow.querySelector('button[aria-label="Build editor"]') as HTMLButtonElement).click(),
    );
    expect(onToggle).toHaveBeenCalledOnce();
    await act(async () =>
      (conversationRow.querySelector('button[aria-label="New conversation"]') as HTMLButtonElement).click(),
    );
    expect(rail.onCreateSession).toHaveBeenCalledOnce();
  });
});

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
