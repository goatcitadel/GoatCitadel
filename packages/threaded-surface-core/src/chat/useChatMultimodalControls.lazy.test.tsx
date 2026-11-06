import React, { useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachmentRecord } from "@goatcitadel/contracts";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  createRealtimeVoiceClientSecret: vi.fn(),
  downloadChatAttachment: vi.fn(),
  fetchVoiceRuntimeStatus: vi.fn(),
  fetchVoiceStatus: vi.fn(),
  generateLlmImage: vi.fn(),
  startVoiceTalkSession: vi.fn(),
  stopRealtimeVoiceSession: vi.fn(),
  stopVoiceTalkSession: vi.fn(),
  transcribeVoice: vi.fn(),
}));

const helperMocks = vi.hoisted(() => ({
  fileToBase64: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  createRealtimeVoiceClientSecret: apiMocks.createRealtimeVoiceClientSecret,
  downloadChatAttachment: apiMocks.downloadChatAttachment,
  fetchVoiceRuntimeStatus: apiMocks.fetchVoiceRuntimeStatus,
  fetchVoiceStatus: apiMocks.fetchVoiceStatus,
  generateLlmImage: apiMocks.generateLlmImage,
  startVoiceTalkSession: apiMocks.startVoiceTalkSession,
  stopRealtimeVoiceSession: apiMocks.stopRealtimeVoiceSession,
  stopVoiceTalkSession: apiMocks.stopVoiceTalkSession,
  transcribeVoice: apiMocks.transcribeVoice,
}));

// The synthetic voice window intentionally contains only media APIs. Keep URL discovery at its API boundary.
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => "http://127.0.0.1:8787",
}));

vi.mock("../settings-page-utils", () => ({
  fileToBase64: helperMocks.fileToBase64,
}));

let useChatMultimodalControls: typeof import("./useChatMultimodalControls").useChatMultimodalControls;

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

class FakeDataChannel {
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
}

class FakePeerConnection {
  ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;
  addTrack = vi.fn();
  close = vi.fn();
  dataChannel = new FakeDataChannel();
  createDataChannel = vi.fn(() => this.dataChannel);
  createOffer = vi.fn(async () => ({ type: "offer", sdp: "offer-sdp" }));
  setLocalDescription = vi.fn(async () => undefined);
  setRemoteDescription = vi.fn(async () => undefined);
}

function installRealtimeBrowserMocks() {
  const audioTrack = {
    enabled: true,
    stop: vi.fn(),
  };
  const mediaStream = {
    getAudioTracks: vi.fn(() => [audioTrack]),
    getTracks: vi.fn(() => [audioTrack]),
  };
  const audioElement = {
    autoplay: false,
    remove: vi.fn(),
    setAttribute: vi.fn(),
    srcObject: null as MediaStream | null,
  };
  const peerConnection = new FakePeerConnection();
  const getUserMedia = vi.fn(async () => mediaStream);
  const fetchMock = vi.fn(async () => new Response("answer-sdp", { status: 200 }));
  Object.defineProperty(window, "RTCPeerConnection", {
    configurable: true,
    value: vi.fn(function RTCPeerConnection() {
      return peerConnection;
    }),
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia,
      },
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      body: {
        appendChild: vi.fn(),
      },
      createElement: vi.fn(() => audioElement),
    },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: fetchMock,
  });
  return {
    audioElement,
    audioTrack,
    fetchMock,
    getUserMedia,
    mediaStream,
    peerConnection,
  };
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
  deferVoiceReadiness?: boolean;
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
    deferVoiceReadiness: props.deferVoiceReadiness,
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
      return true;
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

describe("live voice first-use implementation", () => {
  let renderer: ReactTestRenderer | undefined;
  let release!: () => void;
  let reject!: (error: Error) => void;
  let requested = false;
  beforeEach(async () => {
    latest = null;
    localStorageState = new Map([["goatcitadel.chat.speak-replies.enabled", "true"]]);
    speechSynthesis.cancel.mockClear();
    speechSynthesis.speak.mockClear();
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    helperMocks.fileToBase64.mockReset();
    installWindow();
    apiMocks.fetchVoiceStatus.mockResolvedValue({ talk: { activeSessionId: null } });
    apiMocks.fetchVoiceRuntimeStatus.mockResolvedValue({ readiness: "ready", selectedModelId: "whisper-local" });
    apiMocks.createRealtimeVoiceClientSecret.mockResolvedValue({
      provider: "openai-realtime",
      surface: "chat",
      voiceSessionId: "voice-session-1",
      sessionId: "session-1",
      model: "gpt-realtime-2.1",
      voice: "marin",
      status: "ready",
      createdAt: "2026-07-08T00:00:00.000Z",
      clientSecret: {
        value: "ek_test",
      },
    });
    apiMocks.stopRealtimeVoiceSession.mockResolvedValue({
      provider: "openai-realtime",
      state: "stopped",
      apiKeyReady: true,
      model: "gpt-realtime-2.1",
      voice: "marin",
      updatedAt: "2026-07-08T00:01:00.000Z",
    });
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

    vi.resetModules();
    requested = false;
    const gate = new Promise<void>((resolve, no) => {
      release = resolve;
      reject = no;
    });
    vi.doMock("./multimodal-live-voice-start.js", async () => {
      requested = true;
      await gate;
      return vi.importActual("./multimodal-live-voice-start.js");
    });
    ({ useChatMultimodalControls } = await import("./useChatMultimodalControls"));
  });
  afterEach(async () => {
    release();
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.doUnmock("./multimodal-live-voice-start.js");
    vi.resetModules();
  });

  it.each(["cancel", "unmount"] as const)(
    "publishes busy state immediately, then prevents every voice effect when %s wins during import",
    async (outcome) => {
      const browser = installRealtimeBrowserMocks();
      await act(async () => {
        renderer = create(<Harness />);
      });
      expect(requested).toBe(false);
      let start!: Promise<void>;
      await act(async () => {
        start = latest!.controls.handleToggleLiveVoice();
      });
      await vi.waitFor(() => expect(requested).toBe(true));
      expect(latest!.controls.voiceBusy).toBe(true);
      expect(latest!.controls.liveVoiceState).toBe("connecting");
      expect(apiMocks.createRealtimeVoiceClientSecret).not.toHaveBeenCalled();
      if (outcome === "cancel")
        await act(async () => {
          await latest!.controls.handleToggleLiveVoice();
        });
      else
        await act(async () => {
          renderer!.unmount();
          renderer = undefined;
        });
      await act(async () => {
        release();
        await start;
      });
      expect(apiMocks.createRealtimeVoiceClientSecret).not.toHaveBeenCalled();
      expect(browser.getUserMedia).not.toHaveBeenCalled();
      expect(window.RTCPeerConnection).not.toHaveBeenCalled();
      expect(browser.fetchMock).not.toHaveBeenCalled();
      if (outcome === "cancel") {
        expect(latest!.controls.liveVoiceState).toBe("idle");
        expect(latest!.controls.voiceBusy).toBe(false);
      }
    },
  );

  it("starts after the demanded module resolves and keeps resource cleanup with the mounted owner", async () => {
    const browser = installRealtimeBrowserMocks();
    await act(async () => {
      renderer = create(<Harness />);
    });
    let start!: Promise<void>;
    await act(async () => {
      start = latest!.controls.handleToggleLiveVoice();
    });
    await vi.waitFor(() => expect(requested).toBe(true));
    await act(async () => {
      release();
      await start;
    });
    expect(apiMocks.createRealtimeVoiceClientSecret).toHaveBeenCalledWith({ surface: "chat", sessionId: "session-1" });
    expect(browser.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(browser.peerConnection.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "answer-sdp" });
    expect(latest!.controls.liveVoiceState).toBe("listening");
    await act(async () => {
      renderer!.unmount();
      renderer = undefined;
    });
    expect(browser.audioTrack.stop).toHaveBeenCalled();
    expect(browser.peerConnection.close).toHaveBeenCalled();
    expect(apiMocks.stopRealtimeVoiceSession).toHaveBeenCalledWith("voice-session-1");
  });

  it("settles busy and surfaces module-load failure without creating voice resources", async () => {
    const browser = installRealtimeBrowserMocks();
    await act(async () => {
      renderer = create(<Harness />);
    });
    let start!: Promise<void>;
    await act(async () => {
      start = latest!.controls.handleToggleLiveVoice();
    });
    await vi.waitFor(() => expect(requested).toBe(true));
    await act(async () => {
      reject(new TypeError("Failed to fetch dynamically imported voice module"));
      await start;
    });
    expect(latest!.controls.voiceBusy).toBe(false);
    expect(latest!.controls.liveVoiceState).toBe("error");
    expect(latest!.snapshot().errors.some((error) => typeof error.value === "string" && error.value.length > 0)).toBe(
      true,
    );
    expect(apiMocks.createRealtimeVoiceClientSecret).not.toHaveBeenCalled();
    expect(browser.getUserMedia).not.toHaveBeenCalled();
    expect(browser.fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "createElement",
    "appendChild",
    "addTrack",
    "createDataChannel",
    "createDataChannel-cleanup-throws",
  ] as const)("retires partially allocated voice resources after %s fails and permits a clean retry", async (fault) => {
    const browser = installRealtimeBrowserMocks();
    const failure = new Error("synthetic live voice startup: " + fault);
    let peerAlive = false;
    let audioAttached = false;
    Object.defineProperty(window, "RTCPeerConnection", {
      configurable: true,
      value: vi.fn(function RTCPeerConnection() {
        peerAlive = true;
        return browser.peerConnection;
      }),
    });
    browser.peerConnection.close.mockImplementation(() => {
      peerAlive = false;
      if (fault === "createDataChannel-cleanup-throws") throw new Error("synthetic cleanup failure");
    });
    browser.audioElement.remove.mockImplementation(() => {
      audioAttached = false;
    });
    vi.mocked(document.body.appendChild).mockImplementation(() => {
      audioAttached = true;
      return browser.audioElement as unknown as Node;
    });
    if (fault === "createElement")
      vi.mocked(document.createElement).mockImplementationOnce(() => {
        throw failure;
      });
    if (fault === "appendChild")
      vi.mocked(document.body.appendChild).mockImplementationOnce(() => {
        throw failure;
      });
    if (fault === "addTrack")
      browser.peerConnection.addTrack.mockImplementationOnce(() => {
        throw failure;
      });
    if (fault.startsWith("createDataChannel"))
      browser.peerConnection.createDataChannel.mockImplementationOnce(() => {
        throw failure;
      });
    await act(async () => {
      renderer = create(<Harness />);
    });
    let start!: Promise<void>;
    await act(async () => {
      start = latest!.controls.handleToggleLiveVoice();
    });
    await vi.waitFor(() => expect(requested).toBe(true));
    await act(async () => {
      release();
      await start;
    });
    // Real helper and hook allocation paths ran; only platform/API fixtures are synthetic.
    expect(window.RTCPeerConnection).toHaveBeenCalledTimes(1);
    expect(apiMocks.createRealtimeVoiceClientSecret).toHaveBeenCalledTimes(1);
    expect(browser.getUserMedia).toHaveBeenCalledTimes(1);
    expect(browser.peerConnection.close).toHaveBeenCalledTimes(1);
    expect(peerAlive).toBe(false);
    expect(audioAttached).toBe(false);
    if (fault !== "createElement") expect(browser.audioElement.remove).toHaveBeenCalledTimes(1);
    expect(browser.audioTrack.stop).toHaveBeenCalled();
    expect(apiMocks.stopRealtimeVoiceSession).toHaveBeenCalledWith("voice-session-1");
    expect(browser.fetchMock).not.toHaveBeenCalled();
    expect(latest!.controls.liveVoiceState).toBe("error");
    expect(latest!.controls.voiceBusy).toBe(false);
    expect(latest!.snapshot().errors.at(-1)?.value).toBe(failure.message);
    // No pending ref may strand the next explicit user activation.
    const recovery = installRealtimeBrowserMocks();
    await act(async () => {
      await latest!.controls.handleToggleLiveVoice();
    });
    expect(recovery.getUserMedia).toHaveBeenCalledTimes(1);
    expect(recovery.peerConnection.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "answer-sdp" });
    expect(latest!.controls.liveVoiceState).toBe("listening");
    await act(async () => {
      await latest!.controls.handleToggleLiveVoice();
    });
    expect(recovery.peerConnection.close).toHaveBeenCalled();
    expect(recovery.audioElement.remove).toHaveBeenCalled();
    expect(recovery.audioTrack.stop).toHaveBeenCalled();
    expect(latest!.controls.liveVoiceState).toBe("idle");
  });
});
