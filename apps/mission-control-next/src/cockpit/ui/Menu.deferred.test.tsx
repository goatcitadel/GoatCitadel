// @vitest-environment happy-dom
import { act, StrictMode, type ComponentProps, type Ref } from "react";
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
let ui: typeof import("./Menu"), sdk: typeof import("./MenuRuntime");
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
  sdk = await vi.importActual<typeof import("./MenuRuntime")>("./MenuRuntime");
  vi.doMock("./MenuRuntime", async () => {
    await load.started();
    load.completed();
    return sdk;
  });
  ui = await import("./Menu");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.doUnmock("./MenuRuntime");
  vi.restoreAllMocks();
});
const trigger = () => host.querySelector<HTMLButtonElement>("[data-overlay-trigger]")!;
const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const item = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) => node.textContent === label)!;
const outside = () => host.querySelector<HTMLButtonElement>("#overlay-outside")!;
function pointer(node: HTMLElement, type: "pointerdown" | "pointerup" | "pointercancel") {
  return node.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerType: "mouse",
      pointerId: 1,
      isPrimary: true,
    }),
  );
}
async function key(node: HTMLElement, value: string) {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
  await act(async () => {
    node.dispatchEvent(event);
  });
  return event;
}
async function clickSequence(node: HTMLElement) {
  await act(async () => {
    pointer(node, "pointerdown");
    pointer(node, "pointerup");
    node.click();
  });
}
async function ready() {
  await vi.waitFor(() => expect(menu()).not.toBeNull());
}
async function closed() {
  await vi.waitFor(() => expect(menu()).toBeNull());
}
type Options = {
  hiddenFirst?: boolean;
  onContentFocus?: ComponentProps<typeof ui.MenuContent>["onFocus"];
  open?: boolean;
  defaultOpen?: boolean;
  scope?: string;
  strict?: boolean;
  asChild?: boolean;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSelect?: () => void;
  triggerRef?: Ref<HTMLButtonElement>;
  onPointerDown?: ComponentProps<typeof ui.MenuTrigger>["onPointerDown"];
  onKeyDown?: ComponentProps<typeof ui.MenuTrigger>["onKeyDown"];
  onClick?: ComponentProps<typeof ui.MenuTrigger>["onClick"];
  childDown?: ComponentProps<"button">["onPointerDown"];
  childClick?: ComponentProps<"button">["onClick"];
};
function view(options: Options = {}) {
  const button = (
    <button
      type="button"
      data-overlay-trigger
      id="owned-menu-trigger"
      className="existing-trigger-style"
      onPointerDown={options.childDown}
      onClick={options.childClick}
    >
      Existing action label
    </button>
  );
  const content = (
    <>
      <textarea aria-label="Unsent answer" />
      <button id="overlay-outside" type="button">
        Outside
      </button>
      <ui.Menu
        scopeKey={options.scope ?? "session-a"}
        open={options.open}
        defaultOpen={options.defaultOpen}
        onOpenChange={options.onOpenChange}
        modal={false}
        dir="ltr"
      >
        <ui.MenuTrigger
          data-overlay-trigger
          id="owned-menu-trigger"
          className="existing-trigger-style"
          aria-label="Existing actions"
          asChild={options.asChild}
          disabled={options.disabled}
          ref={options.triggerRef}
          onPointerDown={options.onPointerDown}
          onKeyDown={options.onKeyDown}
          onClick={options.onClick}
        >
          {options.asChild ? button : "Existing action label"}
        </ui.MenuTrigger>
        <ui.MenuContent align="end" onFocus={options.onContentFocus}>
          {options.hiddenFirst ? <ui.MenuItem style={{ display: "none" }}>Hidden first</ui.MenuItem> : null}
          <ui.MenuItem disabled>Disabled first</ui.MenuItem>
          <ui.MenuItem onSelect={options.onSelect}>First enabled</ui.MenuItem>
          <ui.MenuItem>Last enabled</ui.MenuItem>
        </ui.MenuContent>
      </ui.Menu>
    </>
  );
  return options.strict ? <StrictMode>{content}</StrictMode> : content;
}
async function render(options: Options = {}) {
  await act(async () => root.render(view(options)));
}

describe("deferred Menu public contract", () => {
  it("does not import a closed menu or load from focus alone", async () => {
    await render();
    trigger().focus();
    expect(load.started).not.toHaveBeenCalled();
    expect(menu()).toBeNull();
  });
  it("preserves the original pointer click and normal ref handoff when loading finishes between down and up", async () => {
    const held = gate();
    load.started.mockImplementationOnce(() => held.promise);
    const clicks = vi.fn(),
      down = vi.fn(),
      selected = vi.fn(),
      changes = vi.fn();
    const refs: (HTMLButtonElement | null)[] = [];
    await render({
      asChild: true,
      onPointerDown: down,
      onClick: clicks,
      onSelect: selected,
      onOpenChange: changes,
      triggerRef: (node) => {
        refs.push(node);
      },
    });
    const native = trigger(),
      className = trigger().className;
    await act(async () => {
      pointer(native, "pointerdown");
    });
    expect(down).toHaveBeenCalledOnce();
    expect(changes.mock.calls).toEqual([[true]]);
    expect(native.getAttribute("aria-busy")).toBe("true");
    await act(async () => held.resolve());
    await vi.waitFor(() => expect(load.completed).toHaveBeenCalledOnce());
    expect(trigger()).toBe(native);
    expect(menu()).toBeNull();
    expect(clicks).not.toHaveBeenCalled();
    expect(selected).not.toHaveBeenCalled();
    await act(async () => {
      pointer(native, "pointerup");
    });
    expect(trigger()).toBe(native);
    expect(menu()).toBeNull();
    await act(async () => native.click());
    await ready();
    const current = trigger();
    expect(current).not.toBe(native);
    expect(native.isConnected).toBe(false);
    expect(refs).toContain(null);
    expect(refs.at(-1)).toBe(current);
    expect(current.id).toBe("owned-menu-trigger");
    expect(current.className).toBe(className);
    expect(current.textContent).toBe("Existing action label");
    expect(clicks).toHaveBeenCalledOnce();
    expect(changes.mock.calls).toEqual([[true]]);
    expect(selected).not.toHaveBeenCalled();
    await act(async () => item("First enabled").click());
    await closed();
    expect(selected).toHaveBeenCalledOnce();
    expect(changes.mock.calls).toEqual([[true], [false]]);
    await vi.waitFor(() => expect(document.activeElement).toBe(current));
  });
  it.each(["pointer", "keyboard"] as const)(
    "composes asChild %s external handlers once and respects defaultPrevented",
    async (kind) => {
      const wrapperDown = vi.fn(),
        wrapperKey = vi.fn((event: React.KeyboardEvent<HTMLButtonElement>) => event.preventDefault()),
        childDown = vi.fn((event: React.PointerEvent<HTMLButtonElement>) => event.preventDefault()),
        childClick = vi.fn();
      await render({
        asChild: true,
        onPointerDown: wrapperDown,
        onKeyDown: wrapperKey,
        childDown: kind === "pointer" ? childDown : undefined,
        childClick,
        onClick: vi.fn(),
      });
      const native = trigger();
      native.focus();
      if (kind === "pointer") {
        await act(async () => {
          pointer(native, "pointerdown");
          pointer(native, "pointerup");
          native.click();
        });
        expect(childDown).toHaveBeenCalledOnce();
        expect(wrapperDown).toHaveBeenCalledOnce();
        expect(childClick).toHaveBeenCalledOnce();
      } else {
        const event = await key(native, "Enter");
        expect(event.defaultPrevented).toBe(true);
        expect(wrapperKey).toHaveBeenCalledOnce();
      }
      expect(trigger()).toBe(native);
      expect(load.started).not.toHaveBeenCalled();
      expect(menu()).toBeNull();
    },
  );
  it.each(["cold", "ready"] as const)(
    "preserves child/wrapper click order and once counts for a %s public asChild trigger",
    async (readiness) => {
      const changes = vi.fn(),
        order: string[] = [];
      await render({ asChild: true, onOpenChange: changes });
      if (readiness === "ready") {
        await clickSequence(trigger());
        await ready();
        await key(menu()!, "Escape");
        await closed();
        changes.mockClear();
      }
      const childClick = vi.fn(() => {
          order.push("child");
        }),
        wrapperClick = vi.fn(() => {
          order.push("wrapper");
        });
      await render({ asChild: true, onOpenChange: changes, childClick, onClick: wrapperClick });
      await clickSequence(trigger());
      await ready();
      expect(order).toEqual(["child", "wrapper"]);
      expect(childClick).toHaveBeenCalledOnce();
      expect(wrapperClick).toHaveBeenCalledOnce();
      expect(changes.mock.calls).toEqual([[true]]);
    },
  );
  it("keeps prevented READY keyboard opening under the real public SDK, with one external callback", async () => {
    await render({ asChild: true });
    await clickSequence(trigger());
    await ready();
    await key(menu()!, "Escape");
    await closed();
    const prevented = vi.fn((event: React.KeyboardEvent<HTMLButtonElement>) => event.preventDefault()),
      changes = vi.fn();
    await render({ asChild: true, onOpenChange: changes, onKeyDown: prevented });
    const current = trigger();
    current.focus();
    const event = await key(current, "Enter");
    expect(event.defaultPrevented).toBe(true);
    expect(prevented).toHaveBeenCalledOnce();
    expect(menu()).toBeNull();
    expect(changes).not.toHaveBeenCalled();
    expect(trigger()).toBe(current);
  });
  it.each(["Enter", " ", "ArrowDown"])(
    "gives the first enabled real SDK item focus on cold %s, then restores the current logical trigger on Escape",
    async (openingKey) => {
      const changes = vi.fn();
      await render({ onOpenChange: changes });
      trigger().focus();
      const event = await key(trigger(), openingKey);
      expect(event.defaultPrevented).toBe(true);
      await ready();
      await vi.waitFor(() => expect(document.activeElement).toBe(item("First enabled")));
      const current = trigger();
      await key(document.activeElement as HTMLElement, "Escape");
      await closed();
      await vi.waitFor(() => expect(document.activeElement).toBe(current));
      expect(changes.mock.calls).toEqual([[true], [false]]);
    },
  );
  it("keeps ArrowUp and prevented/disabled opening keys unchanged", async () => {
    await render();
    trigger().focus();
    const event = await key(trigger(), "ArrowUp");
    expect(event.defaultPrevented).toBe(false);
    expect(load.started).not.toHaveBeenCalled();
    await render({ disabled: true });
    await key(trigger(), "Enter");
    await act(async () => {
      pointer(trigger(), "pointerdown");
    });
    expect(load.started).not.toHaveBeenCalled();
    expect(menu()).toBeNull();
  });
  it("keeps READY controlled close refusal under the public SDK owner, including subsequent item selection", async () => {
    const changes = vi.fn(),
      selected = vi.fn();
    await render({ open: true, onOpenChange: changes, onSelect: selected });
    await ready();
    item("First enabled").focus();
    const currentMenu = menu();
    await key(item("First enabled"), "Escape");
    expect(changes.mock.calls).toEqual([[false]]);
    expect(menu()).toBe(currentMenu);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    await act(async () => item("First enabled").click());
    expect(selected).toHaveBeenCalledOnce();
    expect(changes.mock.calls).toEqual([[false], [false]]);
    expect(menu()).toBe(currentMenu);
  });
  it("restores focus when a READY controlled parent accepts the SDK close request", async () => {
    const changes = vi.fn();
    await render({ open: true, onOpenChange: changes });
    await ready();
    const current = trigger();
    item("First enabled").focus();
    await key(item("First enabled"), "Escape");
    expect(menu()).not.toBeNull();
    expect(changes.mock.calls).toEqual([[false]]);
    await render({ open: false, onOpenChange: changes });
    await closed();
    await vi.waitFor(() => expect(document.activeElement).toBe(current));
    expect(changes.mock.calls).toEqual([[false]]);
  });

  it("honors refused PENDING controlled Escape and preserves code until the parent actually commits false", async () => {
    const held = gate();
    load.started.mockImplementationOnce(() => held.promise);
    const changes = vi.fn();
    await render({ open: true, onOpenChange: changes });
    trigger().focus();
    await key(trigger(), "Escape");
    expect(changes.mock.calls).toEqual([[false]]);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    await act(async () => held.resolve());
    await ready();
    expect(load.started).toHaveBeenCalledOnce();
    const current = trigger();
    await key(menu()!, "Escape");
    expect(menu()).not.toBeNull();
    expect(changes.mock.calls).toEqual([[false], [false]]);
    await render({ open: false, onOpenChange: changes });
    await closed();
    await vi.waitFor(() => expect(document.activeElement).toBe(current));
  });
  it("rejects pending code after an accepted controlled close and accepts only a fresh opening", async () => {
    const held = gate();
    load.started.mockImplementationOnce(() => held.promise);
    const changes = vi.fn();
    await render({ open: true, onOpenChange: changes });
    trigger().focus();
    await key(trigger(), "Escape");
    await render({ open: false, onOpenChange: changes });
    const outsideButton = outside();
    outsideButton.focus();
    await act(async () => held.resolve());
    await vi.waitFor(() => expect(load.completed).toHaveBeenCalledOnce());
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(outsideButton);
    trigger().focus();
    await render({ open: true, onOpenChange: changes });
    await ready();
    expect(load.started).toHaveBeenCalledOnce();
  });
  it("revokes actual pending Tab focus departure despite controlled close refusal and never opens late from unchanged true", async () => {
    const held = gate();
    load.started.mockImplementationOnce(() => held.promise);
    const changes = vi.fn();
    await render({ open: true, onOpenChange: changes });
    trigger().focus();
    const event = await key(trigger(), "Tab");
    expect(event.defaultPrevented).toBe(false);
    expect(changes).not.toHaveBeenCalled();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    await act(async () => outside().focus());
    expect(changes.mock.calls).toEqual([[false]]);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    await act(async () => held.resolve());
    await vi.waitFor(() => expect(load.completed).toHaveBeenCalledOnce());
    await render({ open: true, onOpenChange: changes });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(outside());
    await render({ open: false, onOpenChange: changes });
    trigger().focus();
    await render({ open: true, onOpenChange: changes });
    await ready();
  });
  it("retains failed controlled intent when explicit Cancel is refused instead of promising another load", async () => {
    load.started.mockRejectedValue(new Error("fixture code unavailable"));
    const changes = vi.fn();
    await render({ open: true, onOpenChange: changes });
    trigger().focus();
    await vi.waitFor(() => expect(host.textContent).toContain("Menu controls could not load"));
    const cancel = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === "Cancel menu",
    )!;
    cancel.focus();
    await act(async () => cancel.click());
    expect(changes.mock.calls).toEqual([[false]]);
    expect(host.textContent).toContain("Menu controls could not load");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(load.started).toHaveBeenCalledOnce();
    await render({ open: false, onOpenChange: changes });
    expect(host.textContent).not.toContain("Menu controls could not load");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });
  it("does not turn controlled open refusal into an uncontrolled popup", async () => {
    const changes = vi.fn();
    await render({ open: false, onOpenChange: changes });
    await clickSequence(trigger());
    await vi.waitFor(() => expect(load.completed).toHaveBeenCalledOnce());
    expect(changes.mock.calls).toEqual([[true]]);
    expect(menu()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });
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
  it("rejects a stale READY item before the caller subscription can commit the next render", async () => {
    const selected = vi.fn();
    await render({ onSelect: selected });
    trigger().focus();
    await key(trigger(), "Enter");
    await ready();
    const retained = item("First enabled");
    custody.caller += 2;
    await act(async () => retained.click());
    expect(selected).not.toHaveBeenCalled();
    await act(async () => custody.callers.forEach((notify) => notify()));
    await closed();
  });

  it("keeps a real reload review portaled without dismissing failed menu intent, then Cancel/Escape make no changes", async () => {
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
    load.started.mockRejectedValue(new TypeError("Failed to fetch dynamically imported module: private-fixture"));
    const selected = vi.fn(),
      changes = vi.fn();
    await render({ onSelect: selected, onOpenChange: changes });
    const native = trigger();
    native.focus();
    await key(native, "Enter");
    await vi.waitFor(() => expect(host.textContent).toContain("Menu controls could not load"));
    const answer = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Unsent answer"]')!;
    answer.value = "Held answer";
    const recovery = () => document.querySelector<HTMLElement>('[role="dialog"]');
    const reloadButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === "Reload app",
    )!;
    expect(host.textContent).not.toContain("Retry menu");
    expect(host.textContent).not.toContain("private-fixture");
    const assertRetained = () => {
      expect(trigger()).toBe(native);
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(host.textContent).toContain("Menu controls could not load");
      expect(host.querySelector('textarea[aria-label="Unsent answer"]')).toBe(answer);
      expect(answer.value).toBe("Held answer");
      expect(selected).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
      expect(changes.mock.calls).toEqual([[true]]);
      expect(load.started).toHaveBeenCalledOnce();
    };
    reloadButton.focus();
    await act(async () => reloadButton.click());
    await vi.waitFor(() =>
      expect(recovery()?.textContent).toContain("Unsent question answers and unsaved edits may be lost"),
    );
    const cancel = () =>
      [...recovery()!.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === "Cancel")!;
    expect(document.activeElement).toBe(cancel());
    assertRetained();
    await act(async () => {
      pointer(cancel(), "pointerdown");
      pointer(cancel(), "pointerup");
      cancel().click();
    });
    await vi.waitFor(() => expect(recovery()).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(reloadButton));
    assertRetained();
    await act(async () => reloadButton.click());
    await vi.waitFor(() => expect(recovery()).not.toBeNull());
    await key(cancel(), "Escape");
    await vi.waitFor(() => expect(recovery()).toBeNull());
    assertRetained();
    const cancelMenu = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === "Cancel menu",
    )!;
    cancelMenu.focus();
    await act(async () => cancelMenu.click());
    expect(host.textContent).not.toContain("Menu controls could not load");
    expect(menu()).toBeNull();
    expect(changes.mock.calls).toEqual([[true], [false]]);
    expect(document.activeElement).toBe(native);
    expect(reload).not.toHaveBeenCalled();
  });
  it("creates a fresh initial-open ticket through the actual StrictMode effect replay", async () => {
    const changes = vi.fn();
    await render({ strict: true, defaultOpen: true, onOpenChange: changes });
    await ready();
    expect(changes).not.toHaveBeenCalled();
    await key(menu()!, "Escape");
    await closed();
    expect(changes.mock.calls).toEqual([[false]]);
  });
  it("drops an unmounted opening before the held public SDK can resolve", async () => {
    const held = gate();
    load.started.mockImplementationOnce(() => held.promise);
    await render();
    trigger().focus();
    await key(trigger(), "Enter");
    const original = trigger();
    await act(async () =>
      root.render(
        <button type="button" id="replacement">
          Replacement
        </button>,
      ),
    );
    const replacement = host.querySelector<HTMLButtonElement>("#replacement")!;
    replacement.focus();
    await act(async () => held.resolve());
    await vi.waitFor(() => expect(load.completed).toHaveBeenCalledOnce());
    expect(menu()).toBeNull();
    expect(original.isConnected).toBe(false);
    expect(document.activeElement).toBe(replacement);
  });
  it("consumes current reload consent once and never calls a menu action or writes draft storage", async () => {
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined),
      selected = vi.fn();
    load.started.mockRejectedValue(new Error("fixture chunk unavailable"));
    await render({ onSelect: selected });
    trigger().focus();
    await key(trigger(), "Enter");
    await vi.waitFor(() => expect(host.textContent).toContain("Menu controls could not load"));
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === "Reload app",
    )!;
    button.focus();
    await act(async () => button.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === "Reload app",
    )!;
    const localWrite = vi.spyOn(window.localStorage, "setItem"),
      sessionWrite = vi.spyOn(window.sessionStorage, "setItem");
    const href = window.location.href,
      historyState = window.history.state;
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    expect(reload).toHaveBeenCalledOnce();
    expect(selected).not.toHaveBeenCalled();
    expect(localWrite).not.toHaveBeenCalled();
    expect(sessionWrite).not.toHaveBeenCalled();
    expect(window.location.href).toBe(href);
    expect(window.history.state).toEqual(historyState);
  });
  it.each(["caller", "access", "gateway", "history-aba", "url"] as const)(
    "refuses connected reload consent after uncommitted %s departure",
    async (reason) => {
      const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined),
        selected = vi.fn();
      load.started.mockRejectedValue(new Error("fixture chunk unavailable"));
      await render({ onSelect: selected });
      trigger().focus();
      await key(trigger(), "Enter");
      await vi.waitFor(() => expect(host.textContent).toContain("Menu controls could not load"));
      const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        (node) => node.textContent === "Reload app",
      )!;
      button.focus();
      await act(async () => button.click());
      const confirm = [
        ...document.querySelector<HTMLElement>('[role="dialog"]')!.querySelectorAll<HTMLButtonElement>("button"),
      ].find((node) => node.textContent === "Reload app")!;
      if (reason === "caller") custody.caller += 2;
      if (reason === "access") custody.access++;
      if (reason === "gateway") custody.gateway = "http://gateway-b";
      if (reason === "history-aba") custody.history += 2;
      if (reason === "url") window.history.replaceState(window.history.state, "", "/chat?sessionId=session-b");
      expect(confirm.isConnected).toBe(true);
      await act(async () => confirm.click());
      expect(reload).not.toHaveBeenCalled();
      expect(selected).not.toHaveBeenCalled();
    },
  );
  it("revokes recovery portal ownership on session ABA without stealing new focus", async () => {
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
    load.started.mockRejectedValue(new Error("fixture chunk unavailable"));
    await render();
    trigger().focus();
    await key(trigger(), "Enter");
    await vi.waitFor(() => expect(host.textContent).toContain("Menu controls could not load"));
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === "Reload app",
    )!;
    button.focus();
    await act(async () => button.click());
    const oldConfirm = [
      ...document.querySelector<HTMLElement>('[role="dialog"]')!.querySelectorAll<HTMLButtonElement>("button"),
    ].find((node) => node.textContent === "Reload app")!;
    await render({ scope: "session-b" });
    await render({ scope: "session-a" });
    outside().focus();
    await act(async () => oldConfirm.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(outside());
    expect(reload).not.toHaveBeenCalled();
  });

  it("honors the public Content focus callback and its preventDefault on cold keyboard entry", async () => {
    const focused = vi.fn<NonNullable<Options["onContentFocus"]>>((event) => event.preventDefault()),
      selected = vi.fn();
    await render({ onContentFocus: focused, onSelect: selected });
    trigger().focus();
    await key(trigger(), "Enter");
    await ready();
    await vi.waitFor(() => expect(document.activeElement).toBe(menu()));
    expect(focused).toHaveBeenCalledOnce();
    expect(selected).not.toHaveBeenCalled();
    await key(menu()!, "Escape");
    await closed();
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  it("tries the next enabled keyboard focus target when the first hidden item rejects focus", async () => {
    const selected = vi.fn();
    await render({
      hiddenFirst: true,
      onSelect: selected,
      onContentFocus: (event) => {
        if (event.target === event.currentTarget) {
          const hidden = item("Hidden first");
          vi.spyOn(hidden, "focus").mockImplementation(() => undefined);
        }
      },
    });
    trigger().focus();
    await key(trigger(), "Enter");
    await ready();
    await vi.waitFor(() => expect(document.activeElement).toBe(item("First enabled")));
    expect(selected).not.toHaveBeenCalled();
    await key(item("First enabled"), "Escape");
    await closed();
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger()));
  });
});
