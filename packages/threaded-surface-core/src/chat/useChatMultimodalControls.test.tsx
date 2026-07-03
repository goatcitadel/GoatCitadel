import React, { useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachmentRecord } from "@goatcitadel/contracts";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  downloadChatAttachment: vi.fn(),
  fetchVoiceRuntimeStatus: vi.fn(),
  fetchVoiceStatus: vi.fn(),
  generateLlmImage: vi.fn(),
  startVoiceTalkSession: vi.fn(),
  stopVoiceTalkSession: vi.fn(),
  transcribeVoice: vi.fn(),
}));

const helperMocks = vi.hoisted(() => ({
  fileToBase64: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  downloadChatAttachment: apiMocks.downloadChatAttachment,
  fetchVoiceRuntimeStatus: apiMocks.fetchVoiceRuntimeStatus,
  fetchVoiceStatus: apiMocks.fetchVoiceStatus,
  generateLlmImage: apiMocks.generateLlmImage,
  startVoiceTalkSession: apiMocks.startVoiceTalkSession,
  stopVoiceTalkSession: apiMocks.stopVoiceTalkSession,
  transcribeVoice: apiMocks.transcribeVoice,
}));

vi.mock("../settings-page-utils", () => ({
  fileToBase64: helperMocks.fileToBase64,
}));

import { useChatMultimodalControls } from "./useChatMultimodalControls";

const openaiProvider = {
  providerId: "openai",
  label: "OpenAI",
  defaultModel: "gpt-image-1",
  models: ["gpt-5.5"],
  capabilities: { imageGenerate: true, imageEdit: true, voiceInput: true, voiceOutput: true },
};

const googleProvider = {
  providerId: "google",
  label: "Google",
  models: ["gemini-3-pro-image-preview"],
  capabilities: { imageGenerate: true, voiceInput: true, voiceOutput: true },
};

interface HarnessApi {
  controls: ReturnType<typeof useChatMultimodalControls>;
  snapshot: () => {
    draft: string;
    uploadedFiles: File[][];
    errors: Array<{ value: string | null; source?: string }>;
    notices: Array<{ message: string; tone?: string }>;
  };
}

let latest: HarnessApi | null = null;
let localStorageState = new Map<string, string>();
const speechSynthesis = {
  cancel: vi.fn(),
  speak: vi.fn(),
};

class FakeFileReader {
  result: string | ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readAsDataURL() {
    this.result = "data:image/png;base64,aW1hZ2U=";
    this.onload?.();
  }
}

function installWindow() {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => localStorageState.get(key) ?? null,
        setItem: (key: string, value: string) => {
          localStorageState.set(key, value);
        },
      },
      speechSynthesis,
      SpeechSynthesisUtterance: class {
        text: string;
        constructor(text: string) {
          this.text = text;
        }
      },
    },
  });
  Object.defineProperty(globalThis, "FileReader", {
    configurable: true,
    value: FakeFileReader,
  });
  Object.defineProperty(globalThis, "atob", {
    configurable: true,
    value: (value: string) => Buffer.from(value, "base64").toString("binary"),
  });
}

function Harness(props: {
  draft?: string;
  providerOptions?: (typeof openaiProvider)[];
  selectedProviderId?: string | null;
  routePreflight?: any;
  selectedSessionId?: string | null;
  activeThreadSessionId?: string | null;
  pendingAttachments?: ChatAttachmentRecord[];
  latestAssistantMessageId?: string;
  latestAssistantContent?: string;
  latestAssistantStatus?: "completed" | "running";
  preferredImageProviderId?: string;
  preferredImageModel?: string;
}) {
  const [draft, setDraft] = useState(props.draft ?? "draw a launch console");
  const uploadedFilesRef = React.useRef<File[][]>([]);
  const errorsRef = React.useRef<Array<{ value: string | null; source?: string }>>([]);
  const noticesRef = React.useRef<Array<{ message: string; tone?: string }>>([]);
  const controls = useChatMultimodalControls({
    providerOptions: (props.providerOptions ?? [openaiProvider, googleProvider]) as never,
    selectedProviderId: props.selectedProviderId === undefined ? "openai" : (props.selectedProviderId ?? undefined),
    preferredImageProviderId: props.preferredImageProviderId,
    preferredImageModel: props.preferredImageModel,
    routePreflight: props.routePreflight ?? null,
    selectedSessionId: props.selectedSessionId === undefined ? "session-1" : props.selectedSessionId,
    activeThreadSessionId: props.activeThreadSessionId === undefined ? "session-1" : props.activeThreadSessionId,
    pendingAttachments: props.pendingAttachments ?? [],
    draft,
    latestAssistantMessageId: props.latestAssistantMessageId ?? "assistant-1",
    latestAssistantContent: props.latestAssistantContent ?? "Ready",
    latestAssistantStatus: props.latestAssistantStatus ?? "completed",
    setDraft,
    setError: (value, source) => {
      errorsRef.current.push({ value, source });
    },
    pushLocalNotice: (message, tone) => {
      noticesRef.current.push({ message, tone });
    },
    uploadAttachments: async (files) => {
      uploadedFilesRef.current.push(files);
    },
  });

  latest = {
    controls,
    snapshot: () => ({
      draft,
      uploadedFiles: uploadedFilesRef.current,
      errors: errorsRef.current,
      notices: noticesRef.current,
    }),
  };
  return null;
}

async function flushAsyncEffects(cycles = 4) {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve();
  }
}

describe("useChatMultimodalControls", () => {
  beforeEach(() => {
    latest = null;
    localStorageState = new Map([["goatcitadel.chat.speak-replies.enabled", "true"]]);
    speechSynthesis.cancel.mockClear();
    speechSynthesis.speak.mockClear();
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    helperMocks.fileToBase64.mockReset();
    installWindow();
    apiMocks.fetchVoiceStatus.mockResolvedValue({ talk: { activeSessionId: null } });
    apiMocks.fetchVoiceRuntimeStatus.mockResolvedValue({ readiness: "ready", selectedModelId: "whisper-local" });
    apiMocks.startVoiceTalkSession.mockResolvedValue({});
    apiMocks.stopVoiceTalkSession.mockResolvedValue({});
    helperMocks.fileToBase64.mockResolvedValue("audio-bytes");
    apiMocks.transcribeVoice.mockResolvedValue({ text: "transcribed audio" });
    apiMocks.generateLlmImage.mockResolvedValue({
      operation: "generate",
      data: [{ b64Json: "aW1hZ2U=" }],
    });
    apiMocks.downloadChatAttachment.mockResolvedValue({
      blob: new Blob(["image"], { type: "image/png" }),
      fileName: "input.png",
      mimeType: "image/png",
    });
  });

  it("hydrates voice state, stores speech preference, and speaks new completed assistant replies", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
      await flushAsyncEffects();
    });

    expect(latest!.controls.voiceInputAvailable).toBe(true);
    expect(latest!.controls.voiceOutputAvailable).toBe(true);
    expect(latest!.controls.voiceStatusLabel).toBe("Voice ready · whisper-local");

    act(() => {
      latest!.controls.setSpeakResponsesEnabled(false);
    });
    expect(localStorageState.get("goatcitadel.chat.speak-replies.enabled")).toBe("false");

    act(() => {
      latest!.controls.setSpeakResponsesEnabled(true);
    });
    await act(async () => {
      renderer.update(
        <Harness
          latestAssistantMessageId="assistant-2"
          latestAssistantContent="The run is complete."
          latestAssistantStatus="completed"
        />,
      );
      await flushAsyncEffects();
    });
    expect(speechSynthesis.speak).toHaveBeenCalledTimes(1);
  });

  it("starts and stops push-to-talk while refreshing voice status", async () => {
    const activeStatus = { talk: { activeSessionId: "talk-1" } };
    apiMocks.fetchVoiceStatus
      .mockResolvedValueOnce({ talk: { activeSessionId: null } })
      .mockResolvedValue(activeStatus);
    await act(async () => {
      create(<Harness />);
      await flushAsyncEffects();
    });

    await act(async () => {
      await latest!.controls.handleToggleVoiceTalk();
      await flushAsyncEffects();
    });
    expect(apiMocks.startVoiceTalkSession).toHaveBeenCalledWith({
      mode: "push_to_talk",
      sessionId: "session-1",
    });
    expect(latest!.snapshot().notices).toContainEqual({
      message: "Push-to-talk session started.",
      tone: "success",
    });

    await act(async () => {
      await latest!.controls.handleToggleVoiceTalk();
      await flushAsyncEffects();
    });
    expect(apiMocks.stopVoiceTalkSession).toHaveBeenCalledWith("talk-1");
  });

  it("treats a partial voice status without talk as inactive instead of crashing", async () => {
    // Well-formed-but-partial gateway response: a stub gateway can return {}
    // for the voice status endpoint, so `talk` may be absent at runtime even
    // though the contract type declares it required.
    apiMocks.fetchVoiceStatus.mockResolvedValue({});
    await act(async () => {
      create(<Harness />);
      await flushAsyncEffects();
    });

    expect(latest!.controls.voiceTalkActive).toBe(false);
    expect(latest!.controls.voiceStatusLabel).toBe("Voice ready · whisper-local");
  });

  it("starts a fresh push-to-talk session when the partial voice status omits talk", async () => {
    apiMocks.fetchVoiceStatus.mockResolvedValue({});
    await act(async () => {
      create(<Harness />);
      await flushAsyncEffects();
    });

    await act(async () => {
      await latest!.controls.handleToggleVoiceTalk();
      await flushAsyncEffects();
    });

    expect(apiMocks.startVoiceTalkSession).toHaveBeenCalledWith({
      mode: "push_to_talk",
      sessionId: "session-1",
    });
    expect(apiMocks.stopVoiceTalkSession).not.toHaveBeenCalled();
  });

  it("transcribes selected audio files into the draft", async () => {
    await act(async () => {
      create(<Harness draft="Existing" />);
      await flushAsyncEffects();
    });

    const audioFile = new File(["audio"], "note.wav", { type: "audio/wav" });
    await act(async () => {
      await latest!.controls.handleAudioFileSelected({ item: () => audioFile } as unknown as FileList);
      await flushAsyncEffects();
    });

    expect(apiMocks.transcribeVoice).toHaveBeenCalledWith({
      bytesBase64: "audio-bytes",
      mimeType: "audio/wav",
    });
    expect(latest!.snapshot().draft).toBe("Existing\n\ntranscribed audio");
    expect(latest!.snapshot().notices).toContainEqual({
      message: "Inserted transcript from note.wav.",
      tone: "success",
    });
  });

  it("generates images with Google fallback, edits referenced images, and reports prompt errors", async () => {
    apiMocks.generateLlmImage
      .mockRejectedValueOnce(new Error("403 organization must be verified for gpt-image-2"))
      .mockResolvedValueOnce({ operation: "generate", data: [{ b64Json: "aW1hZ2U=" }] })
      .mockResolvedValueOnce({ operation: "edit", data: [{ b64Json: "aW1hZ2U=" }] });
    await act(async () => {
      create(
        <Harness
          draft="make this sharper"
          preferredImageProviderId="openai"
          preferredImageModel="gpt-image-2"
          pendingAttachments={[
            {
              attachmentId: "attachment-1",
              fileName: "source.png",
              mimeType: "image/png",
              mediaType: "image",
              sizeBytes: 10,
              createdAt: "2026-05-01T00:00:00.000Z",
            } as ChatAttachmentRecord,
          ]}
        />,
      );
      await flushAsyncEffects();
    });

    await act(async () => {
      await expect(
        latest!.controls.handleGenerateImage({ clearDraftOnSuccess: true, trigger: "auto_send" }),
      ).resolves.toBe(true);
      await flushAsyncEffects();
    });
    expect(apiMocks.generateLlmImage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ providerId: "openai", model: "gpt-image-2", outputFormat: "png" }),
    );
    expect(apiMocks.generateLlmImage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ providerId: "google", responseFormat: "b64_json" }),
    );
    expect(latest!.snapshot().draft).toBe("");
    expect(latest!.snapshot().uploadedFiles[0]?.[0]).toBeInstanceOf(File);

    await act(async () => {
      create(
        <Harness
          draft="edit this image"
          preferredImageProviderId="openai"
          preferredImageModel="gpt-image-2"
          pendingAttachments={[
            {
              attachmentId: "attachment-1",
              fileName: "source.png",
              mimeType: "image/png",
              mediaType: "image",
              sizeBytes: 10,
              createdAt: "2026-05-01T00:00:00.000Z",
            } as ChatAttachmentRecord,
          ]}
        />,
      );
      await flushAsyncEffects();
    });
    await act(async () => {
      await expect(latest!.controls.handleEditImage()).resolves.toBe(true);
      await flushAsyncEffects();
    });
    expect(apiMocks.downloadChatAttachment).toHaveBeenCalledWith("attachment-1");
    expect(apiMocks.generateLlmImage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        providerId: "openai",
        referenceImages: [
          expect.objectContaining({
            bytesBase64: "aW1hZ2U=",
            fileName: "input.png",
            mimeType: "image/png",
          }),
        ],
      }),
    );

    await act(async () => {
      create(<Harness draft="   " />);
      await flushAsyncEffects();
    });
    await act(async () => {
      await expect(latest!.controls.handleGenerateImage()).resolves.toBe(false);
    });
    expect(latest!.snapshot().errors).toContainEqual({ value: "Add an image prompt first.", source: undefined });
  });

  it("handles no-window setup, unavailable image routes, and provider model edge cases", async () => {
    Reflect.deleteProperty(globalThis, "window");
    await act(async () => {
      create(
        <Harness
          providerOptions={
            [
              {
                providerId: "disabled",
                label: "Disabled",
                disabled: true,
                models: [],
                capabilities: { imageGenerate: true },
              },
              {
                providerId: "text-only",
                label: "Text only",
                defaultModel: "text-model",
                models: [],
                capabilities: { imageGenerate: true },
              },
              {
                providerId: "blocked",
                label: "Blocked",
                defaultModel: "blocked-image",
                models: [],
                capabilities: { imageGenerate: false },
              },
            ] as never
          }
          selectedProviderId="text-only"
        />,
      );
      await flushAsyncEffects();
    });
    expect(latest!.controls.speakResponsesEnabled).toBe(false);
    expect(latest!.controls.imageGenerationAvailable).toBe(false);
    await act(async () => {
      await expect(latest!.controls.handleGenerateImage()).resolves.toBe(false);
    });
    expect(latest!.snapshot().errors).toContainEqual({
      value: "Image generation is unavailable on the current routes.",
      source: "image_generate",
    });

    installWindow();
    await act(async () => {
      create(
        <Harness
          providerOptions={
            [
              {
                providerId: "openai-codex",
                label: "OpenAI Codex",
                defaultModel: "codex-text",
                models: [],
                capabilities: { imageGenerate: true, imageEdit: true },
              },
            ] as never
          }
          selectedProviderId="openai-codex"
          preferredImageProviderId="openai-codex"
          preferredImageModel="custom-image-model"
        />,
      );
      await flushAsyncEffects();
    });
    expect(latest!.controls.imageRouteLabel).toBe("OpenAI Codex / custom-image-model");

    await act(async () => {
      create(
        <Harness
          providerOptions={
            [
              {
                providerId: "custom",
                label: "Custom",
                defaultModel: "custom-image-model",
                models: [],
                capabilities: { imageGenerate: true },
              },
            ] as never
          }
          selectedProviderId="custom"
        />,
      );
      await flushAsyncEffects();
    });
    expect(latest!.controls.imageGenerationAvailable).toBe(false);
  });

  it("covers route fallback selection, non-image attachments, null session voice start, and plain base64 reads", async () => {
    class PlainBase64FileReader {
      result: string | ArrayBuffer | null = "plainbase64";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() {
        this.onload?.();
      }
    }
    Object.defineProperty(globalThis, "FileReader", {
      configurable: true,
      value: PlainBase64FileReader,
    });

    await act(async () => {
      create(
        <Harness
          providerOptions={[openaiProvider] as never}
          selectedProviderId={null}
          selectedSessionId={null}
          routePreflight={{ effectiveProviderId: undefined }}
          pendingAttachments={[
            {
              attachmentId: "attachment-doc",
              fileName: "notes.txt",
              mimeType: "text/plain",
              mediaType: "document",
              sizeBytes: 10,
              createdAt: "2026-05-01T00:00:00.000Z",
            } as ChatAttachmentRecord,
            {
              attachmentId: "attachment-image",
              fileName: "source.bin",
              mimeType: "application/octet-stream",
              mediaType: "image",
              sizeBytes: 10,
              createdAt: "2026-05-01T00:00:00.000Z",
            } as ChatAttachmentRecord,
          ]}
        />,
      );
      await flushAsyncEffects();
    });

    expect(latest!.controls.imageEditAvailable).toBe(true);
    await act(async () => {
      await latest!.controls.handleToggleVoiceTalk();
    });
    expect(apiMocks.startVoiceTalkSession).toHaveBeenCalledWith({ mode: "push_to_talk", sessionId: undefined });

    await act(async () => {
      await expect(latest!.controls.handleEditImage()).resolves.toBe(true);
    });
    expect(apiMocks.generateLlmImage).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceImages: [
          {
            bytesBase64: "plainbase64",
            fileName: "input.png",
            mimeType: "image/png",
          },
        ],
      }),
    );

    await act(async () => {
      create(
        <Harness
          pendingAttachments={[
            {
              attachmentId: "attachment-doc-only",
              fileName: "notes.txt",
              mimeType: "text/plain",
              mediaType: "document",
              sizeBytes: 10,
              createdAt: "2026-05-01T00:00:00.000Z",
            } as ChatAttachmentRecord,
          ]}
        />,
      );
      await flushAsyncEffects();
    });
    expect(latest!.controls.imageEditAvailable).toBe(false);
  });

  it("covers voice runtime failures, unavailable states, cleanup, audio guards, and voice errors", async () => {
    apiMocks.fetchVoiceRuntimeStatus.mockRejectedValueOnce(new Error("voice down"));
    await act(async () => {
      create(<Harness activeThreadSessionId="other-session" />);
      await flushAsyncEffects();
    });
    expect(latest!.controls.voiceInputAvailable).toBe(false);

    apiMocks.fetchVoiceRuntimeStatus.mockResolvedValueOnce({ readiness: "ready" });
    await act(async () => {
      create(<Harness />);
      await flushAsyncEffects();
    });
    expect(latest!.controls.voiceStatusLabel).toBe("Voice runtime ready");

    apiMocks.fetchVoiceRuntimeStatus.mockResolvedValueOnce({ readiness: "broken" });
    await act(async () => {
      create(<Harness />);
      await flushAsyncEffects();
    });
    expect(latest!.controls.voiceStatusLabel).toBe("Voice runtime needs repair");
    expect(latest!.controls.voiceUnavailableReason).toContain("incomplete");

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness latestAssistantMessageId="assistant-cleanup-1" latestAssistantContent="First" />);
      await flushAsyncEffects();
    });
    await act(async () => {
      renderer.update(<Harness latestAssistantMessageId="assistant-cleanup-2" latestAssistantContent="Second" />);
      await flushAsyncEffects();
    });
    await act(async () => {
      renderer.unmount();
      await flushAsyncEffects();
    });
    expect(speechSynthesis.cancel).toHaveBeenCalled();

    apiMocks.startVoiceTalkSession.mockRejectedValueOnce(new Error("talk failed"));
    await act(async () => {
      create(<Harness />);
      await flushAsyncEffects();
    });
    await act(async () => {
      await latest!.controls.handleToggleVoiceTalk();
      await flushAsyncEffects();
    });
    expect(latest!.snapshot().errors).toContainEqual({ value: "talk failed", source: undefined });

    await act(async () => {
      await latest!.controls.handleAudioFileSelected(null);
    });
    latest!.controls.audioInputRef.current = { click: vi.fn(), value: "selected" } as never;
    latest!.controls.handleOpenAudioTranscribe();
    expect(latest!.controls.audioInputRef.current.click).toHaveBeenCalled();

    apiMocks.transcribeVoice.mockRejectedValueOnce(new Error("transcribe failed"));
    const audioFile = new File(["audio"], "broken.wav", { type: "" });
    await act(async () => {
      await latest!.controls.handleAudioFileSelected({ item: () => audioFile } as unknown as FileList);
      await flushAsyncEffects();
    });
    expect(latest!.snapshot().errors).toContainEqual({ value: "transcribe failed", source: undefined });
    expect(latest!.controls.audioInputRef.current?.value).toBe("");
  });

  it("covers image route success labels and generation failure variants", async () => {
    await act(async () => {
      create(<Harness preferredImageProviderId="google" preferredImageModel="gemini-3-pro-image-preview" />);
      await flushAsyncEffects();
    });
    expect(latest!.controls.imageRouteLabel).toBe("Google / gemini-3-pro-image-preview");
    await act(async () => {
      await expect(latest!.controls.handleGenerateImage()).resolves.toBe(true);
      await flushAsyncEffects();
    });
    expect(latest!.snapshot().notices.at(-1)).toEqual({
      message: "Generated image added to the draft attachments via Google / gemini-3-pro-image-preview.",
      tone: "success",
    });
    await act(async () => {
      await expect(latest!.controls.handleEditImage()).resolves.toBe(false);
    });
    expect(latest!.snapshot().errors).toContainEqual({
      value: "Image editing is unavailable on the current image route.",
      source: "image_edit",
    });

    await act(async () => {
      create(<Harness preferredImageProviderId="openai" preferredImageModel="gpt-image-1" />);
      await flushAsyncEffects();
    });
    await act(async () => {
      await expect(latest!.controls.handleGenerateImage()).resolves.toBe(true);
      await flushAsyncEffects();
    });
    expect(latest!.snapshot().notices.at(-1)).toEqual({
      message: "Generated image added to the draft attachments.",
      tone: "success",
    });

    apiMocks.generateLlmImage
      .mockRejectedValueOnce(new Error("verify organization before using gpt-image-2"))
      .mockResolvedValueOnce({
        operation: "generate",
        data: [{ b64Json: "aW1hZ2U=" }],
      });
    await act(async () => {
      create(<Harness preferredImageProviderId="openai" preferredImageModel="gpt-image-2" />);
      await flushAsyncEffects();
    });
    await act(async () => {
      await expect(latest!.controls.handleGenerateImage()).resolves.toBe(true);
      await flushAsyncEffects();
    });
    expect(latest!.snapshot().notices.some((notice) => notice.message.includes("Retrying via Google"))).toBe(true);

    apiMocks.generateLlmImage.mockRejectedValueOnce(new Error("provider offline"));
    await act(async () => {
      create(<Harness preferredImageProviderId="openai" preferredImageModel="gpt-image-2" />);
      await flushAsyncEffects();
    });
    await act(async () => {
      await expect(latest!.controls.handleGenerateImage()).resolves.toBe(false);
    });
    expect(latest!.snapshot().errors).toContainEqual({ value: "provider offline", source: "image_generate" });

    apiMocks.generateLlmImage.mockResolvedValueOnce({ operation: "generate", data: [] });
    await act(async () => {
      create(<Harness preferredImageProviderId="openai" preferredImageModel="gpt-image-2" />);
      await flushAsyncEffects();
    });
    await act(async () => {
      await expect(latest!.controls.handleGenerateImage()).resolves.toBe(false);
    });
    expect(latest!.snapshot().errors).toContainEqual({
      value: "Image generation returned no image payload.",
      source: "image_generate",
    });
  });

  it("reports binary read failures while preparing image edit references", async () => {
    class NonStringFileReader {
      result: string | ArrayBuffer | null = new ArrayBuffer(1);
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() {
        this.onload?.();
      }
    }
    Object.defineProperty(globalThis, "FileReader", {
      configurable: true,
      value: NonStringFileReader,
    });
    await act(async () => {
      create(
        <Harness
          draft="edit failure"
          preferredImageProviderId="openai"
          preferredImageModel="gpt-image-2"
          pendingAttachments={[
            {
              attachmentId: "attachment-binary",
              fileName: "source.png",
              mimeType: "image/png",
              mediaType: "image",
              sizeBytes: 10,
              createdAt: "2026-05-01T00:00:00.000Z",
            } as ChatAttachmentRecord,
          ]}
        />,
      );
      await flushAsyncEffects();
    });
    await act(async () => {
      await expect(latest!.controls.handleEditImage()).resolves.toBe(false);
    });
    expect(latest!.snapshot().errors).toContainEqual({
      value: "Unable to read binary content.",
      source: "image_edit",
    });
  });

  it("reports FileReader errors while preparing image edit references", async () => {
    class ErrorFileReader {
      result: string | ArrayBuffer | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() {
        this.onerror?.();
      }
    }
    Object.defineProperty(globalThis, "FileReader", {
      configurable: true,
      value: ErrorFileReader,
    });
    await act(async () => {
      create(
        <Harness
          draft="edit failure"
          preferredImageProviderId="openai"
          preferredImageModel="gpt-image-2"
          pendingAttachments={[
            {
              attachmentId: "attachment-reader-error",
              fileName: "source.png",
              mimeType: "image/png",
              mediaType: "image",
              sizeBytes: 10,
              createdAt: "2026-05-01T00:00:00.000Z",
            } as ChatAttachmentRecord,
          ]}
        />,
      );
      await flushAsyncEffects();
    });
    await act(async () => {
      await expect(latest!.controls.handleEditImage()).resolves.toBe(false);
    });
    expect(latest!.snapshot().errors).toContainEqual({
      value: "Unable to read binary content.",
      source: "image_edit",
    });
  });
});
