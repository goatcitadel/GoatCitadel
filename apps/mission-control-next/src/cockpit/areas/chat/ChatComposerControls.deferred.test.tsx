// @vitest-environment happy-dom
import { act, createRef, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Catalog labels read the query cache; these tests exercise the controls, so the model id stands in for its name.
vi.mock("../../data/use-model-label", () => ({
  useModelLabel: (_providerId?: string, modelId?: string) => modelId ?? "Unknown model",
  useProviderLabelLookup: () => () => undefined,
}));
vi.mock("./use-chat-model-labels", () => ({ useChatModelLabels: () => (modelId: string) => modelId }));

const load = vi.hoisted(() => ({ started: vi.fn<() => Promise<void>>(), completed: vi.fn() }));
const custody = vi.hoisted(() => ({
  history: 0,
  histories: new Set<() => void>(),
  caller: 1,
  access: 1,
  gateway: "http://gateway-a",
  workspace: "workspace-a",
  citadel: "personal",
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
  useUiPreferences: () => ({ activeWorkspaceId: custody.workspace, activeCitadelId: custody.citadel }),
}));
vi.mock("../../app/cockpit-back-guard", () => ({ COCKPIT_LOCATION_EVENT: "goatcitadel:cockpit-location" }));
vi.mock("../../app/cockpit-history", () => ({
  readCockpitHistory: () => `${custody.history}:${window.location.href}`,
  subscribeCockpitHistory: (notify: () => void) => {
    custody.histories.add(notify);
    return () => custody.histories.delete(notify);
  },
}));
let ChatComposerControls: typeof import("./ChatComposerControls").ChatComposerControls;
let sdk: typeof import("./ChatModelOptionsPopover"), root: Root, host: HTMLDivElement;
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
    workspace: "workspace-a",
    citadel: "personal",
  });
  sdk = await vi.importActual<typeof import("./ChatModelOptionsPopover")>("./ChatModelOptionsPopover");
  vi.doMock("./ChatModelOptionsPopover", async () => {
    await load.started();
    load.completed();
    return sdk;
  });
  ChatComposerControls = (await import("./ChatComposerControls")).ChatComposerControls;
  host = document.createElement("div");
  host.style.overflow = "auto";
  host.style.height = "500px";
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.doUnmock("./ChatModelOptionsPopover");
  vi.restoreAllMocks();
});
type Controls = ComponentProps<typeof ChatComposerControls>["props"];
function controls(overrides: Partial<Controls> = {}): Controls {
  return {
    routePreflight: null,
    providerOptions: [
      { providerId: "fixture", label: "Fixture", models: ["fixture-chat", "fixture-large"], disabled: false },
    ],
    selectedProviderId: "fixture",
    selectedModel: "fixture-chat",
    modelSwitchDisabled: false,
    onRequestProviderChange: vi.fn(),
    onRequestModelChange: vi.fn(),
    currentThinkingLevel: "standard",
    onSetThinkingLevel: vi.fn(),
    activePersonality: null,
    onOpenPersonalitiesSettings: vi.fn(),
    planningMode: "off",
    onTogglePlanningMode: vi.fn(),
    currentWebMode: "off",
    onSetWebMode: vi.fn(),
    currentReviewDepth: "off",
    onToggleReviewMode: vi.fn(),
    pendingAttachments: [],
    onRemoveAttachment: vi.fn(),
    fileInputRef: createRef<HTMLInputElement>(),
    onAttachFiles: vi.fn(),
    onUploadFiles: vi.fn(),
    historicalReadOnly: false,
    sending: false,
    routeBoundaryAckRequired: false,
    routeBoundaryAcknowledged: false,
    onAcknowledgeRouteBoundary: vi.fn(),
    ...overrides,
  } as unknown as Controls;
}
async function render(
  input = controls(),
  scope = "session-a",
  reasoningEfforts?: ComponentProps<typeof ChatComposerControls>["reasoningEfforts"],
) {
  await act(async () =>
    root.render(
      <>
        <textarea aria-label="Unsent answer" />
        <button id="popover-outside" type="button">
          Outside
        </button>
        <ChatComposerControls props={input} scopeKey={scope} reasoningEfforts={reasoningEfforts} />
      </>,
    ),
  );
}
const trigger = () => host.querySelector<HTMLButtonElement>('button[aria-label$="Model and reasoning options"]')!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const provider = () => document.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')!;
const model = () => document.querySelector<HTMLSelectElement>('select[aria-label="Model"]')!;
const effort = () => document.querySelector<HTMLSelectElement>('select[aria-label="Effort"]')!;
const outside = () => host.querySelector<HTMLButtonElement>("#popover-outside")!;
async function ready() {
  await vi.waitFor(() => expect(provider()).not.toBeNull());
}
async function open() {
  trigger().focus();
  await act(async () => trigger().click());
  await ready();
}
async function change(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
  });
}
async function key(node: HTMLElement, key: string) {
  await act(async () => {
    node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

describe("deferred public model options Popover", () => {
  it("keeps mandatory controls usable without loading the closed optional renderer", async () => {
    const input = controls();
    await render(input);
    const native = trigger();
    native.focus();
    expect(load.started).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
    await change(host.querySelector<HTMLSelectElement>('select[aria-label="Web search"]')!, "deep");
    expect(input.onSetWebMode).toHaveBeenCalledExactlyOnceWith("deep");
    const plan = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === "Plan first",
    )!;
    await act(async () => plan.click());
    expect(input.onTogglePlanningMode).toHaveBeenCalledOnce();
    expect(load.started).not.toHaveBeenCalled();
  });
  it("keeps the same physical trigger through held loading, public virtual-anchor measurement and Done focus restoration", async () => {
    const held = gate();
    load.started.mockImplementationOnce(() => held.promise);
    const input = controls();
    await render(input);
    const native = trigger();
    const measured = vi.spyOn(native, "getBoundingClientRect").mockReturnValue(new DOMRect(200, 650, 240, 40));
    const className = native.className,
      label = native.textContent;
    native.focus();
    await act(async () => native.click());
    expect(trigger()).toBe(native);
    expect(native.getAttribute("aria-busy")).toBe("true");
    expect(dialog()).toBeNull();
    await act(async () => held.resolve());
    await ready();
    await vi.waitFor(() => expect(measured).toHaveBeenCalled());
    expect(trigger()).toBe(native);
    expect(native.className).toBe(className);
    expect(native.textContent).toBe(label);
    expect(native.getAttribute("aria-controls")).toBe(dialog()?.id);
    await change(model(), "fixture-large");
    expect(input.onRequestModelChange).toHaveBeenCalledExactlyOnceWith("fixture-large");
    const done = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === "Done",
    )!;
    done.focus();
    await act(async () => done.click());
    await vi.waitFor(() => expect(dialog()).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(native));
    expect(trigger()).toBe(native);
    await open();
    expect(trigger()).toBe(native);
    expect(load.started).toHaveBeenCalledOnce();
  });
  it("uses the current disabled and model-effort metadata when the delayed renderer arrives", async () => {
    const held = gate();
    load.started.mockImplementationOnce(() => held.promise);
    const input = controls();
    await render(input);
    const native = trigger();
    const answer = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Unsent answer"]')!;
    answer.value = "Preserved during current metadata change";
    native.focus();
    await act(async () => native.click());
    await render({ ...input, sending: true }, "session-a", ["high"]);
    expect(trigger()).toBe(native);
    expect(host.querySelector('textarea[aria-label="Unsent answer"]')).toBe(answer);
    expect(answer.value).toBe("Preserved during current metadata change");
    await act(async () => held.resolve());
    await ready();
    expect(load.started).toHaveBeenCalledOnce();
    expect(trigger()).toBe(native);
    expect(provider().disabled).toBe(true);
    expect(model().disabled).toBe(true);
    expect(effort().disabled).toBe(true);
    expect([...effort().options].map((option) => option.value)).toEqual(["standard", "extended"]);
    expect(effort().selectedOptions[0]?.disabled).toBe(true);
    expect(input.onRequestModelChange).not.toHaveBeenCalled();
  });
  it.each(["Escape", "Tab", "outside-focus", "outside-pointer", "session-ABA", "caller-ABA", "access", "workspace"])(
    "keeps the native trigger and rejects late focus/action after pending %s",
    async (reason) => {
      const held = gate();
      load.started.mockImplementationOnce(() => held.promise);
      const input = controls();
      await render(input);
      const native = trigger();
      native.focus();
      await act(async () => native.click());
      if (reason === "Escape" || reason === "Tab") {
        await key(native, reason);
        if (reason === "Tab") await act(async () => outside().focus());
      }
      if (reason === "outside-focus") await act(async () => outside().focus());
      if (reason === "outside-pointer")
        await act(async () => {
          outside().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
          outside().focus();
        });
      if (reason === "session-ABA") {
        await render(input, "session-b");
        await render(input, "session-a");
      }
      if (reason === "caller-ABA")
        await act(async () => {
          custody.caller += 2;
          custody.callers.forEach((notify) => notify());
        });
      if (reason === "access")
        await act(async () => {
          custody.access++;
          custody.accesses.forEach((notify) => notify());
        });
      if (reason === "workspace") {
        custody.workspace = "workspace-b";
        await render(input);
      }
      const focus = document.activeElement;
      await act(async () => held.resolve());
      await vi.waitFor(() => expect(load.completed).toHaveBeenCalledOnce());
      expect(dialog()).toBeNull();
      expect(trigger()).toBe(native);
      expect(document.activeElement).toBe(focus);
      expect(input.onRequestProviderChange).not.toHaveBeenCalled();
      expect(input.onRequestModelChange).not.toHaveBeenCalled();
      expect(input.onSetThinkingLevel).not.toHaveBeenCalled();
    },
  );
  it("rejects a stale READY selector event before the caller subscription commits", async () => {
    const input = controls();
    await render(input);
    await open();
    const retained = model();
    custody.caller += 2;
    await change(retained, "fixture-large");
    expect(input.onRequestModelChange).not.toHaveBeenCalled();
    await act(async () => custody.callers.forEach((notify) => notify()));
    await vi.waitFor(() => expect(dialog()).toBeNull());
  });

  it("retains eager model controls and unsent input through a real portaled reload Cancel/Escape without actions", async () => {
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
    load.started.mockRejectedValue(new TypeError("Failed to fetch dynamically imported module: private-fixture"));
    const input = controls();
    await render(input);
    const native = trigger();
    native.focus();
    await act(async () => native.click());
    await vi.waitFor(() => expect(host.textContent).toContain("Model options could not load"));
    const answer = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Unsent answer"]')!;
    answer.value = "Held answer";
    const reloadButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === "Reload app",
    )!;
    expect(host.textContent).not.toContain("Retry model options");
    expect(host.textContent).not.toContain("private-fixture");
    const assertRetained = () => {
      expect(trigger()).toBe(native);
      expect(native.getAttribute("aria-expanded")).toBe("true");
      expect(host.textContent).toContain("Model options could not load");
      expect(host.querySelector('textarea[aria-label="Unsent answer"]')).toBe(answer);
      expect(answer.value).toBe("Held answer");
      expect(input.onRequestModelChange).not.toHaveBeenCalled();
      expect(input.onRequestProviderChange).not.toHaveBeenCalled();
      expect(input.onSetThinkingLevel).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
      expect(load.started).toHaveBeenCalledOnce();
    };
    reloadButton.focus();
    await act(async () => reloadButton.click());
    await vi.waitFor(() =>
      expect(dialog()?.textContent).toContain("Reloading does not submit an answer or an approval decision"),
    );
    const cancel = () =>
      [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === "Cancel")!;
    expect(document.activeElement).toBe(cancel());
    assertRetained();
    await act(async () => cancel().click());
    await vi.waitFor(() => expect(dialog()).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(reloadButton));
    assertRetained();
    await act(async () => reloadButton.click());
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    await key(cancel(), "Escape");
    await vi.waitFor(() => expect(dialog()).toBeNull());
    assertRetained();
    const cancelOptions = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === "Cancel model options",
    )!;
    cancelOptions.focus();
    await act(async () => cancelOptions.click());
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(native);
    expect(reload).not.toHaveBeenCalled();
    const plan = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === "Plan first",
    )!;
    await act(async () => plan.click());
    expect(input.onTogglePlanningMode).toHaveBeenCalledOnce();
  });
  it("lets the public SDK close on outside focus without restoring or stealing that focus", async () => {
    await render();
    await open();
    const outsideButton = outside();
    await act(async () => outsideButton.focus());
    await vi.waitFor(() => expect(dialog()).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(outsideButton));
  });
  it.each(["caller", "access", "gateway", "history-aba", "url"] as const)(
    "refuses connected model reload consent after uncommitted %s departure",
    async (reason) => {
      const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined),
        input = controls();
      load.started.mockRejectedValue(new Error("fixture chunk unavailable"));
      await render(input);
      trigger().focus();
      await act(async () => trigger().click());
      await vi.waitFor(() => expect(host.textContent).toContain("Model options could not load"));
      const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        (node) => node.textContent === "Reload app",
      )!;
      button.focus();
      await act(async () => button.click());
      const confirm = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find(
        (node) => node.textContent === "Reload app",
      )!;
      if (reason === "caller") custody.caller += 2;
      if (reason === "access") custody.access++;
      if (reason === "gateway") custody.gateway = "http://gateway-b";
      if (reason === "history-aba") custody.history += 2;
      if (reason === "url") window.history.replaceState(window.history.state, "", "/chat?sessionId=session-b");
      expect(confirm.isConnected).toBe(true);
      await act(async () => confirm.click());
      expect(reload).not.toHaveBeenCalled();
      expect(input.onRequestModelChange).not.toHaveBeenCalled();
      expect(input.onRequestProviderChange).not.toHaveBeenCalled();
    },
  );
  it("confirms one current model reload without firing provider/model/effort actions", async () => {
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined),
      input = controls();
    load.started.mockRejectedValue(new Error("fixture chunk unavailable"));
    await render(input);
    trigger().focus();
    await act(async () => trigger().click());
    await vi.waitFor(() => expect(host.textContent).toContain("Model options could not load"));
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === "Reload app",
    )!;
    button.focus();
    await act(async () => button.click());
    const confirm = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === "Reload app",
    )!;
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    expect(reload).toHaveBeenCalledOnce();
    expect(input.onRequestProviderChange).not.toHaveBeenCalled();
    expect(input.onRequestModelChange).not.toHaveBeenCalled();
    expect(input.onSetThinkingLevel).not.toHaveBeenCalled();
  });
  it("revokes current recovery on session ABA and preserves outside focus", async () => {
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined),
      input = controls();
    load.started.mockRejectedValue(new Error("fixture chunk unavailable"));
    await render(input);
    trigger().focus();
    await act(async () => trigger().click());
    await vi.waitFor(() => expect(host.textContent).toContain("Model options could not load"));
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === "Reload app",
    )!;
    button.focus();
    await act(async () => button.click());
    const oldConfirm = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === "Reload app",
    )!;
    await render(input, "session-b");
    await render(input, "session-a");
    outside().focus();
    await act(async () => oldConfirm.click());
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(outside());
    expect(reload).not.toHaveBeenCalled();
  });
});
