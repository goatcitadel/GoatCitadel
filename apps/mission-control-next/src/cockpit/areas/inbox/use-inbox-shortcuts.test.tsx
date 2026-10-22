// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { useInboxShortcuts } from "./use-inbox-shortcuts";

const items = [
  { id: "a", kind: "approval", group: "needs_decision" },
  { id: "b", kind: "approval", group: "needs_decision" },
] as unknown as OperatorInboxItem[];
let root: Root, container: HTMLDivElement;
const select = vi.fn();
function Probe() {
  useInboxShortcuts({
    enabled: true,
    orderedItems: items,
    selectedId: "a",
    select,
    inspect: vi.fn(),
    inspectorShowsInboxItem: false,
    groupOf: () => "needs_decision",
    listHandles: { current: new Map() },
    announce: vi.fn(),
  });
  return null;
}
beforeEach(async () => {
  select.mockReset();
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
