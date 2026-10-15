// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PaletteSearchGroup } from "./command-palette-search";
import type { ChatSessionCreation } from "@goatcitadel/mission-control-shared/state/chat-session-creation";
let CommandPalette: typeof import("./CommandPalette").CommandPalette;
let registry: typeof import("@goatcitadel/mission-control-shared/state/chat-session-creation");
const loader = vi.hoisted(() => ({ load: vi.fn<() => Promise<void>>() }));
const identity = vi.hoisted(() => ({
  gateway: "http://gateway-a",
  caller: 1,
  access: 1,
  workspace: "workspace-a",
  citadel: "personal",
  history: 1,
}));
const controls = vi.hoisted(() => ({
  create: vi.fn(),
  navigate: vi.fn(),
  inspect: vi.fn(),
  search: vi.fn(),
  owner: vi.fn(),
  attempt: undefined as
    | undefined
    | { state: "unknown" | "confirmed"; message: string; mode: "chat"; sessionId?: string },
  groups: [] as PaletteSearchGroup[],
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => identity.gateway,
  API_BASE: "http://gateway-a",
  request: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/access-scope", () => ({
  getGatewayCallerScopeRevision: () => identity.caller,
  getGatewayCallerScope: () => "fixture-caller",
  getGatewayAccessRevision: () => identity.access,
  subscribeGatewayCallerScope: () => () => {},
  subscribeGatewayAccessChange: () => () => {},
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({
    theme: "dark",
    density: "comfortable",
    activeWorkspaceId: identity.workspace,
    activeCitadelId: identity.citadel,
    setTheme: vi.fn(),
    setDensity: vi.fn(),
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      activeProviderId: "local",
      activeModel: "recorded-model",
      items: [{ workspaceId: identity.workspace, name: "Research" }],
    },
    isPending: false,
    isFetching: false,
    isError: false,
    dataUpdatedAt: Date.now(),
  }),
}));
vi.mock("./use-cockpit-route", () => ({
  useCockpitRoute: () => ({
    navigate: controls.navigate,
    requestTransition: (
      action: (review: { isCurrent: () => boolean; navigate: typeof controls.navigate; signal: AbortSignal }) => void,
    ) => action({ isCurrent: () => true, navigate: controls.navigate, signal: new AbortController().signal }),
  }),
}));
vi.mock("./use-cockpit-shell-switch", () => ({ useCockpitShellSwitch: () => ({ request: vi.fn(), feedback: null }) }));
vi.mock("./inspector", () => ({ useInspector: () => ({ open: controls.inspect }) }));
vi.mock("./use-command-palette-search", () => ({
  useCommandPaletteSearch: (...args: unknown[]) => {
    controls.search(...args);
    return { groups: controls.groups, loading: false, error: undefined };
  },
}));
vi.mock("./use-command-new-chat", () => ({
  useCommandNewChat: (...args: unknown[]) => {
    controls.owner(...args);
    return { create: controls.create, blocked: controls.attempt?.state === "unknown", attempt: controls.attempt };
  },
}));
vi.mock("./cockpit-history", async (original) => ({
  ...(await original<typeof import("./cockpit-history")>()),
  readCockpitHistory: () => identity.history + ":" + window.location.href,
  subscribeCockpitHistory: () => () => {},
}));
vi.mock("../areas/library/LibraryResourceDetail", () => ({
  LibraryResourceDetail: () => <p>Original resource owner</p>,
}));
let root: Root, host: HTMLDivElement;
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const input = () =>
  document.querySelector<HTMLInputElement>('[aria-label="Search or run a command"],input[cmdk-input]')!;
const sdk = () => document.querySelector<HTMLInputElement>("input[cmdk-input]");
const named = (label: string, parent: ParentNode = document) =>
  [...parent.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => (node.getAttribute("aria-label") ?? node.textContent) === label,
  )!;
const review = () =>
  [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
    (node) => document.getElementById(node.getAttribute("aria-labelledby") ?? "")?.textContent === "Reload app?",
  );
function render(open = true, close = vi.fn()) {
  root.render(
    <>
      <textarea id="outside-answer" defaultValue="Retained answer" />
      <CommandPalette open={open} onOpenChange={close} />
    </>,
  );
}
async function ready(held: ReturnType<typeof deferred>) {
  await act(async () => held.resolve());
  await vi.waitFor(() => expect(sdk()).not.toBeNull());
}
function type(node: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(node, value);
  node.dispatchEvent(new Event("input", { bubbles: true }));
}
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  controls.attempt = undefined;
  controls.groups = [];
  Object.assign(identity, {
    gateway: "http://gateway-a",
    caller: 1,
    access: 1,
    workspace: "workspace-a",
    citadel: "personal",
    history: 1,
  });
  window.history.replaceState({ retained: true }, "", "/chat?sessionId=session-a&shell=cockpit#current");
  vi.doMock("./CommandPaletteView", async (original) => {
    await loader.load();
    return original<typeof import("./CommandPaletteView")>();
  });
  registry = await import("@goatcitadel/mission-control-shared/state/chat-session-creation");
  registry.resetChatSessionCreationForTests();
  ({ CommandPalette } = await import("./CommandPalette"));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  registry.resetChatSessionCreationForTests();
  vi.restoreAllMocks();
});
it("does not load view code while closed and keeps the original New Chat/search owners mounted", async () => {
  await act(async () => render(false));
  expect(loader.load).not.toHaveBeenCalled();
  expect(controls.owner.mock.calls.some((call) => call[1] === false)).toBe(true);
  expect(controls.search.mock.calls.some((call) => call[0] === false)).toBe(true);
});
it("keeps typed query, selection and only owned input focus through real CMDK handoff", async () => {
  const held = deferred();
  loader.load.mockImplementationOnce(() => held.promise);
  await act(async () => render());
  await vi.waitFor(() => expect(loader.load).toHaveBeenCalledOnce());
  const old = input();
  await act(async () => type(old, "needle text"));
  old.focus();
  old.setSelectionRange(2, 7, "backward");
  expect(controls.search.mock.calls.at(-1)?.[2]).toBe("needle text");
  await ready(held);
  expect(old.isConnected).toBe(false);
  expect(sdk()?.value).toBe("needle text");
  expect(document.activeElement).toBe(sdk());
  expect(sdk()?.selectionStart).toBe(2);
  expect(sdk()?.selectionEnd).toBe(7);
  expect(sdk()?.selectionDirection).toBe("backward");
  expect(controls.create).not.toHaveBeenCalled();
});
it("keeps the actual pending input through composition even when its real module is ready", async () => {
  const held = deferred();
  loader.load.mockImplementationOnce(() => held.promise);
  await act(async () => render());
  await vi.waitFor(() => expect(loader.load).toHaveBeenCalledOnce());
  const old = input();
  old.focus();
  await act(async () => old.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "typed" })));
  await act(async () => type(old, "composed query"));
  await act(async () => held.resolve());
  expect(input()).toBe(old);
  expect(old.isConnected).toBe(true);
  expect(sdk()).toBeNull();
  await act(async () =>
    old.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "composed query" })),
  );
  await vi.waitFor(() => expect(sdk()).not.toBeNull());
  expect(sdk()?.value).toBe("composed query");
  expect(document.activeElement).toBe(sdk());
  expect(controls.create).not.toHaveBeenCalled();
});
it("keeps pending input across the pointerup microtask checkpoint, then releases outside without click after mouseup selection", async () => {
  const held = deferred();
  loader.load.mockImplementationOnce(() => held.promise);
  await act(async () => render());
  await vi.waitFor(() => expect(loader.load).toHaveBeenCalledOnce());
  const old = input();
  await act(async () => type(old, "selected query"));
  old.focus();
  await act(async () => old.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true })));
  await act(async () => held.resolve());
  expect(input()).toBe(old);
  const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
  vi.useFakeTimers();
  try {
    await act(async () => panel.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true })));
    await Promise.resolve();
    expect(old.isConnected).toBe(true);
    expect(sdk()).toBeNull();
    old.setSelectionRange(3, 10, "forward");
    await act(async () => panel.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true })));
    expect(old.isConnected).toBe(true);
    await act(async () => vi.advanceTimersByTime(0));
  } finally {
    vi.useRealTimers();
  }
  await vi.waitFor(() => expect(sdk()).not.toBeNull());
  expect(sdk()?.value).toBe("selected query");
  expect(sdk()?.selectionStart).toBe(3);
  expect(sdk()?.selectionEnd).toBe(10);
  expect(controls.create).not.toHaveBeenCalled();
  expect(controls.navigate).not.toHaveBeenCalled();
});
it.each(["Enter", " "])("does not treat an outside %s key as a missing created-conversation control", async (key) => {
  const held = deferred();
  loader.load.mockImplementationOnce(() => held.promise);
  await act(async () => render());
  await vi.waitFor(() => expect(loader.load).toHaveBeenCalledOnce());
  expect(named("Open created conversation")).toBeUndefined();
  await act(async () =>
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })),
  );
  await ready(held);
  expect(controls.create).not.toHaveBeenCalled();
  expect(controls.navigate).not.toHaveBeenCalled();
});
it("does not steal focus from the unchanged parent Close control when code completes", async () => {
  const held = deferred();
  loader.load.mockImplementationOnce(() => held.promise);
  await act(async () => render());
  await vi.waitFor(() => expect(loader.load).toHaveBeenCalledOnce());
  const close = named("Close dialog");
  close.focus();
  await ready(held);
  expect(named("Close dialog")).toBe(close);
  expect(document.activeElement).toBe(close);
});
it("keeps one current created-conversation click through load between down and up and controlled refusal", async () => {
  const held = deferred(),
    close = vi.fn();
  controls.attempt = {
    state: "confirmed",
    message: "Conversation created. Opening it failed; use Open created conversation.",
    mode: "chat",
    sessionId: "created-session",
  };
  loader.load.mockImplementationOnce(() => held.promise);
  await act(async () => render(false, close));
  await act(async () => render(true, close));
  await vi.waitFor(() => expect(loader.load).toHaveBeenCalledOnce());
  const button = named("Open created conversation");
  button.focus();
  await act(async () => button.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true })));
  await act(async () => held.resolve());
  expect(button.isConnected).toBe(true);
  expect(sdk()).toBeNull();
  await act(async () => button.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true })));
  expect(button.isConnected).toBe(true);
  await act(async () => button.click());
  await vi.waitFor(() => expect(sdk()).not.toBeNull());
  expect(close).toHaveBeenCalledExactlyOnceWith(false);
  expect(controls.navigate).toHaveBeenCalledExactlyOnceWith("/chat?shell=cockpit&sessionId=created-session");
  expect(controls.create).not.toHaveBeenCalled();
});
it.each(["caller-aba", "access", "gateway", "workspace"])(
  "publishes only current fields/actions after %s while code is held",
  async (departure) => {
    const held = deferred(),
      close = vi.fn();
    loader.load.mockImplementationOnce(() => held.promise);
    await act(async () => render(true, close));
    await vi.waitFor(() => expect(loader.load).toHaveBeenCalledOnce());
    if (departure === "caller-aba") identity.caller += 2;
    if (departure === "access") identity.access++;
    if (departure === "gateway") identity.gateway = "http://gateway-b";
    if (departure === "workspace") identity.workspace = "workspace-b";
    const current = vi.fn();
    controls.create = current;
    await act(async () => render(true, close));
    if (departure === "access") {
      expect(close).toHaveBeenCalledExactlyOnceWith(false);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      await act(async () => render(false, close));
      await act(async () => render(true, close));
    }
    await ready(held);
    const item = [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find((node) =>
      node.textContent?.startsWith("New chat"),
    )!;
    await act(async () => item.click());
    expect(current).toHaveBeenCalledOnce();
  },
);
it("does not reopen a closed palette after late code and retains its original unknown creation on reopening", async () => {
  const held = deferred();
  controls.attempt = { state: "unknown", message: "Creation outcome is unconfirmed.", mode: "chat" };
  loader.load.mockImplementationOnce(() => held.promise);
  await act(async () => render());
  await vi.waitFor(() => expect(loader.load).toHaveBeenCalledOnce());
  expect(document.body.textContent).toContain("Creation outcome is unconfirmed");
  await act(async () => render(false));
  await act(async () => held.resolve());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => render());
  await vi.waitFor(() => expect(sdk()).not.toBeNull());
  expect(document.body.textContent).toContain("Creation outcome is unconfirmed");
  expect(controls.create).not.toHaveBeenCalled();
});
async function fail() {
  loader.load.mockRejectedValueOnce(new TypeError("private failed palette asset"));
  await act(async () => render());
  await vi.waitFor(() => expect(document.body.textContent).toContain("Command controls could not load"));
  expect(document.body.textContent).not.toContain("private failed palette asset");
  expect(named("Try again")).toBeUndefined();
}
async function openReload() {
  const trigger = named("Reload app");
  trigger.focus();
  await act(async () => trigger.click());
  await vi.waitFor(() => expect(review()).toBeDefined());
  return trigger;
}
it("keeps the same outside answer and requires warned Reload; Cancel/Escape retain current controls with no Retry", async () => {
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
  await fail();
  const answer = host.querySelector<HTMLTextAreaElement>("#outside-answer")!,
    field = input();
  await act(async () => type(field, "retained query"));
  const trigger = await openReload();
  expect(document.activeElement).toBe(named("Cancel", review()!));
  await act(async () => named("Cancel", review()!).click());
  await vi.waitFor(() => expect(review()).toBeUndefined());
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  await openReload();
  await act(async () =>
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  await vi.waitFor(() => expect(review()).toBeUndefined());
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(input()).toBe(field);
  expect(field.value).toBe("retained query");
  expect(host.querySelector("#outside-answer")).toBe(answer);
  expect(answer.value).toBe("Retained answer");
  expect(reload).not.toHaveBeenCalled();
  expect(loader.load).toHaveBeenCalledOnce();
});
it.each(["checking", "pending", "unknown"] as const)(
  "blocks code-failure Reload while the existing live creation owner is %s and permits recovered state",
  async (state) => {
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
    const key = registry.chatSessionCreationKey(identity.gateway, identity.workspace),
      attempt: ChatSessionCreation = { state, message: "Creation is unconfirmed.", mode: "chat" };
    expect(registry.beginChatSessionCreation(key, attempt)).toBe(true);
    controls.attempt = { state: "unknown", message: attempt.message, mode: "chat" };
    await fail();
    expect(named("Reload app").disabled).toBe(true);
    expect(document.body.textContent).toContain(attempt.message);
    await act(async () => named("Reload app").click());
    expect(review()).toBeUndefined();
    expect(reload).not.toHaveBeenCalled();
    expect(controls.create).not.toHaveBeenCalled();
    attempt.state = "confirmed";
    registry.publishChatSessionCreation(key, attempt);
    controls.attempt = {
      state: "confirmed",
      message: "Conversation created and verified.",
      mode: "chat",
      sessionId: "created",
    };
    await act(async () => render());
    expect(named("Reload app").disabled).toBe(false);
    await openReload();
    const confirm = named("Reload app", review()!);
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    expect(reload).toHaveBeenCalledOnce();
    expect(controls.create).not.toHaveBeenCalled();
  },
);
it("refuses still-connected Reload consent when a live unknown creation appears before any React rerender", async () => {
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
  await fail();
  await openReload();
  const confirm = named("Reload app", review()!);
  const key = registry.chatSessionCreationKey(identity.gateway, identity.workspace);
  expect(registry.beginChatSessionCreation(key, { state: "unknown", message: "Unknown create", mode: "chat" })).toBe(
    true,
  );
  expect(confirm.isConnected).toBe(true);
  await act(async () => confirm.click());
  expect(reload).not.toHaveBeenCalled();
  expect(registry.chatSessionCreationBlocked(registry.readChatSessionCreation(key))).toBe(true);
  expect(controls.create).not.toHaveBeenCalled();
});
it.each(["caller-aba", "access", "gateway", "url", "history-aba"])(
  "refuses stale still-connected Reload after %s",
  async (departure) => {
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
    await fail();
    await openReload();
    const confirm = named("Reload app", review()!);
    if (departure === "caller-aba") identity.caller += 2;
    if (departure === "access") identity.access++;
    if (departure === "gateway") identity.gateway = "http://gateway-b";
    if (departure === "url") window.history.replaceState(window.history.state, "", "/chat?sessionId=session-b");
    if (departure === "history-aba") identity.history += 2;
    expect(confirm.isConnected).toBe(true);
    await act(async () => confirm.click());
    expect(reload).not.toHaveBeenCalled();
  },
);
