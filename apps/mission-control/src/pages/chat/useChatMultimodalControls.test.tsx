import React, { useMemo, useState } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatMultimodalControls } from "./useChatMultimodalControls";

const fetchVoiceStatusMock = vi.fn(
  async (): Promise<{ talk: { activeSessionId: string | null } }> => ({
    talk: {
      activeSessionId: null,
    },
  }),
);
const fetchVoiceRuntimeStatusMock = vi.fn(
  async (): Promise<{ readiness: string; selectedModelId: string | null }> => ({
    readiness: "ready",
    selectedModelId: "voice-mini",
  }),
);
const downloadChatAttachmentMock = vi.fn();
const generateLlmImageMock = vi.fn();
const startVoiceTalkSessionMock = vi.fn();
const stopVoiceTalkSessionMock = vi.fn();
const transcribeVoiceMock = vi.fn();
const fileToBase64Mock = vi.fn(async (_file: File) => "YXVkaW8=");

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<object>("../../api/client");
  return {
    ...actual,
    fetchVoiceStatus: () => fetchVoiceStatusMock(),
    fetchVoiceRuntimeStatus: () => fetchVoiceRuntimeStatusMock(),
    downloadChatAttachment: (...args: unknown[]) => downloadChatAttachmentMock(...args),
    generateLlmImage: (...args: unknown[]) => generateLlmImageMock(...args),
    startVoiceTalkSession: (...args: unknown[]) => startVoiceTalkSessionMock(...args),
    stopVoiceTalkSession: (...args: unknown[]) => stopVoiceTalkSessionMock(...args),
    transcribeVoice: (...args: unknown[]) => transcribeVoiceMock(...args),
  };
});

vi.mock("../settings-page-utils", () => ({
  fileToBase64: (file: File) => fileToBase64Mock(file),
}));

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => {
      map.clear();
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
}

async function settlePromises(iterations = 4): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

type HarnessState = {
  setSelectedSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setActiveThreadSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setLatestAssistantMessageId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setLatestAssistantContent: React.Dispatch<React.SetStateAction<string | undefined>>;
  setLatestAssistantStatus: React.Dispatch<React.SetStateAction<any>>;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  controls: ReturnType<typeof useChatMultimodalControls>;
  draft: string;
  handleGenerateImage: () => Promise<void>;
  handleEditImage: () => Promise<void>;
  setErrorMock: ReturnType<typeof vi.fn>;
  pushLocalNoticeMock: ReturnType<typeof vi.fn>;
  uploadAttachmentsMock: ReturnType<typeof vi.fn>;
};

let latest: HarnessState | null = null;

function Harness(
  props: {
    providerOptions?: any[];
    selectedProviderId?: string;
    preferredImageProviderId?: string;
    preferredImageModel?: string;
    routePreflight?: any;
    pendingAttachments?: any[];
    initialDraft?: string;
  } = {},
) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>("sess-1");
  const [activeThreadSessionId, setActiveThreadSessionId] = useState<string | null>("sess-1");
  const [draft, setDraft] = useState(props.initialDraft ?? "Create an image of a horse");
  const [latestAssistantMessageId, setLatestAssistantMessageId] = useState<string | undefined>("assistant-history");
  const [latestAssistantContent, setLatestAssistantContent] = useState<string | undefined>("Historical reply");
  const [latestAssistantStatus, setLatestAssistantStatus] = useState<any>("completed");
  const setErrorMock = useMemo(() => vi.fn(), []);
  const pushLocalNoticeMock = useMemo(() => vi.fn(), []);
  const uploadAttachmentsMock = useMemo(() => vi.fn(async () => undefined), []);

  const controls = useChatMultimodalControls({
    providerOptions: props.providerOptions ?? [
      {
        providerId: "openai",
        label: "OpenAI",
        models: ["gpt-image-2"],
        capabilities: {
          voiceOutput: true,
        },
      },
    ],
    selectedProviderId: props.selectedProviderId ?? "openai",
    preferredImageProviderId: props.preferredImageProviderId,
    preferredImageModel: props.preferredImageModel,
    routePreflight: props.routePreflight ?? null,
    selectedSessionId,
    activeThreadSessionId,
    pendingAttachments: props.pendingAttachments ?? [],
    draft,
    latestAssistantMessageId,
    latestAssistantContent,
    latestAssistantStatus,
    setDraft,
    setError: setErrorMock,
    pushLocalNotice: pushLocalNoticeMock,
    uploadAttachments: uploadAttachmentsMock,
  });

  latest = {
    setSelectedSessionId,
    setActiveThreadSessionId,
    setLatestAssistantMessageId,
    setLatestAssistantContent,
    setLatestAssistantStatus,
    setDraft,
    controls,
    draft,
    handleGenerateImage: controls.handleGenerateImage,
    handleEditImage: controls.handleEditImage,
    setErrorMock,
    pushLocalNoticeMock,
    uploadAttachmentsMock,
  };

  return null;
}

describe("useChatMultimodalControls", () => {
  beforeEach(() => {
    latest = null;
    fetchVoiceStatusMock.mockClear();
    fetchVoiceRuntimeStatusMock.mockClear();
    downloadChatAttachmentMock.mockReset();
    generateLlmImageMock.mockReset();
    startVoiceTalkSessionMock.mockReset();
    stopVoiceTalkSessionMock.mockReset();
    transcribeVoiceMock.mockReset();
    fileToBase64Mock.mockClear();
    startVoiceTalkSessionMock.mockResolvedValue(undefined);
    stopVoiceTalkSessionMock.mockResolvedValue(undefined);
    transcribeVoiceMock.mockResolvedValue({ text: "transcribed audio" });

    const localStorage = createMemoryStorage();
    localStorage.setItem("goatcitadel.chat.speak-replies.enabled", "true");
    const speechSynthesis = {
      speak: vi.fn(),
      cancel: vi.fn(),
    };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {
        localStorage,
        speechSynthesis,
        SpeechSynthesisUtterance: class SpeechSynthesisUtterance {
          public constructor(public text: string) {}
        },
      },
    });
    Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
      configurable: true,
      writable: true,
      value: class SpeechSynthesisUtterance {
        public constructor(public text: string) {}
      },
    });
    Object.defineProperty(globalThis, "FileReader", {
      configurable: true,
      writable: true,
      value: class FileReader {
        public result: string | ArrayBuffer | null = null;
        public onload: (() => void) | null = null;
        public onerror: (() => void) | null = null;

        public readAsDataURL(): void {
          this.result = "data:image/png;base64,c291cmNlLWltYWdl";
          this.onload?.();
        }
      },
    });
  });

  it("does not replay the latest historical assistant reply when a session is opened", async () => {
    create(<Harness />);

    await act(async () => {
      await settlePromises();
    });

    expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
  });

  it("speaks only after a new assistant reply reaches completed status", async () => {
    const renderer = create(<Harness />);

    await act(async () => {
      await settlePromises();
    });

    await act(async () => {
      latest?.setLatestAssistantMessageId("assistant-streaming");
      latest?.setLatestAssistantContent("Partial reply");
      latest?.setLatestAssistantStatus("running");
      await settlePromises();
    });

    expect(window.speechSynthesis.speak).not.toHaveBeenCalled();

    await act(async () => {
      latest?.setLatestAssistantContent("Completed reply");
      latest?.setLatestAssistantStatus("completed");
      await settlePromises();
    });

    expect(window.speechSynthesis.cancel as any).toHaveBeenCalled();
    expect(window.speechSynthesis.speak as any).toHaveBeenCalledTimes(1);
    expect((window.speechSynthesis.speak as any).mock.calls[0]?.[0]?.text).toBe("Completed reply");

    const cancelCountBeforeUnmount = (window.speechSynthesis.cancel as any).mock.calls.length;
    await act(async () => {
      renderer.unmount();
    });

    expect((window.speechSynthesis.cancel as any).mock.calls.length).toBeGreaterThan(cancelCountBeforeUnmount);
  });

  it("primes the newly loaded thread after a session switch instead of speaking its history", async () => {
    create(<Harness />);

    await act(async () => {
      await settlePromises();
    });

    await act(async () => {
      latest?.setSelectedSessionId("sess-2");
      latest?.setActiveThreadSessionId("sess-2");
      latest?.setLatestAssistantMessageId("assistant-history-2");
      latest?.setLatestAssistantContent("Second session history");
      latest?.setLatestAssistantStatus("completed");
      await settlePromises();
    });

    expect(window.speechSynthesis.speak).not.toHaveBeenCalled();

    await act(async () => {
      latest?.setSelectedSessionId("sess-3");
      await settlePromises();
    });

    expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
  });

  it("keeps browser-only controls unavailable when no window object exists", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: undefined,
    });

    create(
      <Harness
        providerOptions={[
          {
            providerId: "anthropic",
            label: "Anthropic",
            defaultModel: "claude-text",
            models: ["claude-text"],
            capabilities: { imageGenerate: true, voiceOutput: true },
          },
        ]}
        selectedProviderId={undefined}
      />,
    );

    await act(async () => {
      await settlePromises();
    });

    expect(latest?.controls.speakResponsesEnabled).toBe(false);
    expect(latest?.controls.voiceOutputAvailable).toBe(false);
    expect(latest?.controls.imageGenerationAvailable).toBe(false);
    expect(latest?.controls.imageProviderOptions).toEqual([]);
  });

  it("resolves preferred image models even when they are not in the provider catalog", async () => {
    create(
      <Harness
        providerOptions={[
          {
            providerId: "openai",
            label: "OpenAI",
            defaultModel: "   ",
            models: ["gpt-4o-mini"],
            capabilities: { imageGenerate: true, voiceInput: false, voiceOutput: false },
          },
        ]}
        preferredImageProviderId="openai"
        preferredImageModel="custom-image-experiment"
      />,
    );

    await act(async () => {
      await settlePromises();
    });

    expect(latest?.controls.selectedImageProviderId).toBe("openai");
    expect(latest?.controls.selectedImageModel).toBe("custom-image-experiment");
    expect(latest?.controls.voiceInputAvailable).toBe(false);
    expect(latest?.controls.voiceOutputAvailable).toBe(false);
  });

  it("tags image generation failures with the image_generate source", async () => {
    generateLlmImageMock.mockRejectedValue(
      new Error('API error 400: {"error":"image generation failed (400 Bad Request): {\\"message\\":\\"blocked\\"}"}'),
    );

    create(<Harness />);

    await act(async () => {
      await settlePromises();
    });

    await act(async () => {
      await latest?.handleGenerateImage();
      await settlePromises();
    });

    expect(latest?.setErrorMock).toHaveBeenCalledWith(
      'API error 400: {"error":"image generation failed (400 Bad Request): {\\"message\\":\\"blocked\\"}"}',
      "image_generate",
    );
  });

  it("falls back from OpenAI image generation to Google when the route reports verification failure", async () => {
    generateLlmImageMock
      .mockRejectedValueOnce(new Error("403: gpt-image-2 organization must be verified"))
      .mockResolvedValueOnce({
        operation: "generate",
        data: [{ b64Json: btoa("google image") }],
      });

    create(
      <Harness
        providerOptions={[
          {
            providerId: "openai",
            label: "OpenAI",
            models: ["gpt-image-2"],
            capabilities: { imageGenerate: true },
          },
          {
            providerId: "google",
            label: "Google",
            models: ["gemini-3-pro-image-preview"],
            capabilities: { imageGenerate: true },
          },
        ]}
      />,
    );

    await act(async () => {
      await settlePromises();
      await latest?.handleGenerateImage();
    });

    expect(generateLlmImageMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        providerId: "openai",
        model: "gpt-image-2",
        outputFormat: "png",
      }),
    );
    expect(generateLlmImageMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        providerId: "google",
        model: "gemini-3-pro-image-preview",
        responseFormat: "b64_json",
      }),
    );
    expect(latest?.pushLocalNoticeMock).toHaveBeenCalledWith(
      "OpenAI image route unavailable. Retrying via Google / gemini-3-pro-image-preview.",
      "warning",
    );
    expect(latest?.uploadAttachmentsMock).toHaveBeenCalledWith([
      expect.objectContaining({ name: expect.stringMatching(/^goatcitadel-generate-/), type: "image/png" }),
    ]);
    expect(latest?.pushLocalNoticeMock).toHaveBeenLastCalledWith(
      "Generated image added to the draft attachments via Google / gemini-3-pro-image-preview.",
      "success",
    );
  });

  it("edits the latest image attachment through the OpenAI route", async () => {
    downloadChatAttachmentMock.mockResolvedValue({
      blob: new Blob(["source image"], { type: "image/png" }),
      fileName: "source.png",
      mimeType: "image/png",
    });
    generateLlmImageMock.mockResolvedValue({
      operation: "edit",
      data: [{ b64Json: btoa("edited image") }],
    });

    create(
      <Harness
        pendingAttachments={[
          {
            attachmentId: "doc-1",
            fileName: "notes.txt",
            mediaType: "document",
            mimeType: "text/plain",
            sizeBytes: 5,
          },
          {
            attachmentId: "image-1",
            fileName: "source.png",
            mediaType: "image",
            mimeType: "image/png",
            sizeBytes: 12,
          },
        ]}
      />,
    );

    await act(async () => {
      await settlePromises();
      await latest?.handleEditImage();
    });

    expect(downloadChatAttachmentMock).toHaveBeenCalledWith("image-1");
    expect(generateLlmImageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "openai",
        model: "gpt-image-2",
        referenceImages: [
          expect.objectContaining({
            fileName: "source.png",
            mimeType: "image/png",
            bytesBase64: expect.any(String),
          }),
        ],
      }),
    );
    expect(latest?.uploadAttachmentsMock).toHaveBeenCalledWith([
      expect.objectContaining({ name: expect.stringMatching(/^goatcitadel-edit-/), type: "image/png" }),
    ]);
    expect(latest?.pushLocalNoticeMock).toHaveBeenLastCalledWith(
      "Edited image added to the draft attachments.",
      "success",
    );
  });

  it("reports image-reference decoding failures before dispatching an edit", async () => {
    downloadChatAttachmentMock.mockResolvedValue({
      blob: new Blob(["source image"], { type: "image/png" }),
      fileName: "source.png",
      mimeType: "image/png",
    });

    Object.defineProperty(globalThis, "FileReader", {
      configurable: true,
      writable: true,
      value: class FileReader {
        public result: string | ArrayBuffer | null = new ArrayBuffer(0);
        public onload: (() => void) | null = null;
        public onerror: (() => void) | null = null;

        public readAsDataURL(): void {
          this.onload?.();
        }
      },
    });

    const firstRenderer = create(
      <Harness
        pendingAttachments={[
          {
            attachmentId: "image-binary",
            fileName: "source.png",
            mediaType: "image",
            mimeType: "image/png",
            sizeBytes: 12,
          },
        ]}
      />,
    );

    await act(async () => {
      await settlePromises();
      await latest?.handleEditImage();
    });

    expect(generateLlmImageMock).not.toHaveBeenCalled();
    expect(latest?.setErrorMock).toHaveBeenCalledWith("Unable to read binary content.", "image_edit");

    await act(async () => {
      firstRenderer.unmount();
    });

    Object.defineProperty(globalThis, "FileReader", {
      configurable: true,
      writable: true,
      value: class FileReader {
        public result: string | ArrayBuffer | null = null;
        public onload: (() => void) | null = null;
        public onerror: (() => void) | null = null;

        public readAsDataURL(): void {
          this.onerror?.();
        }
      },
    });

    generateLlmImageMock.mockClear();
    create(
      <Harness
        pendingAttachments={[
          {
            attachmentId: "image-reader-error",
            fileName: "source.png",
            mediaType: "image",
            mimeType: "image/png",
            sizeBytes: 12,
          },
        ]}
      />,
    );

    await act(async () => {
      await settlePromises();
      await latest?.handleEditImage();
    });

    expect(generateLlmImageMock).not.toHaveBeenCalled();
    expect(latest?.setErrorMock).toHaveBeenCalledWith("Unable to read binary content.", "image_edit");
  });

  it("reports image prompt, route, edit capability, and empty payload failures", async () => {
    create(<Harness initialDraft="   " />);

    await act(async () => {
      await settlePromises();
      await latest?.handleGenerateImage();
    });

    expect(latest?.setErrorMock).toHaveBeenCalledWith("Add an image prompt first.");

    latest?.setErrorMock.mockClear();

    create(
      <Harness
        providerOptions={[
          {
            providerId: "local",
            label: "Local",
            defaultModel: "llama",
            models: ["llama"],
            capabilities: { imageGenerate: false },
          },
        ]}
        selectedProviderId="local"
        initialDraft="Create a logo"
      />,
    );
    await act(async () => {
      await settlePromises();
      await latest?.handleGenerateImage();
    });

    expect(latest?.setErrorMock).toHaveBeenCalledWith(
      "Image generation is unavailable on the current routes.",
      "image_generate",
    );

    generateLlmImageMock.mockResolvedValueOnce({ operation: "generate", data: [] });
    create(
      <Harness
        providerOptions={[
          {
            providerId: "google",
            label: "Google",
            defaultModel: "gemini-2.5-flash-image",
            models: [],
            capabilities: { imageGenerate: true },
          },
        ]}
        selectedProviderId="google"
        pendingAttachments={[
          {
            attachmentId: "image-google",
            fileName: "source.png",
            mediaType: "image",
            mimeType: "image/png",
            sizeBytes: 12,
          },
        ]}
        initialDraft="Create a logo"
      />,
    );
    await act(async () => {
      await settlePromises();
      await latest?.handleEditImage();
    });

    expect(latest?.setErrorMock).toHaveBeenCalledWith(
      "Image editing is unavailable on the current image route.",
      "image_edit",
    );

    await act(async () => {
      await latest?.handleGenerateImage();
    });

    expect(latest?.setErrorMock).toHaveBeenCalledWith("Image generation returned no image payload.", "image_generate");
  });

  it("starts, stops, and reports errors for push-to-talk sessions", async () => {
    const startRenderer = create(<Harness />);

    await act(async () => {
      await settlePromises();
      await latest?.controls.handleToggleVoiceTalk();
    });

    expect(startVoiceTalkSessionMock).toHaveBeenCalledWith({
      mode: "push_to_talk",
      sessionId: "sess-1",
    });
    expect(latest?.pushLocalNoticeMock).toHaveBeenCalledWith("Push-to-talk session started.", "success");

    await act(async () => {
      startRenderer.unmount();
    });

    fetchVoiceStatusMock.mockResolvedValue({
      talk: { activeSessionId: "talk-1" },
    });
    const stopRenderer = create(<Harness />);
    await act(async () => {
      await settlePromises();
    });
    await act(async () => {
      await latest?.controls.handleToggleVoiceTalk();
    });

    expect(stopVoiceTalkSessionMock).toHaveBeenCalledWith("talk-1");
    expect(latest?.pushLocalNoticeMock).toHaveBeenCalledWith("Push-to-talk session stopped.", "neutral");

    await act(async () => {
      stopRenderer.unmount();
    });

    startVoiceTalkSessionMock.mockRejectedValueOnce(new Error("microphone denied"));
    fetchVoiceStatusMock.mockResolvedValue({ talk: { activeSessionId: null } });
    create(<Harness />);
    await act(async () => {
      await settlePromises();
    });
    await act(async () => {
      await latest?.controls.handleToggleVoiceTalk();
    });

    expect(latest?.setErrorMock).toHaveBeenCalledWith("microphone denied");
  });

  it("transcribes selected audio files, ignores empty selections, and resets the input", async () => {
    create(<Harness initialDraft="Existing draft" />);

    await act(async () => {
      await settlePromises();
      await latest?.controls.handleAudioFileSelected(null);
    });

    expect(transcribeVoiceMock).not.toHaveBeenCalled();

    const click = vi.fn();
    latest!.controls.audioInputRef.current = { click, value: "audio.wav" } as unknown as HTMLInputElement;
    latest?.controls.handleOpenAudioTranscribe();
    expect(click).toHaveBeenCalledOnce();

    const file = new File(["audio"], "voice.webm", { type: "" });
    await act(async () => {
      await latest?.controls.handleAudioFileSelected({
        item: () => file,
      } as unknown as FileList);
      await settlePromises();
    });

    expect(fileToBase64Mock).toHaveBeenCalledWith(file);
    expect(transcribeVoiceMock).toHaveBeenCalledWith({
      bytesBase64: "YXVkaW8=",
      mimeType: "audio/wav",
    });
    expect(latest?.draft).toBe("Existing draft\n\ntranscribed audio");
    expect(latest?.controls.audioInputRef.current?.value).toBe("");

    transcribeVoiceMock.mockRejectedValueOnce(new Error("transcribe failed"));
    await act(async () => {
      await latest?.controls.handleAudioFileSelected({
        item: () => new File(["bad"], "bad.wav", { type: "audio/wav" }),
      } as unknown as FileList);
    });

    expect(latest?.setErrorMock).toHaveBeenCalledWith("transcribe failed");
  });

  it("surfaces broken and unavailable voice runtime states", async () => {
    fetchVoiceRuntimeStatusMock.mockResolvedValueOnce({
      readiness: "broken",
      selectedModelId: null,
    });
    create(<Harness />);

    await act(async () => {
      await settlePromises();
    });

    expect(latest?.controls.voiceStatusLabel).toBe("Voice runtime needs repair");
    expect(latest?.controls.voiceUnavailableReason).toBe(
      "Voice runtime is installed but incomplete. Repair it in Configure > Runtime.",
    );

    fetchVoiceStatusMock.mockRejectedValueOnce(new Error("offline"));
    fetchVoiceRuntimeStatusMock.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      create(<Harness providerOptions={[]} selectedProviderId={undefined} />);
      await settlePromises();
    });

    expect(latest?.controls.voiceStatusLabel).toBe("Voice runtime unavailable");
    expect(latest?.controls.voiceInputAvailable).toBe(false);
  });
});
