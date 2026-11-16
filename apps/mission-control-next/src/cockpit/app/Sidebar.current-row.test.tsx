// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const route = vi.hoisted(() => ({ pathname: "/chat", search: "", hash: "", area: "chat", navigate: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { items: [] } }) }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({
    activeCitadelId: "personal",
    activeWorkspaceId: "default",
    themePreference: "light",
    setTheme: vi.fn(),
  }),
}));
vi.mock("./use-cockpit-route", () => ({ useCockpitRoute: () => route }));
vi.mock("./use-cockpit-preload", () => ({ useCockpitPreload: () => vi.fn() }));
vi.mock("./use-cockpit-shell-switch", () => ({ useCockpitShellSwitch: () => ({ request: vi.fn(), feedback: null }) }));
vi.mock("./use-health-digest", () => ({
  useHealthDigestStatus: () => ({
    tone: "waiting",
    phase: "ready",
    label: "1 check needs review",
    title: "Backups: no backup yet.",
    retry: vi.fn(),
  }),
}));
vi.mock("../data/use-operator-inbox", () => ({ useOperatorInbox: () => ({ data: undefined, isError: false }) }));
vi.mock("./ScopeSwitcher", () => ({ ScopeSwitcher: () => null }));
vi.mock("./WorkRunningIndicator", () => ({ WorkRunningIndicator: () => null }));
vi.mock("../ui/Menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <>{children}</>,
  MenuTrigger: ({ children, ...props }: { children: ReactNode; [key: string]: unknown }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  MenuContent: () => null,
  MenuItem: () => null,
}));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  route.area = "chat";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function renderSidebar(collapsed: boolean) {
  const { Sidebar } = await import("./Sidebar");
  await act(async () => root.render(<Sidebar onOpenPalette={vi.fn()} streamState="open" collapsed={collapsed} />));
}

// U-GL-005: a current row must differ from a hovered one by more than the tint.
it.each([false, true])("marks only the current area link as the current row (collapsed: %s)", async (collapsed) => {
  await renderSidebar(collapsed);
  const rows = [...host.querySelectorAll<HTMLElement>("nav a")];
  const current = rows.filter((row) => row.getAttribute("aria-current") === "page");
  expect(current).toHaveLength(1);
  expect(current[0]!.hasAttribute("data-current-row")).toBe(true);
  expect(current[0]!.className).toContain("aria-[current=page]:font-medium");
  expect(rows.every((row) => row.hasAttribute("data-current-row"))).toBe(true);
});

it("marks the Settings gear as a current row while Settings is open", async () => {
  route.area = "settings";
  await renderSidebar(false);
  const gear = host.querySelector<HTMLElement>('[aria-label="Settings and account"]')!;
  expect(gear.getAttribute("aria-current")).toBe("page");
  expect(gear.hasAttribute("data-current-row")).toBe(true);
});
