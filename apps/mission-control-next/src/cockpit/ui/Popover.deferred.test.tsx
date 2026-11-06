// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const load = vi.hoisted(() => ({ started: vi.fn<() => Promise<void>>(), completed: vi.fn() }));
const custody = vi.hoisted(() => ({
  history: 0,
  histories: new Set<() => void>(),
  caller: 1,
  access: 1,
  gateway: "http://gateway-a",
  citadel: "personal",
  workspace: "workspace-a",
  callers: new Set<() => void>(),
  accesses: new Set<() => void>(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => custody.gateway }));
vi.mock("@goatcitadel/mission-control-shared/api/access-scope", () => ({
  getGatewayCallerScopeRevision: () => custody.caller,
  getGatewayAccessRevision: () => custody.access,
  subscribeGatewayCallerScope: (notify: () => void) => {
    custody.callers.add(notify);
    return () => custody.callers.delete(notify);
  },
  subscribeGatewayAccessChange: (notify: () => void) => {
    custody.accesses.add(notify);
    return () => custody.accesses.delete(notify);
  },
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeCitadelId: custody.citadel, activeWorkspaceId: custody.workspace }),
}));
vi.mock("../app/cockpit-back-guard", () => ({ COCKPIT_LOCATION_EVENT: "goatcitadel:cockpit-location" }));
vi.mock("../app/cockpit-history", () => ({
  readCockpitHistory: () => `${custody.history}:${window.location.href}`,
  subscribeCockpitHistory: (notify: () => void) => {
    custody.histories.add(notify);
    return () => custody.histories.delete(notify);
  },
}));
let ui: typeof import("./Popover"), sdk: typeof import("./PopoverRuntime");
let root: Root, host: HTMLDivElement;
function gate() {
  let resolve!: () => void, reject!: (cause: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
beforeEach(async () => {
  vi.resetModules();
  load.started.mockReset().mockResolvedValue(undefined);
  load.completed.mockReset();
  custody.callers.clear();
  custody.accesses.clear();
  custody.histories.clear();
  custody.history = 0;
  window.history.replaceState({ fixturePosition: 3 }, "", "/chat?sessionId=session-a&shell=cockpit#overlay");
  Object.assign(custody, {
    caller: 1,
    access: 1,
    gateway: "http://gateway-a",
    citadel: "personal",
    workspace: "workspace-a",
  });
  // Real installed public SDK is fixture data. Only the private destination is held;
  // product code still executes its actual dynamic-import/open/focus ownership path.
  const primitive = (await vi.importActual<typeof import("radix-ui")>("radix-ui")).Popover; sdk = { Root: primitive.Root, Trigger: primitive.Trigger, Content: primitive.Content } as typeof sdk;
  vi.doMock("./PopoverRuntime", async () => {
    await load.started();
    load.completed();
    return sdk;
  });
  ui = await import("./Popover");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.doUnmock("./PopoverRuntime");
  vi.restoreAllMocks();
});
const trigger = () => host.querySelector<HTMLButtonElement>('[data-overlay-trigger]')!;
const menu = () => document.querySelector<HTMLElement>('[role="dialog"]');
const outside = () => host.querySelector<HTMLButtonElement>('#overlay-outside')!;
function pointer(node: HTMLElement, type: string) { return node.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,button:0,pointerType:'mouse',pointerId:1,isPrimary:true})); }
async function key(node: HTMLElement, value: string) { await act(async () => { node.dispatchEvent(new KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true})); }); }
type Options = {scope?:string; open?:boolean; onSelect?:()=>void};
function view(options:Options={}) { return <><textarea aria-label="Draft" defaultValue="Keep this"/><button type="button" id="overlay-outside">Outside</button><ui.Popover scopeKey={options.scope ?? 'session-a'} open={options.open}><ui.PopoverTrigger data-overlay-trigger>Options</ui.PopoverTrigger><ui.PopoverContent aria-label="Options"><button type="button" onClick={options.onSelect}>Action</button></ui.PopoverContent></ui.Popover></>; }
async function render(options:Options={}) { await act(async () => root.render(view(options))); }
describe('deferred Popover',()=>{
 it('does not import a closed panel or load on focus',async()=>{ await render(); trigger().focus(); expect(load.started).not.toHaveBeenCalled(); expect(menu()).toBeNull(); });
 it.each(['click','Enter',' '])('loads once for %s and shows immediate status',async kind=>{
  const held=gate(); load.started.mockImplementationOnce(()=>held.promise); await render(); trigger().focus();
  if(kind==='click') await act(async()=>trigger().click()); else await key(trigger(),kind);
  expect(document.querySelector('[role="status"]')?.textContent).toMatch(/Loading/i); expect(load.started).toHaveBeenCalledOnce();
  await act(async()=>held.resolve()); await vi.waitFor(()=>expect(menu()).not.toBeNull()); expect(load.started).toHaveBeenCalledOnce();
 });
 it('invalidates accepted controlled false',async()=>{const held=gate();load.started.mockImplementationOnce(()=>held.promise);await render({open:true});await vi.waitFor(()=>expect(load.started).toHaveBeenCalledOnce());await render({open:false});await act(async()=>held.resolve());await vi.waitFor(()=>expect(load.completed).toHaveBeenCalledOnce());expect(menu()).toBeNull();});
 it('rejects without changing the draft or firing actions',async()=>{const held=gate(), selected=vi.fn();load.started.mockImplementationOnce(()=>held.promise);await render({onSelect:selected});trigger().focus();await key(trigger(),'Enter');await act(async()=>held.reject(new Error('fixture failure')));await vi.waitFor(()=>expect(document.querySelector('[role="status"]')?.textContent).toMatch(/could not load/i));expect(host.querySelector('textarea')?.value).toBe('Keep this');expect(selected).not.toHaveBeenCalled();outside().focus();expect(document.activeElement).toBe(outside());});
 it('cancels while loading',async()=>{const held=gate();load.started.mockImplementationOnce(()=>held.promise);await render();trigger().focus();await key(trigger(),'Enter');await act(async()=>[...document.querySelectorAll('button')].find(n=>/^Cancel/.test(n.textContent ?? ''))!.click());await act(async()=>held.resolve());await vi.waitFor(()=>expect(load.completed).toHaveBeenCalledOnce());expect(menu()).toBeNull();});
  it.each(["Escape", "Tab", "outside-focus", "blur-body", "outside-pointer", "pointercancel"])(
    "cannot open late after pending %s",
    async (reason) => {
      const held = gate();
      load.started.mockImplementationOnce(() => held.promise);
      const selected = vi.fn();
      await render({ onSelect: selected });
      trigger().focus();
      await key(trigger(), "Enter");
      const native = trigger();
      if (reason === "Escape" || reason === "Tab") {
        await key(native, reason);
        if (reason === "Tab") await act(async () => outside().focus());
      } else if (reason === "outside-focus") await act(async () => outside().focus());
      else if (reason === "blur-body") await act(async () => native.blur());
      else if (reason === "outside-pointer")
        await act(async () => {
          pointer(outside(), "pointerdown");
          outside().focus();
        });
      else
        await act(async () => {
          pointer(native, "pointercancel");
        });
      const focusAfterCancel = document.activeElement;
      await act(async () => held.resolve());
      await vi.waitFor(() => expect(load.completed).toHaveBeenCalledOnce());
      expect(menu()).toBeNull();
      expect(trigger()).toBe(native);
      expect(document.activeElement).toBe(focusAfterCancel);
      expect(selected).not.toHaveBeenCalled();
    },
  );
  it.each(["caller-ABA", "access", "gateway", "session-ABA", "location-ABA", "workspace", "citadel"])(
    "rejects the old opening and action subject after %s",
    async (reason) => {
      const held = gate();
      load.started.mockImplementationOnce(() => held.promise);
      const selected = vi.fn();
      await render({ onSelect: selected });
      trigger().focus();
      await key(trigger(), "Enter");
      await act(async () => {
        if (reason === "caller-ABA") {
          custody.caller += 2;
          custody.callers.forEach((notify) => notify());
        }
        if (reason === "access") {
          custody.access += 1;
          custody.accesses.forEach((notify) => notify());
        }
        if (reason === "gateway") {
          custody.gateway = "http://gateway-b";
          root.render(view({ onSelect: selected }));
        }
        if (reason === "location-ABA") {
          window.dispatchEvent(new Event("goatcitadel:cockpit-location"));
          window.dispatchEvent(new Event("goatcitadel:cockpit-location"));
        }
        if (reason === "workspace") {
          custody.workspace = "workspace-b";
          root.render(view({ onSelect: selected }));
        }
        if (reason === "citadel") {
          custody.citadel = "other";
          root.render(view({ onSelect: selected }));
        }
      });
      if (reason === "session-ABA") {
        await render({ scope: "session-b", onSelect: selected });
        await render({ scope: "session-a", onSelect: selected });
      }
      const outsideButton = outside();
      outsideButton.focus();
      await act(async () => held.resolve());
      await vi.waitFor(() => expect(load.completed).toHaveBeenCalledOnce());
      expect(menu()).toBeNull();
      expect(document.activeElement).toBe(outsideButton);
      expect(selected).not.toHaveBeenCalled();
    },
  );
 it('drops an unmounted pending opening',async()=>{const held=gate();load.started.mockImplementationOnce(()=>held.promise);await render();trigger().focus();await key(trigger(),'Enter');await act(async()=>root.render(<button type="button">Replacement</button>));await act(async()=>held.resolve());await vi.waitFor(()=>expect(load.completed).toHaveBeenCalledOnce());expect(menu()).toBeNull();});
});
