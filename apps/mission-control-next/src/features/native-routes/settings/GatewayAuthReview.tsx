import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import type { useGatewayAuthSettings } from "./use-gateway-auth-settings";

export function GatewayAuthReview({ control }: { control: ReturnType<typeof useGatewayAuthSettings> }) {
  const review = control.review;
  return (
    <ConfirmModal
      open={Boolean(review)}
      danger
      title="Apply Gateway authentication changes?"
      className="[overflow-wrap:anywhere]"
      message={
        review
          ? `${control.reviewCurrent ? "" : "This review is stale. Cancel, refresh and review again. "}Gateway installation settings revision ${review.revision}. Mode: ${review.current.mode} → ${review.submitted.mode}. Loopback bypass: ${review.current.allowLoopbackBypass ? "enabled" : "disabled"} → ${review.submitted.allowLoopbackBypass ? "enabled" : "disabled"}. ${review.submitted.basicUsername ? `Basic username: ${review.submitted.basicUsername}. ` : ""}${review.submitted.replaceCredential ? "A new credential will be submitted directly to Gateway custody. " : "No replacement credential will be submitted. "}This affects every workspace and can disconnect this session and other devices. The Gateway may require approval before applying it. The UI cannot verify credential values by reading them back.`
          : "Review current authentication before submitting."
      }
      confirmLabel="Apply reviewed authentication"
      cancelLabel="Keep current authentication"
      pending={control.attempt?.state === "pending"}
      confirmDisabled={!control.reviewCurrent || control.locked}
      onCancel={control.cancel}
      onConfirm={() => void control.confirm()}
    />
  );
}
