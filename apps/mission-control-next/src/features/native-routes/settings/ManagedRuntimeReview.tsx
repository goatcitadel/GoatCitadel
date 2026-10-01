import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { normalizeManagedRuntime } from "./managed-runtime-state";
import type { useManagedRuntimeSettings } from "./use-managed-runtime-settings";

export function ManagedRuntimeReview({ control }: { control: ReturnType<typeof useManagedRuntimeSettings> }) {
  const review = control.review;
  const next = review ? normalizeManagedRuntime(review.submitted) : null;
  return (
    <ConfirmModal
      open={review !== null}
      title="Apply managed runtime configuration?"
      message={
        review && next
          ? `${control.reviewCurrent ? "" : "This review is no longer current. Choose Keep current runtime settings to close this dialog, then refresh and review your retained draft. "}Review installation settings revision ${review.revision}. Enabled: ${review.current.enabled ? "on" : "off"} → ${next.enabled ? "on" : "off"}. Auto-start: ${review.current.autoStart ? "on" : "off"} → ${next.autoStart ? "on" : "off"}. Endpoint: ${review.current.baseUrl} → ${next.baseUrl}. Model alias: ${review.current.alias} → ${next.alias}. This affects every workspace using this runtime. Disabling can stop the managed process; enabling auto-start can start it. Saving does not prove runtime health. Command and model paths stay under the validated setup owner.`
          : "Review the exact current configuration before saving."
      }
      confirmLabel="Apply reviewed runtime settings"
      cancelLabel="Keep current runtime settings"
      pending={control.busy}
      confirmDisabled={!control.reviewCurrent || control.locked}
      onCancel={control.cancel}
      onConfirm={() => void control.confirm()}
    />
  );
}
