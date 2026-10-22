import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { Button } from "../../ui/Button";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { SettingsApprovalOwnerAction } from "./SettingsApprovalOwnerAction";
import { ApprovedSettingsContinuation } from "./ApprovedSettingsContinuation";
import { presentChangeStatusLabel } from "./settings-vocabulary";
import type { SettingsApprovalOwner } from "./settings-approval-owner";
import type { GovernedRuntimeSetting, GovernedSettingValue } from "./use-governed-runtime-setting";

/** Loading, read failure, and a saved value the Gateway did not report in a usable form. */
export function GovernedSettingLoadState<T extends GovernedSettingValue>({
  governed,
  loading,
  incomplete,
}: {
  governed: GovernedRuntimeSetting<T>;
  loading: string;
  incomplete: string;
}) {
  const { settings, ready } = governed;
  return (
    <>
      {settings.isLoading ? (
        <p role="status" className="mt-3 text-sm text-fg-muted">
          {loading}
        </p>
      ) : null}
      {settings.isError ? (
        <p role="alert" className="mt-3 text-sm text-status-failed">
          {describeApiError(settings.error).summary}
        </p>
      ) : null}
      {settings.data && !settings.isError && !ready ? (
        <p role="alert" className="mt-3 text-sm text-status-failed">
          {incomplete}
        </p>
      ) : null}
    </>
  );
}

/** The unsaved-draft marker and the prompt to move a draft onto a newer saved version. */
export function GovernedSettingDraftState<T extends GovernedSettingValue>({
  governed,
  unsaved,
  currentLabel,
}: {
  governed: GovernedRuntimeSetting<T>;
  unsaved: string;
  currentLabel: string;
}) {
  const { draft } = governed;
  return (
    <>
      {draft.isDirty ? (
        <p role="status" className="mt-2 text-xs text-status-waiting">
          {unsaved}
        </p>
      ) : null}
      {draft.hasRemoteChanges ? (
        <div role="status" className="mt-2 space-y-2 text-sm text-fg-secondary">
          <p>The saved setting changed after this draft began. Current: {currentLabel}.</p>
          <Button size="sm" onClick={draft.rebaseToCurrent}>
            Apply draft to latest version
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** The submitted change's status, its approval and continuation, the save notice, and recovery after an unknown outcome. */
export function GovernedSettingChangeStatus<T extends GovernedSettingValue>({
  governed,
  owner,
  recoveryLabel,
}: {
  governed: GovernedRuntimeSetting<T>;
  owner: SettingsApprovalOwner;
  recoveryLabel: string;
}) {
  const { change, confirmed, notice, draft } = governed;
  return (
    <>
      {change.change ? (
        <div className="mt-3 border-t border-line-subtle pt-3 text-sm text-fg-secondary">
          <p role="status">
            <strong className="text-fg">{presentChangeStatusLabel(change.change.receipt.status)}</strong> ·{" "}
            {change.change.message}
          </p>
          {change.change.error ? (
            <p role="alert" className="mt-1 text-status-failed">
              {change.change.error}
            </p>
          ) : null}
          {change.change.blocking ? (
            <p className="mt-1">The draft remains unsaved until GoatCitadel confirms the change.</p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void change.refresh()}>
              Refresh change status
            </Button>
            {change.change.receipt.requiredAction?.kind === "approval" && !confirmed ? (
              <SettingsApprovalOwnerAction
                plan={change.change.plan}
                receipt={change.change.receipt}
                owner={owner}
                workspaceId="default"
                viewIdentity={draft.key}
                label="Review approval"
              />
            ) : null}
          </div>
          {!confirmed ? <ApprovedSettingsContinuation plan={change.change.plan} onSettled={change.refresh} /> : null}
        </div>
      ) : null}
      {notice && !(confirmed && notice.message.startsWith("Change submitted.")) ? (
        <p
          role={notice.tone === "failed" ? "alert" : "status"}
          className={`mt-3 text-sm ${notice.tone === "failed" ? "text-status-failed" : notice.tone === "waiting" ? "text-status-waiting" : "text-status-done"}`}
        >
          {notice.message}
        </p>
      ) : null}
      {governed.outcomeUncertain ? (
        <NativeOwnerLink
          href={governed.recoveryHref}
          scope={[draft.key, change.change?.receipt.planId, change.change?.receipt.revision]}
          className="mt-3 inline-block text-sm font-medium text-accent hover:underline"
        >
          {recoveryLabel}
        </NativeOwnerLink>
      ) : null}
    </>
  );
}
