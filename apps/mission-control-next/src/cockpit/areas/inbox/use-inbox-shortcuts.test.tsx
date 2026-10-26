// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { useAreaShortcuts } from "../../app/use-area-shortcuts";
import { useInboxShortcuts } from "./use-inbox-shortcuts";

const items = [
  { id: "a", kind: "approval", group: "needs_decision" },
  { id: "b", kind: "approval", group: "needs_decision" },
] as unknown as OperatorInboxItem[];
let root: Root, container: HTMLDivElement;
const select = vi.fn();
const inspect = vi.fn();
const navigate = vi.fn();
function Probe({ withAreaShortcuts = false }: { withAreaShortcuts?: boolean }) {
  useInboxShortcuts({
    enabled: true,
    orderedItems: items,
    selectedId: "a",
    select,
    inspect,
    inspectorShowsInboxItem: false,
    groupOf: () => "needs_decision",
    listHandles: { current: new Map() },
    announce: vi.fn(),
  });
  return withAreaShortcuts ? <AreaShortcuts /> : null;
}
// The cockpit shell mounts the area key handler beside the Inbox page, so the two share every keystroke.
function AreaShortcuts() {
  useAreaShortcuts({
    scope: "test",
    navigate,
    onPalette: vi.fn(),
    onHelp: vi.fn(),
    onToggleSidebar: vi.fn(),
  });
  return null;
}
beforeEach(async () => {
  select.mockReset();
  inspect.mockReset();
  navigate.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<Probe />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.querySelectorAll('[role="dialog"]').forEach((dialog) => dialog.remove());
});
const press = (key: string) => act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key })));

it("pauses for an ordinary dialog but keeps working under the phone inspector sheet (SH-N10)", async () => {
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  document.body.appendChild(dialog);
  await press("j");
  expect(select).not.toHaveBeenCalled();
  // The inspector sheet holds the inspector body; the shortcuts keep moving through the list behind it.
  const body = document.createElement("div");
  body.setAttribute("data-inspector-body", "true");
  dialog.appendChild(body);
  await press("j");
  expect(select).toHaveBeenCalledExactlyOnceWith("b");
});

// A key event as the browser delivers it: from the focused element, up through the document to the window.
const pressOnDocument = (key: string) =>
  act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));

it("still approves on A when nothing else handled the key", async () => {
  await pressOnDocument("a");
  expect(inspect).toHaveBeenCalledExactlyOnceWith(items[0], "approve");
});

it("ignores a key another handler already handled", async () => {
  const handled = (event: Event) => event.preventDefault();
  document.addEventListener("keydown", handled);
  try {
    await pressOnDocument("a");
  } finally {
    document.removeEventListener("keydown", handled);
  }
  expect(inspect).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
});

it("does not approve when G then A jumps to Capabilities", async () => {
  await act(async () => root.render(<Probe withAreaShortcuts />));
  await pressOnDocument("g");
  await pressOnDocument("a");
  expect(navigate).toHaveBeenCalledExactlyOnceWith("/capabilities");
  expect(inspect).not.toHaveBeenCalled();
});
