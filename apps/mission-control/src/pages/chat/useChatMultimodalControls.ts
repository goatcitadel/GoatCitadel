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
} from "../../api/client";
import { fileToBase64 } from "../settings-page-utils";

const SPEAK_REPLIES_PREF_KEY = "goatcitadel.chat.speak-replies.enabled";

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

export function useChatMultimodalControls(input: {
  providerOptions: Array<{
    providerId: string;
    label: string;
    capabilities?: {
      voiceInput?: boolean;
      voiceOutput?: boolean;
      imageGenerate?: boolean;
      imageEdit?: boolean;
    };
  }>;
  selectedProviderId?: string;
  routePreflight: RoutingPreflightResult | null;
  selectedSessionId: string | null;
  activeThreadSessionId?: string | null;
  pendingAttachments: ChatAttachmentRecord[];
  draft: string;
  latestAssistantMessageId?: string;
  latestAssistantContent?: string;
  latestAssistantStatus?: ChatTurnLifecycleStatus;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setError: (value: string | null) => void;
  pushLocalNotice: (message: string, tone?: "neutral" | "warning" | "critical" | "success") => void;
  uploadAttachments: (files: File[]) => Promise<void>;
}) {
  const {
    providerOptions,
    selectedProviderId,
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
  const imageGenerationAvailable =
    activeProviderId === "openai" && (activeProvider?.capabilities?.imageGenerate ?? true);
  const imageEditAvailable = imageGenerationAvailable && Boolean(latestImageAttachment);
  const imageRouteLabel = imageGenerationAvailable ? "OpenAI / gpt-image-1" : null;
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
        const response = await generateLlmImage({
          providerId: "openai",
          model: "gpt-image-1",
          prompt,
          referenceImages,
          responseFormat: "b64_json",
          outputFormat: "png",
        });
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
            : "Generated image added to the draft attachments.",
          "success",
        );
      } catch (error) {
        setError((error as Error).message);
      } finally {
        setImageBusy(false);
      }
    },
    [draft, latestImageAttachment, pushLocalNotice, setError, uploadAttachments],
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
    imageRouteLabel,
    handleToggleVoiceTalk,
    handleOpenAudioTranscribe,
    handleAudioFileSelected,
    handleGenerateImage: () => runImageGeneration("generate"),
    handleEditImage: () => runImageGeneration("edit"),
  };
}
