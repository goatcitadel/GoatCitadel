// @vitest-environment happy-dom
import {
  act,
  cloneElement,
  createContext,
  StrictMode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
let Sheet: typeof import("./Sheet").Sheet;
const loader = vi.hoisted(() => ({ load: vi.fn<() => Promise<void>>(), roots: vi.fn(), unmounts: vi.fn() }));
const identity = vi.hoisted(() => ({
  gateway: "http://gateway-a",
  caller: 1,
  access: 1,
  workspace: "workspace-a",
  citadel: "personal",
}));
const navigation = vi.hoisted(() => ({ revision: 1 }));
const history = vi.hoisted(() => ({ register: vi.fn(), cleanup: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => identity.gateway,
}));
vi.mock("@goatcitadel/mission-control-shared/api/access-scope", () => ({
  getGatewayCallerScopeRevision: () => identity.caller,
  getGatewayCallerScope: () => "fixture-caller",
  getGatewayAccessRevision: () => identity.access,
  subscribeGatewayCallerScope: () => () => {},
  subscribeGatewayAccessChange: () => () => {},
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: identity.workspace, activeCitadelId: identity.citadel }),
}));
vi.mock("@goatcitadel/mission-control-shared/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("../app/cockpit-history", async (original) => ({
  ...(await original<typeof import("../app/cockpit-history")>()),
  readCockpitHistory: () => navigation.revision + ":" + window.location.href,
  subscribeCockpitHistory: () => () => {},
}));
vi.mock("../app/cockpit-back-guard", () => ({
  registerCockpitSheetBack: (close: () => void) => {
    history.register(close);
    return history.cleanup;
  },
}));
let root: Root, host: HTMLDivElement;
const sdk = createContext<{ open: boolean; onOpenChange: (open: boolean) => void }>({
  open: false,
  onOpenChange: () => {},
});
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function named(label: string, parent: ParentNode = document) {
  return [...parent.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => (node.getAttribute("aria-label") ?? node.textContent) === label,
  )!;
}
const drawer = () => document.querySelector<HTMLElement>("[data-vaul-drawer]");
const review = () =>
  [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
    (node) => document.getElementById(node.getAttribute("aria-labelledby") ?? "")?.textContent === "Reload app?",
  );
function render(
  open = true,
  close = vi.fn(),
  children: ReactNode = <input aria-label="Original child" defaultValue="Unsent child" />,
  strict = false,
) {
  const sheet = (
    <Sheet open={open} onOpenChange={close} title="More">
      {children}
    </Sheet>
  );
  root.render(
    <>
      <textarea id="outside-draft" defaultValue="Retained answer" />
      {strict ? <StrictMode>{sheet}</StrictMode> : sheet}
    </>,
  );
}
async function ready(held: ReturnType<typeof deferred>) {
  await act(async () => held.resolve());
  await vi.waitFor(() => expect(drawer()).not.toBeNull());
}
beforeEach(async () => {
  vi.resetModules();
  loader.load.mockReset();
  loader.roots.mockReset();
  loader.unmounts.mockReset();
  history.register.mockReset();
  history.cleanup.mockReset();
  navigation.revision = 1;
  Object.assign(identity, {
    gateway: "http://gateway-a",
    caller: 1,
    access: 1,
    workspace: "workspace-a",
    citadel: "personal",
  });
  window.history.replaceState({ retained: true }, "", "/chat?sessionId=session-a&shell=cockpit#current");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.doMock("vaul", async () => {
    await loader.load();
    return {
      Drawer: {
        Root: ({
          children,
          open,
          onOpenChange,
        }: {
          children: ReactNode;
          open: boolean;
          onOpenChange: (open: boolean) => void;
        }) => {
          useEffect(() => {
            loader.roots();
            return () => {
              loader.unmounts();
            };
          }, []);
          return <sdk.Provider value={{ open, onOpenChange }}>{children}</sdk.Provider>;
        },
        Portal: ({ children }: { children: ReactNode }) => (useContext(sdk).open ? <>{children}</> : null),
        Overlay: () => null,
        Content: ({
          children,
          onOpenAutoFocus,
          onCloseAutoFocus,
        }: {
          children: ReactNode;
          onOpenAutoFocus?: (event: Event) => void;
          onCloseAutoFocus?: (event: Event) => void;
        }) => {
          const ref = useRef<HTMLDivElement>(null);
          const autofocus = useRef({ onOpenAutoFocus, onCloseAutoFocus });
          useLayoutEffect(() => {
            autofocus.current = { onOpenAutoFocus, onCloseAutoFocus };
          }, [onOpenAutoFocus, onCloseAutoFocus]);
          useEffect(() => {
            const node = ref.current!;
            const opened = new Event("openAutoFocus", { cancelable: true });
            node.addEventListener("openAutoFocus", (event) => autofocus.current.onOpenAutoFocus?.(event), {
              once: true,
            });
            node.dispatchEvent(opened);
            opened.preventDefault();
            return () => {
              autofocus.current.onCloseAutoFocus?.(new Event("closeAutoFocus", { cancelable: true }));
            };
          }, []);
          return (
            <div ref={ref} role="dialog" tabIndex={-1} data-state="open" data-vaul-drawer="">
              {children}
            </div>
          );
        },
        Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
        Close: ({ children }: { children: ReactElement<{ onClick?: (event: MouseEvent) => void }> }) => {
          const owner = useContext(sdk);
          return cloneElement(children, {
            onClick: (event) => {
              children.props.onClick?.(event);
              if (!event.defaultPrevented) owner.onOpenChange(false);
            },
          });
        },
      },
    };
  });
  ({ Sheet } = await import("./Sheet"));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
it("keeps closed public children unmounted and performs zero SDK imports or history entries", async () => {
  await act(async () => render(false));
  expect(loader.load).not.toHaveBeenCalled();
  expect(history.register).not.toHaveBeenCalled();
  expect(document.querySelector('[aria-label="Original child"]')).toBeNull();
});
it("captures the original trigger and one Back owner before held code, then mounts current children once", async () => {
  const held = deferred();
  loader.load.mockImplementationOnce(() => held.promise);
  const child = vi.fn();
  function Child() {
    useEffect(() => {
      child();
    }, []);
    return <input aria-label="Original child" defaultValue="Unsent child" />;
  }
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  await act(async () => render(true, vi.fn(), <Child />));
  await vi.waitFor(() => expect(loader.load).toHaveBeenCalledOnce());
  expect(history.register).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain("Loading sheet controls");
  expect(child).not.toHaveBeenCalled();
  await ready(held);
  expect(child).toHaveBeenCalledOnce();
  expect(history.register).toHaveBeenCalledOnce();
  expect(history.cleanup).not.toHaveBeenCalled();
  trigger.remove();
});
it("transfers only the removed owned Close focus through SDK handoff", async () => {
  const held = deferred();
  loader.load.mockImplementationOnce(() => held.promise);
  await act(async () => render());
  await vi.waitFor(() => expect(loader.load).toHaveBeenCalledOnce());
  const close = named("Close sheet");
  close.focus();
  await ready(held);
  expect(close.isConnected).toBe(false);
  expect(document.activeElement).toBe(named("Close sheet"));
});
it("preserves a complete pointer click when code becomes ready between down and up", async () => {
  const held = deferred(),
    close = vi.fn();
  loader.load.mockImplementationOnce(() => held.promise);
  await act(async () => render(true, close));
  await vi.waitFor(() => expect(loader.load).toHaveBeenCalledOnce());
  const button = named("Close sheet");
  await act(async () => button.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true })));
  await act(async () => held.resolve());
  expect(button.isConnected).toBe(true);
  expect(drawer()).toBeNull();
  await act(async () => button.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true })));
  expect(button.isConnected).toBe(true);
  await act(async () => button.click());
  expect(close).toHaveBeenCalledExactlyOnceWith(false);
  await vi.waitFor(() => expect(drawer()).not.toBeNull());
  expect(loader.load).toHaveBeenCalledOnce();
});
it.each([false, true])(
  "keeps the native Close through a capture microtask checkpoint (default prevented: %s)",
  async (prevented) => {
    const held = deferred(),
      close = vi.fn();
    loader.load.mockImplementationOnce(() => held.promise);
    await act(async () => render(true, close));
    await vi.waitFor(() => expect(loader.load).toHaveBeenCalledOnce());
    const button = named("Close sheet");
    await act(async () => button.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true })));
    await act(async () => {
      held.resolve();
      await vi.dynamicImportSettled();
    });
    expect(button.isConnected).toBe(true);
    expect(drawer()).toBeNull();
    // Model the trusted browser checkpoint between document capture and React's
    // delegated bubble listener. Happy DOM's synchronous click does not perform it.
    const queued: VoidFunction[] = [],
      queue = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((task) => queued.push(task));
    const checkpoint = () => {
      flushSync(() => {
        while (queued.length) queued.shift()!();
      });
      expect(button.isConnected).toBe(true);
      expect(drawer()).toBeNull();
    };
    document.addEventListener("click", checkpoint, true);
    if (prevented) button.addEventListener("click", (event) => event.preventDefault(), { once: true });
    try {
      await act(async () => button.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true })));
      expect(button.isConnected).toBe(true);
      await act(async () => button.click());
      expect(close.mock.calls).toEqual(prevented ? [] : [[false]]);
    } finally {
      document.removeEventListener("click", checkpoint, true);
      queue.mockRestore();
      await act(async () => {
        while (queued.length) queued.shift()!();
      });
    }
    // A refused controlled close keeps true; ready SDK code may mount only after
    // the complete click, without replaying its default-prevented/public action.
    await vi.waitFor(() => expect(drawer()).not.toBeNull());
    expect(close.mock.calls).toEqual(prevented ? [] : [[false]]);
    expect(loader.load).toHaveBeenCalledOnce();
  },
);
it("cancels a queued complete-click release on unmount without mounting SDK code or replaying Close", async () => {
  // Radix mount and deferred unmount cleanup must share one timer domain.
  vi.useFakeTimers();
  let restoreTimerSpies: () => void = () => undefined;
  try {
    const held = deferred(),
      close = vi.fn();
    loader.load.mockImplementationOnce(() => held.promise);
    await act(async () => render(true, close));
    await vi.waitFor(() => expect(loader.load).toHaveBeenCalledOnce());
    const button = named("Close sheet");
    await act(async () => button.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true })));
    await act(async () => {
      held.resolve();
      await vi.dynamicImportSettled();
    });
    const schedule = vi.spyOn(globalThis, "setTimeout"),
      clear = vi.spyOn(globalThis, "clearTimeout");
    restoreTimerSpies = () => {
      schedule.mockRestore();
      clear.mockRestore();
    };
    await act(async () => {
      button.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true }));
      button.click();
    });
    expect(close).toHaveBeenCalledExactlyOnceWith(false);
    expect(drawer()).toBeNull();
    const release = schedule.mock.results.at(-1)?.value;
    expect(release).toBeDefined();
    await act(async () => root.unmount());
    expect(clear).toHaveBeenCalledWith(release);
    await act(async () => vi.runOnlyPendingTimersAsync());
    expect(loader.roots).not.toHaveBeenCalled();
    expect(drawer()).toBeNull();
    expect(close).toHaveBeenCalledOnce();
  } finally {
    try {
      await act(async () => root.unmount());
      await act(async () => vi.runOnlyPendingTimersAsync());
    } finally {
      restoreTimerSpies();
      // Drain spy restores before uninstalling the clock; afterEach must not reinstall fake timers.
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  }
});
it.each(["Enter", " "])(
  "preserves a pending native Close %j activation and its single public close request",
  async (key) => {
    const held = deferred(),
      close = vi.fn();
    loader.load.mockImplementationOnce(() => held.promise);
    await act(async () => render(true, close));
    await vi.waitFor(() => expect(loader.load).toHaveBeenCalledOnce());
    const button = named("Close sheet");
    button.focus();
    await act(async () => button.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
    await act(async () => held.resolve());
    expect(button.isConnected).toBe(true);
    // Happy DOM does not synthesize button keyboard default click; a real native click completes it.
    await act(async () => button.click());
    expect(close).toHaveBeenCalledExactlyOnceWith(false);
    await vi.waitFor(() => expect(drawer()).not.toBeNull());
  },
);
it("releases canceled Space activation after actual default prevention without requesting close", async () => {
  const held = deferred(),
    close = vi.fn();
  loader.load.mockImplementationOnce(() => held.promise);
  await act(async () => render(true, close));
  await vi.waitFor(() => expect(loader.load).toHaveBeenCalledOnce());
  const button = named("Close sheet");
  button.focus();
  await act(async () =>
    button.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })),
  );
  await act(async () => held.resolve());
  expect(button.isConnected).toBe(true);
  expect(drawer()).toBeNull();
  const end = new KeyboardEvent("keyup", { key: " ", bubbles: true, cancelable: true });
  document.addEventListener("keyup", (event) => event.preventDefault(), { once: true });
  await act(async () => button.dispatchEvent(end));
  expect(end.defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(drawer()).not.toBeNull());
  expect(close).not.toHaveBeenCalled();
});
it("retains logical panel focus after moving away from Close cancels a pending activation", async () => {
  const held = deferred(),
    close = vi.fn();
  loader.load.mockImplementationOnce(() => held.promise);
  await act(async () => render(true, close));
  await vi.waitFor(() => expect(loader.load).toHaveBeenCalledOnce());
  const button = named("Close sheet");
  button.focus();
  await act(async () =>
    button.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })),
  );
  await act(async () => held.resolve());
  const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
  await act(async () => panel.focus());
  await vi.waitFor(() => expect(drawer()).not.toBeNull());
  expect(panel.isConnected).toBe(false);
  expect(document.activeElement).toBe(drawer());
  expect(close).not.toHaveBeenCalled();
});
it("releases pending pointer activation on window blur without stealing focus or requesting close", async () => {
  const held = deferred(),
    close = vi.fn();
  loader.load.mockImplementationOnce(() => held.promise);
  await act(async () => render(true, close));
  await vi.waitFor(() => expect(loader.load).toHaveBeenCalledOnce());
  const button = named("Close sheet");
  await act(async () => button.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true })));
  await act(async () => held.resolve());
  expect(drawer()).toBeNull();
  await act(async () => window.dispatchEvent(new Event("blur")));
  await vi.waitFor(() => expect(drawer()).not.toBeNull());
  expect(close).not.toHaveBeenCalled();
  expect(document.activeElement).not.toBe(named("Close sheet"));
});
it("retains the warm public Root through controlled close refusal and later accepted close", async () => {
  const held = deferred(),
    close = vi.fn(),
    children = <input aria-label="Original child" defaultValue="Unsent child" />;
  loader.load.mockImplementationOnce(() => held.promise);
  await act(async () => render(true, close, children));
  await ready(held);
  const input = document.querySelector<HTMLInputElement>('[aria-label="Original child"]')!;
  input.value = "Retained child";
  await act(async () => named("Close sheet").click());
  expect(close).toHaveBeenCalledExactlyOnceWith(false);
  expect(drawer()).not.toBeNull();
  expect(document.querySelector('[aria-label="Original child"]')).toBe(input);
  expect(input.value).toBe("Retained child");
  await act(async () => render(false, close, children));
  expect(drawer()).toBeNull();
  expect(loader.unmounts).not.toHaveBeenCalled();
  await act(async () => render(true, close, children));
  expect(drawer()).not.toBeNull();
  expect(loader.load).toHaveBeenCalledOnce();
  expect(loader.roots).toHaveBeenCalledOnce();
});
it.each(["caller-aba", "access", "gateway", "workspace"])(
  "uses only current public callbacks/children after %s while code is held",
  async (departure) => {
    const held = deferred(),
      old = vi.fn(),
      current = vi.fn();
    loader.load.mockImplementationOnce(() => held.promise);
    await act(async () => render(true, old, <p>Old child</p>));
    await vi.waitFor(() => expect(loader.load).toHaveBeenCalledOnce());
    if (departure === "caller-aba") identity.caller += 2;
    if (departure === "access") identity.access++;
    if (departure === "gateway") identity.gateway = "http://gateway-b";
    if (departure === "workspace") identity.workspace = "workspace-b";
    await act(async () => render(true, current, <p>Current child</p>));
    if (departure === "access") {
      expect(current).toHaveBeenCalledExactlyOnceWith(false);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      await act(async () => render(false, current, <p>Current child</p>));
      await act(async () => render(true, current, <p>Current child</p>));
    }
    await ready(held);
    expect(document.body.textContent).not.toContain("Old child");
    expect(document.body.textContent).toContain("Current child");
    await act(async () => named("Close sheet").click());
    expect(old).not.toHaveBeenCalled();
    if (departure === "access") {
      expect(current).toHaveBeenCalledTimes(2);
      expect(current.mock.calls).toEqual([[false], [false]]);
    } else expect(current).toHaveBeenCalledExactlyOnceWith(false);
  },
);
it("does not resurrect a closed sheet or its children when held code completes", async () => {
  const held = deferred();
  loader.load.mockImplementationOnce(() => held.promise);
  await act(async () => render());
  await vi.waitFor(() => expect(loader.load).toHaveBeenCalledOnce());
  await act(async () => render(false));
  await act(async () => held.resolve());
  expect(drawer()).toBeNull();
  expect(document.querySelector('[aria-label="Original child"]')).toBeNull();
});
async function fail() {
  loader.load.mockRejectedValueOnce(new TypeError("private failed asset"));
  await act(async () => render());
  await vi.waitFor(() => expect(document.body.textContent).toContain("Sheet controls could not load"));
  expect(document.body.textContent).not.toContain("private failed asset");
  expect(named("Try again")).toBeUndefined();
}
async function openReload() {
  const trigger = named("Reload app");
  trigger.focus();
  await act(async () => trigger.click());
  await vi.waitFor(() => expect(review()).toBeDefined());
  return trigger;
}
it("truthfully warns before Reload; Cancel and Escape keep the same outside answer without code Retry", async () => {
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
  await fail();
  const draft = host.querySelector<HTMLTextAreaElement>("#outside-draft")!;
  draft.value = "Keep answer";
  const trigger = await openReload();
  expect(document.activeElement).toBe(named("Cancel", review()!));
  expect(review()?.textContent).toContain("Unsent question answers and unsaved edits may be lost");
  await act(async () => named("Cancel", review()!).click());
  await vi.waitFor(() => expect(review()).toBeUndefined());
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  await openReload();
  await act(async () =>
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  await vi.waitFor(() => expect(review()).toBeUndefined());
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(host.querySelector("#outside-draft")).toBe(draft);
  expect(draft.value).toBe("Keep answer");
  expect(reload).not.toHaveBeenCalled();
  expect(loader.load).toHaveBeenCalledOnce();
});
it("consumes current explicit Reload consent once with no answer, storage or history writes", async () => {
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
  await fail();
  await openReload();
  const confirm = named("Reload app", review()!),
    url = window.location.href,
    state = window.history.state;
  const local = vi.spyOn(window.localStorage, "setItem"),
    session = vi.spyOn(window.sessionStorage, "setItem"),
    draft = host.querySelector<HTMLTextAreaElement>("#outside-draft")!;
  await act(async () => {
    confirm.click();
    confirm.click();
  });
  expect(reload).toHaveBeenCalledOnce();
  expect(draft.value).toBe("Retained answer");
  expect(window.location.href).toBe(url);
  expect(window.history.state).toEqual(state);
  expect(local).not.toHaveBeenCalled();
  expect(session).not.toHaveBeenCalled();
});
it.each(["caller-aba", "access", "gateway", "url", "history-aba"])(
  "rejects still-connected stale Reload consent after %s",
  async (departure) => {
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
    await fail();
    await openReload();
    const confirm = named("Reload app", review()!);
    if (departure === "caller-aba") identity.caller += 2;
    if (departure === "access") identity.access++;
    if (departure === "gateway") identity.gateway = "http://gateway-b";
    if (departure === "url")
      window.history.replaceState(window.history.state, "", "/chat?sessionId=session-b&shell=cockpit");
    if (departure === "history-aba") navigation.revision += 2;
    expect(confirm.isConnected).toBe(true);
    await act(async () => confirm.click());
    expect(reload).not.toHaveBeenCalled();
  },
);
it("deduplicates only SDK code across StrictMode replay while preserving the existing paired Back registration", async () => {
  const held = deferred();
  loader.load.mockImplementationOnce(() => held.promise);
  await act(async () => render(true, vi.fn(), <p>Current child</p>, true));
  await vi.waitFor(() => expect(loader.load).toHaveBeenCalledOnce());
  await ready(held);
  expect(loader.load).toHaveBeenCalledOnce();
  expect(history.register.mock.calls.length - history.cleanup.mock.calls.length).toBe(1);
});
