import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatAttachmentRecord,
  RoutingPreflightResult,
  ChatTurnLifecycleStatus,
  VoiceRuntimeStatus,
  VoiceStatus,
} from "@goatcitadel/contracts";
import {
  createRealtimeVoiceClientSecret,
  downloadChatAttachment,
  fetchVoiceRuntimeStatus,
  fetchVoiceStatus,
  generateLlmImage,
  startVoiceTalkSession,
  stopRealtimeVoiceSession,
  stopVoiceTalkSession,
  transcribeVoice,
} from "@goatcitadel/mission-control-shared/api/client";
import type { ChatModelProviderOption } from "@goatcitadel/mission-control-shared/components/ChatModelPicker";
import { fileToBase64 } from "../settings-page-utils";
import type { ChatErrorSource } from "./chat-error-copy";

const SPEAK_REPLIES_PREF_KEY = "goatcitadel.chat.speak-replies.enabled";
const OPENAI_IMAGE_MODEL_PREFERENCES = ["gpt-image-2", "gpt-image-1"] as const;
const GOOGLE_IMAGE_MODEL_PREFERENCES = [
  "gemini-3.1-flash-image-preview",
  "gemini-3-pro-image-preview",
  "gemini-2.5-flash-image",
] as const;
const IMAGE_MODEL_PREFERENCES: Record<"openai" | "openai-codex" | "google", readonly string[]> = {
  openai: OPENAI_IMAGE_MODEL_PREFERENCES,
  "openai-codex": OPENAI_IMAGE_MODEL_PREFERENCES,
  google: GOOGLE_IMAGE_MODEL_PREFERENCES,
};

interface ChatImageRoute {
  providerId: "openai" | "openai-codex" | "google";
  model: string;
  label: string;
  supportsEdit: boolean;
}

interface ImageGenerationOptions {
  clearDraftOnSuccess?: boolean;
  trigger?: "button" | "auto_send";
}

type LiveVoiceUiState =
  | "idle"
  | "requesting_mic"
  | "connecting"
  | "listening"
  | "speaking"
  | "thinking"
  | "stopping"
  | "error";

interface LiveVoiceConnection {
  peerConnection: RTCPeerConnection;
  dataChannel: RTCDataChannel;
  mediaStream: MediaStream;
  audioElement: HTMLAudioElement;
  voiceSessionId: string;
}

interface PendingLiveVoiceStart {
  canceled: boolean;
  mediaStream: MediaStream | null;
  voiceSessionId: string | null;
}

const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

function isImageAttachment(attachment: ChatAttachmentRecord): boolean {
  return attachment.mediaType === "image" || attachment.mimeType.startsWith("image/");
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Unable to read binary content."));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = reject.bind(null, new Error("Unable to read binary content."));
    reader.readAsDataURL(blob);
  });
}

function base64ToFile(base64: string, fileName: string, mimeType = "image/png"): File {
  const bytes = atob(base64);
  const out = new Uint8Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    out[index] = bytes.charCodeAt(index);
  }
  return new File([out], fileName, { type: mimeType });
}

function normalizeOptionalString(value?: string | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getImageModelPreferences(providerId: string): readonly string[] {
  return providerId === "openai" || providerId === "openai-codex"
    ? OPENAI_IMAGE_MODEL_PREFERENCES
    : providerId === "google"
      ? GOOGLE_IMAGE_MODEL_PREFERENCES
      : [];
}

function getImageModelOptions(provider: ChatModelProviderOption): string[] {
  const available = new Set<string>();
  for (const value of [provider.defaultModel, ...provider.models]) {
    const normalized = normalizeOptionalString(value);
    if (normalized && normalized.toLowerCase().includes("image")) {
      available.add(normalized);
    }
  }
  for (const model of getImageModelPreferences(provider.providerId)) {
    available.add(model);
  }
  return [...available];
}

function resolveImageModel(provider: ChatModelProviderOption, preferredModel?: string): string | null {
  const normalizedPreferred = normalizeOptionalString(preferredModel);
  const availableModels = getImageModelOptions(provider);
  if (normalizedPreferred) {
    if (availableModels.includes(normalizedPreferred)) {
      return normalizedPreferred;
    }
    if (normalizedPreferred.toLowerCase().includes("image")) {
      return normalizedPreferred;
    }
  }
  return availableModels[0] ?? null;
}

function toImageProviderOption(provider: ChatModelProviderOption | null | undefined): ChatModelProviderOption | null {
  if (!provider || provider.disabled || provider.capabilities?.imageGenerate === false) {
    return null;
  }
  const models = getImageModelOptions(provider);
  if (models.length === 0 && !IMAGE_MODEL_PREFERENCES[provider.providerId as keyof typeof IMAGE_MODEL_PREFERENCES]) {
    return null;
  }
  return {
    ...provider,
    defaultModel: models[0] ?? provider.defaultModel,
    models,
  };
}

function buildImageRoute(
  provider: ChatModelProviderOption | null | undefined,
  preferredModel?: string,
): ChatImageRoute | null {
  if (!provider || provider.disabled || provider.capabilities?.imageGenerate === false) {
    return null;
  }
  const model = resolveImageModel(provider, preferredModel);
  if (model && (provider.providerId === "openai" || provider.providerId === "openai-codex")) {
    return {
      providerId: provider.providerId,
      model,
      label: provider.providerId === "openai-codex" ? `OpenAI Codex / ${model}` : `OpenAI / ${model}`,
      supportsEdit: true,
    };
  }
  if (model && provider.providerId === "google") {
    return {
      providerId: "google",
      model,
      label: `Google / ${model}`,
      supportsEdit: false,
    };
  }
  return null;
}

function shouldRetryImageGenerationWithGoogleFallback(error: string): boolean {
  const normalized = error.toLowerCase();
  return (
    normalized.includes("organization must be verified") ||
    (normalized.includes("verify organization") && normalized.includes("gpt-image-2")) ||
    (normalized.includes("403") && normalized.includes("gpt-image-2"))
  );
}

function supportsBrowserRealtimeVoice(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }
  return (
    typeof window.RTCPeerConnection === "function" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof document !== "undefined" &&
    typeof document.createElement === "function"
  );
}

function getLiveVoiceStatusLabel(state: LiveVoiceUiState, status?: VoiceStatus["realtime"] | null): string {
  if (state === "requesting_mic") {
    return "Requesting microphone";
  }
  if (state === "connecting") {
    return "OpenAI Realtime connecting";
  }
  if (state === "listening") {
    return "OpenAI Realtime listening";
  }
  if (state === "speaking") {
    return "OpenAI Realtime speaking";
  }
  if (state === "thinking") {
    return "OpenAI Realtime thinking";
  }
  if (state === "stopping") {
    return "Stopping OpenAI Realtime voice";
  }
  if (state === "error") {
    return "OpenAI Realtime voice needs attention";
  }
  if (status?.apiKeyReady) {
    return `OpenAI Realtime ready · ${status.model}`;
  }
  return "OpenAI Realtime unavailable";
}

function mapRealtimeEventToLiveVoiceState(eventType: string): LiveVoiceUiState | null {
  if (
    eventType === "response.audio.delta" ||
    eventType === "response.output_audio.delta" ||
    eventType === "output_audio_buffer.started"
  ) {
    return "speaking";
  }
  if (
    eventType === "input_audio_buffer.speech_stopped" ||
    eventType === "response.created" ||
    eventType === "response.output_item.added"
  ) {
    return "thinking";
  }
  if (
    eventType === "input_audio_buffer.speech_started" ||
    eventType === "response.done" ||
    eventType === "output_audio_buffer.stopped"
  ) {
    return "listening";
  }
  if (eventType === "error") {
    return "error";
  }
  return null;
}

function parseRealtimeEventType(raw: MessageEvent["data"]): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { type?: unknown };
    return typeof parsed.type === "string" ? parsed.type : null;
  } catch {
    return null;
  }
}

function cleanupLiveVoiceConnection(connection: LiveVoiceConnection | null): void {
  if (!connection) {
    return;
  }
  connection.dataChannel.close();
  connection.peerConnection.close();
  for (const track of connection.mediaStream.getTracks()) {
    track.stop();
  }
  connection.audioElement.srcObject = null;
  connection.audioElement.remove();
}

export function useChatMultimodalControls(input: {
  providerOptions: ChatModelProviderOption[];
  selectedProviderId?: string;
  preferredImageProviderId?: string;
  preferredImageModel?: string;
  routePreflight: RoutingPreflightResult | null;
  selectedSessionId: string | null;
  activeThreadSessionId?: string | null;
  pendingAttachments: ChatAttachmentRecord[];
  draft: string;
  latestAssistantMessageId?: string;
  latestAssistantContent?: string;
  latestAssistantStatus?: ChatTurnLifecycleStatus;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setError: (value: string | null, source?: ChatErrorSource) => void;
  pushLocalNotice: (message: string, tone?: "neutral" | "warning" | "critical" | "success") => void;
  uploadAttachments: (files: File[]) => Promise<void>;
}) {
  const {
    providerOptions,
    selectedProviderId,
    preferredImageProviderId,
    preferredImageModel,
    routePreflight,
    selectedSessionId,
    activeThreadSessionId,
    pendingAttachments,
    draft,
    latestAssistantMessageId,
    latestAssistantContent,
    latestAssistantStatus,
    setDraft,
    setError,
    pushLocalNotice,
    uploadAttachments,
  } = input;

  const audioInputRef = useRef<HTMLInputElement | null>(null);
  const lastSpokenMessageIdRef = useRef<string | null>(null);
  const liveVoiceConnectionRef = useRef<LiveVoiceConnection | null>(null);
  const liveVoiceStartRef = useRef<PendingLiveVoiceStart | null>(null);
  const primedSessionIdRef = useRef<string | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const [voiceRuntime, setVoiceRuntime] = useState<VoiceRuntimeStatus | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [liveVoiceState, setLiveVoiceState] = useState<LiveVoiceUiState>("idle");
  const [liveVoiceMuted, setLiveVoiceMuted] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [speakResponsesEnabled, setSpeakResponsesEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return false;
    }
    try {
      return window.localStorage.getItem(SPEAK_REPLIES_PREF_KEY) === "true";
    } catch {
      return false;
    }
  });

  const activeProviderId =
    routePreflight?.effectiveProviderId ?? selectedProviderId ?? providerOptions[0]?.providerId ?? null;
  const activeProvider = useMemo(
    () => providerOptions.find((provider) => provider.providerId === activeProviderId) ?? null,
    [activeProviderId, providerOptions],
  );
  const imageProviderOptions = useMemo(
    () =>
      providerOptions.map((provider) => toImageProviderOption(provider)).filter(Boolean) as ChatModelProviderOption[],
    [providerOptions],
  );
  const preferredImageProvider = useMemo(
    () => imageProviderOptions.find((provider) => provider.providerId === preferredImageProviderId) ?? null,
    [imageProviderOptions, preferredImageProviderId],
  );
  const primaryImageRoute = useMemo(() => {
    const preferredRoute = buildImageRoute(preferredImageProvider, preferredImageModel);
    if (preferredRoute) {
      return preferredRoute;
    }
    const activeRoute = buildImageRoute(toImageProviderOption(activeProvider) ?? undefined);
    if (activeRoute) {
      return activeRoute;
    }
    return (
      buildImageRoute(imageProviderOptions.find((provider) => provider.providerId === "openai")) ??
      buildImageRoute(imageProviderOptions.find((provider) => provider.providerId === "google")) ??
      null
    );
  }, [activeProvider, imageProviderOptions, preferredImageModel, preferredImageProvider]);
  const googleFallbackImageRoute = useMemo(() => {
    if (primaryImageRoute?.providerId !== "openai") {
      return null;
    }
    return buildImageRoute(imageProviderOptions.find((provider) => provider.providerId === "google"));
  }, [imageProviderOptions, primaryImageRoute]);
  const latestImageAttachment = useMemo(
    () => [...pendingAttachments].reverse().find(isImageAttachment) ?? null,
    [pendingAttachments],
  );
  const supportsSpeechSynthesis =
    typeof window !== "undefined" &&
    typeof window.speechSynthesis !== "undefined" &&
    typeof window.SpeechSynthesisUtterance !== "undefined";
  const voiceReady = voiceRuntime?.readiness === "ready";
  const voiceInputAvailable = voiceReady && activeProvider?.capabilities?.voiceInput !== false;
  const voiceOutputAvailable = supportsSpeechSynthesis && activeProvider?.capabilities?.voiceOutput !== false;
  const realtimeVoiceStatus = voiceStatus?.realtime ?? null;
  const liveVoiceBrowserAvailable = supportsBrowserRealtimeVoice();
  const liveVoiceAvailable =
    liveVoiceBrowserAvailable &&
    activeProvider?.capabilities?.voiceInput !== false &&
    realtimeVoiceStatus?.apiKeyReady === true;
  const liveVoiceActive =
    liveVoiceConnectionRef.current !== null ||
    liveVoiceState === "requesting_mic" ||
    liveVoiceState === "connecting" ||
    liveVoiceState === "listening" ||
    liveVoiceState === "speaking" ||
    liveVoiceState === "thinking" ||
    liveVoiceState === "stopping";
  const liveVoiceStatusLabel = getLiveVoiceStatusLabel(liveVoiceState, realtimeVoiceStatus);
  const liveVoiceUnavailableReason = liveVoiceAvailable
    ? null
    : !liveVoiceBrowserAvailable
      ? "OpenAI Realtime voice needs browser microphone and WebRTC support."
      : realtimeVoiceStatus?.apiKeyReady === false
        ? "OpenAI Realtime voice requires OPENAI_API_KEY on the Gateway."
        : "OpenAI Realtime voice readiness has not been confirmed yet.";
  const imageGenerationAvailable = Boolean(primaryImageRoute);
  const imageEditAvailable = Boolean(primaryImageRoute?.supportsEdit && latestImageAttachment);
  const imageRouteLabel = primaryImageRoute
    ? googleFallbackImageRoute
      ? `${primaryImageRoute.label} with ${googleFallbackImageRoute.label} fallback`
      : primaryImageRoute.label
    : null;
  // `talk` is required by the VoiceStatus contract, but partial gateway
  // responses (e.g. a stub returning {}) can omit it at runtime — treat a
  // missing talk block as "no active talk session" everywhere below.
  const voiceStatusLabel = voiceStatus?.talk?.activeSessionId
    ? "Talk mode live"
    : voiceReady
      ? voiceRuntime?.selectedModelId
        ? `Voice ready · ${voiceRuntime.selectedModelId}`
        : "Voice runtime ready"
      : voiceRuntime?.readiness === "broken"
        ? "Voice runtime needs repair"
        : "Voice runtime unavailable";
  const voiceUnavailableReason = voiceInputAvailable
    ? null
    : voiceRuntime?.readiness === "broken"
      ? "Voice runtime is installed but incomplete. Repair it in Configure > Runtime."
      : "Voice runtime is not ready yet. Install a local voice model in Configure > Runtime.";

  const refreshVoiceState = useCallback(async () => {
    try {
      const [status, runtime] = await Promise.all([fetchVoiceStatus(), fetchVoiceRuntimeStatus()]);
      setVoiceStatus(status);
      setVoiceRuntime(runtime);
    } catch {
      setVoiceStatus(null);
      setVoiceRuntime(null);
    }
  }, []);

  useEffect(() => {
    void refreshVoiceState();
  }, [refreshVoiceState]);

  useEffect(
    () => () => {
      const connection = liveVoiceConnectionRef.current;
      const pendingStart = liveVoiceStartRef.current;
      if (pendingStart) {
        pendingStart.canceled = true;
      }
      for (const track of pendingStart?.mediaStream?.getTracks() ?? []) {
        track.stop();
      }
      cleanupLiveVoiceConnection(connection);
      liveVoiceConnectionRef.current = null;
      liveVoiceStartRef.current = null;
      if (connection?.voiceSessionId) {
        void stopRealtimeVoiceSession(connection.voiceSessionId).catch(() => undefined);
      } else if (pendingStart?.voiceSessionId) {
        void stopRealtimeVoiceSession(pendingStart.voiceSessionId).catch(() => undefined);
      }
    },
    [],
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.setItem(SPEAK_REPLIES_PREF_KEY, String(speakResponsesEnabled));
    } catch {
      // Fallback: localStorage may be disabled or quota-exceeded; preference will not persist this session.
    }
  }, [speakResponsesEnabled]);

  useEffect(() => {
    if (primedSessionIdRef.current === selectedSessionId) {
      return;
    }
    if (activeThreadSessionId !== selectedSessionId) {
      return;
    }
    primedSessionIdRef.current = selectedSessionId;
    lastSpokenMessageIdRef.current = latestAssistantMessageId ?? null;
    if (typeof window !== "undefined" && typeof window.speechSynthesis !== "undefined") {
      window.speechSynthesis.cancel();
    }
  }, [activeThreadSessionId, latestAssistantMessageId, selectedSessionId]);

  useEffect(() => {
    if (
      !voiceOutputAvailable ||
      !speakResponsesEnabled ||
      !latestAssistantMessageId ||
      !latestAssistantContent?.trim() ||
      latestAssistantStatus !== "completed"
    ) {
      return;
    }
    if (lastSpokenMessageIdRef.current === latestAssistantMessageId) {
      return;
    }
    lastSpokenMessageIdRef.current = latestAssistantMessageId;
    const utterance = new window.SpeechSynthesisUtterance(latestAssistantContent);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    return () => {
      window.speechSynthesis.cancel();
    };
  }, [
    latestAssistantContent,
    latestAssistantMessageId,
    latestAssistantStatus,
    speakResponsesEnabled,
    voiceOutputAvailable,
  ]);

  const handleToggleVoiceTalk = useCallback(async () => {
    setVoiceBusy(true);
    setError(null);
    try {
      if (voiceStatus?.talk?.activeSessionId) {
        await stopVoiceTalkSession(voiceStatus.talk.activeSessionId);
        pushLocalNotice("Push-to-talk session stopped.", "neutral");
      } else {
        await startVoiceTalkSession({
          mode: "push_to_talk",
          sessionId: selectedSessionId ?? undefined,
        });
        pushLocalNotice("Push-to-talk session started.", "success");
      }
      await refreshVoiceState();
    } catch (error) {
      setError((error as Error).message);
      await refreshVoiceState();
    } finally {
      setVoiceBusy(false);
    }
  }, [pushLocalNotice, refreshVoiceState, selectedSessionId, setError, voiceStatus?.talk?.activeSessionId]);

  const stopLiveVoice = useCallback(
    async (announce = true) => {
      const connection = liveVoiceConnectionRef.current;
      const pendingStart = liveVoiceStartRef.current;
      if (pendingStart) {
        pendingStart.canceled = true;
      }
      if (!connection) {
        setLiveVoiceState("idle");
        setLiveVoiceMuted(false);
        if (pendingStart?.voiceSessionId) {
          await stopRealtimeVoiceSession(pendingStart.voiceSessionId).catch(() => undefined);
          await refreshVoiceState();
        }
        return;
      }
      setLiveVoiceState("stopping");
      cleanupLiveVoiceConnection(connection);
      liveVoiceConnectionRef.current = null;
      setLiveVoiceMuted(false);
      setLiveVoiceState("idle");
      try {
        await stopRealtimeVoiceSession(connection.voiceSessionId);
      } finally {
        await refreshVoiceState();
      }
      if (announce) {
        pushLocalNotice("OpenAI Realtime voice stopped.", "neutral");
      }
    },
    [pushLocalNotice, refreshVoiceState],
  );

  const cancelPendingLiveVoiceStart = useCallback(
    async (announce = true) => {
      const pendingStart = liveVoiceStartRef.current;
      if (!pendingStart) {
        setLiveVoiceState("idle");
        setLiveVoiceMuted(false);
        return;
      }
      pendingStart.canceled = true;
      liveVoiceStartRef.current = null;
      setLiveVoiceState("stopping");
      for (const track of pendingStart.mediaStream?.getTracks() ?? []) {
        track.stop();
      }
      if (pendingStart.voiceSessionId) {
        await stopRealtimeVoiceSession(pendingStart.voiceSessionId).catch(() => undefined);
      }
      setLiveVoiceMuted(false);
      setLiveVoiceState("idle");
      await refreshVoiceState();
      if (announce) {
        pushLocalNotice("OpenAI Realtime voice stopped.", "neutral");
      }
    },
    [pushLocalNotice, refreshVoiceState],
  );

  const handleToggleLiveVoice = useCallback(async () => {
    if (liveVoiceConnectionRef.current) {
      await stopLiveVoice();
      return;
    }
    if (liveVoiceStartRef.current) {
      await cancelPendingLiveVoiceStart();
      return;
    }
    if (!supportsBrowserRealtimeVoice()) {
      setError("OpenAI Realtime voice needs browser microphone and WebRTC support.");
      setLiveVoiceState("error");
      return;
    }

    setVoiceBusy(true);
    setError(null);
    setLiveVoiceState("connecting");
    let issuedVoiceSessionId: string | null = null;
    let pendingMediaStream: MediaStream | null = null;
    let pendingConnection: LiveVoiceConnection | null = null;
    const pendingStart: PendingLiveVoiceStart = {
      canceled: false,
      mediaStream: null,
      voiceSessionId: null,
    };
    liveVoiceStartRef.current = pendingStart;
    let canceledStart = false;
    const abortIfCanceled = () => {
      if (pendingStart.canceled || liveVoiceStartRef.current !== pendingStart) {
        canceledStart = true;
        throw new Error("OpenAI Realtime voice start was canceled.");
      }
    };
    try {
      const token = await createRealtimeVoiceClientSecret({
        surface: "chat",
        sessionId: selectedSessionId ?? undefined,
      });
      issuedVoiceSessionId = token.voiceSessionId;
      pendingStart.voiceSessionId = token.voiceSessionId;
      abortIfCanceled();
      setLiveVoiceState("requesting_mic");
      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      pendingMediaStream = mediaStream;
      pendingStart.mediaStream = mediaStream;
      abortIfCanceled();
      setLiveVoiceState("connecting");

      const peerConnection = new window.RTCPeerConnection();
      const audioElement = document.createElement("audio");
      audioElement.autoplay = true;
      audioElement.setAttribute("data-goatcitadel-live-voice", "true");
      document.body?.appendChild(audioElement);

      peerConnection.ontrack = (event) => {
        audioElement.srcObject = event.streams[0] ?? null;
      };
      for (const track of mediaStream.getAudioTracks()) {
        peerConnection.addTrack(track, mediaStream);
      }
      const dataChannel = peerConnection.createDataChannel("oai-events");
      dataChannel.onopen = () => setLiveVoiceState("listening");
      dataChannel.onmessage = (event) => {
        const eventType = parseRealtimeEventType(event.data);
        const nextState = eventType ? mapRealtimeEventToLiveVoiceState(eventType) : null;
        if (nextState) {
          setLiveVoiceState(nextState);
        }
      };
      dataChannel.onerror = () => setLiveVoiceState("error");

      pendingConnection = {
        peerConnection,
        dataChannel,
        mediaStream,
        audioElement,
        voiceSessionId: token.voiceSessionId,
      };
      liveVoiceConnectionRef.current = pendingConnection;
      abortIfCanceled();

      const offer = await peerConnection.createOffer();
      if (!offer.sdp) {
        throw new Error("Unable to create a WebRTC offer for OpenAI Realtime voice.");
      }
      await peerConnection.setLocalDescription(offer);
      abortIfCanceled();
      const sdpResponse = await fetch(OPENAI_REALTIME_CALLS_URL, {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${token.clientSecret.value}`,
          "Content-Type": "application/sdp",
        },
      });
      if (!sdpResponse.ok) {
        const message = (await sdpResponse.text()).trim() || sdpResponse.statusText || "Realtime connection failed.";
        throw new Error(`OpenAI Realtime WebRTC connection failed (${sdpResponse.status}): ${message}`);
      }
      abortIfCanceled();
      await peerConnection.setRemoteDescription({
        type: "answer",
        sdp: await sdpResponse.text(),
      });
      abortIfCanceled();
      setLiveVoiceState("listening");
      pushLocalNotice("OpenAI Realtime voice is live.", "success");
      await refreshVoiceState();
    } catch (error) {
      cleanupLiveVoiceConnection(pendingConnection);
      if (!pendingConnection) {
        for (const track of pendingMediaStream?.getTracks() ?? []) {
          track.stop();
        }
      }
      if (liveVoiceConnectionRef.current === pendingConnection) {
        liveVoiceConnectionRef.current = null;
      }
      if (issuedVoiceSessionId) {
        await stopRealtimeVoiceSession(issuedVoiceSessionId).catch(() => undefined);
      }
      if (canceledStart || pendingStart.canceled) {
        setLiveVoiceMuted(false);
        setLiveVoiceState("idle");
        await refreshVoiceState();
        return;
      }
      setLiveVoiceState("error");
      setError((error as Error).message);
      await refreshVoiceState();
    } finally {
      if (liveVoiceStartRef.current === pendingStart) {
        liveVoiceStartRef.current = null;
      }
      setVoiceBusy(false);
    }
  }, [cancelPendingLiveVoiceStart, pushLocalNotice, refreshVoiceState, selectedSessionId, setError, stopLiveVoice]);

  const handleToggleLiveVoiceMute = useCallback(() => {
    const connection = liveVoiceConnectionRef.current;
    if (!connection) {
      return;
    }
    const nextMuted = !liveVoiceMuted;
    for (const track of connection.mediaStream.getAudioTracks()) {
      track.enabled = !nextMuted;
    }
    setLiveVoiceMuted(nextMuted);
    pushLocalNotice(nextMuted ? "OpenAI Realtime microphone muted." : "OpenAI Realtime microphone unmuted.", "neutral");
  }, [liveVoiceMuted, pushLocalNotice]);

  const handleOpenAudioTranscribe = useCallback(() => {
    audioInputRef.current?.click();
  }, []);

  const handleAudioFileSelected = useCallback(
    async (files: FileList | null) => {
      const file = files?.item(0);
      if (!file) {
        return;
      }
      setVoiceBusy(true);
      setError(null);
      try {
        const text = await fileToBase64(file).then((bytesBase64) =>
          transcribeVoice({
            bytesBase64,
            mimeType: file.type || "audio/wav",
          }),
        );
        setDraft((current) => (current.trim() ? `${current.trim()}\n\n${text.text}` : text.text));
        pushLocalNotice(`Inserted transcript from ${file.name}.`, "success");
        await refreshVoiceState();
      } catch (error) {
        setError((error as Error).message);
        await refreshVoiceState();
      } finally {
        setVoiceBusy(false);
        if (audioInputRef.current) {
          audioInputRef.current.value = "";
        }
      }
    },
    [pushLocalNotice, refreshVoiceState, setDraft, setError],
  );

  const runImageGeneration = useCallback(
    async (mode: "generate" | "edit", options?: ImageGenerationOptions): Promise<boolean> => {
      const prompt = draft.trim();
      if (!prompt) {
        setError("Add an image prompt first.");
        return false;
      }
      setImageBusy(true);
      setError(null);
      try {
        if (!primaryImageRoute) {
          throw new Error("Image generation is unavailable on the current routes.");
        }
        if (mode === "edit" && !primaryImageRoute.supportsEdit) {
          throw new Error("Image editing is unavailable on the current image route.");
        }
        const referenceImages =
          mode === "edit" && latestImageAttachment
            ? [
                await downloadChatAttachment(latestImageAttachment.attachmentId).then(
                  async ({ blob, fileName, mimeType }) => ({
                    bytesBase64: await blobToBase64(blob),
                    fileName,
                    mimeType,
                  }),
                ),
              ]
            : undefined;
        const runRequest = async (route: ChatImageRoute) =>
          generateLlmImage({
            providerId: route.providerId,
            model: route.model,
            prompt,
            referenceImages,
            ...(route.providerId === "openai"
              ? { outputFormat: "png" as const }
              : { responseFormat: "b64_json" as const }),
          });
        let routeUsed = primaryImageRoute;
        let response;
        try {
          response = await runRequest(primaryImageRoute);
        } catch (error) {
          const message = (error as Error).message;
          if (
            mode === "generate" &&
            googleFallbackImageRoute &&
            shouldRetryImageGenerationWithGoogleFallback(message)
          ) {
            routeUsed = googleFallbackImageRoute;
            pushLocalNotice(
              `OpenAI image route unavailable. Retrying via ${googleFallbackImageRoute.label}.`,
              "warning",
            );
            response = await runRequest(googleFallbackImageRoute);
          } else {
            throw error;
          }
        }
        const first = response.data[0];
        if (!first?.b64Json) {
          throw new Error("Image generation returned no image payload.");
        }
        const file = base64ToFile(
          first.b64Json,
          `goatcitadel-${response.operation}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
          "image/png",
        );
        await uploadAttachments([file]);
        if (options?.clearDraftOnSuccess) {
          setDraft("");
        }
        pushLocalNotice(
          response.operation === "edit"
            ? "Edited image added to the draft attachments."
            : options?.trigger === "auto_send"
              ? `Detected image request and generated it via ${routeUsed.label}.`
              : routeUsed.providerId === "google"
                ? `Generated image added to the draft attachments via ${routeUsed.label}.`
                : "Generated image added to the draft attachments.",
          "success",
        );
        return true;
      } catch (error) {
        setError((error as Error).message, mode === "edit" ? "image_edit" : "image_generate");
        return false;
      } finally {
        setImageBusy(false);
      }
    },
    [
      draft,
      googleFallbackImageRoute,
      latestImageAttachment,
      primaryImageRoute,
      pushLocalNotice,
      setDraft,
      setError,
      uploadAttachments,
    ],
  );

  return {
    audioInputRef,
    voiceBusy,
    liveVoiceActive,
    liveVoiceAvailable,
    liveVoiceMuted,
    liveVoiceState,
    liveVoiceStatusLabel,
    liveVoiceUnavailableReason,
    voiceInputAvailable,
    voiceOutputAvailable,
    voiceTalkActive: Boolean(voiceStatus?.talk?.activeSessionId),
    voiceStatusLabel,
    voiceUnavailableReason,
    speakResponsesEnabled,
    setSpeakResponsesEnabled,
    imageBusy,
    imageGenerationAvailable,
    imageEditAvailable,
    imageProviderOptions,
    selectedImageProviderId: primaryImageRoute?.providerId,
    selectedImageModel: primaryImageRoute?.model,
    imageRouteLabel,
    handleToggleVoiceTalk,
    handleToggleLiveVoice,
    handleToggleLiveVoiceMute,
    handleOpenAudioTranscribe,
    handleAudioFileSelected,
    handleGenerateImage: (options?: ImageGenerationOptions) => runImageGeneration("generate", options),
    handleEditImage: (options?: ImageGenerationOptions) => runImageGeneration("edit", options),
  };
}
