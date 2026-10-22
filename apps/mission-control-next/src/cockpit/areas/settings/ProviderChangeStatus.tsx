import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { isProviderProfileCheckpoint, type ChangePlanRecord } from "@goatcitadel/contracts";
import type { SettingsChangeStatus } from "../../../features/native-routes/settings/use-settings-change";
import { ApprovedSettingsContinuation } from "./ApprovedSettingsContinuation";
import { Button } from "../../ui/Button";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { presentChangeStatusLabel } from "./settings-vocabulary";

export function ProviderChangeStatus({
  change,
  onRefresh,
  onReview,
}: Pick<Parameters<typeof SettingsChangeStatus>[0], "change" | "onRefresh"> & {
  onReview?: (plan: ChangePlanRecord) => void;
}) {
  if (!change) return null;
  const plan = change.plan,
    checkpoint = plan?.result?.providerProfileCheckpoint;
  const committedProfile =
    plan?.kind === "provider_connection" &&
    plan.request.kind === "provider_connection" &&
    isProviderProfileCheckpoint(checkpoint) &&
    checkpoint.providerId === plan.request.providerId &&
    checkpoint.intentHash === plan.intentHash &&
    checkpoint.originalRevision === change.baseRevision &&
    checkpoint.appliedRevision === plan.target.expectedRevision &&
    plan.target.ownerId === "provider_connection" &&
    plan.target.resourceId === checkpoint.providerId &&
    plan.evidenceRefs.includes(
      `provider_profile:${checkpoint.providerId}:settings_revision:${checkpoint.appliedRevision}`,
    );
  return (
    <section
      aria-label="Provider change status"
      className="space-y-2 border-t border-line-subtle pt-3 text-sm text-fg-secondary"
    >
      <p role="status">
        <strong>{presentChangeStatusLabel(change.receipt.status)}</strong> · {change.message}
      </p>
      {change.blocking ? (
        <p>This change is not finished. Refresh its status or review the required step before saving again.</p>
      ) : null}
      {change.blocking && committedProfile ? (
        <p>Profile saved. Credential setup is not confirmed yet. Review the required step before continuing.</p>
      ) : null}
      {change.error ? (
        <p role="alert" className="text-status-failed">
          {change.error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void onRefresh()}>
          Refresh change status
        </Button>
        {change.blocking && change.plan?.requiredAction && onReview ? (
          <Button size="sm" onClick={() => onReview(change.plan!)}>
            Review required step
          </Button>
        ) : null}
        {change.blocking && change.receipt.requiredAction?.kind === "approval" ? (
          <NativeOwnerLink
            scope={[plan?.origin.workspaceId, change.receipt.planId]}
            className="text-accent underline"
            href="/inbox"
          >
            Open approvals in Inbox
          </NativeOwnerLink>
        ) : null}
      </div>
      {committedProfile ? (
        <TechnicalDetails>
          <p className="break-all font-mono text-xs">Saved at settings version {checkpoint!.appliedRevision}</p>
        </TechnicalDetails>
      ) : null}
      <ApprovedSettingsContinuation plan={change.plan} onSettled={onRefresh} />
    </section>
  );
}
