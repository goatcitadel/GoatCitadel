// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scope = vi.hoisted(() => ({
  caller: 1,
  access: 1,
  workspace: "workspace-a",
  callers: new Set<() => void>(),
  accesses: new Set<() => void>(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => "http://gateway-a",
}));
vi.mock("@goatcitadel/mission-control-shared/api/access-scope", () => ({
  getGatewayCallerScopeRevision: () => scope.caller,
  getGatewayAccessRevision: () => scope.access,
  subscribeGatewayCallerScope: (notify: () => void) => {
    scope.callers.add(notify);
    return () => scope.callers.delete(notify);
  },
  subscribeGatewayAccessChange: (notify: () => void) => {
    scope.accesses.add(notify);
    return () => scope.accesses.delete(notify);
  },
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeCitadelId: "personal", activeWorkspaceId: scope.workspace }),
}));
vi.mock("../app/cockpit-back-guard", () => ({ COCKPIT_LOCATION_EVENT: "goatcitadel:cockpit-location" }));
vi.mock("../app/cockpit-history", () => ({
  readCockpitHistory: () => window.location.href,
  subscribeCockpitHistory: () => () => {},
}));
import { useDeferredOverlay } from "./deferred-overlay-owner";

type Module = { label: string };
function gate() {
  let resolve!: (module: Module) => void, reject!: (cause: Error) => void;
  const promise = new Promise<Module>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
let root: Root, host: HTMLDivElement, outside: HTMLButtonElement, held: ReturnType<typeof gate>;
let load: ReturnType<typeof vi.fn<() => Promise<Module>>>,
  changes: ReturnType<typeof vi.fn<(open: boolean) => void>>,
  actions: ReturnType<typeof vi.fn<() => void>>;
function Surface() {
  const state = useDeferredOverlay({ scopeKey: "session-a", load, onOpenChange: changes });
  return (
    <>
      <button
        ref={(node) => {
          state.trigger.current = node;
        }}
        data-trigger
        type="button"
        onClick={() => state.request(true, "keyboard")}
      >
        Open
      </button>
      {state.loading || state.failure ? (
        <span ref={state.status} role="status">
          {state.failure ? "Unavailable" : "Loading"}
          <button type="button" data-recovery>
            Reload
          </button>
        </span>
      ) : null}
      {state.open && state.runtime ? (
        <div
          ref={(node) => {
            state.content.current = node;
          }}
          role="menu"
        >
          <button type="button" onClick={() => actions()}>
            {state.runtime.label}
          </button>
        </div>
      ) : null}
    </>
  );
}
const trigger = () => host.querySelector<HTMLButtonElement>("[data-trigger]")!;
const recovery = () => host.querySelector<HTMLButtonElement>("[data-recovery]");
const menu = () => host.querySelector('[role="menu"]');
async function render() {
  await act(async () => root.render(<Surface />));
}
async function open() {
  await act(async () => {
    trigger().focus();
    trigger().click();
  });
}
async function bodyGap() {
  await act(async () => {
    trigger().blur();
    await Promise.resolve();
  });
  expect(document.activeElement).toBe(document.body);
}
async function unavailable() {
  await open();
  await act(async () => held.reject(new Error("fixture optional code unavailable")));
  expect(host.textContent).toContain("Unavailable");
}
beforeEach(async () => {
  Object.assign(scope, { caller: 1, access: 1, workspace: "workspace-a" });
  scope.callers.clear();
  scope.accesses.clear();
  window.history.replaceState({}, "", "/chat?sessionId=session-a&shell=cockpit");
  held = gate();
  load = vi.fn(() => held.promise);
  changes = vi.fn<(open: boolean) => void>();
  actions = vi.fn<() => void>();
  host = document.createElement("div");
  outside = document.createElement("button");
  outside.textContent = "Outside";
  document.body.append(host, outside);
  root = createRoot(host);
  // Only task settlement is held. Real Promise microtasks and focus events remain live.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  outside.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("pending overlay native focus settlement", () => {
  it("retains failed Reload through microtask BODY and owned focus, then immediately revokes real outside focus", async () => {
    await unavailable();
    const reload = recovery()!;
    await bodyGap();
    expect(recovery()).toBe(reload);
    expect(reload.isConnected).toBe(true);
    expect(host.textContent).toContain("Unavailable");
    await act(async () => reload.focus());
    await act(async () => vi.runOnlyPendingTimers());
    expect(document.activeElement).toBe(reload);
    expect(recovery()).toBe(reload);
    expect(load).toHaveBeenCalledOnce();
    await act(async () => outside.focus());
    expect(recovery()).toBeNull();
    expect(document.activeElement).toBe(outside);
    expect(actions).not.toHaveBeenCalled();
  });
  it("publishes code completed during BODY only when current owned focus lands without replaying an action", async () => {
    await open();
    await bodyGap();
    await act(async () => held.resolve({ label: "Run original action" }));
    expect(menu()).toBeNull();
    expect(recovery()).not.toBeNull();
    expect(actions).not.toHaveBeenCalled();
    const original = trigger();
    await act(async () => original.focus());
    expect(menu()).not.toBeNull();
    expect(trigger()).toBe(original);
    expect(document.activeElement).toBe(original);
    expect(actions).not.toHaveBeenCalled();
    await act(async () => vi.runOnlyPendingTimers());
    expect(menu()).not.toBeNull();
    expect(load).toHaveBeenCalledOnce();
    await act(async () => host.querySelector<HTMLButtonElement>('[role="menu"] button')!.click());
    expect(actions).toHaveBeenCalledOnce();
  });
  it("revokes outside focus before held code settles and never restores or executes from late completion", async () => {
    await open();
    await bodyGap();
    await act(async () => outside.focus());
    expect(recovery()).toBeNull();
    expect(document.activeElement).toBe(outside);
    await act(async () => held.resolve({ label: "Run original action" }));
    await act(async () => vi.runOnlyPendingTimers());
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(outside);
    expect(actions).not.toHaveBeenCalled();
    expect(changes.mock.calls).toEqual([[true], [false]]);
  });
  it("revokes BODY that remains outside after the native focus transfer settles", async () => {
    await unavailable();
    await bodyGap();
    expect(recovery()).not.toBeNull();
    await act(async () => vi.runOnlyPendingTimers());
    expect(recovery()).toBeNull();
    expect(document.activeElement).toBe(document.body);
    expect(changes.mock.calls).toEqual([[true], [false]]);
  });
  it.each(["caller ABA", "workspace", "unmount"])(
    "clears pending focus settlement and rejects stale code after %s",
    async (boundary) => {
      await open();
      await bodyGap();
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      if (boundary === "caller ABA") {
        await act(async () => {
          scope.caller += 1;
          for (const notify of scope.callers) notify();
        });
        await act(async () => {
          scope.caller += 1;
          for (const notify of scope.callers) notify();
        });
      } else if (boundary === "workspace") {
        scope.workspace = "workspace-b";
        await render();
      } else await act(async () => root.render(null));
      expect(vi.getTimerCount()).toBe(0);
      outside.focus();
      await act(async () => held.resolve({ label: "Run original action" }));
      await act(async () => vi.runOnlyPendingTimers());
      expect(menu()).toBeNull();
      expect(recovery()).toBeNull();
      expect(document.activeElement).toBe(outside);
      expect(actions).not.toHaveBeenCalled();
    },
  );
});
