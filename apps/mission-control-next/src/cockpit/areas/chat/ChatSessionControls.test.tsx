// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionThreadedContextDockProps } from "@goatcitadel/threaded-surface-core";
import { ChatSessionOverflow, ChatSessionTitle } from "./ChatSessionControls";

let root: Root;
let container: HTMLDivElement;

function dock(overrides: Partial<MissionThreadedContextDockProps> = {}): MissionThreadedContextDockProps {
  return {
    renameTitle: "Original title",
    onRenameTitleChange: vi.fn(),
    onRenameSession: vi.fn(async () => {}),
    onToggleArchiveSession: vi.fn(async () => {}),
    onExportSnapshot: vi.fn(),
    selectedSession: { sessionId: "session-1" },
    sessionControlPending: null,
    ...overrides,
  } as unknown as MissionThreadedContextDockProps;
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

describe("Chat session controls", () => {
  it("uses the existing controller to rename the current conversation", async () => {
    const context = dock();
    await act(async () => root.render(<ChatSessionTitle title="Original title" dock={context} />));
    await act(async () => (container.querySelector('button[title="Rename conversation"]') as HTMLButtonElement).click());
    expect(context.onRenameTitleChange).toHaveBeenCalledWith("Original title");
    await act(async () => (container.querySelector('button[type="submit"]') as HTMLButtonElement).click());
    expect(context.onRenameSession).toHaveBeenCalledOnce();
  });

  const trigger = () => container.querySelector('button[aria-label="Conversation actions"]') as HTMLButtonElement;
  const item = (label: string) =>
    [...document.body.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent === label) as HTMLElement | undefined;
  const openWithPointer = () =>
    act(async () => { trigger().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); });

  it("exports immediately but requires confirmation before archiving", async () => {
    const context = dock();
    await act(async () => root.render(<ChatSessionOverflow dock={context} onFork={vi.fn()} />));
    await openWithPointer();
    await act(async () => item("Export conversation")?.click());
    expect(context.onExportSnapshot).toHaveBeenCalledOnce();
    expect(item("Export conversation")).toBeUndefined();
    await openWithPointer();
    await act(async () => item("Archive conversation")?.click());
    expect(context.onToggleArchiveSession).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Archive conversation?");
    const confirm = [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Archive");
    await act(async () => confirm?.click());
    expect(context.onToggleArchiveSession).toHaveBeenCalledOnce();
  });

  it("opens from the keyboard, closes on Escape and returns focus to the trigger", async () => {
    await act(async () => root.render(<ChatSessionOverflow dock={dock()} onFork={vi.fn()} onInspect={vi.fn()} />));
    trigger().focus();
    await act(async () => { trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(item("Inspect conversation")).toBeDefined();
    expect(item("Fork from latest turn")).toBeDefined();
    const menu = document.body.querySelector('[role="menu"]') as HTMLElement;
    await act(async () => { menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    // Radix restores focus on the next task after the menu unmounts.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(document.activeElement).toBe(trigger());
  });

  it("disables fork when the conversation has no turn to fork from", async () => {
    await act(async () => root.render(<ChatSessionOverflow dock={dock()} />));
    await openWithPointer();
    expect(item("Fork from latest turn")?.getAttribute("aria-disabled")).toBe("true");
  });
});
