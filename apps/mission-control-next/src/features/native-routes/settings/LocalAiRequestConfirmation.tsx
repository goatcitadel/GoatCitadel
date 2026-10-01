import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import type { useLocalAiSettings } from "./use-local-ai-settings";

export function LocalAiRequestConfirmation({ control }: { control: ReturnType<typeof useLocalAiSettings> }) {
  return (
    <ConfirmModal
      open={Boolean(control.review)}
      title="Record Local AI approval request?"
      message={`Request approval to ${control.review?.kind === "serve" ? "serve" : "download"} ${control.review?.model.modelId ?? "this model"} with ${control.review?.model.backend ?? "the selected backend"}? The current Gateway records intent only. This route does not download a model, start a server, or establish working inference; approval does not add that missing execution step.`}
      confirmLabel="Record approval request"
      cancelLabel="Keep Local AI unchanged"
      pending={control.queueing}
      confirmDisabled={control.queueing || !control.readiness}
      onCancel={control.cancel}
      onConfirm={() => void control.confirm()}
    />
  );
}
