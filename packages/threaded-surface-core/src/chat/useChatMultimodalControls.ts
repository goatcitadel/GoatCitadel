import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatAttachmentRecord,
  RoutingPreflightResult,
  ChatTurnLifecycleStatus,
  VoiceRuntimeStatus,
  VoiceStatus,
} from "@goatcitadel/contracts";
import {
  downloadChatAttachment,
  fetchVoiceRuntimeStatus,
  fetchVoiceStatus,
  generateLlmImage,
  startVoiceTalkSession,
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
const IMAGE_MODEL_PREFERENCES: Record<"openai" | "google", readonly string[]> = {
  openai: OPENAI_IMAGE_MODEL_PREFERENCES,
  google: GOOGLE_IMAGE_MODEL_PREFERENCES,
};

interface ChatImageRoute {
  providerId: "openai" | "google";
  model: string;
  label: string;
  supportsEdit: boolean;
}

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
    reader.onerror = () => reject(new Error("Unable to read binary content."));
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
  return providerId === "openai"
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
  if (!model) {
    return null;
  }
  if (provider.providerId === "openai") {
    return {
      providerId: "openai",
      model,
      label: `OpenAI / ${model}`,
      supportsEdit: true,
    };
  }
  if (provider.providerId === "google") {
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
  const primedSessionIdRef = useRef<string | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const [voiceRuntime, setVoiceRuntime] = useState<VoiceRuntimeStatus | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [speakResponsesEnabled, setSpeakResponsesEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.localStorage.getItem(SPEAK_REPLIES_PREF_KEY) === "true";
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
  const imageGenerationAvailable = Boolean(primaryImageRoute);
  const imageEditAvailable = Boolean(primaryImageRoute?.supportsEdit && latestImageAttachment);
  const imageRouteLabel = primaryImageRoute
    ? googleFallbackImageRoute
      ? `${primaryImageRoute.label} with ${googleFallbackImageRoute.label} fallback`
      : primaryImageRoute.label
    : null;
  const voiceStatusLabel = voiceStatus?.talk.activeSessionId
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

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(SPEAK_REPLIES_PREF_KEY, String(speakResponsesEnabled));
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
      if (voiceStatus?.talk.activeSessionId) {
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
  }, [pushLocalNotice, refreshVoiceState, selectedSessionId, setError, voiceStatus?.talk.activeSessionId]);

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
    async (mode: "generate" | "edit") => {
      const prompt = draft.trim();
      if (!prompt) {
        setError("Add an image prompt first.");
        return;
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
        pushLocalNotice(
          response.operation === "edit"
            ? "Edited image added to the draft attachments."
            : routeUsed.providerId === "google"
              ? `Generated image added to the draft attachments via ${routeUsed.label}.`
              : "Generated image added to the draft attachments.",
          "success",
        );
      } catch (error) {
        setError((error as Error).message, mode === "edit" ? "image_edit" : "image_generate");
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
      setError,
      uploadAttachments,
    ],
  );

  return {
    audioInputRef,
    voiceBusy,
    voiceInputAvailable,
    voiceOutputAvailable,
    voiceTalkActive: Boolean(voiceStatus?.talk.activeSessionId),
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
    handleOpenAudioTranscribe,
    handleAudioFileSelected,
    handleGenerateImage: () => runImageGeneration("generate"),
    handleEditImage: () => runImageGeneration("edit"),
  };
}
