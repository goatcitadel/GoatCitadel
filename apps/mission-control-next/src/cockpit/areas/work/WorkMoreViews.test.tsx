// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkMoreViews } from "./WorkMoreViews";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ rest: [], navigate }) }));
// The deferred Radix menu owner has its own tests; here it renders its items inline so the wiring is visible.
vi.mock("../../ui/Menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({ children, ...props }: { children: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  MenuContent: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
  MenuItem: ({ children, onSelect }: { children: ReactNode; onSelect: () => void }) => (
    <div role="menuitem" tabIndex={-1} onClick={onSelect}>
      {children}
    </div>
  ),
}));

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

it("WK-01: opens the older Kanban from the Work overflow menu at its kept route", () => {
  act(() => root.render(<WorkMoreViews />));
  expect(host.querySelector('button[aria-label="More Work views"]')?.textContent).toContain("More");
  const item = host.querySelector<HTMLElement>('[role="menuitem"]')!;
  expect(item.textContent).toBe("Older Kanban view");
  act(() => item.click());
  expect(navigate).toHaveBeenCalledWith("/work/kanban");
});
