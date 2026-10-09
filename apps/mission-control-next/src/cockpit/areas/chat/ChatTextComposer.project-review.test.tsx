// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import { useChatSessionControls } from "../../../../../../packages/threaded-surface-core/src/chat/useChatSessionControls";
import { useChatComposerPaletteActions } from "../../../../../../packages/threaded-surface-core/src/chat/useChatComposerPaletteActions";
import { CockpitNavigationContext, type CockpitNavigationOwner } from "../../app/cockpit-navigation-context";
import { ProjectAssignmentReview } from "./ProjectAssignmentReview";
import { notifyGatewayAccessChanged } from "@goatcitadel/mission-control-shared/api/access-scope";
import { ChatTextComposer, type ComposerProps } from "./ChatTextComposer";

const api = vi.hoisted(() => ({ assign: vi.fn(), refresh: vi.fn(), error: vi.fn() }));
const scope = vi.hoisted(() => ({ activeCitadelId: "citadel-a", activeWorkspaceId: "workspace-a" }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", async (original) => ({
  ...await original<typeof import("@goatcitadel/mission-control-shared/state/ui-preferences")>(), useUiPreferences: () => scope,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({
  ...await original<typeof import("@goatcitadel/mission-control-shared/api/client")>(),
  assignChatSessionProject: api.assign,
}));
const noop = () => undefined;
const item = { key: "project:destination", command: "Destination", description: "Switch project", applyValue: "",
  action: { type: "switch_project" as const, projectId: "destination", projectName: "Destination" } };
const baseSession = { sessionId: "conversation-a", workspaceId: "workspace-a", revision: 7,
  projectId: "source", scope: "mission", mode: "chat", lifecycleStatus: "active" } as ChatSessionRecord;
let root: Root;
let host: HTMLDivElement;
let navigation: CockpitNavigationOwner;
let deferred: (() => void) | undefined;

function Harness({ changes = {}, viewIdentity, assignment = false }: { changes?: Partial<ComposerProps>; viewIdentity?: string; assignment?: boolean }) {
  const context = changes.projectSwitchContext ?? { workspaceId: "workspace-a", session: baseSession,
    projects: [{ projectId: "destination", workspaceId: "workspace-a", revision: 3, name: "Destination", workspacePath: "F:/authorized/project", lifecycleStatus: "active" as const }],
    mutationPending: false };
  const controls = useChatSessionControls({ workspaceId: context.session.workspaceId ?? "default", viewIdentity, historyView: "active",
    sessionMode: "chat", selectedProjectId: "all", selectedSessionId: context.session.sessionId,
    selectedSession: context.session as ChatSessionRecord, renameTitle: "", folderName: "", tagsValue: "",
    setSelectedProjectId: noop, setSelectedSessionId: noop, setHistoryView: noop, setError: api.error, setSending: noop,
    setQueuedOutbound: noop, setSessions: noop, setThread: noop, loadSidebar: api.refresh, setBinding: noop });
  const actions = useChatComposerPaletteActions({ workspaceId: context.session.workspaceId ?? "default",
    ensureSession: controls.ensureSession, setPendingAttachments: noop, pushLocalNotice: noop,
    setComposerPaletteGlobalOpen: noop, setComposerPaletteQuery: noop, setDraft: noop,
    requestThreadModelPatch: noop, setSelectedPresetId: noop, handleApplyPresetById: async () => undefined,
    handleAssignProject: controls.handleAssignProject, handleAttachKnowledgeUrlValue: async () => undefined,
    openRunVariableForm: noop, setUiError: api.error });
  const props = { draft: "Preserved draft", pendingAttachments: [], selectedSessionId: context.session.sessionId,
    sending: false, hasActiveStream: false, historicalReadOnly: false, canSend: true, editingTurnId: null,
    sessionControlBanner: null, pendingApproval: null, pendingUserInput: null, providerOptions: [],
    currentThinkingLevel: "standard", currentWebMode: "off", currentReviewDepth: "off", planningMode: "off",
    composerRef: createRef<HTMLTextAreaElement>(), fileInputRef: createRef<HTMLInputElement>(),
    commandSuggestions: [item], commandIndex: 0, onApplyDraftCommand: noop, onDraftChange: noop,
    onComposerKeyDown: noop, onSend: noop, onAttachFiles: noop, onUploadFiles: noop,
    projectSwitchContext: { ...context, mutationPending: controls.sessionControlPending !== null },
    composerPalette: { enabled: true, globalOpen: true, query: "", loading: false, failures: [], onOpen: noop,
      onClose: noop, onQueryChange: noop, onIndexChange: noop, onSelect: actions.handleComposerPaletteSelect },
    ...changes } as ComposerProps;
  return <CockpitNavigationContext.Provider value={navigation}><div data-selected-session={context.session.sessionId}>{assignment ? <ProjectAssignmentReview active={props} /> : <ChatTextComposer props={props} />}</div></CockpitNavigationContext.Provider>;
}
async function render(changes: Partial<ComposerProps> = {}, viewIdentity?: string) { await act(async () => root.render(<Harness changes={changes} viewIdentity={viewIdentity} />)); }
async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}
async function open() { await act(async () => document.querySelector<HTMLButtonElement>('[role="option"]')!.click()); }
beforeEach(() => {
  vi.clearAllMocks(); api.assign.mockResolvedValue({}); api.refresh.mockResolvedValue(undefined); deferred = undefined;
  scope.activeCitadelId = "citadel-a"; scope.activeWorkspaceId = "workspace-a";
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  navigation = { isTransitionPending: () => false, navigate: vi.fn(), requestTransition: (action) => {
    void action({ isCurrent: () => true, signal: new AbortController().signal, navigate: () => true });
  } };
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("reviewed Cockpit palette project reassignment through the real controller", () => {
  it("shows authorized destination context and cancellation never reaches assignment or navigation", async () => {
    const url = window.location.href;
    await render(); await open();
    expect(document.body.textContent).toContain("Destination in workspace workspace-a");
    expect(document.body.textContent).toContain("F:/authorized/project");
    expect(document.body.textContent).toContain("current draft and attachments stay");
    await click("Cancel");
    expect(api.assign).not.toHaveBeenCalled(); expect(navigation.navigate).not.toHaveBeenCalled();
    expect(window.location.href).toBe(url); expect(host.querySelector("textarea")?.value).toBe("Preserved draft");
  });
  it("confirms exactly the reviewed current conversation and revision through the existing API owner", async () => {
    await render(); await open(); await click("Switch project");
    expect(api.assign).toHaveBeenCalledExactlyOnceWith("conversation-a", "destination", 7);
    expect(api.refresh).toHaveBeenCalledWith("active", { bypassCache: true, preserveSelection: true });
  });
  it.each(["session", "workspace", "revision", "project", "draft", "attachments", "destination"])("rejects a changed %s before confirmation", async (change) => {
    await render(); await open();
    const context = { workspaceId: "workspace-a", session: { ...baseSession }, projects: [{ projectId: "destination", workspaceId: "workspace-a", revision: 3,
      name: "Destination", workspacePath: "F:/authorized/project", lifecycleStatus: "active" as const }], mutationPending: false };
    const changes: Partial<ComposerProps> = { projectSwitchContext: context };
    if (change === "session") { context.session.sessionId = "conversation-b"; changes.selectedSessionId = "conversation-b"; }
    if (change === "workspace") context.session.workspaceId = "workspace-b";
    if (change === "revision") context.session.revision = 8;
    if (change === "project") context.session.projectId = "another-project";
    if (change === "destination") context.projects[0]!.revision = 4;
    if (change === "draft") changes.draft = "New unsaved work";
    if (change === "attachments") changes.pendingAttachments = [{ attachmentId: "new", fileName: "note.txt", mimeType: "text/plain", sizeBytes: 5 }];
    await render(changes); await click("Switch project"); expect(api.assign).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("changed");
  });
  it("rechecks after delayed leave review, rejecting newly dirty work", async () => {
    navigation.requestTransition = (action) => { deferred = () => { void action({ isCurrent: () => true, signal: new AbortController().signal, navigate: () => true }); }; };
    await render(); await open(); await click("Switch project"); expect(api.assign).not.toHaveBeenCalled();
    await render({ draft: "Changed while leave review was pending" });
    await act(async () => deferred!()); expect(api.assign).not.toHaveBeenCalled();
  });
  it("keeps assignment untouched when the existing draft-leave review is cancelled", async () => {
    navigation.requestTransition = vi.fn();
    await render(); await open(); await click("Switch project");
    expect(navigation.requestTransition).toHaveBeenCalledOnce(); expect(api.assign).not.toHaveBeenCalled();
    expect(host.querySelector("textarea")?.value).toBe("Preserved draft");
  });
  it("rejects a confirmation from a scope that changed away and back", async () => {
    await render(); await open(); scope.activeCitadelId = "citadel-b"; await render();
    scope.activeCitadelId = "citadel-a"; await render(); await click("Switch project");
    expect(api.assign).not.toHaveBeenCalled();
  });
  it("rejects an old delayed action after a workspace change", async () => {
    navigation.requestTransition = (action) => { deferred = () => { void action({ isCurrent: () => true, signal: new AbortController().signal, navigate: () => true }); }; };
    await render(); await open(); await click("Switch project"); scope.activeWorkspaceId = "workspace-b"; await render();
    await act(async () => deferred!()); expect(api.assign).not.toHaveBeenCalled();
  });
  it("rejects stale owner data left visible after a workspace switch", async () => {
    scope.activeWorkspaceId = "workspace-b"; await render(); await open();
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(api.assign).not.toHaveBeenCalled();
  });
  it("rejects a running turn that starts after the destination review", async () => {
    await render(); await open(); await render({ hasActiveStream: true }); await click("Switch project");
    expect(api.assign).not.toHaveBeenCalled();
  });
  it("consumes a confirmation once even when two clicks arrive in one event batch", async () => {
    await render(); await open();
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Switch project")!;
    await act(async () => { confirm.click(); confirm.click(); }); expect(api.assign).toHaveBeenCalledOnce();
  });
  it("does not reselect the old conversation when its assignment response settles after navigation", async () => {
    let settle!: () => void;
    api.assign.mockImplementationOnce(() => new Promise<void>((resolve) => { settle = resolve; }));
    await render(); await open(); await click("Switch project");
    expect(api.assign).toHaveBeenCalledWith("conversation-a", "destination", 7);
    await render({ selectedSessionId: "conversation-b", projectSwitchContext: {
      workspaceId: "workspace-a", session: { ...baseSession, sessionId: "conversation-b" }, projects: [], mutationPending: false,
    } });
    await act(async () => settle());
    expect(api.refresh).not.toHaveBeenCalled(); expect(host.querySelector("[data-selected-session]")?.getAttribute("data-selected-session")).toBe("conversation-b");
  });
  it("does not refresh the old view after a Citadel-only identity ABA during a pending assignment", async () => {
    let settle!: () => void;
    api.assign.mockImplementationOnce(() => new Promise<void>((resolve) => { settle = resolve; }));
    await render({}, "citadel-a"); await open(); await click("Switch project");
    await render({}, "citadel-b"); await render({}, "citadel-a"); await act(async () => settle());
    expect(api.assign).toHaveBeenCalledExactlyOnceWith("conversation-a", "destination", 7); expect(api.refresh).not.toHaveBeenCalled();
  });
  it.each([{ sending: true }, { hasActiveStream: true }, { historicalReadOnly: true }])("rejects busy/read-only work %j", async (changes) => {
    await render(changes); await open(); expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(api.assign).not.toHaveBeenCalled();
  });
  it("rejects composition in progress without consuming the draft", async () => {
    await render(); await act(async () => host.querySelector("textarea")!.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    await open(); expect(api.assign).not.toHaveBeenCalled(); expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});


it("native Projects assignment handoff uses the existing review and controller exactly once", async () => {
  window.history.replaceState(null, "", "/chat?sessionId=conversation-a&assignProjectId=destination&shell=cockpit");
  await act(async () => root.render(<Harness assignment />));
  await click("Review project assignment"); await click("Cancel"); expect(api.assign).not.toHaveBeenCalled();
  await click("Review project assignment"); await click("Switch project");
  expect(api.assign).toHaveBeenCalledExactlyOnceWith("conversation-a", "destination", 7);
});
it("native assignment handoff closes on changed caller access without persisting", async () => {
  window.history.replaceState(null, "", "/chat?sessionId=conversation-a&assignProjectId=destination&shell=cockpit");
  await act(async () => root.render(<Harness assignment />)); await click("Review project assignment");
  await act(async () => notifyGatewayAccessChanged()); expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(api.assign).not.toHaveBeenCalled();
});
