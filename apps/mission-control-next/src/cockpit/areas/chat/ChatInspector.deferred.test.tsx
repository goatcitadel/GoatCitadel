// @vitest-environment happy-dom
import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
let ChatInspector: typeof import("./ChatInspector").ChatInspector;
let InspectorProvider: typeof import("../../app/inspector").InspectorProvider;
let InspectorPanel: typeof import("../../app/inspector").InspectorPanel;
let useInspector: typeof import("../../app/inspector").useInspector;
const loader = vi.hoisted(() => ({ load: vi.fn<() => Promise<void>>(), bodies: vi.fn() }));
const identity = vi.hoisted(() => ({
  gateway: "http://gateway-a",
  caller: 1,
  access: 1,
  workspace: "workspace-a",
  citadel: "personal",
}));
const navigation = vi.hoisted(() => ({ revision: 1 }));
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
vi.mock("../../app/cockpit-history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/cockpit-history")>()),
  readCockpitHistory: () => navigation.revision + ":" + window.location.href,
  subscribeCockpitHistory: () => () => {},
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
function fixture(sessionId = "session-a", onSelectTurn = vi.fn()): MissionThreadedRenderSurfaceInput {
  return {
    sessionRail: { selectedSessionId: sessionId },
    activeSessionSurfaceProps: { selectedSessionId: sessionId, onSelectTurn },
    contextDockProps: { selectedSessionId: sessionId },
  } as unknown as MissionThreadedRenderSurfaceInput;
}
function render(input = fixture(), initialTab: "run" | "turn" | "files" = "run", strict = false) {
  const inspector = <ChatInspector input={input} initialTab={initialTab} />;
  root.render(
    <>
      <textarea id="outside-draft" defaultValue="Unsent answer" />
      {strict ? <StrictMode>{inspector}</StrictMode> : inspector}
    </>,
  );
}
const named = (label: string, parent: ParentNode = host) =>
  [...parent.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
beforeEach(async () => {
  vi.resetModules();
  loader.load.mockReset();
  loader.bodies.mockReset();
  navigation.revision = 1;
  Object.assign(identity, {
    gateway: "http://gateway-a",
    caller: 1,
    access: 1,
    workspace: "workspace-a",
    citadel: "personal",
  });
  window.history.replaceState({ retained: true }, "", "/chat?sessionId=session-a&shell=cockpit#evidence");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.doMock("./ChatInspectorBody", async () => {
    await loader.load();
    return {
      ChatInspector: (props: Parameters<typeof ChatInspector>[0]) => {
        loader.bodies(props);
        return (
          <section aria-label="Ready inspector">
            <p>
              {props.input.sessionRail.selectedSessionId} · {props.initialTab}
            </p>
            <button type="button" onClick={() => props.input.activeSessionSurfaceProps?.onSelectTurn("current-turn")}>
              Select current turn
            </button>
          </section>
        );
      },
    };
  });
  const facade = await import("./ChatInspector");
  ChatInspector = facade.ChatInspector;
  ({ InspectorProvider, InspectorPanel, useInspector } = await import("../../app/inspector"));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
it("does not load code for a registered closed inspector and preserves the existing panel owner when opening", async () => {
  const held = deferred();
  loader.load.mockImplementationOnce(() => held.promise);
  const input = fixture();
  function Register() {
    const { register, open } = useInspector();
    useEffect(
      () => register("chat", { source: "chat", title: "Conversation", body: <ChatInspector input={input} /> }),
      [register],
    );
    return (
      <button
        type="button"
        onClick={() => open({ source: "chat", title: "Conversation", body: <ChatInspector input={input} /> })}
      >
        Inspect conversation
      </button>
    );
  }
  await act(async () =>
    root.render(
      <InspectorProvider>
        <Register />
        <InspectorPanel />
      </InspectorProvider>,
    ),
  );
  expect(loader.load).not.toHaveBeenCalled();
  expect(host.querySelector("[data-inspector-body]")).toBeNull();
  await act(async () => named("Inspect conversation").click());
  await vi.waitFor(() => expect(loader.load).toHaveBeenCalledOnce());
  const panel = host.querySelector("[data-inspector-body]");
  expect(panel).not.toBeNull();
  expect(host.textContent).toContain("Loading conversation evidence");
  await act(async () => held.resolve());
  await vi.waitFor(() => expect(host.querySelector('[aria-label="Ready inspector"]')).not.toBeNull());
  expect(host.querySelector("[data-inspector-body]")).toBe(panel);
  expect(loader.bodies.mock.calls.at(-1)?.[0].input).toBe(input);
});
it("forwards only current exact props after held code, preserving an outside answer and focus", async () => {
  const held = deferred();
  loader.load.mockImplementationOnce(() => held.promise);
  const old = vi.fn(),
    current = vi.fn();
  await act(async () => render(fixture("session-a", old)));
  await vi.waitFor(() => expect(loader.load).toHaveBeenCalledOnce());
  const draft = host.querySelector<HTMLTextAreaElement>("#outside-draft")!;
  draft.value = "Keep this answer";
  draft.focus();
  const input = fixture("session-a", current);
  await act(async () => render(input, "files"));
  await act(async () => held.resolve());
  await vi.waitFor(() => expect(host.querySelector('[aria-label="Ready inspector"]')).not.toBeNull());
  expect(host.querySelector("#outside-draft")).toBe(draft);
  expect(draft.value).toBe("Keep this answer");
  expect(document.activeElement).toBe(draft);
  expect(loader.bodies.mock.calls.at(-1)?.[0].input).toBe(input);
  expect(host.textContent).toContain("session-a · files");
  await act(async () => named("Select current turn").click());
  expect(old).not.toHaveBeenCalled();
  expect(current).toHaveBeenCalledExactlyOnceWith("current-turn");
});
it.each(["caller-aba", "access", "gateway", "workspace-aba", "session-aba"])(
  "publishes only the fresh owner after %s while code is held",
  async (departure) => {
    const held = deferred();
    loader.load.mockImplementationOnce(() => held.promise);
    const old = vi.fn(),
      current = vi.fn();
    await act(async () => render(fixture("session-a", old)));
    await vi.waitFor(() => expect(loader.load).toHaveBeenCalledOnce());
    if (departure === "caller-aba") identity.caller += 2;
    if (departure === "access") identity.access++;
    if (departure === "gateway") identity.gateway = "http://gateway-b";
    if (departure === "workspace-aba") {
      identity.workspace = "workspace-b";
      await act(async () => render());
      identity.workspace = "workspace-a";
    }
    if (departure === "session-aba") await act(async () => render(fixture("session-b")));
    const input = fixture("session-a", current);
    await act(async () => render(input));
    await act(async () => held.resolve());
    await vi.waitFor(() => expect(host.querySelector('[aria-label="Ready inspector"]')).not.toBeNull());
    expect(loader.bodies.mock.calls.at(-1)?.[0].input).toBe(input);
    await act(async () => named("Select current turn").click());
    expect(old).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledOnce();
  },
);
it("does not resurrect a closed inspector after code completes", async () => {
  const held = deferred();
  loader.load.mockImplementationOnce(() => held.promise);
  await act(async () => render());
  await vi.waitFor(() => expect(loader.load).toHaveBeenCalledOnce());
  await act(async () => root.render(<textarea id="outside-draft" defaultValue="Kept" />));
  await act(async () => held.resolve());
  expect(loader.bodies).not.toHaveBeenCalled();
  expect(host.querySelector('[aria-label="Ready inspector"]')).toBeNull();
});
async function failCode() {
  loader.load.mockRejectedValueOnce(
    new TypeError("Failed to fetch dynamically imported module: private fixture asset"),
  );
  await act(async () => render());
  await vi.waitFor(() => expect(host.textContent).toContain("Conversation details could not load"));
  expect(host.textContent).not.toContain("private fixture asset");
  expect(named("Try again")).toBeUndefined();
}
async function openReload() {
  const trigger = named("Reload app");
  trigger.focus();
  await act(async () => trigger.click());
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
  return trigger;
}
it("requires warned current-document Reload and lets Cancel and Escape retain the answer without retrying code", async () => {
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
  await failCode();
  const draft = host.querySelector<HTMLTextAreaElement>("#outside-draft")!;
  draft.value = "Retained answer";
  const trigger = await openReload();
  expect(dialog()?.textContent).toContain("Unsent question answers and unsaved edits may be lost");
  expect(document.activeElement).toBe(named("Cancel", dialog()!));
  await act(async () => named("Cancel", dialog()!).click());
  await vi.waitFor(() => expect(dialog()).toBeNull());
  expect(reload).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  await openReload();
  await act(async () =>
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  await vi.waitFor(() => expect(dialog()).toBeNull());
  expect(host.querySelector("#outside-draft")).toBe(draft);
  expect(draft.value).toBe("Retained answer");
  expect(reload).not.toHaveBeenCalled();
  expect(loader.load).toHaveBeenCalledOnce();
});
it("consumes current Reload consent once without changing answers, history or draft storage", async () => {
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
  await failCode();
  const draft = host.querySelector<HTMLTextAreaElement>("#outside-draft")!;
  const value = draft.value;
  await openReload();
  const confirm = named("Reload app", dialog()!);
  const url = window.location.href,
    state = window.history.state;
  const local = vi.spyOn(window.localStorage, "setItem"),
    session = vi.spyOn(window.sessionStorage, "setItem");
  await act(async () => {
    confirm.click();
    confirm.click();
  });
  expect(reload).toHaveBeenCalledOnce();
  expect(draft.value).toBe(value);
  expect(window.location.href).toBe(url);
  expect(window.history.state).toEqual(state);
  expect(local).not.toHaveBeenCalled();
  expect(session).not.toHaveBeenCalled();
});
it.each(["caller-aba", "access", "gateway", "url", "history-aba"])(
  "refuses stale still-connected Reload consent after %s",
  async (departure) => {
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
    await failCode();
    await openReload();
    const confirm = named("Reload app", dialog()!);
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
it("uses one code-only import through StrictMode effect replay", async () => {
  const held = deferred();
  loader.load.mockImplementationOnce(() => held.promise);
  await act(async () => render(fixture(), "run", true));
  await vi.waitFor(() => expect(loader.load).toHaveBeenCalledOnce());
  await act(async () => held.resolve());
  await vi.waitFor(() => expect(host.querySelector('[aria-label="Ready inspector"]')).not.toBeNull());
  expect(loader.load).toHaveBeenCalledOnce();
});
