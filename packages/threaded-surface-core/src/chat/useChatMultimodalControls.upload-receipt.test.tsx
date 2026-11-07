import React, { useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachmentRecord, ChatSessionRecord } from "@goatcitadel/contracts";
import { notifyGatewayAccessChanged } from "@goatcitadel/mission-control-shared/api/access-scope";
import { useChatComposerInteractions } from "./useChatComposerInteractions";
import { useChatMultimodalControls } from "./useChatMultimodalControls";
import { useChatComposerSendIntent } from "./controller/useChatComposerSendIntent";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const transport = vi.hoisted(() => ({
  generateLlmImage: vi.fn(), uploadChatAttachment: vi.fn(), fetchVoiceStatus: vi.fn(), fetchVoiceRuntimeStatus: vi.fn(),
  startVoiceTalkSession: vi.fn(), stopVoiceTalkSession: vi.fn(), stopRealtimeVoiceSession: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => transport);

const prompt = "Draw an image of a moonlit citadel";
const session = { sessionId: "existing-chat", workspaceId: "workspace", projectId: "project" } as ChatSessionRecord;
const attachment: ChatAttachmentRecord = {
  attachmentId: "generated-receipt", sessionId: session.sessionId, workspaceId: "workspace", projectId: "project",
  fileName: "generated.png", mimeType: "image/png", mediaType: "image", sizeBytes: 5, sha256: "fixture-sha",
  storageRelPath: "fixtures/generated.png", extractStatus: "ready", createdAt: "2026-11-04T00:00:00Z",
};
const ensureSession = vi.fn(async () => session);
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
};
function Harness({ sessionId = session.sessionId, initialSending = false }: { sessionId?: string; initialSending?: boolean }) {
  const [draft, setDraft] = useState(prompt);
  const [sending, setSending] = useState(initialSending);
  const [pending, setPendingAttachments] = useState<ChatAttachmentRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<{ prompt: string; sessionId: string | null } | null>(null);
  const [, setCommandIndex] = useState(0);
  const [, setDockOpen] = useState(false);
  const composer = useChatComposerInteractions({
    draft, commandSuggestions: [], commandIndex: 0, error, dockOpen: false, sending,
    selectedSession: sessionId === session.sessionId ? session : { ...session, sessionId }, messageMode: "chat",
    ensureSession, handleSend: ordinarySend, handleCreateSession: asyncNoop,
    handleArchiveWorkspaceMissionChats: asyncNoop, handleRunQuickResearch: asyncNoop, handlePrefPatch: asyncNoop,
    handleTogglePlanningMode: noop, handleRevealSelectedTurnDetails: noop,
    confirmCapabilitySuggestionAction: asyncNoop, confirmDeleteSession: asyncNoop,
    setSending, setError, setDraft, setCommandIndex, setPendingAttachments,
    setIsDragActive: noop, setEditingTurnId: noop, setDockOpen, setArchiveWorkspaceConfirmOpen: noop,
  });
  const media = useChatMultimodalControls({
    deferVoiceReadiness: true,
    providerOptions: [{ providerId: "openai", label: "OpenAI", models: ["gpt-image-2"] }],
    selectedProviderId: "openai", routePreflight: null, selectedSessionId: sessionId, activeThreadSessionId: sessionId,
    pendingAttachments: pending, draft, setDraft, setError, pushLocalNotice: notice,
    // Exact production wiring: the real uploader catches transport errors itself.
    uploadAttachments: composer.uploadAttachments,
  });
  const sendInput = {
    workspaceId: "workspace", profileDependentAdmissionBlockReason: undefined,
    notices: { pushLocalNotice: notice }, setFollowThreadOutput: noop,
    knowledgeActions: { requiresThreadKnowledge: false, attachPendingKnowledgeSources: asyncNoop },
    orchestration: { handleSend: ordinarySend, setQueuedOutbound: noop, editingTurnId: null },
    scopedErrors: { setUiError: setError }, draft, openBtwSideChat: asyncNoop, setDraft,
    coordination: { activeStreamRef: { current: null } }, goalActions: { handleSteerMidTurn: asyncNoop },
    oneShotContext: { consumeModelCouncilArming: noop, modelCouncilEnabledRef: { current: false },
      consumeWorkspaceSnapshotRequest: noop, workspaceSnapshotRequestRef: { current: null } },
    selection: { selectedSessionId: sessionId }, pendingAttachments: pending, setPendingAttachments,
    sessionData: { prefs: { webMode: "auto", orchestrationReviewDepth: "off" } },
    conversationContext: { activeOutboundContext: null }, externalSourceAttachments: { selectedAttachmentIds: [] },
    pendingDocumentContextRefs: [], knowledgeUrlDraft: "", runVariables: { pendingTemplateInvocation: null },
    surfaceState: { messageMode: "chat" }, planningMode: "off", multimodal: media,
    errorState: { failedAutoImageRecovery: recovery, setFailedAutoImageRecovery: (value: typeof recovery) => {
      recoveryUpdates(value); setRecovery(value);
    } },
  } as unknown as Parameters<typeof useChatComposerSendIntent>[0];
  const send = useChatComposerSendIntent(sendInput);
  latest = { composer, media, send, draft, sending, pending, recovery, setDraft };
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
  Object.values(transport).forEach((mock) => mock.mockReset());
  transport.generateLlmImage.mockResolvedValue({ operation: "generate", data: [{ b64Json: "aW1hZ2U=" }] });
  transport.uploadChatAttachment.mockResolvedValue(attachment);
  ensureSession.mockClear(); ordinarySend.mockClear(); notice.mockClear(); recoveryUpdates.mockClear();
});
afterEach(async () => { await act(async () => renderer?.unmount()); renderer = undefined; });

describe("real composer upload receipts consumed by media and send intent", () => {
  it.each(["direct", "send"] as const)("retains prompt and uploader error after rejected transport (%s)", async (action) => {
    transport.uploadChatAttachment.mockRejectedValue(new Error("Attachment response unavailable"));
    await act(async () => { renderer = create(<Harness />); });
    let result: boolean | undefined;
    await act(async () => {
      if (action === "direct") result = await latest.media.handleGenerateImage({ clearDraftOnSuccess: true, trigger: "auto_send" });
      else await latest.send.handleSendWithKnowledge();
    });
    // Assert shared user-visible state first so auto-send independently catches prompt loss.
    expect(latest.draft).toBe(prompt);
    expect(latest.pending).toEqual([]);
    expect(latest.composer.attachmentUpload.error).toBe("Attachment response unavailable");
    assertNoImageSuccess(); assertIdle();
    expect(transport.generateLlmImage).toHaveBeenCalledTimes(1);
    expect(transport.uploadChatAttachment).toHaveBeenCalledTimes(1);
    expect(ordinarySend).not.toHaveBeenCalled();
    if (action === "direct") expect(result).toBe(false);
    else expect(latest.recovery).toEqual({ prompt, sessionId: session.sessionId });
  });

  it.each(["direct", "send"] as const)("accepts positive current upload receipt and clears admitted prompt (%s)", async (action) => {
    await act(async () => { renderer = create(<Harness />); });
    let result: boolean | undefined;
    await act(async () => {
      if (action === "direct") result = await latest.media.handleGenerateImage({ clearDraftOnSuccess: true, trigger: "auto_send" });
      else await latest.send.handleSendWithKnowledge();
    });
    expect(latest.pending).toEqual([attachment]);
    expect(latest.draft).toBe("");
    expect(latest.composer.attachmentUpload.error).toBeNull();
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("Detected image request"), "success");
    assertIdle();
    expect(transport.generateLlmImage).toHaveBeenCalledTimes(1);
    expect(transport.uploadChatAttachment).toHaveBeenCalledTimes(1);
    expect(ordinarySend).not.toHaveBeenCalled();
    if (action === "direct") expect(result).toBe(true);
    else { expect(latest.recovery).toBeNull(); expect(recoveryUpdates).toHaveBeenLastCalledWith(null); }
  });

  it("declines a real sending admission without claiming a generated attachment", async () => {
    await act(async () => { renderer = create(<Harness initialSending />); });
    let result!: boolean;
    await act(async () => { result = await latest.media.handleGenerateImage({ clearDraftOnSuccess: true }); });
    expect(result).toBe(false);
    expect(latest.draft).toBe(prompt);
    expect(latest.pending).toEqual([]);
    assertNoImageSuccess();
    expect(transport.generateLlmImage).toHaveBeenCalledTimes(1);
    expect(transport.uploadChatAttachment).not.toHaveBeenCalled();
    expect(latest.sending).toBe(true);
    expect(latest.media.imageBusy).toBe(false);
  });

  it("leaves the real already-owned upload untouched when image upload is declined", async () => {
    const gate = deferred<ChatAttachmentRecord>();
    transport.uploadChatAttachment.mockReturnValue(gate.promise);
    await act(async () => { renderer = create(<Harness />); });
    let existing!: ReturnType<typeof latest.composer.uploadAttachments>;
    await act(async () => { existing = latest.composer.uploadAttachments([new File(["manual"], "manual.txt")]); });
    await vi.waitFor(() => expect(transport.uploadChatAttachment).toHaveBeenCalledTimes(1));
    let result!: boolean;
    await act(async () => { result = await latest.media.handleGenerateImage({ clearDraftOnSuccess: true }); });
    try {
      expect(result).toBe(false);
      expect(latest.draft).toBe(prompt);
      expect(latest.pending).toEqual([]);
      expect(latest.sending).toBe(true);
      expect(latest.composer.attachmentUpload.pending).toBe(1);
      expect(transport.uploadChatAttachment).toHaveBeenCalledTimes(1);
      assertNoImageSuccess();
    } finally {
      await act(async () => { gate.resolve(attachment); await existing; });
    }
    expect(latest.pending).toEqual([attachment]); assertIdle();
  });

  it.each(["session", "access"] as const)("does not accept an old upload response after %s ownership changes", async (transition) => {
    const gate = deferred<ChatAttachmentRecord>();
    transport.uploadChatAttachment.mockReturnValue(gate.promise);
    await act(async () => { renderer = create(<Harness />); });
    let pending!: Promise<boolean>;
    await act(async () => { pending = latest.media.handleGenerateImage({ clearDraftOnSuccess: true }); });
    await vi.waitFor(() => expect(transport.uploadChatAttachment).toHaveBeenCalledTimes(1));
    await act(async () => {
      if (transition === "session") renderer!.update(<Harness sessionId="replacement-chat" />);
      else { notifyGatewayAccessChanged(false); renderer!.update(<Harness />); }
    });
    await act(async () => { gate.resolve(attachment); expect(await pending).toBe(false); });
    expect(latest.pending).toEqual([]); expect(latest.draft).toBe(prompt);
    assertNoImageSuccess(); assertIdle();
    expect(transport.generateLlmImage).toHaveBeenCalledTimes(1);
    expect(transport.uploadChatAttachment).toHaveBeenCalledTimes(1);
  });

  it("preserves replacement text while a confirmed upload completes without retry", async () => {
    const gate = deferred<ChatAttachmentRecord>();
    transport.uploadChatAttachment.mockReturnValue(gate.promise);
    await act(async () => { renderer = create(<Harness />); });
    let pending!: Promise<boolean>;
    await act(async () => { pending = latest.media.handleGenerateImage({ clearDraftOnSuccess: true }); });
    await vi.waitFor(() => expect(transport.uploadChatAttachment).toHaveBeenCalledTimes(1));
    await act(async () => latest.setDraft("replacement text"));
    await act(async () => { gate.resolve(attachment); await pending; });
    expect(latest.pending).toEqual([attachment]); expect(latest.draft).toBe("replacement text");
    assertIdle();
    expect(transport.generateLlmImage).toHaveBeenCalledTimes(1);
    expect(transport.uploadChatAttachment).toHaveBeenCalledTimes(1);
  });

  it("reports multi-file rejection as unconfirmed without retry or a rollback claim", async () => {
    transport.uploadChatAttachment.mockResolvedValueOnce(attachment).mockRejectedValueOnce(new Error("Second upload response unavailable"));
    await act(async () => { renderer = create(<Harness />); });
    let result: unknown;
    await act(async () => { result = await latest.composer.uploadAttachments([new File(["one"], "one.txt"), new File(["two"], "two.txt")]); });
    expect(result).toBe(false);
    expect(latest.pending).toEqual([]);
    expect(latest.composer.attachmentUpload.error).toBe("Second upload response unavailable");
    expect(transport.uploadChatAttachment).toHaveBeenCalledTimes(2);
    expect(transport.generateLlmImage).not.toHaveBeenCalled();
    assertIdle();
  });
});
