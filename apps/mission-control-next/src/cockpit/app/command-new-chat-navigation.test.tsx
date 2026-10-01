// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import { CockpitNavigationProvider } from "./CockpitNavigationProvider";
import { useCockpitRoute } from "./use-cockpit-route";
import { useCommandNewChat, resetCommandNewChatForTests } from "./use-command-new-chat";
import { useSessionDraft, __resetSessionDraftsForTests } from "../../features/native-routes/library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../features/native-routes/library/use-form-dirty";

const api = vi.hoisted(() => ({ verify: vi.fn(), create: vi.fn(), read: vi.fn() }));
const scope = vi.hoisted(() => ({ activeWorkspaceId: "workspace-a", activeCitadelId: "citadel-a" }));
vi.mock("./command-palette-search", () => ({ assertPaletteWorkspace: api.verify }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({ createChatSession: api.create, fetchChatSessionStatus: api.read }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ API_BASE: "http://owner.invalid", getGatewayApiBaseUrl: () => "http://owner.invalid" }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => scope }));
vi.mock("../../shell-preference", () => ({ switchShell: vi.fn(), writeShellPreference: vi.fn() }));
const receipt: ChatSessionRecord = {
  sessionId: "new/one", revision: 1, sessionKey: "mission:new/one", workspaceId: "workspace-a",
  scope: "mission", mode: "chat", includeInHistory: true, pinned: false, lifecycleStatus: "active",
  channel: "mission", account: "local", updatedAt: "2026-10-01T00:00:00Z", lastActivityAt: "2026-10-01T00:00:00Z",
  tokenTotal: 0, costUsdTotal: 0,
};
let root: Root, element: HTMLDivElement;
let draft: ReturnType<typeof useSessionDraft<{ name: string }>>, creation: ReturnType<typeof useCommandNewChat>;
const close = vi.fn(), unexpectedNavigation = vi.fn();
function Probe() {
  const route = useCockpitRoute();
  draft = useSessionDraft("creation-origin-draft", { name: "Saved" }, 1, { label: "Origin draft" });
  const owner = useCommandNewChat({ workspaceId: scope.activeWorkspaceId, citadelId: scope.activeCitadelId }, true, unexpectedNavigation);
  creation = owner;
  return <button type="button" onClick={() => route.requestTransition(async (review) => {
    await owner.create({ isCurrent: review.isCurrent, onCreated: (sessionId) => {
      if (review.navigate(`/chat?${new URLSearchParams({ shell: "cockpit", sessionId })}`)) close();
    } });
  })}>Create reviewed chat</button>;
}
async function render() { await act(async () => { root.render(<CockpitNavigationProvider><Probe /></CockpitNavigationProvider>); }); }
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent === label);
  expect(button).toBeDefined(); await act(async () => { button!.click(); });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(async () => {
  vi.clearAllMocks(); resetCommandNewChatForTests(); __resetSessionDraftsForTests(); __resetFormDirtyRegistryForTests();
  scope.activeWorkspaceId = "workspace-a"; scope.activeCitadelId = "citadel-a";
  api.verify.mockResolvedValue(undefined); api.create.mockResolvedValue(receipt);
  api.read.mockResolvedValue({ sessionId: receipt.sessionId, workspaceId: receipt.workspaceId });
  window.history.replaceState(null, "", "/settings/safety?shell=cockpit#approval-mode");
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
  await render(); await act(async () => { draft.setValue({ name: "Unsaved grant input" }); });
});
afterEach(async () => {
  await act(async () => { root.unmount(); }); element.remove();
  __resetSessionDraftsForTests(); __resetFormDirtyRegistryForTests();
});

describe("New chat reviewed navigation admission", () => {
  it("does not read or create until leave consent; Cancel keeps the owner unchanged and Keep creates once", async () => {
    await click("Create reviewed chat");
    expect(api.verify).not.toHaveBeenCalled(); expect(api.create).not.toHaveBeenCalled();
    await click("Cancel"); expect(close).not.toHaveBeenCalled();
    expect(draft.value.name).toBe("Unsaved grant input");
    await click("Create reviewed chat"); await click("Keep draft and close");
    expect(api.create).toHaveBeenCalledTimes(1); expect(api.read).toHaveBeenCalledWith(receipt.sessionId, expect.any(AbortSignal));
    expect(window.location.pathname + window.location.search).toBe("/chat?shell=cockpit&sessionId=new%2Fone");
    expect(creation.attempt?.state).toBe("confirmed"); expect(close).toHaveBeenCalledTimes(1);
    expect(unexpectedNavigation).not.toHaveBeenCalled(); expect(draft.value.name).toBe("Unsaved grant input");
  });

  it("cancels accepted preflight after URL ABA before any create request", async () => {
    const pending = deferred<void>(); api.verify.mockReturnValue(pending.promise);
    await click("Create reviewed chat"); await click("Keep draft and close");
    await act(async () => {
      window.history.replaceState(null, "", "/inbox?shell=cockpit"); window.dispatchEvent(new Event("goatcitadel:cockpit-location"));
      window.history.replaceState(null, "", "/settings/safety?shell=cockpit#approval-mode"); window.dispatchEvent(new Event("goatcitadel:cockpit-location"));
    });
    await act(async () => { pending.resolve(); await pending.promise; });
    expect(api.create).not.toHaveBeenCalled(); expect(creation.blocked).toBe(false); expect(close).not.toHaveBeenCalled();
  });

  it("retains a dispatched confirmed owner after scope changes without opening the obsolete view", async () => {
    const pending = deferred<ChatSessionRecord>(); api.create.mockReturnValue(pending.promise);
    await click("Create reviewed chat"); await click("Keep draft and close");
    expect(api.create).toHaveBeenCalledTimes(1);
    scope.activeWorkspaceId = "workspace-b"; await render();
    await act(async () => { pending.resolve(receipt); await pending.promise; });
    expect(close).not.toHaveBeenCalled(); expect(window.location.pathname).toBe("/settings/safety");
    scope.activeWorkspaceId = "workspace-a"; await render();
    expect(creation.attempt?.state).toBe("confirmed"); expect(creation.attempt?.sessionId).toBe(receipt.sessionId);
    expect(draft.value.name).toBe("Unsaved grant input");
  });

  it("retains an unknown creation lock across remount without retrying after another leave consent", async () => {
    api.create.mockRejectedValue(new Error("Acknowledgement lost"));
    await click("Create reviewed chat"); await click("Keep draft and close");
    expect(creation.attempt?.state).toBe("unknown");
    await act(async () => { root.render(null); }); await render();
    await click("Create reviewed chat"); await click("Keep draft and close");
    expect(api.create).toHaveBeenCalledTimes(1); expect(creation.blocked).toBe(true); expect(close).not.toHaveBeenCalled();
  });
});
