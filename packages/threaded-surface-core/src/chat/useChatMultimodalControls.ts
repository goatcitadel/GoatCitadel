import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatAttachmentRecord,
  ChatSessionRecord,
  RoutingPreflightResult,
  ChatTurnLifecycleStatus,
  VoiceRuntimeStatus,
  VoiceStatus,
} from "@goatcitadel/contracts";
import type { ChatModelProviderOption } from "@goatcitadel/mission-control-shared/components/ChatModelPicker";
import type { ChatErrorSource } from "./chat-error-copy";
import { getGatewayAccessRevision, getGatewayCallerScopeRevision } from "@goatcitadel/mission-control-shared/api/access-scope";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { fetchVoiceRuntimeStatus, fetchVoiceStatus } from "@goatcitadel/mission-control-shared/api/client";
import type { UploadAttachmentOptions, ChatImageRoute, ImageGenerationOptions } from "./multimodal-action-types";
import type { LiveVoiceUiState } from "./multimodal-live-voice-start.js";
import type { createRealtimeVoiceOperation } from "./multimodal-realtime-voice.js";
export type { ImageGenerationOptions } from "./multimodal-action-types";

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

// These functions cache code only. Rejected loads are retried on the next explicit action.
export const multimodalCodeLoaders = {
  image: () => import("./multimodal-image-code.js"),
  transcribe: () => import("./multimodal-transcribe-code.js"),
  realtime: () => import("./multimodal-realtime-voice.js"),
  voiceApi: () => import("./multimodal-voice-api.js"),
};
let imageCodePromise: ReturnType<typeof multimodalCodeLoaders.image> | undefined;
let transcribeCodePromise: ReturnType<typeof multimodalCodeLoaders.transcribe> | undefined;
let realtimeCodePromise: ReturnType<typeof multimodalCodeLoaders.realtime> | undefined;
let voiceApiPromise: ReturnType<typeof multimodalCodeLoaders.voiceApi> | undefined;
function loadImageCode() {
  return imageCodePromise ??= multimodalCodeLoaders.image().catch((error: unknown) => {
    imageCodePromise = undefined;
    throw error;
  });
}
function loadTranscribeCode() {
  return transcribeCodePromise ??= multimodalCodeLoaders.transcribe().catch((error: unknown) => {
    transcribeCodePromise = undefined;
    throw error;
  });
}

function loadRealtimeCode() {
  return realtimeCodePromise ??= multimodalCodeLoaders.realtime().catch((error: unknown) => {
    realtimeCodePromise = undefined;
    throw error;
  });
}

function loadVoiceApi() {
  return voiceApiPromise ??= multimodalCodeLoaders.voiceApi().catch((error: unknown) => {
    voiceApiPromise = undefined;
    throw error;
  });
}

interface LiveVoiceAttempt {
  operation?: ReturnType<typeof createRealtimeVoiceOperation>;
}

function isImageAttachment(attachment: ChatAttachmentRecord): boolean {
  return attachment.mediaType === "image" || attachment.mimeType.startsWith("image/");
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

export function useChatMultimodalControls(input: {
  workspaceId?: string;
  selectionRevisionRef?: { readonly current: number };
  selectedSession?: ChatSessionRecord | null;
  /** Native disclosures request readiness on intent; compatibility callers retain eager reads. */
  deferVoiceReadiness?: boolean;
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
  uploadAttachments: (files: File[], options?: UploadAttachmentOptions) => Promise<boolean>;
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
  const liveVoiceAttemptRef = useRef<LiveVoiceAttempt | null>(null);
  const talkAttemptRef = useRef<object | null>(null);
  const voiceReadGenerationRef = useRef(0);
  const primedSessionIdRef = useRef<string | null>(null);
  const [mediaReadinessRequested, setMediaReadinessRequested] = useState(false);
  const onMediaControlsOpenChange = useCallback((open: boolean) => {
    if (open) setMediaReadinessRequested(true);
  }, []);
  const [voiceReadiness, setVoiceReadiness] = useState<{
    authority: string;
    status: VoiceStatus;
    runtime: VoiceRuntimeStatus;
  } | null>(null);
  const [transcriptionBusy, setTranscriptionBusy] = useState(false);
  const [talkBusy, setTalkBusy] = useState(false);
  const [realtimeBusy, setRealtimeBusy] = useState(false);
  const voiceBusy = transcriptionBusy || talkBusy || realtimeBusy;
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
  const mountedRef = useRef(true);
  const [, refreshImageMountGeneration] = useState(0);
  const currentInputRef = useRef(input);
  currentInputRef.current = input;
  type MediaTicket = { scope: string; generation: number; draft: string; revision: number; authority: string };
  type ImageTicket = {
    generation: number; base: string; revision: number; draft: string; selectedId: string | null;
    workspace: string | undefined; destination?: string; selectionSeen: boolean;
    recordSeen: boolean; threadSeen: boolean; confirmationOpen: boolean; revoked: boolean;
  };
  const imageTicketRef = useRef<ImageTicket | null>(null);
  const imagePublicationRef = useRef<ImageTicket | null>(null);
  const transcriptTicketRef = useRef<MediaTicket | null>(null);
  const getTranscriptAuthority = useCallback(() => JSON.stringify([
    currentInputRef.current.workspaceId ?? currentInputRef.current.selectedSession?.workspaceId,
    getGatewayApiBaseUrl(), getGatewayAccessRevision(), getGatewayCallerScopeRevision(),
  ]), []);
  const transcriptAuthority = getTranscriptAuthority();
  const voiceStatus = voiceReadiness?.authority === transcriptAuthority ? voiceReadiness.status : null;
  const voiceRuntime = voiceReadiness?.authority === transcriptAuthority ? voiceReadiness.runtime : null;
  const mediaSelectionRevision = input.selectionRevisionRef?.current ?? 0;
  const mediaScope = JSON.stringify([selectedSessionId, mediaSelectionRevision, transcriptAuthority, activeThreadSessionId, activeProviderId,
    primaryImageRoute?.providerId, primaryImageRoute?.model, primaryImageRoute?.supportsEdit, googleFallbackImageRoute?.model]);
  const scopeRef = useRef(mediaScope);
  const generationRef = useRef(0);
  if (scopeRef.current !== mediaScope) generationRef.current += 1;
  scopeRef.current = mediaScope;
  const mediaGeneration = generationRef.current;
  const renderedImageGenerationRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    if (imageOwnerRef.current.generation !== renderedImageGenerationRef.current) refreshImageMountGeneration((value) => value + 1);
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      imageOwnerRef.current.generation += 1;
      if (imageTicketRef.current) imageTicketRef.current.revoked = true;
      imageTicketRef.current = null;
      if (imagePublicationRef.current) imagePublicationRef.current.revoked = true;
      imagePublicationRef.current = null;
    };
  }, []);
  useEffect(() => {
    if (transcriptTicketRef.current && transcriptTicketRef.current.generation !== mediaGeneration) {
      transcriptTicketRef.current = null;
      setTranscriptionBusy(false);
    }
  }, [mediaScope, mediaGeneration]);

  const imageWorkspace = input.workspaceId ?? input.selectedSession?.workspaceId;
  const imageRevision = input.selectionRevisionRef?.current ?? 0;
  const imageBase = JSON.stringify([imageWorkspace, getGatewayApiBaseUrl(), getGatewayAccessRevision(),
    getGatewayCallerScopeRevision(), activeProviderId, primaryImageRoute, googleFallbackImageRoute]);
  const imageObservation = { selectedId: selectedSessionId, revision: imageRevision,
    recordId: input.selectedSession?.sessionId ?? null, recordWorkspace: input.selectedSession?.workspaceId,
    threadId: activeThreadSessionId ?? null };
  const imageObservationKey = JSON.stringify([imageBase, imageObservation]);
  const imageOwnerRef = useRef({ generation: 0, key: imageObservationKey });
  if (imageOwnerRef.current.key !== imageObservationKey) {
    const generation = imageOwnerRef.current.generation + 1;
    const ticket = imageTicketRef.current ?? imagePublicationRef.current;
    let allowed = Boolean(ticket && !ticket.revoked && ticket.base === imageBase);
    if (ticket && allowed) {
      const target = ticket.destination ?? ticket.selectedId;
      const waitingForOwnSelection = Boolean(ticket.destination && !ticket.selectionSeen &&
        selectedSessionId === null && imageRevision === ticket.revision);
      allowed = waitingForOwnSelection || (selectedSessionId === target &&
        imageRevision === ticket.revision + (ticket.destination ? 1 : 0));
      if (allowed && !waitingForOwnSelection && ticket.destination) ticket.selectionSeen = true;
      if (imageObservation.recordId !== null) {
        allowed = allowed && imageObservation.recordId === target && imageObservation.recordWorkspace === ticket.workspace;
        if (allowed) ticket.recordSeen = true;
      } else if (ticket.recordSeen) allowed = false;
      if (imageObservation.threadId !== null) {
        allowed = allowed && imageObservation.threadId === target;
        if (allowed) ticket.threadSeen = true;
      } else if (ticket.threadSeen) allowed = false;
      if (allowed) ticket.generation = generation;
    }
    if (ticket && !allowed) { ticket.revoked = true; imageTicketRef.current = null; }
    imageOwnerRef.current = { generation, key: imageObservationKey };
  }
  const imageGeneration = imageOwnerRef.current.generation;
  renderedImageGenerationRef.current = imageGeneration;
  const hasCurrentImageBase = useCallback((ticket: ImageTicket) =>
    ticket.base === JSON.stringify([currentInputRef.current.workspaceId ?? currentInputRef.current.selectedSession?.workspaceId,
        getGatewayApiBaseUrl(), getGatewayAccessRevision(), getGatewayCallerScopeRevision(), activeProviderId,
        primaryImageRoute, googleFallbackImageRoute]), [activeProviderId, googleFallbackImageRoute, primaryImageRoute]);
  const currentImage = useCallback((ticket: ImageTicket) => {
    const revision = currentInputRef.current.selectionRevisionRef?.current ?? imageRevision;
    return mountedRef.current && imageTicketRef.current === ticket && !ticket.revoked &&
      ticket.generation === imageOwnerRef.current.generation && currentInputRef.current.draft === ticket.draft &&
      hasCurrentImageBase(ticket) &&
      (revision === ticket.revision + (ticket.destination ? 1 : 0) ||
        Boolean(ticket.destination && !ticket.selectionSeen && revision === ticket.revision));
  }, [hasCurrentImageBase, imageRevision]);
  useEffect(() => { if (!imageTicketRef.current) setImageBusy(false); }, [imageGeneration]);

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
    liveVoiceAttemptRef.current !== null ||
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
        : voiceRuntime
          ? "Voice runtime unavailable"
          : "Voice readiness not confirmed";
  const voiceUnavailableReason = voiceInputAvailable
    ? null
    : !voiceRuntime
      ? "Voice readiness has not been confirmed yet."
      : voiceRuntime.readiness === "broken"
        ? "Voice runtime is installed but incomplete. Repair it in Configure > Runtime."
        : "Voice runtime is not ready yet. Install a local voice model in Configure > Runtime.";

  const refreshVoiceState = useCallback(async () => {
    if (!mountedRef.current) return;
    const generation = ++voiceReadGenerationRef.current;
    const authority = getTranscriptAuthority();
    const current = () => mountedRef.current && generation === voiceReadGenerationRef.current &&
      authority === getTranscriptAuthority();
    try {
      const [status, runtime] = await Promise.all([fetchVoiceStatus(), fetchVoiceRuntimeStatus()]);
      if (!current()) return;
      setVoiceReadiness({ authority, status, runtime });
    } catch {
      if (current()) setVoiceReadiness(null);
    }
  }, [getTranscriptAuthority]);

  useEffect(() => {
    if (!input.deferVoiceReadiness || mediaReadinessRequested) void refreshVoiceState();
  }, [input.deferVoiceReadiness, mediaReadinessRequested, refreshVoiceState, transcriptAuthority]);

  useEffect(() => {
    setLiveVoiceState("idle");
    setLiveVoiceMuted(false);
    setTalkBusy(false);
    setRealtimeBusy(false);
    return () => {
      voiceReadGenerationRef.current += 1;
      const attempt = liveVoiceAttemptRef.current;
      liveVoiceAttemptRef.current = null;
      talkAttemptRef.current = null;
      void attempt?.operation?.stop().catch(() => undefined);
    };
  }, []);

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

  const isMediaScopeCurrent = useCallback(() =>
    mountedRef.current &&
    generationRef.current === mediaGeneration &&
    (currentInputRef.current.selectionRevisionRef?.current ?? 0) === mediaSelectionRevision &&
    getTranscriptAuthority() === transcriptAuthority,
  [getTranscriptAuthority, mediaGeneration, mediaSelectionRevision, transcriptAuthority]);

  const handleToggleVoiceTalk = useCallback(async () => {
    if (!isMediaScopeCurrent() || talkAttemptRef.current) return;
    const attempt = {};
    talkAttemptRef.current = attempt;
    const current = () => talkAttemptRef.current === attempt && isMediaScopeCurrent();
    setTalkBusy(true);
    setError(null);
    try {
      const { startVoiceTalkSession, stopVoiceTalkSession } = await loadVoiceApi();
      if (!current()) return;
      if (voiceStatus?.talk?.activeSessionId) {
        await stopVoiceTalkSession(voiceStatus.talk.activeSessionId);
        if (current()) pushLocalNotice("Push-to-talk session stopped.", "neutral");
      } else {
        await startVoiceTalkSession({
          mode: "push_to_talk",
          sessionId: selectedSessionId ?? undefined,
        });
        if (current()) pushLocalNotice("Push-to-talk session started.", "success");
      }
      if (current()) await refreshVoiceState();
    } catch (error) {
      if (!current()) return;
      setError((error as Error).message);
      await refreshVoiceState();
    } finally {
      if (talkAttemptRef.current === attempt) {
        talkAttemptRef.current = null;
        setTalkBusy(false);
      }
    }
  }, [isMediaScopeCurrent, pushLocalNotice, refreshVoiceState, selectedSessionId, setError, voiceStatus?.talk?.activeSessionId]);

  const handleToggleLiveVoice = useCallback(async () => {
    if (!mountedRef.current) return;
    const previous = liveVoiceAttemptRef.current;
    if (previous) {
      liveVoiceAttemptRef.current = null;
      setRealtimeBusy(false);
      setLiveVoiceMuted(false);
      setLiveVoiceState("idle");
      try {
        await previous.operation?.stop();
      } catch (error) {
        if (!liveVoiceAttemptRef.current && isMediaScopeCurrent()) setError((error as Error).message);
        return;
      }
      if (!liveVoiceAttemptRef.current && isMediaScopeCurrent()) {
        pushLocalNotice("OpenAI Realtime voice stopped.", "neutral");
        await refreshVoiceState();
      }
      return;
    }
    if (!isMediaScopeCurrent()) return;
    if (!supportsBrowserRealtimeVoice()) {
      setError("OpenAI Realtime voice needs browser microphone and WebRTC support.");
      setLiveVoiceState("error");
      return;
    }

    const attempt: LiveVoiceAttempt = {};
    liveVoiceAttemptRef.current = attempt;
    const isStartCurrent = () => liveVoiceAttemptRef.current === attempt && isMediaScopeCurrent();
    setRealtimeBusy(true);
    setError(null);
    setLiveVoiceState("connecting");
    try {
      const { createRealtimeVoiceOperation } = await loadRealtimeCode();
      if (!isStartCurrent()) return;
      attempt.operation = createRealtimeVoiceOperation({
        sessionId: selectedSessionId,
        isStartCurrent,
        isAuthorityCurrent: () => getTranscriptAuthority() === transcriptAuthority,
        setState: (state) => {
          if (mountedRef.current && liveVoiceAttemptRef.current === attempt) setLiveVoiceState(state);
        },
      });
      await attempt.operation.start();
      if (!isStartCurrent()) return;
      pushLocalNotice("OpenAI Realtime voice is live.", "success");
      await refreshVoiceState();
    } catch (error) {
      if (!isStartCurrent()) return;
      liveVoiceAttemptRef.current = null;
      setLiveVoiceState("error");
      setError((error as Error).message);
      await refreshVoiceState();
    } finally {
      if (mountedRef.current && liveVoiceAttemptRef.current === attempt) {
        if (!isStartCurrent()) {
          liveVoiceAttemptRef.current = null;
          void attempt.operation?.stop().catch(() => undefined);
          setLiveVoiceMuted(false);
          setLiveVoiceState("idle");
        }
        setRealtimeBusy(false);
      } else if (mountedRef.current && !liveVoiceAttemptRef.current) {
        setRealtimeBusy(false);
      }
    }
  }, [getTranscriptAuthority, isMediaScopeCurrent, pushLocalNotice, refreshVoiceState, selectedSessionId, setError, transcriptAuthority]);

  const handleToggleLiveVoiceMute = useCallback(() => {
    const nextMuted = !liveVoiceMuted;
    if (!liveVoiceAttemptRef.current?.operation?.setMuted(nextMuted)) return;
    setLiveVoiceMuted(nextMuted);
    pushLocalNotice(nextMuted ? "OpenAI Realtime microphone muted." : "OpenAI Realtime microphone unmuted.", "neutral");
  }, [liveVoiceMuted, pushLocalNotice]);

  const handleOpenAudioTranscribe = useCallback(() => {
    audioInputRef.current?.click();
  }, []);

  const handleAudioFileSelected = useCallback(
    async (files: FileList | null) => {
      const file = files?.item(0);
      if (!file || !mountedRef.current || generationRef.current !== mediaGeneration ||
        (currentInputRef.current.selectionRevisionRef?.current ?? 0) !== mediaSelectionRevision ||
        getTranscriptAuthority() !== transcriptAuthority ||
        scopeRef.current !== mediaScope || voiceBusy || transcriptTicketRef.current) return;
      const ticket = { scope: mediaScope, generation: mediaGeneration, draft, revision: mediaSelectionRevision, authority: transcriptAuthority };
      transcriptTicketRef.current = ticket;
      const isCurrent = () => mountedRef.current && transcriptTicketRef.current === ticket &&
        scopeRef.current === ticket.scope && generationRef.current === ticket.generation &&
        (currentInputRef.current.selectionRevisionRef?.current ?? 0) === ticket.revision &&
        getTranscriptAuthority() === ticket.authority;
      setTranscriptionBusy(true);
      setError(null);
      try {
        const code = await loadTranscribeCode();
        if (!isCurrent()) return;
        const text = await code.transcribeAudioFile(file, isCurrent);
        if (!isCurrent()) return;
        setDraft((current) => mountedRef.current && scopeRef.current === ticket.scope && generationRef.current === ticket.generation &&
          (currentInputRef.current.selectionRevisionRef?.current ?? 0) === ticket.revision &&
          getTranscriptAuthority() === ticket.authority
          ? (current.trim() ? `${current.trim()}\n\n${text}` : text) : current);
        pushLocalNotice(`Inserted transcript from ${file.name}.`, "success");
        await refreshVoiceState();
      } catch (error) {
        if (!isCurrent()) return;
        setError((error as Error).message);
        await refreshVoiceState();
      } finally {
        if (mountedRef.current && transcriptTicketRef.current === ticket) {
          transcriptTicketRef.current = null;
          setTranscriptionBusy(false);
          if (audioInputRef.current) audioInputRef.current.value = "";
        }
      }
    },
    [draft, mediaScope, mediaGeneration, mediaSelectionRevision, transcriptAuthority, getTranscriptAuthority, voiceBusy, pushLocalNotice, refreshVoiceState, setDraft, setError],
  );

  const runImageGeneration = useCallback(
    async (mode: "generate" | "edit", options?: ImageGenerationOptions): Promise<boolean> => {
      if (!mountedRef.current || imageBase !== JSON.stringify([imageWorkspace, getGatewayApiBaseUrl(),
        getGatewayAccessRevision(), getGatewayCallerScopeRevision(), activeProviderId, primaryImageRoute, googleFallbackImageRoute]) ||
        imageOwnerRef.current.generation !== imageGeneration ||
        (input.selectionRevisionRef?.current ?? imageRevision) !== imageRevision ||
        currentInputRef.current.draft !== draft || imageTicketRef.current) return false;
      if ((input.selectedSession && input.selectedSession.sessionId !== selectedSessionId) ||
        (activeThreadSessionId && activeThreadSessionId !== selectedSessionId)) return false;
      const prompt = draft.trim();
      if (!prompt) { setError("Add an image prompt first."); return false; }
      const ticket: ImageTicket = { generation: imageGeneration, base: imageBase, revision: imageRevision,
        draft, selectedId: selectedSessionId, workspace: imageWorkspace, selectionSeen: false,
        recordSeen: Boolean(input.selectedSession), threadSeen: Boolean(activeThreadSessionId),
        confirmationOpen: true, revoked: false };
      imageTicketRef.current = ticket;
      imagePublicationRef.current = ticket;
      const isCurrent = () => currentImage(ticket);
      setImageBusy(true);
      setError(null);
      try {
        const code = await loadImageCode();
        if (!isCurrent()) return false;
        return await code.runImageGeneration({ mode, prompt, primaryImageRoute, googleFallbackImageRoute,
          latestImageAttachment, options, isCurrent, uploadAttachments, setError, pushLocalNotice,
          onCreatedSession: (created) => {
            if (!ticket.confirmationOpen) return false;
            if (!isCurrent() || ticket.destination || ticket.selectedId !== null ||
              ticket.recordSeen || ticket.threadSeen || !input.selectionRevisionRef || !ticket.workspace ||
              created.workspaceId !== ticket.workspace || !created.sessionId.trim()) {
              ticket.revoked = true; return false;
            }
            const destination = { workspaceId: ticket.workspace, sessionId: created.sessionId };
            if (options?.onCreatedSession && options.onCreatedSession(destination) !== true) { ticket.revoked = true; return false; }
            ticket.destination = destination.sessionId;
            return true;
          },
          clearDraft: () => setDraft((current) => mountedRef.current && imagePublicationRef.current === ticket &&
            hasCurrentImageBase(ticket) && !ticket.revoked && ticket.generation === imageOwnerRef.current.generation &&
            (input.selectionRevisionRef?.current ?? imageRevision) === ticket.revision + (ticket.destination ? 1 : 0) &&
            current === ticket.draft ? "" : current),
        });
      } catch (error) {
        if (isCurrent()) setError((error as Error).message, mode === "edit" ? "image_edit" : "image_generate");
        return false;
      } finally {
        ticket.confirmationOpen = false;
        if (mountedRef.current && imageTicketRef.current === ticket) {
          imageTicketRef.current = null;
          setImageBusy(false);
        }
      }
    },
    [activeProviderId, currentImage, hasCurrentImageBase, draft, imageGeneration, imageRevision, imageBase, imageWorkspace, input.selectionRevisionRef,
      input.selectedSession, selectedSessionId, activeThreadSessionId, googleFallbackImageRoute,
      latestImageAttachment, primaryImageRoute, pushLocalNotice, setDraft, setError, uploadAttachments],
  );

  return {
    onMediaControlsOpenChange,
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
