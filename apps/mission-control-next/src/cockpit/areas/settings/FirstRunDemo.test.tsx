// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { FirstRunDemo } from "./FirstRunDemo";

const state = vi.hoisted(() => ({ memorySeed: false, switchOn: false as boolean | undefined }));
vi.mock("../../../features/native-routes/settings/use-demo-bootstrap", () => ({
  useDemoBootstrap: () => ({
    state: { status: "partial", starterPrompts: [], sessions: [] },
    receipt: {
      status: "partial",
      notes: ["Memory sample skipped: memory administration is turned off on this installation."],
      created: { memorySeed: state.memorySeed },
    },
    locked: false,
    loading: false,
    begin: vi.fn(),
    refresh: vi.fn(),
    cancel: vi.fn(),
    confirm: vi.fn(),
    open: vi.fn(),
  }),
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ setActiveWorkspaceId: vi.fn(), setActiveCitadelId: vi.fn() }),
}));
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ navigate: vi.fn() }) }));
vi.mock("./feature-switches", async (original) => ({
  ...(await original<object>()),
  useFeatureSwitchOn: () => state.switchOn,
}));

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  window.history.replaceState(null, "", "/settings/first-run?shell=cockpit");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
async function render() {
  await act(async () =>
    root.render(
      <CockpitNavigationProvider>
        <FirstRunDemo workspaceId="one" />
      </CockpitNavigationProvider>,
    ),
  );
}
const switchLink = () =>
  [...container.querySelectorAll("a")].find((entry) => entry.textContent === "Turn it on in Settings › Advanced");

it("says which demo step was skipped and links to its switch while memory administration is off", async () => {
  state.memorySeed = false;
  state.switchOn = false;
  await render();
  expect(container.textContent).toContain(
    "Memory sample skipped: memory administration is turned off on this installation.",
  );
  expect(new URL(switchLink()!.getAttribute("href")!, "http://cockpit.invalid").hash).toBe(
    "#feature-switch-memory-administration",
  );
});

it("offers no link once the switch is on, or when the memory sample was created", async () => {
  state.memorySeed = false;
  state.switchOn = true;
  await render();
  expect(switchLink()).toBeUndefined();
  state.memorySeed = true;
  state.switchOn = false;
  await render();
  expect(switchLink()).toBeUndefined();
});
