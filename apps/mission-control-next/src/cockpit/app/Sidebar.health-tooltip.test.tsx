// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const health = vi.hoisted(() => ({ title: "Backups: no backup yet. Last checked 10:02." }));
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
    title: health.title,
    retry: vi.fn(),
  }),
}));
vi.mock("../data/use-operator-inbox", () => ({ useOperatorInbox: () => ({ data: undefined, isError: false }) }));
vi.mock("./ScopeSwitcher", () => ({ ScopeSwitcher: () => null }));
vi.mock("./WorkRunningIndicator", () => ({ WorkRunningIndicator: () => null }));
vi.mock("../ui/Menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <>{children}</>,
  MenuTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  MenuContent: () => null,
  MenuItem: () => null,
}));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  health.title = "Backups: no backup yet. Last checked 10:02.";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function renderSidebar() {
  const { Sidebar } = await import("./Sidebar");
  await act(async () => root.render(<Sidebar onOpenPalette={vi.fn()} streamState="open" collapsed={false} />));
}
const link = () => host.querySelector<HTMLAnchorElement>('a[href*="/system/health"]')!;

it("says the health sentence in the shared tooltip, not a native title", async () => {
  await renderSidebar();
  expect(link().textContent).toContain("1 check needs review");
  expect(link().hasAttribute("title")).toBe(false);
  await act(async () => link().focus());
  await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(health.title));
});

it("renders the link bare when there is no sentence to show", async () => {
  health.title = "";
  await renderSidebar();
  await act(async () => link().focus());
  expect(link().hasAttribute("title")).toBe(false);
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
});
