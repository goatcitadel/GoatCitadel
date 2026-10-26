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
    const rename = container.querySelector('button[aria-label="Rename conversation"]') as HTMLButtonElement;
    // An icon button with a plain name; no tooltip-only affordance.
    expect(rename.hasAttribute("title")).toBe(false);
    await act(async () => rename.click());
    expect(context.onRenameTitleChange).toHaveBeenCalledWith("Original title");
    await act(async () => (container.querySelector('button[type="submit"]') as HTMLButtonElement).click());
    expect(context.onRenameSession).toHaveBeenCalledOnce();
  });

  it("the conversation h1 contains only the title", async () => {
    await act(async () => root.render(<ChatSessionTitle title="Original title" dock={dock()} />));
    const heading = container.querySelector("h1")!;
    expect(heading.textContent).toBe("Original title");
    expect(heading.querySelector("button")).toBeNull();
    // The rename button sits beside the heading, not inside it.
    expect(heading.parentElement?.querySelector('button[aria-label="Rename conversation"]')).not.toBeNull();
  });

  const trigger = () => container.querySelector('button[aria-label="Conversation actions"]') as HTMLButtonElement;
  const item = (label: string) =>
    [...document.body.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent === label) as
      | HTMLElement
      | undefined;
  const openWithPointer = async () => {
    await act(async () => {
      const node = trigger();
      node.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }),
      );
      node.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }),
      );
      node.click();
    });
    await vi.waitFor(() => expect(item("Export conversation")).toBeDefined());
  };

  it("exports and archives immediately: archiving is reversible from Archived (CH-R08)", async () => {
    const context = dock();
    await act(async () => root.render(<ChatSessionOverflow dock={context} onFork={vi.fn()} />));
    await openWithPointer();
    await act(async () => item("Export conversation")?.click());
    expect(context.onExportSnapshot).toHaveBeenCalledOnce();
    expect(item("Export conversation")).toBeUndefined();
    await openWithPointer();
    await act(async () => item("Archive conversation")?.click());
    expect(context.onToggleArchiveSession).toHaveBeenCalledOnce();
    expect(document.body.querySelector("[role=dialog]")).toBeNull();
  });

  it("opens from the keyboard, closes on Escape and returns focus to the trigger", async () => {
    await act(async () => root.render(<ChatSessionOverflow dock={dock()} onFork={vi.fn()} onInspect={vi.fn()} />));
    trigger().focus();
    await act(async () => {
      trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await vi.waitFor(() => expect(item("New conversation from latest message")).toBeDefined());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(item("Inspect conversation")).toBeDefined();
    expect(item("New conversation from latest message")).toBeDefined();
    const menu = document.body.querySelector('[role="menu"]') as HTMLElement;
    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    // Radix restores focus on the next task after the menu unmounts.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(trigger());
  });

  it("opens the build editor from the menu even before a conversation is selected", async () => {
    const onOpenBuildEditor = vi.fn();
    await act(async () => root.render(<ChatSessionOverflow dock={null} onOpenBuildEditor={onOpenBuildEditor} />));
    await act(async () => {
      const node = trigger();
      node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      node.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }));
      node.click();
    });
    await vi.waitFor(() => expect(item("Open code workbench")).toBeDefined());
    expect(item("Export conversation")).toBeUndefined();
    await act(async () => item("Open code workbench")?.click());
    expect(onOpenBuildEditor).toHaveBeenCalledOnce();
  });

  it("offers Unpin for a pinned conversation", async () => {
    await act(async () =>
      root.render(<ChatSessionOverflow dock={dock({ selectedSession: { sessionId: "s", pinned: true } as never })} />),
    );
    await openWithPointer();
    expect(item("Unpin conversation")).toBeDefined();
    expect(item("Pin conversation")).toBeUndefined();
  });

  it("offers Pin for a conversation that is not pinned", async () => {
    await act(async () =>
      root.render(<ChatSessionOverflow dock={dock({ selectedSession: { sessionId: "s", pinned: false } as never })} />),
    );
    await openWithPointer();
    expect(item("Pin conversation")).toBeDefined();
    expect(item("Unpin conversation")).toBeUndefined();
  });

  it("disables fork when the conversation has no turn to fork from", async () => {
    await act(async () => root.render(<ChatSessionOverflow dock={dock()} />));
    await openWithPointer();
    expect(item("New conversation from latest message")?.getAttribute("aria-disabled")).toBe("true");
  });
});
