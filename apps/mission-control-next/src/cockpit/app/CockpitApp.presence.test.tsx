// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CockpitApp } from "./CockpitApp";
const state = vi.hoisted(() => ({
  ready: false,
  callerScope: "caller-a",
  workspace: "w1",
  area: "chat",
  rest: [] as string[],
  upsert: vi.fn(async (_input: Record<string, unknown>) => undefined),
  activeEffects: 0,
  visible: undefined as undefined | ((id?: string) => void),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ upsertNotificationPresence: state.upsert }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  UiPreferencesProvider: ({ children }: { children: React.ReactNode }) => children,
  useUiPreferences: () => ({ activeWorkspaceId: state.workspace, theme: "light", density: "comfortable" }),
}));
vi.mock("./CockpitNavigationProvider", () => ({
  CockpitNavigationProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("./use-cockpit-route", () => ({
  useCockpitRoute: () => ({ area: state.area, rest: state.rest, resolution: { kind: "native" } }),
}));
vi.mock("../../app/use-gateway-access", () => ({
  useGatewayAccess: () => ({ callerScope: state.callerScope, gatewayAccess: { status: state.ready ? "ready" : "loading" } }),
}));
vi.mock("../data/realtime", () => ({ useCockpitRealtime: () => "closed" }));
vi.mock("./use-gateway-reachability", () => ({ useGatewayReachability: () => ({ unavailable: false }) }));
vi.mock("./CockpitAccessGate", () => ({ CockpitAccessGate: () => <p>Access gate</p> }));
vi.mock("./CockpitShell", () => ({
  CockpitShell: ({ onVisibleSessionChange }: { onVisibleSessionChange: (id?: string) => void }) => {
    useEffect(() => {
      state.activeEffects += 1;
      return () => {
        state.activeEffects -= 1;
      };
    }, []);
    state.visible = onVisibleSessionChange;
    return (
      <>
        <p>Shell</p>
        <input aria-label="Unsaved draft" defaultValue="keep this draft" />
      </>
    );
  },
}));
vi.mock("../ui/Toaster", () => ({ CockpitToaster: () => null }));
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
it("leases only ready workspace and actually visible Chat session", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const render = () => act(async () => root!.render(<CockpitApp />));
  await render();
  expect(state.upsert).not.toHaveBeenCalled();
  state.ready = true;
  await render();
  expect(state.upsert).toHaveBeenLastCalledWith(
    expect.objectContaining({ workspaceId: "w1", focused: true, visible: true }),
  );
  await act(async () => state.visible!("s1"));
  expect(state.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "s1" }));
  state.rest = ["projects", "project-a"];
  await render();
  expect(state.upsert.mock.lastCall?.[0]).not.toHaveProperty("sessionId");
  state.rest = [];
  state.area = "inbox";
  await render();
  expect(state.upsert.mock.lastCall?.[0]).not.toHaveProperty("sessionId");
  state.workspace = "w2";
  state.area = "chat";
  await render();
  expect(state.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: "w2" }));
  expect(state.upsert.mock.lastCall?.[0]).not.toHaveProperty("sessionId");
  state.ready = false;
  await render();
  expect(state.upsert).toHaveBeenLastCalledWith(
    expect.objectContaining({ workspaceId: "w2", focused: false, visible: false }),
  );
});

it("keeps the ready shell and drafts mounted behind expired access", async () => {
  state.ready = true;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<CockpitApp />));
  const draft = host.querySelector("input")!;
  draft.value = "unsaved work";
  state.ready = false;
  await act(async () => root!.render(<CockpitApp />));
  expect(host.querySelector("input")).toBe(draft);
  expect(host.querySelector("[inert]")).not.toBeNull();
  expect(state.activeEffects).toBe(0);
  state.ready = true;
  await act(async () => root!.render(<CockpitApp />));
  expect(host.querySelector("input")?.value).toBe("unsaved work");
});

it("recreates controller state for a different server caller and retains it only for same-caller recovery", async () => {
 state.ready=true; state.callerScope="caller-a";
 const host=document.createElement("div");document.body.append(host);root=createRoot(host);
 const render=()=>act(async()=>root!.render(<CockpitApp/>));
 await render(); const original=host.querySelector<HTMLInputElement>("input")!;original.value="caller A unsent draft";
 state.ready=false;await render(); expect(state.activeEffects).toBe(0);
 state.ready=true;await render();expect(host.querySelector("input")).toBe(original);expect(original.value).toBe("caller A unsent draft");
 state.ready=false;await render();state.callerScope="caller-b";state.ready=true;await render();
 expect(host.querySelector("input")).not.toBe(original);expect(host.textContent).not.toContain("caller A unsent draft");
 expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("keep this draft");
 state.callerScope="caller-a";
});
