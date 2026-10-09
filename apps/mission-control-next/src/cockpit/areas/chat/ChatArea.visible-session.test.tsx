// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionThreadedActiveSessionSurfaceProps, MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { buildEditorTurnId, ChatAreaView } from "./ChatArea";
import { InspectorProvider } from "../../app/inspector";

vi.mock("./ThreadList", () => ({ ThreadList: () => null }));

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(() => {
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
    sessionRail: { selectedSessionId: sessionId, missionSessions: [], onCreateSession: vi.fn(), creatingSession: false },
    activeSessionSurfaceProps: null,
  } as unknown as MissionThreadedRenderSurfaceInput;
}

function view(surface: MissionThreadedRenderSurfaceInput, onVisibleSessionChange?: (sessionId: string | undefined) => void) {
  return <QueryClientProvider client={queryClient}><InspectorProvider>
    <ChatAreaView input={surface} onVisibleSessionChange={onVisibleSessionChange} />
  </InspectorProvider></QueryClientProvider>;
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
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Choose conversation"]')?.disabled).toBe(true);
    await act(async () => root.unmount());
  });

  it("opens the build editor on the selected path turn and falls back to the latest turn", () => {
    const active = {
      selectedTurnId: "hidden",
      thread: { turns: [
        { turnId: "older", branch: { isSelectedPath: true } },
        { turnId: "hidden", branch: { isSelectedPath: false } },
        { turnId: "latest", branch: { isSelectedPath: true } },
      ] },
    } as unknown as MissionThreadedActiveSessionSurfaceProps;
    expect(buildEditorTurnId(active)).toBe("latest");
    active.selectedTurnId = "older";
    expect(buildEditorTurnId(active)).toBe("older");
    expect(buildEditorTurnId(null)).toBeUndefined();
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

  it("lets the phone picker reach archived conversations and return to recent history", async () => {
    const surface = input("session-1");
    const onHistoryViewChange = vi.fn();
    const onSelectSession = vi.fn();
    Object.assign(surface.sessionRail, {
      historyView: "active", onHistoryViewChange, onSelectSession,
      missionSessions: [{ sessionId: "session-1" }], renderSessionLabel: () => "Recent conversation",
    });
    await act(async () => root.render(view(surface)));
    const picker = container.querySelector('select[aria-label="Choose conversation"]') as HTMLSelectElement;
    expect(picker.querySelector('option[value="history:archived"]')?.textContent).toBe("Show archived conversations");
    await act(async () => { picker.value = "history:archived"; picker.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(onHistoryViewChange).toHaveBeenCalledWith("archived");

    Object.assign(surface.sessionRail, {
      historyView: "archived", missionSessions: [{ sessionId: "session-2" }],
      renderSessionLabel: () => "Archived conversation",
    });
    await act(async () => root.render(view({ ...surface, sessionRail: { ...surface.sessionRail } })));
    expect(picker.value).toBe("");
    await act(async () => { picker.value = "session-2"; picker.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(onSelectSession).toHaveBeenCalledWith("session-2");
    await act(async () => { picker.value = "history:active"; picker.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(onHistoryViewChange).toHaveBeenCalledWith("active");
    await act(async () => root.unmount());
  });

  it("opens phone filters from the picker without selecting a pseudo conversation, and retains the shared selection", async () => {
    const surface = input("session-1");
    const onSelectSession = vi.fn();
    const onSelectProjectId = vi.fn();
    Object.assign(surface.sessionRail, {
      historyView: "active", onHistoryViewChange: vi.fn(), onSelectSession,
      availableFolders: [], selectedFolderId: "all", onSelectFolderId: vi.fn(),
      selectedProjectId: "all", onSelectProjectId, search: "retained", onSearchChange: vi.fn(),
      missionSessions: [{ sessionId: "session-1" }], renderSessionLabel: () => "Conversation",
    });
    surface.contextDockProps = { projectOptions: [{ value: "project-a", label: "Project A" }] } as NonNullable<MissionThreadedRenderSurfaceInput["contextDockProps"]>;
    await act(async () => root.render(view(surface)));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const picker = container.querySelector('select[aria-label="Choose conversation"]') as HTMLSelectElement;
    await act(async () => { picker.value = "view:filters"; picker.dispatchEvent(new Event("change", { bubbles: true })); });
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Filter conversations");
    expect(onSelectSession).not.toHaveBeenCalled();
    const projects = dialog.querySelector("select")!;
    await act(async () => { projects.value = "project-a"; projects.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(onSelectProjectId).toHaveBeenCalledWith("project-a");
    surface.sessionRail.selectedProjectId = "project-a";
    await act(async () => root.render(view({ ...surface, sessionRail: { ...surface.sessionRail } })));
    const done = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Done")!;
    await act(async () => done.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => { picker.value = "view:filters"; picker.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(document.querySelector<HTMLSelectElement>('[role="dialog"] select')?.value).toBe("project-a");
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')?.value).toBe("retained");
    expect(onSelectSession).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
  it("lets the phone picker load another owner page without selecting a synthetic conversation", async () => {
    const surface = input("session-1"), onLoadMoreSessions = vi.fn(), onSelectSession = vi.fn();
    Object.assign(surface.sessionRail, { historyView: "active", hasMoreSessions: true, loadingMoreSessions: false,
      onLoadMoreSessions, onSelectSession, missionSessions: [{ sessionId: "session-1" }], renderSessionLabel: () => "Current conversation" });
    await act(async () => root.render(view(surface)));
    const picker = container.querySelector('select[aria-label="Choose conversation"]') as HTMLSelectElement;
    await act(async () => { picker.value = "history:load-more"; picker.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(onLoadMoreSessions).toHaveBeenCalledOnce();
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(picker.value).toBe("session-1");
    Object.assign(surface.sessionRail, { loadingMoreSessions: true });
    await act(async () => root.render(view({ ...surface, sessionRail: { ...surface.sessionRail } })));
    expect(picker.querySelector<HTMLOptionElement>('option[value="history:load-more"]')?.disabled).toBe(true);
    await act(async () => root.unmount());
  });

});


it("contains native compact side chat in the positioned conversation host with bound draft/actions", async () => {
  const surface = input("parent");
  const onDraftChange = vi.fn(); const onSend = vi.fn(); const onClose = vi.fn();
  surface.btwSideChatProps = { open: true, parentSessionId: "parent", workspaceId: "default", parentTitle: "Parent", childSessionId: "child", draft: "Side draft", thread: null, streamingPreview: null, loading: false, sending: false, error: null, onDraftChange, onSend, onClose };
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
