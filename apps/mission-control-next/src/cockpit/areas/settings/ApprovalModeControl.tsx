import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { ShieldAlert } from "lucide-react";
import {
  describeToolApprovalMode,
  describeToolApprovalModeHelp,
  TOOL_APPROVAL_MODE_OPTIONS,
} from "../../../features/native-routes/settings/helpers/permission-helpers";
import { useId } from "react";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { cockpitInputClass } from "../../ui/input-class";
import { Dialog } from "../../ui/Dialog";
import { isApprovalMode } from "./approval-mode-state";
import { useApprovalModeControl } from "./use-approval-mode-control";
import { ApprovedSettingsContinuation } from "./ApprovedSettingsContinuation";
import { settingsChangeIsConfirmed } from "../../../features/native-routes/settings/use-settings-change";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { SettingsApprovalOwnerAction } from "./SettingsApprovalOwnerAction";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { presentChangeStatusLabel, presentDeploymentProfile } from "./settings-vocabulary";

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
  const route = useCockpitRoute();
  const bypassReasonId = useId();
  const parameters = new URLSearchParams(route.search);
  parameters.delete("shell");
  parameters.delete("shellScope");
  const recoveryHref = `/settings/safety${parameters.size ? `?${parameters}` : ""}#approval-mode`;
  const approval = change.change?.receipt.requiredAction;
  const confirmed = settingsChangeIsConfirmed(change.change);
  return (
    <section
      id="approval-mode"
      aria-labelledby="approval-mode-title"
      className="mt-4 border-t border-line-subtle pt-4 first:border-t-0 first:pt-0"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="approval-mode-title" className="text-md font-semibold text-fg">
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
          The approval mode, deployment profile, or saved version could not load. Refresh before changing this rule.
        </p>
      ) : null}
      {ready ? (
        <>
          <p className="mt-3 text-sm text-fg-secondary">Current: {describeToolApprovalMode(current)}</p>
          <p className="mt-1 text-xs text-fg-muted">
            Deployment: {presentDeploymentProfile(settings.data?.deploymentProfile)}
          </p>
          <TechnicalDetails>
            <p className="break-all font-mono text-xs">
              Settings version {settings.data?.revision} · {settings.data?.deploymentProfile ?? "unknown"}
            </p>
          </TechnicalDetails>
          <div className="mt-3 max-w-sm">
            <Field label="Approval rule" help={describeToolApprovalModeHelp(draft.value)}>
              {(fieldProps) => (
                <select
                  {...fieldProps}
                  aria-describedby={
                    restricted
                      ? [fieldProps["aria-describedby"], bypassReasonId].filter(Boolean).join(" ")
                      : fieldProps["aria-describedby"]
                  }
                  className={cockpitInputClass}
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
              )}
            </Field>
          </div>
          {restricted ? (
            <p id={bypassReasonId} className="mt-2 text-sm text-status-waiting">
              {describeToolApprovalMode("bypass")} is unavailable here.{" "}
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
              <p>The saved rule changed. Your draft started from an older version. Review the saved rule first.</p>
              <Button size="sm" disabled={locked || Boolean(review)} onClick={draft.rebaseToCurrent}>
                Apply draft to latest version
              </Button>
            </div>
          ) : null}
          <Button
            className="mt-3"
            variant="primary"
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
            <strong className="text-fg">{presentChangeStatusLabel(change.change.receipt.status)}</strong> ·{" "}
            {change.change.message}
          </p>
          {change.change.error ? (
            <p role="alert" className="text-status-failed">
              {change.change.error}
            </p>
          ) : null}
          {change.change.blocking ? <p>The draft remains unsaved until GoatCitadel confirms the change.</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void change.refresh()}>
              Refresh approval change
            </Button>
            {approval?.kind === "approval" && !confirmed ? (
              <SettingsApprovalOwnerAction
                plan={change.change.plan}
                receipt={change.change.receipt}
                owner="tool-approval"
                workspaceId="default"
                viewIdentity={draft.key}
              />
            ) : null}
          </div>
          {!confirmed ? <ApprovedSettingsContinuation plan={change.change.plan} onSettled={change.refresh} /> : null}
          <TechnicalDetails label="Change record">
            <p className="break-all font-mono text-xs">
              Plan {change.change.receipt.planId} · version {change.change.receipt.revision}
            </p>
          </TechnicalDetails>
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
        <NativeOwnerLink
          href={recoveryHref}
          scope={[draft.key, change.change?.receipt.planId, change.change?.receipt.revision]}
        >
          Inspect tool settings activity
        </NativeOwnerLink>
      ) : null}
      <Dialog
        open={Boolean(review)}
        title="Skip normal tool prompts?"
        description={`Change the installation default from ${describeToolApprovalMode(review?.current ?? current)} to Skip normal prompts. Allowed tools may run without normal prompts. Deny rules, Nuclear risk and risky-shell approvals, read boundaries, and tool grants remain in force.`}
        onOpenChange={(open) => {
          if (!open && !control.busy) control.setReview(null);
        }}
      >
        <div className="mb-3">
          <TechnicalDetails>
            <p className="break-all font-mono text-xs">Reviewed at settings version {review?.revision ?? "unknown"}</p>
          </TechnicalDetails>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            loading={control.busy}
            disabled={!control.reviewCurrent}
            onClick={() => void control.confirm()}
          >
            <ShieldAlert aria-hidden="true" className="size-4 shrink-0" />
            Skip normal prompts
          </Button>
          <Button disabled={control.busy} onClick={() => control.setReview(null)}>
            Keep current rule
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
