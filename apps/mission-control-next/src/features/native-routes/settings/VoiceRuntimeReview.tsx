import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import type { useVoiceRuntimeSettings } from "./use-voice-runtime-settings";

export function VoiceRuntimeReview({ control }: { control: ReturnType<typeof useVoiceRuntimeSettings> }) {
  const review = control.review;
  const model = review?.current.catalog.find((item) => item.id === review.modelId);
  return (
    <ConfirmModal
      open={Boolean(review)}
      danger
      title="Change the local voice runtime?"
      className="[overflow-wrap:anywhere]"
      message={
        review
          ? `${review.kind === "install" ? `Download or reuse the managed whisper.cpp runtime, FFmpeg helper and ${model?.label ?? review.modelId} model (${model?.approxSizeLabel ?? "size unavailable"}), then select it for transcription.` : `Select the installed ${model?.label ?? review.modelId} model for transcription.`} This changes voice configuration for the entire Gateway installation. It does not start a microphone session. The owner has no atomic revision guard; current evidence is checked before the request.`
          : "Review the exact runtime action."
      }
      confirmLabel="Apply reviewed voice action"
      cancelLabel="Keep current voice runtime"
      confirmDisabled={!control.reviewCurrent || Boolean(control.attempt)}
      pending={control.attempt?.state === "pending"}
      onConfirm={() => void control.confirm()}
      onCancel={control.cancel}
    />
  );
}
