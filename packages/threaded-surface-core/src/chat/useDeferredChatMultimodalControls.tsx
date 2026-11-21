import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  getGatewayAccessRevision,
  getGatewayCallerScopeRevision,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useChatImageRouting } from "./chat-image-routing";
import { readSpeakRepliesPreference } from "./chat-speak-preference";
import type { ChatMultimodalInput, useChatMultimodalControls } from "./useChatMultimodalControls";
import type { ChatMultimodalRuntime } from "./ChatMultimodalRuntime";

type Controls = ReturnType<typeof useChatMultimodalControls>;
type View = Pick<
  Controls,
  | "voiceBusy"
  | "liveVoiceActive"
  | "liveVoiceAvailable"
  | "liveVoiceMuted"
  | "liveVoiceState"
  | "liveVoiceStatusLabel"
  | "liveVoiceUnavailableReason"
  | "voiceInputAvailable"
  | "voiceOutputAvailable"
  | "voiceTalkActive"
  | "voiceStatusLabel"
  | "voiceUnavailableReason"
  | "speakResponsesEnabled"
  | "imageBusy"
>;
const unloaded: View = {
  voiceBusy: false,
  liveVoiceActive: false,
  liveVoiceAvailable: false,
  liveVoiceMuted: false,
  liveVoiceState: "idle",
  liveVoiceStatusLabel: "OpenAI Realtime unavailable",
  liveVoiceUnavailableReason: "Open voice controls to check availability.",
  voiceInputAvailable: false,
  voiceOutputAvailable: false,
  voiceTalkActive: false,
  voiceStatusLabel: "Voice readiness not confirmed",
  voiceUnavailableReason: "Voice readiness has not been confirmed yet.",
  speakResponsesEnabled: false,
  imageBusy: false,
};
const viewFields = Object.keys(unloaded) as (keyof View)[];
type Runtime = typeof ChatMultimodalRuntime;
let runtimePromise: Promise<Runtime> | undefined;
function loadRuntime() {
  return (runtimePromise ??= import("./ChatMultimodalRuntime").then(
    (module) => module.ChatMultimodalRuntime,
    (error: unknown) => {
      runtimePromise = undefined;
      throw error;
    },
  ));
}

/** The composer can select an image route synchronously. Voice and image work starts on intent. */
export function useDeferredChatMultimodalControls(input: ChatMultimodalInput) {
  const route = useChatImageRouting(input);
  const [initialSpeak] = useState(readSpeakRepliesPreference);
  const [voiceRequested, setVoiceRequested] = useState(false);
  const [Runtime, setRuntime] = useState<Runtime>();
  const [view, setView] = useState<View>(() => ({ ...unloaded, speakResponsesEnabled: initialSpeak }));
  const audioInputRef = useRef<HTMLInputElement | null>(null);
  const controls = useRef<Controls | undefined>(undefined);
  const lastView = useRef(view);
  const waiters = useRef(new Set<(value: Controls | undefined) => void>());
  const mounted = useRef(false);
  const scope = useMemo(
    () => ({ workspaceId: input.workspaceId, sessionId: input.selectedSessionId }),
    [input.workspaceId, input.selectedSessionId],
  );
  const imageRouteLabel = route.imageRouteLabel;
  const committed = useRef({ scope, input, imageRouteLabel });
  useLayoutEffect(() => {
    committed.current = { scope, input, imageRouteLabel };
  }, [scope, input, imageRouteLabel]);
  const settle = useCallback((value?: Controls) => {
    for (const resolve of waiters.current) resolve(value);
    waiters.current.clear();
  }, []);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controls.current = undefined;
      settle();
    };
  }, [settle]);
  const ensureRuntime = useCallback((): Promise<Controls | undefined> => {
    if (!mounted.current || controls.current) return Promise.resolve(controls.current);
    return new Promise((resolve) => {
      waiters.current.add(resolve);
      void loadRuntime().then(
        (component) => {
          if (mounted.current) setRuntime(() => component);
        },
        () => settle(),
      );
    });
  }, [settle]);
  useEffect(() => {
    if (input.deferVoiceReadiness !== true || initialSpeak) void ensureRuntime();
  }, [ensureRuntime, initialSpeak, input.deferVoiceReadiness]);
  const publish = useCallback(
    (next: Controls) => {
      controls.current = next;
      if (viewFields.some((field) => lastView.current[field] !== next[field])) {
        lastView.current = Object.fromEntries(viewFields.map((field) => [field, next[field]])) as View;
        setView(lastView.current);
      }
      settle(next);
    },
    [settle],
  );
  const invoke = useCallback(
    async <T,>(action: (ready: Controls) => T | Promise<T>, usesDraft = false) => {
      const attempt = committed.current;
      const selectionRevision = attempt.input.selectionRevisionRef?.current;
      const access = getGatewayAccessRevision();
      const caller = getGatewayCallerScopeRevision();
      const installation = getGatewayApiBaseUrl();
      const ready = controls.current ?? (await ensureRuntime());
      if (
        !mounted.current ||
        attempt.scope !== committed.current.scope ||
        selectionRevision !== attempt.input.selectionRevisionRef?.current ||
        access !== getGatewayAccessRevision() ||
        caller !== getGatewayCallerScopeRevision() ||
        installation !== getGatewayApiBaseUrl() ||
        (usesDraft &&
          (attempt.input.draft !== committed.current.input.draft ||
            attempt.imageRouteLabel !== committed.current.imageRouteLabel))
      )
        return;
      if (!ready) {
        attempt.input.setError("Chat media controls could not load. Try again.");
        return;
      }
      return action(ready);
    },
    [ensureRuntime],
  );
  const onMediaControlsOpenChange = useCallback(
    (open: boolean) => {
      if (!open) return;
      setVoiceRequested(true);
      void invoke(() => undefined);
    },
    [invoke],
  );
  const handleToggleVoiceTalk = useCallback(async () => {
    await invoke((ready) => ready.handleToggleVoiceTalk());
  }, [invoke]);
  const handleToggleLiveVoice = useCallback(async () => {
    await invoke((ready) => ready.handleToggleLiveVoice());
  }, [invoke]);
  const handleToggleLiveVoiceMute = useCallback(() => controls.current?.handleToggleLiveVoiceMute(), []);
  const handleOpenAudioTranscribe = useCallback(() => audioInputRef.current?.click(), []);
  const handleAudioFileSelected = useCallback(
    async (files: FileList | null) => {
      await invoke((ready) => ready.handleAudioFileSelected(files));
    },
    [invoke],
  );
  const handleGenerateImage = useCallback<Controls["handleGenerateImage"]>(
    async (options) => (await invoke((ready) => ready.handleGenerateImage(options), true)) ?? false,
    [invoke],
  );
  const handleEditImage = useCallback<Controls["handleEditImage"]>(
    async (options) => (await invoke((ready) => ready.handleEditImage(options), true)) ?? false,
    [invoke],
  );
  const setSpeakResponsesEnabled = useCallback<Controls["setSpeakResponsesEnabled"]>(
    (value) => {
      void invoke((ready) => ready.setSpeakResponsesEnabled(value));
    },
    [invoke],
  );
  const multimodalRuntime = Runtime ? (
    <Runtime
      input={{ ...input, audioInputRef, deferVoiceReadiness: input.deferVoiceReadiness && !voiceRequested }}
      publish={publish}
    />
  ) : null;
  const multimodal: Controls = {
    ...view,
    imageGenerationAvailable: route.imageGenerationAvailable,
    imageEditAvailable: route.imageEditAvailable,
    imageProviderOptions: route.imageProviderOptions,
    selectedImageProviderId: route.primaryImageRoute?.providerId,
    selectedImageModel: route.primaryImageRoute?.model,
    imageRouteLabel: route.imageRouteLabel,
    audioInputRef,
    onMediaControlsOpenChange,
    handleToggleVoiceTalk,
    handleToggleLiveVoice,
    handleToggleLiveVoiceMute,
    handleOpenAudioTranscribe,
    handleAudioFileSelected,
    handleGenerateImage,
    handleEditImage,
    setSpeakResponsesEnabled,
  };
  return { multimodal, multimodalRuntime };
}
