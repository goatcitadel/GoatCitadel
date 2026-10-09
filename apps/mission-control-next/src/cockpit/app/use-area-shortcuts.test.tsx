// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAreaShortcuts } from "./use-area-shortcuts";

let container: HTMLDivElement;
let root: Root;
const navigate = vi.fn();
const help = vi.fn();
const palette = vi.fn();
function Probe({ scope = "one" }: { scope?: string }) {
  useAreaShortcuts({ scope, navigate, onHelp: help, onPalette: palette, onToggleSidebar: vi.fn() });
  return <><button type="button">Focus</button><input aria-label="Draft" /><div contentEditable tabIndex={0}>Editable</div></>;
}
function key(value: string, options: KeyboardEventInit = {}, target: EventTarget = document) {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options });
  act(() => target.dispatchEvent(event));
  return event;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  act(() => root.render(<Probe />));
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });
it("navigates six areas with g sequences and retains palette and help", () => {
  for (const [letter, path] of [["c", "chat"], ["i", "inbox"], ["w", "work"], ["l", "library"], ["s", "system"], ["t", "settings"]]) {
    key("g"); expect(key(letter!).defaultPrevented).toBe(true); expect(navigate).toHaveBeenLastCalledWith(`/${path}`);
  }
  key("?", { shiftKey: true }); expect(help).toHaveBeenCalledOnce();
  key("k", { ctrlKey: true }); expect(palette).toHaveBeenCalledOnce();
  expect(key("1", { ctrlKey: true }).defaultPrevented).toBe(false);
});
it("never consumes editing, IME, repeated, or modified sequence keys", () => {
  for (const target of [container.querySelector("input")!, container.querySelector("[contenteditable]")!]) {
    expect(key("g", {}, target).defaultPrevented).toBe(false); key("c", {}, target);
  }
  for (const options of [{ isComposing: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { repeat: true }]) {
    key("g", options); key("c");
  }
  expect(navigate).not.toHaveBeenCalled();
});
it("expires and cancels after unrelated keys, focus, scope, dialog, or unmount", () => {
  key("g"); act(() => vi.advanceTimersByTime(1500)); key("c");
  key("g"); key("x"); key("c");
  key("g"); act(() => container.querySelector("button")!.focus()); key("c");
  key("g"); act(() => root.render(<Probe scope="two" />)); key("c");
  const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog"); dialog.setAttribute("data-state", "open"); document.body.append(dialog);
  key("g"); key("c"); dialog.remove();
  key("g"); act(() => root.render(null)); key("c");
  expect(navigate).not.toHaveBeenCalled();
});
