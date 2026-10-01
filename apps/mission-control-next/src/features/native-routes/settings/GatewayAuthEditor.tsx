import { useState, type ButtonHTMLAttributes, type ComponentType, type ReactNode } from "react";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/client";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { useDraftLeave } from "../library/DraftLeaveDialog";
import { useSettingsApprovalContinuation } from "./use-settings-approval-continuation";
import { NativeButton } from "../primitives";
import { settingsChangeIsConfirmed } from "./use-settings-change";
import { useGatewayAuthSettings } from "./use-gateway-auth-settings";
import { useGatewayAuthContinuation } from "./use-gateway-auth-continuation";
import { useGatewayInstallToken } from "./use-gateway-install-token";
import { GatewayAuthReview } from "./GatewayAuthReview";

export function GatewayAuthEditor({
  settings,
  available,
  reload,
  onReviewApproval,
  renderApprovalAction,
  cockpit = false,
  buttonComponent: Action = NativeButton,
}: {
  settings?: RuntimeSettingsResponse;
  available: boolean;
  reload: () => Promise<unknown>;
  onReviewApproval?: (approvalId: string) => void;
  renderApprovalAction?: (plan: ChangePlanRecord | undefined, receipt: NonNullable<RuntimeSettingsResponse["changePlanReceipt"]>, pending: boolean) => ReactNode;
  cockpit?: boolean;
  buttonComponent?: ComponentType<ButtonHTMLAttributes<HTMLButtonElement>>;
}) {
  const [editing, setEditing] = useState(false);
  const control = useGatewayAuthSettings({ settings, available, active: editing, reload });
  const continuation = useGatewayAuthContinuation(control);
  const install = useGatewayInstallToken({
    key: control.key,
    settings,
    locked: control.locked,
    active: editing,
    available,
    reload,
  });
  const leave = useDraftLeave();
  const { draft, change } = control;
  const receipt = change.change?.receipt;
  const action = receipt?.requiredAction;
  const confirmed = settingsChangeIsConfirmed(change.change);
  const approved = useSettingsApprovalContinuation({
    plan: confirmed ? undefined : change.change?.plan,
    onSettled: change.refresh,
  });
  const button = cockpit
    ? "min-h-10 rounded-md border border-line bg-raised px-3 py-2 text-sm text-fg disabled:opacity-50"
    : undefined;
  const input = cockpit
    ? "mt-1 min-h-10 w-full rounded-md border border-line bg-canvas px-2 text-sm text-fg disabled:opacity-60"
    : "mc-next-settings-input";
  const close = () =>
    leave.request(() => {
      setEditing(false);
      control.clearCredential();
      continuation.cancel();
      install.hide();
    }, [draft.key, `${control.key}:credential`, `${control.key}:continuation-credential`]);
  return (
    <section aria-label="Gateway authentication" className={cockpit ? "space-y-3" : "mc-next-settings-stack"}>
      <p>
        Gateway authentication applies to this installation and every workspace. Current mode:{" "}
        {settings?.auth?.mode ?? "Unavailable"}.
      </p>
      {settings?.auth?.plan?.warnings?.map((warning, index) => (
        <p key={index} role="status">
          {warning}
        </p>
      ))}
      {settings?.auth?.allowLoopbackBypass ? (
        <p role="status">
          Loopback bypass is enabled. Local requests may access the Gateway without full authentication.
        </p>
      ) : null}
      <Action className={button} disabled={!control.ready} onClick={() => setEditing(true)}>
        Configure access{draft.isDirty ? " · Unsaved" : ""}
      </Action>
      {editing ? (
        <section
          aria-label="Configure Gateway access"
          className={cockpit ? "space-y-3 rounded-md border border-line bg-raised p-3" : "mc-next-settings-panel"}
        >
          <h4>Configure Gateway access</h4>
          <p>
            Public settings drafts stay in this app session. Credentials stay only in this open editor and clear when it
            closes or submits.
          </p>
          {draft.hasRemoteChanges ? (
            <div role="status">
              <p>Authentication settings changed. Your public draft is preserved.</p>
              <Action className={button} disabled={control.locked} onClick={draft.rebaseToCurrent}>
                Apply draft to current access
              </Action>
            </div>
          ) : null}
          <div className={cockpit ? "grid gap-3 sm:grid-cols-2" : "mc-next-settings-field-grid"}>
            <label>
              Auth mode
              <select
                className={input}
                value={draft.value.mode}
                disabled={control.locked}
                onChange={(event) => {
                  control.clearCredential();
                  draft.setValue((value) => ({
                    ...value,
                    mode: event.target.value as typeof value.mode,
                    replaceCredential: false,
                  }));
                }}
              >
                <option value="none">None</option>
                <option value="token">Token</option>
                <option value="basic">Basic</option>
              </select>
            </label>
            <label className={cockpit ? "flex min-h-11 items-center gap-2" : "mc-next-settings-toggle"}>
              <input
                type="checkbox"
                checked={draft.value.allowLoopbackBypass}
                disabled={control.locked}
                onChange={(event) =>
                  draft.setValue((value) => ({ ...value, allowLoopbackBypass: event.target.checked }))
                }
              />
              Loopback bypass
            </label>
            {draft.value.mode === "basic" ? (
              <label>
                Basic username
                <input
                  className={input}
                  value={draft.value.basicUsername}
                  disabled={control.locked}
                  autoComplete="off"
                  placeholder="Leave blank to keep the current username"
                  onChange={(event) => draft.setValue((value) => ({ ...value, basicUsername: event.target.value }))}
                />
              </label>
            ) : null}
            {draft.value.mode !== "none" ? (
              <label>
                {draft.value.mode === "token" ? "Token" : "Basic password"}
                <input
                  className={input}
                  type="password"
                  value={control.credential}
                  disabled={control.locked}
                  autoComplete="new-password"
                  placeholder="New credential (only when replacing)"
                  onChange={(event) => control.updateCredential(event.target.value)}
                />
              </label>
            ) : null}
          </div>
          <p>
            Leave loopback bypass off unless every local process should be trusted to reach the Gateway without normal
            authentication.
          </p>
          {control.inputError ? <p role="status">{control.inputError}</p> : null}
          <div className={cockpit ? "flex flex-wrap gap-2" : "mc-next-settings-button-row"}>
            <Action className={button} disabled={!control.canReview} onClick={control.requestReview}>
              Save access settings
            </Action>
            <Action
              className={button}
              disabled={control.locked || (!draft.isDirty && !control.credential)}
              onClick={control.discard}
            >
              Discard authentication draft
            </Action>
            <Action className={button} onClick={close}>
              Close authentication editor
            </Action>
            <Action className={button} disabled={!install.eligible} onClick={install.requestReview}>
              Generate install token
            </Action>
          </div>
          <p>
            The install-token owner can reveal or generate a token in Token mode. Its API has no atomic
            settings-revision check; current posture is checked before the request.
          </p>
          {install.token ? (
            <div>
              <label>
                Install token preview
                <input readOnly type="text" className={input} value={install.token} />
              </label>
              <Action className={button} onClick={install.hide}>
                Hide token
              </Action>
              <p>Preview clears after 30 seconds or when this editor closes.</p>
            </div>
          ) : null}
        </section>
      ) : null}
      {control.notice ? <p role="status">{control.notice}</p> : null}
      {install.message ? <p role="status">{install.message}</p> : null}
      {control.attempt ? (
        <p role={control.attempt.state === "uncertain" ? "alert" : "status"}>{control.attempt.message}</p>
      ) : null}
      {change.change ? (
        <section
          aria-label="Authentication change status"
          className={cockpit ? "space-y-2 rounded-md border border-line p-3" : "mc-next-settings-notice"}
        >
          <p role="status">
            {receipt?.status.replaceAll("_", " ")} · {change.change.message}
          </p>
          {change.change.error ? <p role="alert">{change.change.error}</p> : null}
          <Action className={button} onClick={() => void change.refresh()}>
            Refresh authentication change status
          </Action>
          {!confirmed && action?.kind === "approval" && action.approvalId && receipt ? (
            renderApprovalAction ? renderApprovalAction(change.change?.plan, receipt, control.attempt?.state === "pending")
              : onReviewApproval ? <Action className={button} onClick={() => onReviewApproval(action.approvalId!)}>
                  Review required approval
                </Action> : null
          ) : null}
          {approved.visible ? (
            <div>
              <Action
                className={button}
                disabled={approved.disabled || Boolean(control.attempt)}
                onClick={() => void approved.continueApproved()}
              >
                Continue approved change
              </Action>
              {approved.message ? <p role="status">{approved.message}</p> : null}
            </div>
          ) : null}
          {!confirmed && continuation.action ? (
            <Action className={button} disabled={Boolean(control.attempt)} onClick={continuation.requestReview}>
              Review required authentication action
            </Action>
          ) : null}
          {!confirmed && continuation.action?.kind === "secure_input" ? (
            <label>
              Required Gateway credential
              <input
                type="password"
                className={input}
                autoComplete="new-password"
                value={continuation.credential}
                disabled={Boolean(control.attempt)}
                onChange={(event) => continuation.setCredential(event.target.value)}
              />
            </label>
          ) : null}
          {continuation.message ? <p role="status">{continuation.message}</p> : null}
          <details>
            <summary>Authentication change details</summary>
            <dl className="break-all">
              <dt>Plan</dt>
              <dd>{receipt?.planId}</dd>
              <dt>Plan revision</dt>
              <dd>{receipt?.revision}</dd>
              <dt>Required action</dt>
              <dd>{action?.title ?? "No action reported"}</dd>
            </dl>
          </details>
        </section>
      ) : null}
      <GatewayAuthReview control={control} />
      <ConfirmModal
        open={Boolean(continuation.review)}
        danger
        title="Continue the reviewed authentication change?"
        message={`Continue this exact recorded authentication plan and required action for the entire Gateway installation. ${continuation.action?.kind === "secure_input" ? "The credential goes directly to Gateway custody and clears from this editor after submission." : "The Gateway will enforce any remaining approvals."}`}
        confirmLabel="Continue reviewed authentication action"
        pending={control.attempt?.state === "pending"}
        confirmDisabled={
          !continuation.currentReview ||
          Boolean(control.attempt) ||
          (continuation.action?.kind === "secure_input" && !continuation.credential.trim())
        }
        onCancel={continuation.cancel}
        onConfirm={() => void continuation.confirm()}
      />
      <ConfirmModal
        open={Boolean(install.review)}
        danger
        title="Resolve Gateway install token?"
        message="Request the current install token, generating one if missing, for this Gateway installation. The request does not persist a token to an environment file. This owner has no atomic revision guard. A returned token is revealed only in this editor for 30 seconds."
        confirmLabel="Resolve reviewed install token"
        pending={control.attempt?.state === "pending"}
        confirmDisabled={!install.reviewCurrent || control.locked}
        onCancel={install.cancel}
        onConfirm={() => void install.confirm()}
      />
      {leave.dialog}
    </section>
  );
}
