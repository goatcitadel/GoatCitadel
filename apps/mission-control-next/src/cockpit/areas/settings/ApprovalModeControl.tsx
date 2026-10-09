import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import {
  describeToolApprovalMode,
  describeToolApprovalModeHelp,
  TOOL_APPROVAL_MODE_OPTIONS,
} from "../../../features/native-routes/settings/helpers/permission-helpers";
import { Button } from "../../ui/Button";
import { isApprovalMode } from "./approval-mode-state";
import { useApprovalModeControl } from "./use-approval-mode-control";
import { ApprovedSettingsContinuation } from "./ApprovedSettingsContinuation";
import { settingsChangeIsConfirmed } from "../../../features/native-routes/settings/use-settings-change";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";

export function ApprovalModeControl() {
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const control = useApprovalModeControl({ scope: JSON.stringify([activeCitadelId, activeWorkspaceId]) });
  return <ApprovalModeEditor control={control} />;
}

export function ApprovalModeEditor({
  control,
  safeOnly = false,
}: {
  control: ReturnType<typeof useApprovalModeControl>;
  safeOnly?: boolean;
}) {
  const { settings, ready, current, draft, change, uncertain, review, notice, locked, restricted } = control;
  const approval = change.change?.receipt.requiredAction;
  const confirmed = settingsChangeIsConfirmed(change.change);
  return (
    <section
      id="approval-mode"
      aria-labelledby="approval-mode-title"
      className="mt-4 rounded-lg border border-line bg-sunken p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="approval-mode-title" className="font-display text-base font-semibold text-fg">
            Tool approval rule
          </h3>
          <p className="mt-1 text-sm text-fg-secondary">
            Installation default for future tool invocations. Tool grants, deny rules, and required high-risk approvals
            remain authoritative.
          </p>
        </div>
        <Button
          size="sm"
          disabled={settings.isFetching || control.busy}
          onClick={() => {
            void settings.refetch();
            if (change.change) void change.refresh();
          }}
        >
          Refresh approval settings
        </Button>
      </div>
      {settings.isLoading ? (
        <p role="status" className="mt-3 text-sm text-fg-muted">
          Loading approval settings…
        </p>
      ) : null}
      {settings.isError ? (
        <p role="alert" className="mt-3 text-sm text-status-failed">
          {describeApiError(settings.error).summary}
        </p>
      ) : null}
      {settings.data && !settings.isError && !ready ? (
        <p role="alert" className="mt-3 text-sm text-status-failed">
          Gateway approval mode, deployment profile, or revision is unavailable. Refresh before changing this rule.
        </p>
      ) : null}
      {ready ? (
        <>
          <p className="mt-3 text-sm text-fg-secondary">
            Current: {describeToolApprovalMode(current)} · settings revision {settings.data?.revision}
          </p>
          <p className="mt-1 text-xs text-fg-muted">
            Deployment: {humanizeToken(settings.data?.deploymentProfile ?? "unknown")}
          </p>
          <label className="mt-3 block max-w-sm text-sm font-medium text-fg">
            Approval rule
            <select
              className="mt-1 block min-h-11 w-full rounded-md border border-line bg-canvas px-2 text-fg"
              value={draft.value}
              disabled={locked || Boolean(review)}
              onChange={(event) => {
                if (isApprovalMode(event.target.value)) draft.setValue(event.target.value);
              }}
            >
              {TOOL_APPROVAL_MODE_OPTIONS.map((mode) => (
                <option key={mode} value={mode} disabled={restricted && mode === "bypass"}>
                  {describeToolApprovalMode(mode)}
                </option>
              ))}
            </select>
          </label>
          <p className="mt-2 text-sm text-fg-secondary">{describeToolApprovalModeHelp(draft.value)}</p>
          {restricted ? (
            <p className="mt-2 text-sm text-status-waiting">
              {safeOnly
                ? "Guided setup requires an approval rule that keeps normal prompts available."
                : "Remote Hardened keeps normal prompt skipping unavailable."}
            </p>
          ) : null}
          {draft.isDirty ? (
            <p role="status" className="mt-2 text-xs text-status-waiting">
              Unsaved approval rule draft
            </p>
          ) : null}
          {draft.hasRemoteChanges ? (
            <div role="status" className="mt-2 space-y-2 text-sm text-fg-secondary">
              <p>The saved rule changed after this draft began. Review the current rule before rebasing.</p>
              <Button size="sm" disabled={locked || Boolean(review)} onClick={draft.rebaseToCurrent}>
                Review draft against current revision
              </Button>
            </div>
          ) : null}
          <Button
            className="mt-3"
            variant={draft.value === "bypass" ? "danger" : "primary"}
            disabled={!control.canSave || Boolean(review)}
            onClick={() => void control.requestSave()}
          >
            {control.busy ? "Saving…" : draft.value === "bypass" ? "Review prompt skipping" : "Save approval rule"}
          </Button>
        </>
      ) : null}
      {change.change ? (
        <div className="mt-3 space-y-2 rounded-md border border-line bg-raised p-3 text-sm text-fg-secondary">
          <p role="status">
            <strong className="text-fg">{humanizeToken(change.change.receipt.status)}</strong> · {change.change.message}
          </p>
          {change.change.error ? (
            <p role="alert" className="text-status-failed">
              {change.change.error}
            </p>
          ) : null}
          {change.change.blocking ? <p>The draft remains unsaved until the Gateway confirms the change.</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void change.refresh()}>
              Refresh approval change
            </Button>
            {approval?.kind === "approval" && !confirmed ? (
              <ClassicOwnerLink
                className="text-accent hover:underline"
                href={`/ops/approvals?shell=classic${approval.approvalId ? `&approvalId=${encodeURIComponent(approval.approvalId)}` : ""}`}
                scope={JSON.stringify([draft.key, change.change.receipt.planId, approval.approvalId])}
                label="Review required approval"
              />
            ) : null}
          </div>
          {!confirmed ? <ApprovedSettingsContinuation plan={change.change.plan} onSettled={change.refresh} /> : null}
          <details>
            <summary className="cursor-pointer text-fg-muted">Change evidence</summary>
            <p className="mt-2 break-all">
              Plan {change.change.receipt.planId} · revision {change.change.receipt.revision}
            </p>
          </details>
        </div>
      ) : null}
      {notice && !(confirmed && notice.startsWith("Change submitted.")) ? (
        <p role="status" className="mt-3 text-sm text-fg-secondary">
          {notice}
        </p>
      ) : null}
      {uncertain ? (
        <p role="alert" className="mt-3 text-sm text-status-waiting">
          {uncertain}
        </p>
      ) : null}
      {uncertain || change.change?.blocking ? (
        <ClassicOwnerLink
          href="/settings/tools?shell=classic"
          scope="approval-mode"
          label="Inspect tool settings activity"
        />
      ) : null}
      <ConfirmModal
        open={Boolean(review)}
        title="Skip normal tool prompts?"
        danger
        confirmLabel="Confirm prompt skipping"
        cancelLabel="Keep current rule"
        message={`Change the installation default from ${describeToolApprovalMode(review?.current ?? current)} to Skip normal prompts at settings revision ${review?.revision ?? "unknown"}. Allowed tools may run without normal prompts. Deny rules, Critical risk and risky-shell approvals, read boundaries, and tool grants remain in force.`}
        pending={control.busy}
        confirmDisabled={!control.reviewCurrent}
        onConfirm={() => void control.confirm()}
        onCancel={() => control.setReview(null)}
      />
    </section>
  );
}
