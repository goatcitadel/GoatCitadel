import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

describe("mounted media owner code boundary", () => {
  it("keeps action-only API and encoding imports out of the mounted hook", () => {
    const source = readFileSync(new URL("./useChatMultimodalControls.ts", import.meta.url), "utf8");
    const eagerImports = [...source.matchAll(/^import\s+(?!type\b)[\s\S]*?\sfrom\s*["'][^"']+["'];/gm)]
      .map((match) => match[0]).join("\n");
    // Existing owner is the subject: no dependency on not-yet-created leaves.
    expect(eagerImports).not.toMatch(/\b(downloadChatAttachment|generateLlmImage|transcribeVoice|fileToBase64|startVoiceTalkSession|stopVoiceTalkSession|stopRealtimeVoiceSession)\b/);
  });
});
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({
  downloadChatAttachment: vi.fn(), generateLlmImage: vi.fn(), transcribeVoice: vi.fn(),
  fetchVoiceStatus: vi.fn(), fetchVoiceRuntimeStatus: vi.fn(),
  startVoiceTalkSession: vi.fn(), stopVoiceTalkSession: vi.fn(), stopRealtimeVoiceSession: vi.fn(),
}));
const encoding = vi.hoisted(() => ({ fileToBase64: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("../settings-page-utils", () => encoding);
let hook: typeof import("./useChatMultimodalControls");
let selectionOwner: typeof import("./controller/useChatSessionSelection");
let realSelection: ReturnType<typeof selectionOwner.useChatSessionSelection>;
let renderer: ReactTestRenderer | undefined;
let controls: ReturnType<typeof hook.useChatMultimodalControls>;
let draft: string;
let editDraft: React.Dispatch<React.SetStateAction<string>>;
let heldDraftUpdates: React.SetStateAction<string>[] = [];
let harnessRenders = 0;
const upload = vi.fn();
const error = vi.fn();
const notice = vi.fn();
function Harness({ session = "one", active = session, provider = "openai", attachments = [], holdDraftUpdates = false, deferVoiceReadiness }: { session?: string; active?: string; provider?: string; holdDraftUpdates?: boolean; attachments?: import("@goatcitadel/contracts").ChatAttachmentRecord[]; deferVoiceReadiness?: boolean }) {
  harnessRenders += 1;
  const [value, setValue] = useState("draw a console");
  draft = value;
  editDraft = setValue;
  controls = hook.useChatMultimodalControls({
    providerOptions: [
      { providerId: "openai", label: "OpenAI", models: ["gpt-image-2"] },
      { providerId: "google", label: "Google", models: ["gemini-3-pro-image-preview"] },
      ...(provider === "openai-codex" ? [{ providerId: provider, label: provider, models: ["gpt-image-2"] }] : []),
    ],
    selectedProviderId: provider, routePreflight: null, selectedSessionId: session, deferVoiceReadiness,
    activeThreadSessionId: active, pendingAttachments: attachments, draft: value,
    setDraft: holdDraftUpdates ? (update) => { heldDraftUpdates.push(update); } : setValue,
    setError: error, pushLocalNotice: notice, uploadAttachments: upload,
  });
  return null;
}
function RealSelectionHarness({ holdDraftUpdates = false }: { holdDraftUpdates?: boolean }) {
  harnessRenders += 1;
  realSelection = selectionOwner.useChatSessionSelection({ initialModeOverride: undefined });
  const [value, setValue] = useState("draw a console");
  draft = value; editDraft = setValue;
  controls = hook.useChatMultimodalControls({
    providerOptions: [{ providerId: "openai", label: "OpenAI", models: ["gpt-image-2"] }],
    selectedProviderId: "openai", routePreflight: null,
    selectedSessionId: realSelection.selectedSessionId,
    activeThreadSessionId: realSelection.selectedSessionId ?? undefined,
    selectionRevisionRef: realSelection.selectedSessionRevisionRef,
    pendingAttachments: [], draft: value,
    setDraft: holdDraftUpdates ? update => { heldDraftUpdates.push(update); } : setValue,
    setError: error, pushLocalNotice: notice, uploadAttachments: upload,
  });
  return null;
}
async function mountRealSelection(holdDraftUpdates = false) {
  await act(async () => { renderer = create(<RealSelectionHarness holdDraftUpdates={holdDraftUpdates} />); });
  await act(async () => realSelection.setSelectedSessionId("one"));
  expect(realSelection.selectedSessionId).toBe("one");
}
async function realSelectionRoundTrip() {
  const revision = realSelection.selectedSessionRevisionRef.current;
  await act(async () => {
    realSelection.setSelectedSessionId("two");
    realSelection.setSelectedSessionId("one");
  });
  expect(realSelection.selectedSessionId).toBe("one");
  expect(realSelection.selectedSessionRevisionRef.current).toBe(revision + 2);
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function files() { return { item: () => new File(["audio"], "note.wav", { type: "audio/wav" }) } as unknown as FileList; }

describe("media action code demand and scoped ownership", () => {
  beforeEach(async () => {
    heldDraftUpdates = []; harnessRenders = 0;
    vi.resetModules();
    Object.values(api).forEach((mock) => mock.mockReset());
    encoding.fileToBase64.mockReset().mockResolvedValue("YXVkaW8=");
    api.transcribeVoice.mockResolvedValue({ text: "transcript" });
    api.generateLlmImage.mockResolvedValue({ operation: "generate", data: [{ b64Json: "aW1hZ2U=" }] });
    api.fetchVoiceStatus.mockResolvedValue({ talk: { activeSessionId: null } });
    api.fetchVoiceRuntimeStatus.mockResolvedValue({ readiness: "ready" });
    upload.mockReset().mockResolvedValue(true); error.mockReset(); notice.mockReset();
    hook = await import("./useChatMultimodalControls");
    selectionOwner = await import("./controller/useChatSessionSelection");
  });
  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.doUnmock("./multimodal-image-code.js");
    vi.doUnmock("./multimodal-transcribe-code.js");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["image", "transcribe"] as const)("does not load %s code during mount or readiness refresh", async (kind) => {
    const loader = vi.spyOn(hook.multimodalCodeLoaders, kind);
    await act(async () => { renderer = create(<Harness />); });
    await act(async () => controls.onMediaControlsOpenChange(true));
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(api.fetchVoiceStatus).toHaveBeenCalled();
    expect(loader).not.toHaveBeenCalled();
    expect(api.generateLlmImage).not.toHaveBeenCalled();
    expect(encoding.fileToBase64).not.toHaveBeenCalled();
  });

  it("reads readiness without loading voice action code when the media disclosure opens", async () => {
    const talk = vi.spyOn(hook.multimodalCodeLoaders, "voiceApi");
    const realtime = vi.spyOn(hook.multimodalCodeLoaders, "realtime");
    await act(async () => { renderer = create(<Harness deferVoiceReadiness />); });
    expect(api.fetchVoiceStatus).not.toHaveBeenCalled();
    expect(api.fetchVoiceRuntimeStatus).not.toHaveBeenCalled();
    expect(realtime).not.toHaveBeenCalled();
    await act(async () => controls.onMediaControlsOpenChange(true));
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(controls.voiceInputAvailable).toBe(true);
    expect(api.fetchVoiceStatus).toHaveBeenCalledTimes(1);
    expect(api.fetchVoiceRuntimeStatus).toHaveBeenCalledTimes(1);
    expect(talk).not.toHaveBeenCalled();
    expect(realtime).not.toHaveBeenCalled();
  });

  it.each(["cancel", "selection", "access"] as const)("blocks realtime start on %s while loading its code", async (change) => {
    const start = vi.fn();
    const createOperation = vi.fn(() => ({ start, stop: vi.fn(), setMuted: vi.fn() }));
    const gate = deferred<Awaited<ReturnType<typeof hook.multimodalCodeLoaders.realtime>>>();
    const loader = vi.spyOn(hook.multimodalCodeLoaders, "realtime").mockReturnValue(gate.promise);
    vi.stubGlobal("window", { RTCPeerConnection: class {} });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn() } });
    vi.stubGlobal("document", { createElement: vi.fn() });
    await act(async () => { renderer = create(<Harness deferVoiceReadiness />); });
    let pending!: Promise<void>;
    await act(async () => { pending = controls.handleToggleLiveVoice(); });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(controls.liveVoiceState).toBe("connecting");
    if (change === "cancel") await act(async () => { await controls.handleToggleLiveVoice(); });
    if (change === "selection") await act(async () => renderer!.update(<Harness deferVoiceReadiness session="two" />));
    if (change === "access") {
      const access = await import("@goatcitadel/mission-control-shared/api/access-scope");
      access.notifyGatewayAccessChanged(false);
    }
    await act(async () => {
      gate.resolve({ createRealtimeVoiceOperation: createOperation });
      await pending;
    });
    expect(createOperation).not.toHaveBeenCalled();
    expect(controls.liveVoiceState).toBe("idle");
    expect(controls.voiceBusy).toBe(false);
  });

  it.each(["image", "transcribe"] as const)("holds real %s code, publishes busy immediately and bounds duplicate activation", async (kind) => {
    const gate = deferred<void>();
    let requested = false;
    const modulePath = kind === "image" ? "./multimodal-image-code.js" : "./multimodal-transcribe-code.js";
    vi.doMock(modulePath, async (importOriginal) => { requested = true; await gate.promise; return importOriginal(); });
    await act(async () => { renderer = create(<Harness />); });
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = kind === "image" ? controls.handleGenerateImage() : controls.handleAudioFileSelected(files());
      void (kind === "image" ? controls.handleGenerateImage() : controls.handleAudioFileSelected(files()));
    });
    await vi.waitFor(() => expect(requested).toBe(true));
    expect(kind === "image" ? controls.imageBusy : controls.voiceBusy).toBe(true);
    expect(api.generateLlmImage).not.toHaveBeenCalled();
    expect(encoding.fileToBase64).not.toHaveBeenCalled();
    await act(async () => { gate.resolve(); await pending; });
    expect(kind === "image" ? api.generateLlmImage : api.transcribeVoice).toHaveBeenCalledTimes(1);
    expect(kind === "image" ? controls.imageBusy : controls.voiceBusy).toBe(false);
    if (kind === "image") expect(upload).toHaveBeenCalledTimes(1);
    else expect(draft).toBe("draw a console\n\ntranscript");
  });

  it.each((["image", "transcribe"] as const).flatMap((kind) => (["session", "active", "route"] as const).map((transition) => [kind, transition] as const)))("fences delayed real %s code after %s changes", async (kind, transition) => {
    const gate = deferred<void>();
    let requested = false;
    const modulePath = kind === "image" ? "./multimodal-image-code.js" : "./multimodal-transcribe-code.js";
    vi.doMock(modulePath, async (importOriginal) => { requested = true; await gate.promise; return importOriginal(); });
    await act(async () => { renderer = create(<Harness />); });
    let pending!: Promise<unknown>;
    await act(async () => { pending = kind === "image" ? controls.handleGenerateImage() : controls.handleAudioFileSelected(files()); });
    await vi.waitFor(() => expect(requested).toBe(true));
    await act(async () => renderer!.update(<Harness
      session={transition === "session" ? "two" : "one"}
      active={transition === "active" ? "two" : "one"}
      provider={transition === "route" ? "google" : "openai"}
    />));
    await act(async () => { gate.resolve(); await pending; });
    expect(api.generateLlmImage).not.toHaveBeenCalled();
    expect(api.transcribeVoice).not.toHaveBeenCalled();
    expect(encoding.fileToBase64).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(draft).toBe("draw a console");
  });

  it.each(["image", "transcribe"] as const)("suppresses real %s code after unmount while loading", async (kind) => {
    const gate = deferred<void>();
    const modulePath = kind === "image" ? "./multimodal-image-code.js" : "./multimodal-transcribe-code.js";
    let requested = false;
    vi.doMock(modulePath, async (importOriginal) => { requested = true; await gate.promise; return importOriginal(); });
    await act(async () => { renderer = create(<Harness />); });
    let pending!: Promise<unknown>;
    await act(async () => { pending = kind === "image" ? controls.handleGenerateImage() : controls.handleAudioFileSelected(files()); });
    await vi.waitFor(() => expect(requested).toBe(true));
    await act(async () => { renderer!.unmount(); renderer = undefined; });
    await act(async () => { gate.resolve(); await pending; });
    expect(api.generateLlmImage).not.toHaveBeenCalled();
    expect(api.transcribeVoice).not.toHaveBeenCalled();
    expect(encoding.fileToBase64).not.toHaveBeenCalled();
  });

  it.each(["image", "transcribe"] as const)("retries a rejected %s loader and reuses fulfilled code without retaining action state", async (kind) => {
    const original = hook.multimodalCodeLoaders[kind];
    const loader = vi.spyOn(hook.multimodalCodeLoaders, kind).mockRejectedValueOnce(new Error("Media code could not load. Retry."));
    loader.mockImplementationOnce(original as never);
    await act(async () => { renderer = create(<Harness />); });
    await act(async () => { await (kind === "image" ? controls.handleGenerateImage() : controls.handleAudioFileSelected(files())); });
    expect(error).toHaveBeenCalledWith("Media code could not load. Retry.", ...(kind === "image" ? ["image_generate"] : []));
    expect(kind === "image" ? controls.imageBusy : controls.voiceBusy).toBe(false);
    await act(async () => { await (kind === "image" ? controls.handleGenerateImage() : controls.handleAudioFileSelected(files())); });
    await act(async () => { await (kind === "image" ? controls.handleGenerateImage() : controls.handleAudioFileSelected(files())); });
    expect(loader).toHaveBeenCalledTimes(2);
    expect(kind === "image" ? api.generateLlmImage : api.transcribeVoice).toHaveBeenCalledTimes(2);
  });

  it("does not dispatch transcription when the encoding belongs to an old session", async () => {
    const gate = deferred<string>();
    encoding.fileToBase64.mockReturnValue(gate.promise);
    await act(async () => { renderer = create(<Harness />); });
    let pending!: Promise<void>;
    await act(async () => { pending = controls.handleAudioFileSelected(files()); });
    await vi.waitFor(() => expect(encoding.fileToBase64).toHaveBeenCalledTimes(1));
    await act(async () => renderer!.update(<Harness session="two" />));
    await act(async () => { gate.resolve("YXVkaW8="); await pending; });
    expect(api.transcribeVoice).not.toHaveBeenCalled();
    expect(draft).toBe("draw a console");
  });

  it("appends transcription to ordinary same-session rewrites", async () => {
    const gate = deferred<string>();
    encoding.fileToBase64.mockReturnValue(gate.promise);
    await act(async () => { renderer = create(<Harness />); });
    let pending!: Promise<void>;
    await act(async () => { pending = controls.handleAudioFileSelected(files()); });
    await vi.waitFor(() => expect(encoding.fileToBase64).toHaveBeenCalledTimes(1));
    await act(async () => editDraft("rewritten while waiting"));
    await act(async () => { gate.resolve("YXVkaW8="); await pending; });
    expect(draft).toBe("rewritten while waiting\n\ntranscript");
  });

  it("keeps a newer operation busy when an old delayed owner settles", async () => {
    const gate = deferred<void>();
    const generation = deferred<{ operation: string; data: Array<{ b64Json: string }> }>();
    const original = hook.multimodalCodeLoaders.image;
    vi.spyOn(hook.multimodalCodeLoaders, "image").mockImplementation(() => gate.promise.then(original));
    api.generateLlmImage.mockReturnValue(generation.promise);
    await act(async () => { renderer = create(<Harness />); });
    let old!: Promise<boolean>; let newer!: Promise<boolean>;
    await act(async () => { old = controls.handleGenerateImage(); });
    await act(async () => renderer!.update(<Harness session="two" />));
    await act(async () => { newer = controls.handleGenerateImage(); });
    await act(async () => { gate.resolve(); await old; });
    await vi.waitFor(() => expect(api.generateLlmImage).toHaveBeenCalledTimes(1));
    expect(controls.imageBusy).toBe(true);
    await act(async () => { generation.resolve({ operation: "generate", data: [{ b64Json: "aW1hZ2U=" }] }); await newer; });
    expect(controls.imageBusy).toBe(false);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it.each(["absent", "upload"] as const)("preserves auto-send draft when %s fails after real delayed code", async (failure) => {
    const gate = deferred<void>();
    const original = hook.multimodalCodeLoaders.image;
    vi.spyOn(hook.multimodalCodeLoaders, "image").mockImplementation(() => gate.promise.then(original));
    if (failure === "absent") api.generateLlmImage.mockResolvedValue({ operation: "generate", data: [] });
    else upload.mockRejectedValue(new Error("upload failed"));
    await act(async () => { renderer = create(<Harness />); });
    let pending!: Promise<boolean>;
    await act(async () => { pending = controls.handleGenerateImage({ clearDraftOnSuccess: true, trigger: "auto_send" }); });
    await act(async () => { gate.resolve(); expect(await pending).toBe(false); });
    expect(draft).toBe("draw a console");
    expect(error).toHaveBeenLastCalledWith(failure === "absent" ? "Image generation returned no image payload." : "upload failed", "image_generate");
  });

  it.each([false, true])("clears auto-send draft only after successful current upload (edited=%s)", async (edited) => {
    const gate = deferred<void>();
    const uploaded = deferred<boolean>();
    const original = hook.multimodalCodeLoaders.image;
    vi.spyOn(hook.multimodalCodeLoaders, "image").mockImplementation(() => gate.promise.then(original));
    upload.mockReturnValue(uploaded.promise);
    await act(async () => { renderer = create(<Harness />); });
    let pending!: Promise<boolean>;
    await act(async () => { pending = controls.handleGenerateImage({ clearDraftOnSuccess: true, trigger: "auto_send" }); });
    await act(async () => { gate.resolve(); });
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(draft).toBe("draw a console");
    if (edited) await act(async () => editDraft("replacement draft"));
    await act(async () => { uploaded.resolve(true); await pending; });
    expect(draft).toBe(edited ? "replacement draft" : "");
  });

  it.each(["generate", "edit"] as const)("preserves %s reference payload semantics through delayed real code", async (mode) => {
    const gate = deferred<void>();
    const original = hook.multimodalCodeLoaders.image;
    vi.spyOn(hook.multimodalCodeLoaders, "image").mockImplementation(() => gate.promise.then(original));
    const read = vi.fn();
    vi.stubGlobal("FileReader", class {
      result = "data:image/webp;base64,cmVmZXJlbmNl";
      onload?: () => void;
      readAsDataURL(blob: Blob) { read(blob); this.onload?.(); }
    });
    api.downloadChatAttachment.mockResolvedValue({ blob: new Blob(["reference"]), fileName: "latest.webp", mimeType: "image/webp" });
    const attachment = (id: string) => ({ attachmentId: id, mimeType: "image/webp", mediaType: "image" }) as import("@goatcitadel/contracts").ChatAttachmentRecord;
    await act(async () => { renderer = create(<Harness attachments={[attachment("old"), attachment("latest")]} />); });
    let pending!: Promise<boolean>;
    await act(async () => { pending = mode === "generate" ? controls.handleGenerateImage() : controls.handleEditImage(); });
    expect(read).not.toHaveBeenCalled();
    expect(api.downloadChatAttachment).not.toHaveBeenCalled();
    await act(async () => { gate.resolve(); await pending; });
    if (mode === "edit") {
      expect(api.downloadChatAttachment).toHaveBeenCalledTimes(1);
      expect(api.downloadChatAttachment).toHaveBeenCalledWith("latest");
      expect(api.generateLlmImage).toHaveBeenCalledWith(expect.objectContaining({ referenceImages: [{ bytesBase64: "cmVmZXJlbmNl", fileName: "latest.webp", mimeType: "image/webp" }] }));
    } else {
      expect(api.downloadChatAttachment).not.toHaveBeenCalled();
      expect(api.generateLlmImage).toHaveBeenCalledWith(expect.objectContaining({ referenceImages: undefined }));
    }
  });

  it.each(["current", "stale", "edit", "codex", "unrelated"] as const)("limits Google fallback to current supported errors (%s)", async (outcome) => {
    const code = deferred<void>();
    const failure = deferred<never>();
    const original = hook.multimodalCodeLoaders.image;
    vi.spyOn(hook.multimodalCodeLoaders, "image").mockImplementation(() => code.promise.then(original));
    api.generateLlmImage.mockReturnValueOnce(failure.promise);
    await act(async () => { renderer = create(<Harness provider={outcome === "codex" ? "openai-codex" : "openai"} />); });
    let pending!: Promise<boolean>;
    await act(async () => { pending = outcome === "edit" ? controls.handleEditImage() : controls.handleGenerateImage(); });
    await act(async () => code.resolve());
    await vi.waitFor(() => expect(api.generateLlmImage).toHaveBeenCalledTimes(1));
    if (outcome === "stale") await act(async () => renderer!.update(<Harness session="two" />));
    await act(async () => { failure.reject(new Error(outcome === "unrelated" ? "offline" : "403 organization must be verified for gpt-image-2")); await pending; });
    expect(api.generateLlmImage).toHaveBeenCalledTimes(outcome === "current" ? 2 : 1);
    if (outcome === "current") expect(api.generateLlmImage).toHaveBeenLastCalledWith(expect.objectContaining({ providerId: "google", responseFormat: "b64_json" }));
  });


  it.each(["code", "encoding"] as const)("retires transcription after real coalesced selection ABA during %s and allows a fresh retry", async boundary => {
    const code = deferred<void>(); let requested = false;
    let finish!: () => void, holdEncoding = true;
    const read = vi.fn();
    if (boundary === "code") vi.doMock("./multimodal-transcribe-code.js", async importOriginal => {
      requested = true; await code.promise; return importOriginal();
    });
    else {
      encoding.fileToBase64.mockImplementation((await vi.importActual<typeof import("../settings-page-utils")>("../settings-page-utils")).fileToBase64);
      vi.stubGlobal("FileReader", class {
        result = "data:audio/wav;base64,YXVkaW8=";
        onload?: () => void;
        readAsDataURL(file: File) { read(file); if (holdEncoding) finish = () => this.onload?.(); else this.onload?.(); }
      });
    }
    await mountRealSelection();
    let pending!: Promise<void>;
    await act(async () => { pending = controls.handleAudioFileSelected(files()); });
    if (boundary === "code") await vi.waitFor(() => expect(requested).toBe(true));
    else await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await realSelectionRoundTrip();
    await act(async () => { if (boundary === "code") code.resolve(); else { holdEncoding = false; finish(); } await pending; });
    expect(api.transcribeVoice).not.toHaveBeenCalled();
    expect(draft).toBe("draw a console"); expect(notice).not.toHaveBeenCalled();
    expect(controls.voiceBusy).toBe(false);
    api.transcribeVoice.mockResolvedValue({ text: "fresh retry" });
    await act(async () => { await controls.handleAudioFileSelected(files()); });
    expect(api.transcribeVoice).toHaveBeenCalledTimes(1);
    expect(draft).toBe("draw a console\n\nfresh retry");
    expect(notice).toHaveBeenCalledTimes(1); expect(controls.voiceBusy).toBe(false);
  });

  it("retires old ABA busy ownership before completion and never lets its finally release a fresh transcription", async () => {
    const code = deferred<void>(), response = deferred<{ text: string }>(); let requested = false;
    vi.doMock("./multimodal-transcribe-code.js", async importOriginal => { requested = true; await code.promise; return importOriginal(); });
    api.transcribeVoice.mockReturnValue(response.promise);
    await mountRealSelection();
    let old!: Promise<void>, fresh!: Promise<void>;
    await act(async () => { old = controls.handleAudioFileSelected(files()); });
    try {
      await vi.waitFor(() => expect(requested).toBe(true));
      await realSelectionRoundTrip();
      expect(controls.voiceBusy).toBe(false);
      await act(async () => { fresh = controls.handleAudioFileSelected(files()); });
      expect(controls.voiceBusy).toBe(true);
      await act(async () => { code.resolve(); await old; });
      await vi.waitFor(() => expect(api.transcribeVoice).toHaveBeenCalledTimes(1));
      expect(controls.voiceBusy).toBe(true); expect(draft).toBe("draw a console");
      await act(async () => { response.resolve({ text: "fresh owner" }); await fresh; });
      expect(draft).toBe("draw a console\n\nfresh owner"); expect(notice).toHaveBeenCalledTimes(1);
      expect(controls.voiceBusy).toBe(false);
    } finally {
      await act(async () => { code.resolve(); response.resolve({ text: "cleanup response" }); await Promise.allSettled([old, fresh]); });
    }
  });

  it("does not publish an already-dispatched transcript or success notice after real selection ABA", async () => {
    const response = deferred<{ text: string }>(); api.transcribeVoice.mockReturnValue(response.promise);
    await mountRealSelection(); let pending!: Promise<void>;
    await act(async () => { pending = controls.handleAudioFileSelected(files()); });
    await vi.waitFor(() => expect(api.transcribeVoice).toHaveBeenCalledTimes(1));
    await realSelectionRoundTrip();
    await act(async () => { response.resolve({ text: "abandoned transcript" }); await pending; });
    expect(draft).toBe("draw a console"); expect(notice).not.toHaveBeenCalled(); expect(controls.voiceBusy).toBe(false);
    api.transcribeVoice.mockResolvedValue({ text: "fresh after response" });
    await act(async () => { await controls.handleAudioFileSelected(files()); });
    expect(draft).toBe("draw a console\n\nfresh after response"); expect(notice).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("fences queued transcript publication by live selection revision while preserving ordinary typing (ABA=%s)", async aba => {
    await mountRealSelection(true);
    await act(async () => { await controls.handleAudioFileSelected(files()); });
    expect(heldDraftUpdates).toHaveLength(1); expect(controls.voiceBusy).toBe(false);
    expect(notice).toHaveBeenCalledTimes(1); // Success occurred while this operation was still current.
    await act(async () => editDraft("ordinary rewritten draft"));
    if (aba) await realSelectionRoundTrip();
    await act(async () => editDraft(heldDraftUpdates[0]!));
    expect(draft).toBe(aba ? "ordinary rewritten draft" : "ordinary rewritten draft\n\ntranscript");
    expect(api.transcribeVoice).toHaveBeenCalledTimes(1); expect(notice).toHaveBeenCalledTimes(1);
  });

  it("uses the real held FileReader and suppresses old-session provider dispatch after encoding", async () => {
    encoding.fileToBase64.mockImplementation((await vi.importActual<typeof import("../settings-page-utils")>("../settings-page-utils")).fileToBase64);
    let finish!: () => void;
    const read = vi.fn();
    vi.stubGlobal("FileReader", class {
      result = "data:audio/wav;base64,YXVkaW8=";
      onload?: () => void;
      readAsDataURL(file: File) { read(file); finish = () => this.onload?.(); }
    });
    await act(async () => { renderer = create(<Harness />); });
    let pending!: Promise<void>;
    await act(async () => { pending = controls.handleAudioFileSelected(files()); });
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await act(async () => renderer!.update(<Harness session="two" />));
    await act(async () => { finish(); await pending; });
    expect(api.transcribeVoice).not.toHaveBeenCalled();
  });

  it("keeps no-file inert, defaults transcription MIME and resets the current file input", async () => {
    await act(async () => { renderer = create(<Harness />); });
    const input = { value: "note" };
    controls.audioInputRef.current = input as HTMLInputElement;
    await act(async () => { await controls.handleAudioFileSelected(null); });
    expect(encoding.fileToBase64).not.toHaveBeenCalled();
    expect(input.value).toBe("note");
    await act(async () => { await controls.handleAudioFileSelected({ item: () => new File(["audio"], "note") } as unknown as FileList); });
    expect(api.transcribeVoice).toHaveBeenCalledWith({ bytesBase64: "YXVkaW8=", mimeType: "audio/wav" });
    expect(input.value).toBe("");
    expect(api.fetchVoiceStatus).toHaveBeenCalledTimes(2);
  });

  it("does not dispatch an image action after its draft is replaced during code load", async () => {
    const gate = deferred<void>();
    const original = hook.multimodalCodeLoaders.image;
    vi.spyOn(hook.multimodalCodeLoaders, "image").mockImplementation(() => gate.promise.then(original));
    await act(async () => { renderer = create(<Harness />); });
    let pending!: Promise<boolean>;
    await act(async () => { pending = controls.handleGenerateImage({ clearDraftOnSuccess: true }); });
    await act(async () => editDraft("new draft"));
    await act(async () => { gate.resolve(); expect(await pending).toBe(false); });
    expect(api.generateLlmImage).not.toHaveBeenCalled();
    expect(draft).toBe("new draft");
    expect(controls.imageBusy).toBe(false);
  });

  it("rejects Google editing after lazy load without reading a reference", async () => {
    const gate = deferred<void>();
    const original = hook.multimodalCodeLoaders.image;
    vi.spyOn(hook.multimodalCodeLoaders, "image").mockImplementation(() => gate.promise.then(original));
    await act(async () => { renderer = create(<Harness provider="google" />); });
    let pending!: Promise<boolean>;
    await act(async () => { pending = controls.handleEditImage(); });
    await act(async () => { gate.resolve(); expect(await pending).toBe(false); });
    expect(api.downloadChatAttachment).not.toHaveBeenCalled();
    expect(api.generateLlmImage).not.toHaveBeenCalled();
    expect(error).toHaveBeenLastCalledWith("Image editing is unavailable on the current image route.", "image_edit");
  });


  it("does not read an image reference when ownership changes during download", async () => {
    const download = deferred<{ blob: Blob; fileName: string; mimeType: string }>();
    api.downloadChatAttachment.mockReturnValue(download.promise);
    const read = vi.fn();
    vi.stubGlobal("FileReader", class { readAsDataURL = read; });
    const attachment = { attachmentId: "reference", mimeType: "image/png", mediaType: "image" } as import("@goatcitadel/contracts").ChatAttachmentRecord;
    await act(async () => { renderer = create(<Harness attachments={[attachment]} />); });
    let pending!: Promise<boolean>;
    await act(async () => { pending = controls.handleEditImage(); });
    await vi.waitFor(() => expect(api.downloadChatAttachment).toHaveBeenCalledTimes(1));
    await act(async () => renderer!.update(<Harness session="two" />));
    await act(async () => { download.resolve({ blob: new Blob(["reference"]), fileName: "reference.png", mimeType: "image/png" }); expect(await pending).toBe(false); });
    expect(read).not.toHaveBeenCalled();
    expect(api.generateLlmImage).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });


  it("permanently retires transcription encoding across retained Activity credential custody changes", async () => {
    const access = await import("@goatcitadel/mission-control-shared/api/access-scope");
    access.setGatewayCallerScope("retained-transcription-caller-a");
    encoding.fileToBase64.mockImplementation((await vi.importActual<typeof import("../settings-page-utils")>("../settings-page-utils")).fileToBase64);
    let finish!: () => void, holdEncoding = true;
    const read = vi.fn();
    vi.stubGlobal("FileReader", class {
      result = "data:audio/wav;base64,YXVkaW8=";
      onload?: () => void;
      readAsDataURL(file: File) { read(file); if (holdEncoding) finish = () => this.onload?.(); else this.onload?.(); }
    });
    // Activity is present from the first mount: hiding must retain this exact selection owner.
    const retainedOwner = (mode: "visible" | "hidden") => <React.Activity mode={mode}><RealSelectionHarness /></React.Activity>;
    await act(async () => { renderer = create(retainedOwner("visible")); });
    await act(async () => realSelection.setSelectedSessionId("one"));
    const selectionRef = realSelection.selectedSessionRevisionRef;
    const revision = selectionRef.current;
    const callerRevision = access.getGatewayCallerScopeRevision();
    let pending!: Promise<void>;
    await act(async () => { pending = controls.handleAudioFileSelected(files()); });
    try {
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      expect(controls.voiceBusy).toBe(true);
      const errorsBeforeCustody = error.mock.calls.slice();
      await act(async () => {
        access.notifyGatewayAccessChanged(false);
        renderer!.update(retainedOwner("hidden"));
      });
      await act(async () => {
        // Replacement credentials authenticate the same principal, preserving CockpitApp's caller key.
        access.notifyGatewayAccessChanged(false);
        access.setGatewayCallerScope("retained-transcription-caller-a");
        renderer!.update(retainedOwner("visible"));
      });
      // Model the canonical interval before asynchronous sidebar reload completes. No selection change
      // or owner replacement is allowed to provide an accidental fence for this operation.
      expect(realSelection.selectedSessionRevisionRef).toBe(selectionRef);
      expect(realSelection.selectedSessionId).toBe("one");
      expect(selectionRef.current).toBe(revision);
      expect(access.getGatewayCallerScopeRevision()).toBe(callerRevision);
      await act(async () => { holdEncoding = false; finish(); await pending; });
      expect(api.transcribeVoice).not.toHaveBeenCalled();
      expect(draft).toBe("draw a console");
      expect(notice).not.toHaveBeenCalled(); expect(error.mock.calls).toEqual(errorsBeforeCustody);
      expect(controls.voiceBusy).toBe(false);
      api.transcribeVoice.mockResolvedValue({ text: "fresh retained retry" });
      await act(async () => { await controls.handleAudioFileSelected(files()); });
      expect(api.transcribeVoice).toHaveBeenCalledTimes(1);
      expect(draft).toBe("draw a console\n\nfresh retained retry");
      expect(notice).toHaveBeenCalledTimes(1); expect(controls.voiceBusy).toBe(false);
      expect(realSelection.selectedSessionRevisionRef).toBe(selectionRef);
      expect(selectionRef.current).toBe(revision);
    } finally {
      await act(async () => { holdEncoding = false; finish?.(); await pending; });
    }
  });

  it.each(["access", "caller-aba", "gateway"] as const)("checks live %s authority inside an already-queued transcript updater", async authority => {
    const access = await import("@goatcitadel/mission-control-shared/api/access-scope");
    const gateway = await import("@goatcitadel/mission-control-shared/api/client-core");
    access.setGatewayCallerScope("queued-transcription-caller-a");
    await mountRealSelection(true);
    await act(async () => { await controls.handleAudioFileSelected(files()); });
    // The mocked API already fulfilled while current. This is publication custody, not an
    // in-flight transport response claim: real client-core separately fences stale responses.
    expect(api.transcribeVoice).toHaveBeenCalledTimes(1);
    expect(heldDraftUpdates).toHaveLength(1); expect(typeof heldDraftUpdates[0]).toBe("function");
    expect(controls.voiceBusy).toBe(false); expect(notice).toHaveBeenCalledTimes(1);
    await act(async () => editDraft("ordinary rewritten draft"));
    const selectionRef = realSelection.selectedSessionRevisionRef;
    const revision = selectionRef.current;
    const rendersBeforeDeparture = harnessRenders;
    if (authority === "access") access.notifyGatewayAccessChanged(false);
    if (authority === "caller-aba") {
      access.setGatewayCallerScope("queued-transcription-caller-b");
      access.setGatewayCallerScope("queued-transcription-caller-a");
    }
    if (authority === "gateway") vi.spyOn(gateway, "getGatewayApiBaseUrl").mockReturnValue("http://different-queued-transcription.invalid");
    expect(harnessRenders).toBe(rendersBeforeDeparture);
    expect(realSelection.selectedSessionRevisionRef).toBe(selectionRef);
    expect(selectionRef.current).toBe(revision);
    // Invoke the actual captured functional updater before any owner rerender can retire it.
    await act(async () => editDraft(heldDraftUpdates[0]!));
    expect(draft).toBe("ordinary rewritten draft");
    expect(api.transcribeVoice).toHaveBeenCalledTimes(1); expect(notice).toHaveBeenCalledTimes(1);
    expect(controls.voiceBusy).toBe(false);
  });

  it.each(["current", "access", "caller-aba", "gateway"] as const)("checks %s authority when the actual held draft updater runs after finally", async (authority) => {
    const access = await import("@goatcitadel/mission-control-shared/api/access-scope");
    const gateway = await import("@goatcitadel/mission-control-shared/api/client-core");
    access.setGatewayCallerScope("deferred-clear-caller-a");
    await act(async () => { renderer = create(<Harness holdDraftUpdates />); });
    await act(async () => {
      expect(await controls.handleGenerateImage({ clearDraftOnSuccess: true, trigger: "auto_send" })).toBe(true);
    });
    // The real action and its finally have completed, but its real functional clear is still queued.
    expect(controls.imageBusy).toBe(false);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(api.generateLlmImage).toHaveBeenCalledTimes(1);
    expect(heldDraftUpdates).toHaveLength(1);
    expect(typeof heldDraftUpdates[0]).toBe("function");
    expect(draft).toBe("draw a console");
    const rendersAfterFinally = harnessRenders;
    if (authority === "access") access.notifyGatewayAccessChanged(false);
    if (authority === "caller-aba") {
      access.setGatewayCallerScope("deferred-clear-caller-b");
      access.setGatewayCallerScope("deferred-clear-caller-a");
    }
    if (authority === "gateway") vi.spyOn(gateway, "getGatewayApiBaseUrl").mockReturnValue("http://different-deferred-clear.invalid");
    // No rerender may pre-revoke the ticket: publication itself must read the live authority.
    expect(harnessRenders).toBe(rendersAfterFinally);
    await act(async () => editDraft(heldDraftUpdates[0]!));
    expect(draft).toBe(authority === "current" ? "" : "draw a console");
    expect(controls.imageBusy).toBe(false);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(api.generateLlmImage).toHaveBeenCalledTimes(1);
  });

});
