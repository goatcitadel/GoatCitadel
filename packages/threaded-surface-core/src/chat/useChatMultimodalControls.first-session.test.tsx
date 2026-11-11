import React, { useCallback, useRef, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachmentRecord, ChatSessionRecord } from "@goatcitadel/contracts";
import * as gatewayCore from "@goatcitadel/mission-control-shared/api/client-core";
import { notifyGatewayAccessChanged, setGatewayCallerScope } from "@goatcitadel/mission-control-shared/api/access-scope";
import { useChatSessionSelection } from "./controller/useChatSessionSelection";
import { useChatSessionControls } from "./useChatSessionControls";
import { resetChatSessionCreationForTests } from "@goatcitadel/mission-control-shared/state/chat-session-creation";
import { useChatComposerInteractions } from "./useChatComposerInteractions";
import { useChatMultimodalControls } from "./useChatMultimodalControls";
import { useChatComposerSendIntent } from "./controller/useChatComposerSendIntent";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const transport = vi.hoisted(() => ({
  createChatSession: vi.fn(), fetchChatSessionStatus: vi.fn(),
  generateLlmImage: vi.fn(), uploadChatAttachment: vi.fn(), fetchVoiceStatus: vi.fn(), fetchVoiceRuntimeStatus: vi.fn(),
  startVoiceTalkSession: vi.fn(), stopVoiceTalkSession: vi.fn(), stopRealtimeVoiceSession: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  ...transport, ApiRequestError: class ApiRequestError extends Error {},
}));

const prompt = "Draw an image of a moonlit citadel";
const session: ChatSessionRecord = {
  sessionId: "created-chat", revision: 1, sessionKey: "created-chat", workspaceId: "workspace", scope: "mission",
  mode: "chat", includeInHistory: true, pinned: false, lifecycleStatus: "active", channel: "mission", account: "local",
  updatedAt: "2026-11-04T00:00:00Z", lastActivityAt: "2026-11-04T00:00:00Z", tokenTotal: 0, costUsdTotal: 0,
};
const foreign: ChatSessionRecord = { ...session, sessionId: "existing-other-chat", sessionKey: "existing-other-chat" };
const attachment: ChatAttachmentRecord = {
  attachmentId: "generated-receipt", sessionId: session.sessionId, workspaceId: "workspace",
  fileName: "generated.png", mimeType: "image/png", mediaType: "image", sizeBytes: 5, sha256: "fixture-sha",
  storageRelPath: "fixtures/generated.png", extractStatus: "ready", createdAt: "2026-11-04T00:00:00Z",
};
let sidebarGate: ReturnType<typeof deferred<void>>;
const sidebarCalls = vi.fn();
const sessionCreated = vi.fn();
const noop = () => undefined;
const asyncNoop = async () => undefined;
const ordinarySend = vi.fn(asyncNoop);
const notice = vi.fn();
const recoveryUpdates = vi.fn();
let renderer: ReactTestRenderer | undefined;
let latest: {
  composer: ReturnType<typeof useChatComposerInteractions>;
  media: ReturnType<typeof useChatMultimodalControls>;
  send: ReturnType<typeof useChatComposerSendIntent>;
  draft: string;
  sending: boolean;
  pending: ChatAttachmentRecord[];
  recovery: { prompt: string; sessionId: string | null } | null;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  select: React.Dispatch<React.SetStateAction<string | null>>;
  selectedId: string | null;
  creation: { workspaceId: string; sessionId: string } | null;
  hydrateThread: React.Dispatch<React.SetStateAction<string | null>>;
  selectionRevision: () => number;
  adoptRecord: () => void;
};
type ConfirmationMode = "normal" | "missing" | "workspace" | "return" | "repeat" | "conflict" | "late" | "repeat-later";
let lateConfirmation: (() => void) | undefined;
function Harness({ workspaceId = "workspace", provider = "openai", confirmation = "normal" }: {
  workspaceId?: string; provider?: string; confirmation?: ConfirmationMode;
} = {}) {
  const [draft, setDraft] = useState(prompt);
  const [sending, setSending] = useState(false);
  const [pending, setPendingAttachments] = useState<ChatAttachmentRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<{ prompt: string; sessionId: string | null } | null>(null);
  const [, setCommandIndex] = useState(0);
  const [, setDockOpen] = useState(false);
  const selection = useChatSessionSelection({ initialModeOverride: undefined });
  const selectedId = selection.selectedSessionId;
  const select = selection.setSelectedSessionId;
  const [threadId, hydrateThread] = useState<string | null>(null);
  const [sessions, setSessions] = useState<import("@goatcitadel/mission-control-shared/api/client").ChatSessionsResponse | null>({ items: [foreign] });
  const [, setHistory] = useState<"active" | "archived">("active");
  const [, setProject] = useState("all");
  const selectedSession = sessions?.items.find((record) => record.sessionId === selectedId) ?? null;
  const creation = useRef<{ workspaceId: string; sessionId: string } | null>(null);
  const loadSidebar = useCallback(async (...args: unknown[]) => {
    sidebarCalls(...args);
    // Models the real loadSidebar's awaited read then setSessions/preserveSelection return.
    await sidebarGate.promise;
    setSessions({ items: [session, foreign] });
  }, []);
  const sessionControls = useChatSessionControls({
    workspaceId, selectionRevisionRef: selection.selectedSessionRevisionRef, viewIdentity: "citadel", historyView: "active", sessionMode: "chat",
    selectedProjectId: "all", selectedSessionId: selectedId, selectedSession,
    renameTitle: "", folderName: "", tagsValue: "", setSelectedProjectId: setProject,
    setSelectedSessionId: select, setHistoryView: setHistory, setError, setSending,
    setQueuedOutbound: noop, setSessions, setThread: noop, loadSidebar,
    onSessionCreated: sessionCreated, initialOutboundSessionCreationRef: creation, setBinding: noop,
  });
  const { ensureSession } = sessionControls;
  const ensureForTest = useCallback(async (onResolved?: (created: ChatSessionRecord) => void) => {
    const created = await ensureSession((record) => {
      if (confirmation === "missing") return;
      if (confirmation === "late") { lateConfirmation = () => onResolved?.(record); return; }
      onResolved?.(confirmation === "workspace" ? { ...record, workspaceId: "foreign" } : record);
      if (confirmation === "repeat") onResolved?.(record);
      if (confirmation === "conflict") onResolved?.({ ...record, sessionId: "conflicting-session" });
      if (confirmation === "repeat-later") lateConfirmation = () => onResolved?.(record);
    });
    return confirmation === "return" ? { ...created, sessionId: "mismatched-return" } : created;
  }, [ensureSession, confirmation]);
  const composer = useChatComposerInteractions({
    workspaceId, selectedSessionId: selectedId, selectionRevisionRef: selection.selectedSessionRevisionRef,
    draft, commandSuggestions: [], commandIndex: 0, error, dockOpen: false, sending,
    selectedSession, messageMode: "chat",
    ensureSession: ensureForTest, handleSend: ordinarySend, handleCreateSession: asyncNoop,
    handleArchiveWorkspaceMissionChats: asyncNoop, handleRunQuickResearch: asyncNoop, handlePrefPatch: asyncNoop,
    handleTogglePlanningMode: noop, handleRevealSelectedTurnDetails: noop,
    confirmCapabilitySuggestionAction: asyncNoop, confirmDeleteSession: asyncNoop,
    setSending, setError, setDraft, setCommandIndex, setPendingAttachments,
    setIsDragActive: noop, setEditingTurnId: noop, setDockOpen, setArchiveWorkspaceConfirmOpen: noop,
  });
  const media = useChatMultimodalControls({
    workspaceId, selectedSession, selectionRevisionRef: selection.selectedSessionRevisionRef,
    deferVoiceReadiness: true,
    providerOptions: [{ providerId: provider, label: provider, models: ["gpt-image-2"] }],
    selectedProviderId: provider, routePreflight: null, selectedSessionId: selectedId, activeThreadSessionId: threadId,
    pendingAttachments: pending, draft, setDraft, setError, pushLocalNotice: notice,
    // Exact production wiring: the real uploader catches transport errors itself.
    uploadAttachments: composer.uploadAttachments,
  });
  const sendInput = {
    workspaceId, profileDependentAdmissionBlockReason: undefined,
    notices: { pushLocalNotice: notice }, setFollowThreadOutput: noop,
    knowledgeActions: { requiresThreadKnowledge: false, attachPendingKnowledgeSources: asyncNoop },
    orchestration: { handleSend: ordinarySend, setQueuedOutbound: noop, editingTurnId: null },
    scopedErrors: { setUiError: setError }, draft, openBtwSideChat: asyncNoop, setDraft,
    coordination: { activeStreamRef: { current: null } }, goalActions: { handleSteerMidTurn: asyncNoop },
    oneShotContext: { consumeModelCouncilArming: noop, modelCouncilEnabledRef: { current: false },
      consumeWorkspaceSnapshotRequest: noop, workspaceSnapshotRequestRef: { current: null } },
    selection: { selectedSessionId: selectedId, selectedSessionRevisionRef: selection.selectedSessionRevisionRef }, pendingAttachments: pending, setPendingAttachments,
    sessionData: { prefs: { webMode: "auto", orchestrationReviewDepth: "off" } },
    conversationContext: { activeOutboundContext: null }, externalSourceAttachments: { selectedAttachmentIds: [] },
    pendingDocumentContextRefs: [], knowledgeUrlDraft: "", runVariables: { pendingTemplateInvocation: null },
    surfaceState: { messageMode: "chat" }, planningMode: "off", multimodal: media,
    errorState: { failedAutoImageRecovery: recovery, setFailedAutoImageRecovery: (value: typeof recovery) => {
      recoveryUpdates(value); setRecovery(value);
    } },
  } as unknown as Parameters<typeof useChatComposerSendIntent>[0];
  const send = useChatComposerSendIntent(sendInput);
  latest = { composer, media, send, draft, sending, pending, recovery, setDraft, select, selectedId, creation: creation.current, hydrateThread,
    selectionRevision: () => selection.selectedSessionRevisionRef.current, adoptRecord: () => setSessions({ items: [session, foreign] }) };
  return null;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function assertIdle() {
  expect(latest.media.imageBusy).toBe(false);
  expect(latest.composer.attachmentUpload.pending).toBe(0);
  expect(latest.sending).toBe(false);
}
function assertNoImageSuccess() {
  expect(notice.mock.calls.filter(([, tone]) => tone === "success")).toEqual([]);
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected unmocked request in first-session fixture"); }));
  resetChatSessionCreationForTests();
  lateConfirmation = undefined;
  setGatewayCallerScope("caller-a");
  Object.values(transport).forEach((mock) => mock.mockReset());
  transport.createChatSession.mockResolvedValue(session);
  transport.fetchChatSessionStatus.mockResolvedValue({ sessionId: session.sessionId, workspaceId: session.workspaceId });
  transport.generateLlmImage.mockResolvedValue({ operation: "generate", data: [{ b64Json: "aW1hZ2U=" }] });
  transport.uploadChatAttachment.mockResolvedValue(attachment);
  ordinarySend.mockClear(); notice.mockClear(); recoveryUpdates.mockClear(); sidebarCalls.mockClear(); sessionCreated.mockClear();
  sidebarGate = deferred<void>();
});
afterEach(async () => {
  await act(async () => { sidebarGate.resolve(undefined); renderer?.unmount(); }); renderer = undefined;
  await act(async () => resetChatSessionCreationForTests());
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("real first-session creation ownership through uploads and media", () => {
  it.each(["manual", "image", "auto"] as const)("continues %s upload through its own confirmed creation and real selection", async (action) => {
    const uploadResponse = deferred<ChatAttachmentRecord>();
    transport.uploadChatAttachment.mockReturnValue(uploadResponse.promise);
    await act(async () => { renderer = create(<Harness />); });
    expect(latest.selectedId).toBeNull();
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = action === "manual"
        ? latest.composer.uploadAttachments([new File(["manual"], "manual.txt")])
        : action === "image" ? latest.media.handleGenerateImage({ clearDraftOnSuccess: true, trigger: "auto_send" })
          : latest.send.handleSendWithKnowledge();
    });
    await vi.waitFor(() => expect(sidebarCalls).toHaveBeenCalledTimes(1));
    // The real ensureSession selected its confirmed owner before sidebar completion.
    expect(latest.selectedId).toBe(session.sessionId);
    expect(latest.creation).toEqual({ workspaceId: "workspace", sessionId: session.sessionId });
    expect(sessionCreated).toHaveBeenCalledWith(session);
    expect(sidebarCalls).toHaveBeenCalledWith("active", { bypassCache: true, preserveSelection: true });
    expect(transport.createChatSession).toHaveBeenCalledTimes(1);
    expect(transport.fetchChatSessionStatus).toHaveBeenCalledTimes(1);
    await act(async () => sidebarGate.resolve(undefined));
    // Allow the real sidebar adoption to commit before the upload response is confirmed.
    await act(async () => { uploadResponse.resolve(attachment); });
    let result: unknown;
    await act(async () => { result = await pending; });
    expect(latest.pending).toEqual([attachment]);
    expect(transport.uploadChatAttachment).toHaveBeenCalledTimes(1);
    expect(transport.uploadChatAttachment).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session.sessionId }));
    if (action === "manual") { expect(result).toBe(true); expect(latest.draft).toBe(prompt); }
    else {
      if (action === "image") expect(result).toBe(true);
      expect(latest.draft).toBe("");
      expect(transport.generateLlmImage).toHaveBeenCalledTimes(1);
      expect(notice).toHaveBeenCalledWith(expect.stringContaining("Detected image request"), "success");
      if (action === "auto") expect(latest.recovery).toBeNull();
    }
    assertIdle(); expect(ordinarySend).not.toHaveBeenCalled();
  });

  it.each(["navigation", "access"] as const)("does not treat explicit %s as its own session handoff", async (transition) => {
    await act(async () => { renderer = create(<Harness />); });
    let pending!: Promise<boolean>;
    await act(async () => { pending = latest.media.handleGenerateImage({ clearDraftOnSuccess: true }); });
    await vi.waitFor(() => expect(sidebarCalls).toHaveBeenCalledTimes(1));
    expect(latest.selectedId).toBe(session.sessionId);
    await act(async () => {
      if (transition === "navigation") latest.select(foreign.sessionId);
      else { notifyGatewayAccessChanged(false); renderer!.update(<Harness />); }
    });
    await act(async () => { sidebarGate.resolve(undefined); expect(await pending).toBe(false); });
    expect(latest.pending).toEqual([]); expect(latest.draft).toBe(prompt);
    assertNoImageSuccess(); assertIdle();
    expect(transport.createChatSession).toHaveBeenCalledTimes(1);
    expect(transport.uploadChatAttachment).not.toHaveBeenCalled();
    expect(ordinarySend).not.toHaveBeenCalled();
    if (transition === "navigation") expect(latest.selectedId).toBe(foreign.sessionId);
  });

  it.each(["thread-first", "record-first", "after-response"] as const)("retains exact own hydration when thread arrives %s", async (timing) => {
    const uploaded = deferred<ChatAttachmentRecord>();
    transport.uploadChatAttachment.mockReturnValue(uploaded.promise);
    await act(async () => { renderer = create(<Harness />); });
    let pending!: Promise<boolean>;
    await act(async () => { pending = latest.media.handleGenerateImage({ clearDraftOnSuccess: true, trigger: "auto_send" }); });
    await vi.waitFor(() => expect(sidebarCalls).toHaveBeenCalledTimes(1));
    expect(latest.media.imageBusy).toBe(true);
    if (timing === "thread-first") await act(async () => latest.hydrateThread(session.sessionId));
    await act(async () => sidebarGate.resolve(undefined));
    await vi.waitFor(() => expect(transport.uploadChatAttachment).toHaveBeenCalledTimes(1));
    if (timing === "record-first") await act(async () => latest.hydrateThread(session.sessionId));
    expect(latest.media.imageBusy).toBe(true);
    await act(async () => { uploaded.resolve(attachment); expect(await pending).toBe(true); });
    if (timing === "after-response") await act(async () => latest.hydrateThread(session.sessionId));
    expect(latest.pending).toEqual([attachment]); expect(latest.draft).toBe(""); assertIdle();
    expect(transport.createChatSession).toHaveBeenCalledTimes(1);
    expect(transport.generateLlmImage).toHaveBeenCalledTimes(1);
    expect(transport.uploadChatAttachment).toHaveBeenCalledTimes(1);
  });

  it.each(["upload", "sidebar"] as const)("keeps created-session recovery after actual %s failure without implicit resend", async (failure) => {
    if (failure === "upload") transport.uploadChatAttachment.mockRejectedValue(new Error("Upload response unavailable after creation"));
    await act(async () => { renderer = create(<Harness />); });
    let pending!: Promise<void>;
    await act(async () => { pending = latest.send.handleSendWithKnowledge(); });
    await vi.waitFor(() => expect(sidebarCalls).toHaveBeenCalledTimes(1));
    await act(async () => {
      if (failure === "sidebar") sidebarGate.reject(new Error("Sidebar response unavailable after confirmation"));
      else sidebarGate.resolve(undefined);
      await pending;
    });
    expect(latest.selectedId).toBe(session.sessionId); expect(latest.draft).toBe(prompt);
    expect(latest.pending).toEqual([]); expect(latest.recovery).toEqual({ prompt, sessionId: session.sessionId });
    expect(latest.composer.attachmentUpload.error).toContain(failure === "upload" ? "Upload response" : "Sidebar response");
    assertNoImageSuccess(); assertIdle(); expect(ordinarySend).not.toHaveBeenCalled();
    expect(transport.createChatSession).toHaveBeenCalledTimes(1);
    expect(transport.generateLlmImage).toHaveBeenCalledTimes(1);
    expect(transport.uploadChatAttachment).toHaveBeenCalledTimes(failure === "upload" ? 1 : 0);
    await act(async () => latest.send.handleSendRetainedPromptAsChat());
    expect(ordinarySend).toHaveBeenCalledTimes(1);
    expect(transport.generateLlmImage).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "workspace", "return", "repeat", "conflict", "late"] as const)("rejects %s confirmation corruption while real creator still owns selection", async (confirmation) => {
    await act(async () => { renderer = create(<Harness confirmation={confirmation} />); });
    let pending!: Promise<boolean>;
    await act(async () => { pending = latest.media.handleGenerateImage({ clearDraftOnSuccess: true }); });
    await vi.waitFor(() => expect(sidebarCalls).toHaveBeenCalledTimes(1));
    await act(async () => { sidebarGate.resolve(undefined); expect(await pending).toBe(false); });
    await act(async () => lateConfirmation?.());
    expect(latest.pending).toEqual([]); expect(latest.draft).toBe(prompt);
    expect(transport.uploadChatAttachment).not.toHaveBeenCalled();
    expect(transport.createChatSession).toHaveBeenCalledTimes(1);
    assertNoImageSuccess(); assertIdle();
  });

  it("ignores a saved confirmation after the successful operation completed", async () => {
    await act(async () => { renderer = create(<Harness confirmation="repeat-later" />); });
    let pending!: Promise<boolean>;
    await act(async () => { pending = latest.media.handleGenerateImage({ clearDraftOnSuccess: true }); });
    await vi.waitFor(() => expect(sidebarCalls).toHaveBeenCalledTimes(1));
    await act(async () => { sidebarGate.resolve(undefined); expect(await pending).toBe(true); });
    const before = notice.mock.calls.length;
    await act(async () => lateConfirmation?.());
    expect(latest.pending).toEqual([attachment]); expect(latest.draft).toBe("");
    expect(transport.uploadChatAttachment).toHaveBeenCalledTimes(1); expect(notice).toHaveBeenCalledTimes(before); assertIdle();
  });

  it.each(["before-confirmation", "during-sidebar", "during-upload"] as const)("rejects coalesced selection ABA %s using the real revision owner", async (timing) => {
    const created = deferred<ChatSessionRecord>();
    const uploaded = deferred<ChatAttachmentRecord>();
    if (timing === "before-confirmation") transport.createChatSession.mockReturnValue(created.promise);
    transport.uploadChatAttachment.mockReturnValue(uploaded.promise);
    await act(async () => { renderer = create(<Harness />); });
    let pending!: Promise<void>;
    await act(async () => { pending = latest.send.handleSendWithKnowledge(); });
    if (timing === "before-confirmation") await vi.waitFor(() => expect(transport.createChatSession).toHaveBeenCalledTimes(1));
    else await vi.waitFor(() => expect(sidebarCalls).toHaveBeenCalledTimes(1));
    if (timing === "during-upload") {
      await act(async () => sidebarGate.resolve(undefined));
      await vi.waitFor(() => expect(transport.uploadChatAttachment).toHaveBeenCalledTimes(1));
    }
    const before = latest.selectionRevision();
    await act(async () => {
      latest.select(foreign.sessionId);
      latest.select(timing === "before-confirmation" ? null : session.sessionId);
    });
    expect(latest.selectionRevision()).toBe(before + 2);
    await act(async () => { created.resolve(session); sidebarGate.resolve(undefined); uploaded.resolve(attachment); await pending; });
    expect(latest.pending).toEqual([]); expect(latest.draft).toBe(prompt); expect(latest.recovery).toBeNull();
    assertNoImageSuccess(); assertIdle(); expect(ordinarySend).not.toHaveBeenCalled();
    expect(transport.uploadChatAttachment).toHaveBeenCalledTimes(timing === "during-upload" ? 1 : 0);
    // Coalesced navigation intent must not let the stale creator restore a selected session.
    if (timing === "before-confirmation") expect(latest.selectedId).toBeNull();
  });

  it.each(["caller-aba", "access", "workspace", "gateway", "route", "navigation"] as const)("does not adopt upload or recovery after %s while upload is pending", async (change) => {
    const uploaded = deferred<ChatAttachmentRecord>();
    transport.uploadChatAttachment.mockReturnValue(uploaded.promise);
    await act(async () => { renderer = create(<Harness />); });
    let pending!: Promise<void>;
    await act(async () => { pending = latest.send.handleSendWithKnowledge(); });
    await vi.waitFor(() => expect(sidebarCalls).toHaveBeenCalledTimes(1));
    await act(async () => sidebarGate.resolve(undefined));
    await vi.waitFor(() => expect(transport.uploadChatAttachment).toHaveBeenCalledTimes(1));
    await act(async () => {
      if (change === "caller-aba") { setGatewayCallerScope("caller-b"); setGatewayCallerScope("caller-a"); renderer!.update(<Harness />); }
      if (change === "access") { notifyGatewayAccessChanged(false); renderer!.update(<Harness />); }
      if (change === "workspace") renderer!.update(<Harness workspaceId="foreign-workspace" />);
      if (change === "gateway") { vi.spyOn(gatewayCore, "getGatewayApiBaseUrl").mockReturnValue("http://different.invalid"); renderer!.update(<Harness />); }
      if (change === "route") renderer!.update(<Harness provider="google" />);
      if (change === "navigation") latest.select(foreign.sessionId);
    });
    await act(async () => { uploaded.resolve(attachment); await pending; });
    if (change !== "route") expect(latest.pending).toEqual([]);
    // A route change revokes media, while an already-dispatched uploader can still confirm its same selected attachment owner.
    expect(latest.draft).toBe(prompt); expect(latest.recovery).toBeNull(); assertNoImageSuccess(); assertIdle();
    expect(transport.uploadChatAttachment).toHaveBeenCalledTimes(1); expect(ordinarySend).not.toHaveBeenCalled();
  });

  it("keeps existing selected-ID placeholder hydration without requiring a creation callback", async () => {
    const uploaded = deferred<ChatAttachmentRecord>();
    transport.uploadChatAttachment.mockReturnValue(uploaded.promise);
    await act(async () => { renderer = create(<Harness />); });
    await act(async () => latest.select(session.sessionId));
    let pending!: Promise<boolean>;
    await act(async () => { pending = latest.media.handleGenerateImage({ clearDraftOnSuccess: true }); });
    await vi.waitFor(() => expect(transport.uploadChatAttachment).toHaveBeenCalledTimes(1));
    await act(async () => { latest.adoptRecord(); latest.hydrateThread(session.sessionId); });
    await act(async () => { uploaded.resolve(attachment); expect(await pending).toBe(true); });
    expect(latest.pending).toEqual([attachment]); expect(latest.draft).toBe(""); assertIdle();
    expect(transport.createChatSession).not.toHaveBeenCalled(); expect(transport.fetchChatSessionStatus).not.toHaveBeenCalled();
  });

  it("keeps a confirmed image upload through unchanged sidebar selection reconciliation", async () => {
    const uploaded = deferred<ChatAttachmentRecord>();
    transport.uploadChatAttachment.mockReturnValue(uploaded.promise);
    await act(async () => { renderer = create(<Harness />); });
    await act(async () => latest.select(session.sessionId));
    await act(async () => { latest.adoptRecord(); latest.hydrateThread(session.sessionId); });
    let pending!: Promise<boolean>;
    await act(async () => { pending = latest.media.handleGenerateImage(); });
    await vi.waitFor(() => expect(transport.uploadChatAttachment).toHaveBeenCalledTimes(1));
    await act(async () => latest.select((current) => current));
    let completed = false;
    await act(async () => { uploaded.resolve(attachment); completed = await pending; });
    expect(completed).toBe(true);
    expect(latest.pending).toEqual([attachment]);
    expect(latest.draft).toBe(prompt);
    assertIdle();
  });

  it("never revives a confirmed thread observation after it was lost", async () => {
    const uploaded = deferred<ChatAttachmentRecord>();
    transport.uploadChatAttachment.mockReturnValue(uploaded.promise);
    await act(async () => { renderer = create(<Harness />); });
    let pending!: Promise<boolean>;
    await act(async () => { pending = latest.media.handleGenerateImage({ clearDraftOnSuccess: true }); });
    await vi.waitFor(() => expect(sidebarCalls).toHaveBeenCalledTimes(1));
    await act(async () => { sidebarGate.resolve(undefined); latest.hydrateThread(session.sessionId); });
    await vi.waitFor(() => expect(transport.uploadChatAttachment).toHaveBeenCalledTimes(1));
    await act(async () => latest.hydrateThread(null));
    await act(async () => latest.hydrateThread(session.sessionId));
    await act(async () => { uploaded.resolve(attachment); expect(await pending).toBe(false); });
    expect(latest.draft).toBe(prompt); assertNoImageSuccess(); assertIdle();
  });

  it("keeps a newer upload busy and rejects the old response after navigation", async () => {
    const old = deferred<ChatAttachmentRecord>(); const newer = deferred<ChatAttachmentRecord>();
    transport.uploadChatAttachment.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise);
    await act(async () => { renderer = create(<Harness confirmation="repeat-later" />); });
    let first!: Promise<boolean>; let second!: Promise<boolean>;
    await act(async () => { first = latest.media.handleGenerateImage({ clearDraftOnSuccess: true }); });
    await vi.waitFor(() => expect(sidebarCalls).toHaveBeenCalledTimes(1));
    await act(async () => sidebarGate.resolve(undefined));
    await vi.waitFor(() => expect(transport.uploadChatAttachment).toHaveBeenCalledTimes(1));
    await act(async () => latest.select(foreign.sessionId));
    await act(async () => { second = latest.media.handleGenerateImage({ clearDraftOnSuccess: true }); });
    await vi.waitFor(() => expect(transport.uploadChatAttachment).toHaveBeenCalledTimes(2));
    await act(async () => lateConfirmation?.());
    expect(latest.media.imageBusy).toBe(true); expect(latest.sending).toBe(true);
    await act(async () => { old.resolve(attachment); expect(await first).toBe(false); });
    expect(latest.media.imageBusy).toBe(true); expect(latest.sending).toBe(true);
    await act(async () => { newer.resolve({ ...attachment, sessionId: foreign.sessionId, attachmentId: "newer" }); expect(await second).toBe(true); });
    expect(latest.pending.map((item) => item.attachmentId)).toEqual(["newer"]); assertIdle();
  });


  it.each(["unmount", "hide-reveal"] as const)("does not revive upload/image/recovery after %s", async (lifetime) => {
    const uploaded = deferred<ChatAttachmentRecord>();
    transport.uploadChatAttachment.mockReturnValue(uploaded.promise);
    await act(async () => { renderer = create(<React.Activity mode="visible"><Harness /></React.Activity>); });
    let pending!: Promise<void>;
    await act(async () => { pending = latest.send.handleSendWithKnowledge(); });
    await vi.waitFor(() => expect(sidebarCalls).toHaveBeenCalledTimes(1));
    await act(async () => sidebarGate.resolve(undefined));
    await vi.waitFor(() => expect(transport.uploadChatAttachment).toHaveBeenCalledTimes(1));
    const oldHandler = latest.media.handleGenerateImage;
    await act(async () => {
      if (lifetime === "unmount") { renderer!.unmount(); renderer = undefined; }
      else renderer!.update(<React.Activity mode="hidden"><Harness /></React.Activity>);
    });
    await act(async () => { uploaded.resolve(attachment); await pending; });
    if (lifetime === "hide-reveal") {
      await act(async () => renderer!.update(<React.Activity mode="visible"><Harness /></React.Activity>));
      expect(latest.pending).toEqual([]); expect(latest.draft).toBe(prompt); expect(latest.recovery).toBeNull(); assertIdle();
      await act(async () => { expect(await oldHandler()).toBe(false); });
    }
    assertNoImageSuccess(); expect(transport.uploadChatAttachment).toHaveBeenCalledTimes(1);
    expect(ordinarySend).not.toHaveBeenCalled();
  });

  it("preserves typing after confirmed creation while upload completes", async () => {
    const uploaded = deferred<ChatAttachmentRecord>();
    transport.uploadChatAttachment.mockReturnValue(uploaded.promise);
    await act(async () => { renderer = create(<Harness />); });
    let pending!: Promise<boolean>;
    await act(async () => { pending = latest.media.handleGenerateImage({ clearDraftOnSuccess: true }); });
    await vi.waitFor(() => expect(sidebarCalls).toHaveBeenCalledTimes(1));
    await act(async () => sidebarGate.resolve(undefined));
    await vi.waitFor(() => expect(transport.uploadChatAttachment).toHaveBeenCalledTimes(1));
    await act(async () => latest.setDraft("replacement authored during upload"));
    let completed = false;
    await act(async () => { uploaded.resolve(attachment); completed = await pending; });
    expect(completed).toBe(true);
    expect(latest.pending).toEqual([attachment]); expect(latest.draft).toBe("replacement authored during upload");
    expect(notice).toHaveBeenCalledWith("Generated image added to the draft attachments.", "success");
    assertIdle();
    expect(transport.generateLlmImage).toHaveBeenCalledTimes(1); expect(transport.uploadChatAttachment).toHaveBeenCalledTimes(1);
  });


  it("admits first auto-image after StrictMode effect rehearsal", async () => {
    await act(async () => { renderer = create(<React.StrictMode><Harness /></React.StrictMode>); });
    let pending!: Promise<void>;
    await act(async () => { pending = latest.send.handleSendWithKnowledge(); });
    await vi.waitFor(() => expect(sidebarCalls).toHaveBeenCalledTimes(1));
    await act(async () => { sidebarGate.resolve(undefined); await pending; });
    expect(latest.pending).toEqual([attachment]); expect(latest.draft).toBe(""); expect(latest.recovery).toBeNull();
    expect(transport.createChatSession).toHaveBeenCalledTimes(1);
    expect(transport.generateLlmImage).toHaveBeenCalledTimes(1); expect(transport.uploadChatAttachment).toHaveBeenCalledTimes(1); assertIdle();
  });

  it("never turns an unconfirmed creation into attachment success or an automatic retry", async () => {
    transport.fetchChatSessionStatus.mockRejectedValue(new Error("Independent creation read unavailable"));
    await act(async () => { renderer = create(<Harness />); });
    await act(async () => latest.send.handleSendWithKnowledge());
    expect(latest.selectedId).toBeNull(); expect(latest.creation).toBeNull();
    expect(latest.draft).toBe(prompt); expect(latest.pending).toEqual([]); assertNoImageSuccess(); assertIdle();
    expect(transport.createChatSession).toHaveBeenCalledTimes(1); expect(transport.fetchChatSessionStatus).toHaveBeenCalledTimes(1);
    expect(transport.uploadChatAttachment).not.toHaveBeenCalled(); expect(ordinarySend).not.toHaveBeenCalled();
    expect(sidebarCalls).not.toHaveBeenCalled();
  });

});
