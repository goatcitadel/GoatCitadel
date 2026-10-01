import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import type { useLlamaSetup } from "./use-llama-setup";
import type { useLlamaSetupChatTest } from "./use-llama-setup-chat-test";

export function LlamaSetupReviews({
  control,
  diagnostic,
}: {
  control: ReturnType<typeof useLlamaSetup>;
  diagnostic: ReturnType<typeof useLlamaSetupChatTest>;
}) {
  const review = control.review;
  return (
    <>
      <ConfirmModal
        open={Boolean(review)}
        danger
        className="[overflow-wrap:anywhere]"
        title={review?.kind === "confirm" ? "Confirm the recorded llama.cpp setup?" : "Prepare llama.cpp setup?"}
        message={
          review?.kind === "prepare"
            ? `Prepare a governed setup plan at settings revision ${review.projection.settingsRevision} for ${review.submitted.model} using ${review.submitted.mode === "managed" ? "Gateway-managed installed files" : "an external server"} at ${review.submitted.baseUrl}. The plan changes the installation Chat default. Managed setup can start llama-server and enables automatic startup; external setup does not start or stop the external process. Host paths remain with the Gateway. Confirmation and approval are separate steps.`
            : review?.kind === "confirm"
              ? `${review.plan.summary} ${review.plan.impact} Confirm this exact recorded plan, revision ${review.plan.revision}. The Gateway enforces required approval before application.`
              : "Review the exact setup request."
        }
        confirmLabel={review?.kind === "confirm" ? "Confirm reviewed setup plan" : "Prepare reviewed setup"}
        cancelLabel="Keep current llama.cpp setup"
        pending={control.state.attempt?.state === "pending"}
        confirmDisabled={!control.reviewCurrent || control.locked}
        onCancel={control.cancelReview}
        onConfirm={() => void control.confirmReview()}
      />
      <ConfirmModal
        open={Boolean(diagnostic.review)}
        title="Send a real llama.cpp Chat diagnostic?"
        className="[overflow-wrap:anywhere]"
        message={
          diagnostic.review
            ? `Create a hidden diagnostic Chat in workspace ${control.workspaceId} and request one response from llama.cpp model ${diagnostic.review.projection.chatRoute.model}, settings revision ${diagnostic.review.projection.settingsRevision}. This uses the configured provider and records a real turn. Memory, web and delegation are disabled by the diagnostic owner. It is separate from setup completion.`
            : "Review the current model before sending a diagnostic."
        }
        confirmLabel="Send reviewed Chat diagnostic"
        cancelLabel="Do not send a diagnostic"
        pending={control.state.attempt?.state === "pending"}
        confirmDisabled={!diagnostic.reviewCurrent || control.locked}
        onCancel={diagnostic.cancel}
        onConfirm={() => void diagnostic.confirm()}
      />
    </>
  );
}
