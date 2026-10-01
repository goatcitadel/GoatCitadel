import { useProviderModelCatalog } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import type { MissionControlActiveSessionSurfaceProps } from "../MissionControlActiveSessionSurface";
import type { useChatMultimodalControls } from "../useChatMultimodalControls";
import { useChatPreferenceMutations } from "../useChatPreferenceMutations";

type Input = {
  selectedSessionId: string | null;
  sending: boolean;
  historicalModeActive: boolean;
  blockHistoricalMutation: () => boolean;
  loadModelsForProvider: ReturnType<typeof useProviderModelCatalog>["loadModelsForProvider"];
  handlePrefPatch: ReturnType<typeof useChatPreferenceMutations>["handlePrefPatch"];
  multimodal: Pick<
    ReturnType<typeof useChatMultimodalControls>,
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
    | "imageGenerationAvailable"
    | "imageEditAvailable"
    | "imageProviderOptions"
    | "selectedImageProviderId"
    | "selectedImageModel"
    | "imageRouteLabel"
    | "handleToggleLiveVoice"
    | "handleToggleLiveVoiceMute"
    | "handleToggleVoiceTalk"
    | "handleOpenAudioTranscribe"
    | "handleAudioFileSelected"
    | "setSpeakResponsesEnabled"
    | "handleGenerateImage"
    | "handleEditImage"
  >;
};

/** Builds media controls from the existing multimodal owner. */
export function createChatMediaProps({
  selectedSessionId,
  sending,
  historicalModeActive,
  blockHistoricalMutation,
  loadModelsForProvider,
  handlePrefPatch,
  multimodal,
}: Input): Pick<
  MissionControlActiveSessionSurfaceProps,
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
  | "imageGenerationAvailable"
  | "imageEditAvailable"
  | "imageProviderOptions"
  | "selectedImageProviderId"
  | "selectedImageModel"
  | "imageRouteSwitchDisabled"
  | "imageRouteLabel"
  | "onRequestImageProviderChange"
  | "onRequestImageModelChange"
  | "onToggleLiveVoice"
  | "onToggleLiveVoiceMute"
  | "onToggleVoiceTalk"
  | "onOpenAudioTranscribe"
  | "onAudioFileSelected"
  | "onToggleSpeakResponses"
  | "onGenerateImage"
  | "onEditImage"
> {
  const { handleToggleLiveVoice } = multimodal;
  const { handleToggleLiveVoiceMute } = multimodal;
  const { handleToggleVoiceTalk } = multimodal;
  const { handleOpenAudioTranscribe } = multimodal;
  const { handleAudioFileSelected } = multimodal;
  const { setSpeakResponsesEnabled } = multimodal;
  const { handleGenerateImage } = multimodal;
  const { handleEditImage } = multimodal;

  return {
    voiceBusy: multimodal.voiceBusy,
    liveVoiceActive: multimodal.liveVoiceActive,
    liveVoiceAvailable: multimodal.liveVoiceAvailable,
    liveVoiceMuted: multimodal.liveVoiceMuted,
    liveVoiceState: multimodal.liveVoiceState,
    liveVoiceStatusLabel: multimodal.liveVoiceStatusLabel,
    liveVoiceUnavailableReason: multimodal.liveVoiceUnavailableReason,
    voiceInputAvailable: multimodal.voiceInputAvailable,
    voiceOutputAvailable: multimodal.voiceOutputAvailable,
    voiceTalkActive: multimodal.voiceTalkActive,
    voiceStatusLabel: multimodal.voiceStatusLabel,
    voiceUnavailableReason: multimodal.voiceUnavailableReason,
    speakResponsesEnabled: multimodal.speakResponsesEnabled,
    imageBusy: multimodal.imageBusy,
    imageGenerationAvailable: multimodal.imageGenerationAvailable,
    imageEditAvailable: multimodal.imageEditAvailable,
    imageProviderOptions: multimodal.imageProviderOptions,
    selectedImageProviderId: multimodal.selectedImageProviderId,
    selectedImageModel: multimodal.selectedImageModel,
    imageRouteSwitchDisabled: !selectedSessionId || sending || historicalModeActive,
    imageRouteLabel: multimodal.imageRouteLabel,
    onRequestImageProviderChange: (providerId) => {
      if (blockHistoricalMutation()) return;
      const provider = multimodal.imageProviderOptions.find((item) => item.providerId === providerId);
      void loadModelsForProvider(providerId);
      void handlePrefPatch({
        imageProviderId: providerId,
        imageModel: provider?.defaultModel ?? provider?.models[0] ?? "",
      });
    },
    onRequestImageModelChange: (model) => {
      if (blockHistoricalMutation()) return;
      void handlePrefPatch({
        imageProviderId: multimodal.selectedImageProviderId ?? "",
        imageModel: model,
      });
    },
    onToggleLiveVoice: () => {
      if (!blockHistoricalMutation()) void handleToggleLiveVoice();
    },
    onToggleLiveVoiceMute: () => {
      if (!blockHistoricalMutation()) handleToggleLiveVoiceMute();
    },
    onToggleVoiceTalk: () => {
      if (!blockHistoricalMutation()) void handleToggleVoiceTalk();
    },
    onOpenAudioTranscribe: () => {
      if (!blockHistoricalMutation()) handleOpenAudioTranscribe();
    },
    onAudioFileSelected: (files) => {
      if (!blockHistoricalMutation()) handleAudioFileSelected(files);
    },
    onToggleSpeakResponses: () => {
      if (!blockHistoricalMutation()) setSpeakResponsesEnabled((current) => !current);
    },
    onGenerateImage: () => {
      if (!blockHistoricalMutation()) void handleGenerateImage();
    },
    onEditImage: () => {
      if (!blockHistoricalMutation()) void handleEditImage();
    },
  };
}
