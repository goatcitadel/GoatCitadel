// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { createElement } from "react";
import { SHELL_ROUTE_SHORTCUT_LETTERS, useShellKeyboardManager } from "./use-shell-keyboard-manager";
import type { PrimaryArea } from "./route-model";

/*
 * Tests live alongside use-shell-keyboard-manager.ts. They exercise the hook
 * end-to-end via document.dispatchEvent in a happy-dom environment so the
 * real keydown path runs (not a mocked handler).
 */

type Listeners = {
  onOpenPalette: Mock<() => void>;
  onClosePalette: Mock<() => void>;
  onDismissTopmost: Mock<() => boolean>;
  onJumpToArea: Mock<(area: PrimaryArea) => void>;
};

function Driver({ isPaletteOpen, listeners }: { isPaletteOpen: boolean; listeners: Listeners }) {
  useShellKeyboardManager({
    onOpenPalette: listeners.onOpenPalette,
    onClosePalette: listeners.onClosePalette,
    isPaletteOpen,
    onDismissTopmost: listeners.onDismissTopmost,
    onJumpToArea: listeners.onJumpToArea,
  });
  return null;
}

function emitKey(init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(event);
  return event;
}

describe("useShellKeyboardManager", () => {
  let listeners: Listeners;
  let renderer: ReactTestRenderer | null;

  beforeEach(() => {
    listeners = {
      onOpenPalette: vi.fn<() => void>(),
      onClosePalette: vi.fn<() => void>(),
      onDismissTopmost: vi.fn<() => boolean>().mockReturnValue(false),
      onJumpToArea: vi.fn<(area: PrimaryArea) => void>(),
    };
    renderer = null;
  });

  afterEach(() => {
    if (renderer) {
      act(() => {
        renderer!.unmount();
      });
    }
  });

  function mount(isPaletteOpen: boolean) {
    act(() => {
      renderer = create(createElement(Driver, { isPaletteOpen, listeners }));
    });
  }

  it("opens the palette on Cmd+K", () => {
    mount(false);
    emitKey({ key: "k", metaKey: true });
    expect(listeners.onOpenPalette).toHaveBeenCalledTimes(1);
  });

  it("opens the palette on Ctrl+K", () => {
    mount(false);
    emitKey({ key: "k", ctrlKey: true });
    expect(listeners.onOpenPalette).toHaveBeenCalledTimes(1);
  });

  it("ignores Cmd+Shift+K so other multi-modifier shortcuts pass through", () => {
    mount(false);
    emitKey({ key: "k", metaKey: true, shiftKey: true });
    expect(listeners.onOpenPalette).not.toHaveBeenCalled();
  });

  it("closes the palette on Escape when palette is open", () => {
    mount(true);
    emitKey({ key: "Escape" });
    expect(listeners.onClosePalette).toHaveBeenCalledTimes(1);
    expect(listeners.onDismissTopmost).not.toHaveBeenCalled();
  });

  it("delegates Escape to onDismissTopmost when palette is closed", () => {
    listeners.onDismissTopmost.mockReturnValue(true);
    mount(false);
    emitKey({ key: "Escape" });
    expect(listeners.onDismissTopmost).toHaveBeenCalledTimes(1);
    expect(listeners.onClosePalette).not.toHaveBeenCalled();
  });

  it("jumps to area on g then c", () => {
    mount(false);
    emitKey({ key: "g" });
    emitKey({ key: "c" });
    expect(listeners.onJumpToArea).toHaveBeenCalledWith<[PrimaryArea]>("chat");
  });

  it("jumps to settings on g then s", () => {
    mount(false);
    emitKey({ key: "g" });
    emitKey({ key: "s" });
    expect(listeners.onJumpToArea).toHaveBeenCalledWith<[PrimaryArea]>("settings");
  });

  it("does not jump for unknown letters after g", () => {
    mount(false);
    emitKey({ key: "g" });
    emitKey({ key: "z" });
    expect(listeners.onJumpToArea).not.toHaveBeenCalled();
  });

  it("does not jump when focus is in an input", () => {
    mount(false);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    // Dispatch with explicit target so the focused-input guard triggers.
    const gEvent = new KeyboardEvent("keydown", { key: "g", bubbles: true, cancelable: true });
    Object.defineProperty(gEvent, "target", { value: input, writable: false });
    document.dispatchEvent(gEvent);
    const cEvent = new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true });
    Object.defineProperty(cEvent, "target", { value: input, writable: false });
    document.dispatchEvent(cEvent);
    expect(listeners.onJumpToArea).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it("ignores Cmd+G so the browser's find-next stays available", () => {
    mount(false);
    emitKey({ key: "g", metaKey: true });
    emitKey({ key: "c" });
    expect(listeners.onJumpToArea).not.toHaveBeenCalled();
  });

  it("exposes the route shortcut letter map", () => {
    expect(SHELL_ROUTE_SHORTCUT_LETTERS.get("chat")).toBe("c");
    expect(SHELL_ROUTE_SHORTCUT_LETTERS.get("settings")).toBe("s");
    expect(SHELL_ROUTE_SHORTCUT_LETTERS.get("cowork")).toBe("w");
  });
});
