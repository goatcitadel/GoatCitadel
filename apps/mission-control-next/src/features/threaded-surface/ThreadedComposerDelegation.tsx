import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { useState } from "react";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { StatusChip } from "../native-routes/primitives";
import { formatDelegationConfidence } from "./threaded-composer-labels";

export function ComposerDelegationApproval({ props }: { props: MissionThreadedActiveSessionSurfaceProps }) {
  const suggestion = props.delegationSuggestion;
  if (!suggestion) {
    return null;
  }

  const confidenceLabel = formatDelegationConfidence(suggestion.confidence);
  const reason = suggestion.reason?.trim();

  return (
    <section className="mc-next-composer-delegation-approval" role="alert" aria-live="assertive">
      <div className="mc-next-composer-delegation-head">
        <StatusChip tone="warning">Subagent approval</StatusChip>
        <strong>Subagents unavailable</strong>
        {confidenceLabel ? <span>{confidenceLabel}</span> : null}
      </div>
      <p>Subagent delegation is temporarily unavailable. This saved suggestion can be dismissed.</p>
      <p className="mc-next-composer-delegation-objective">{suggestion.objective}</p>
      {reason ? <p className="mc-next-composer-delegation-reason">{reason}</p> : null}
      {suggestion.roles.length > 0 ? (
        <div className="mc-next-composer-delegation-roles" aria-label="Suggested subagent roles">
          {suggestion.roles.map((role) => (
            <StatusChip key={role} tone="muted">
              {role}
            </StatusChip>
          ))}
        </div>
      ) : null}
      <div className="mc-next-composer-delegation-actions">
        <button
          type="button"
          className="mc-next-composer-inline-button primary"
          disabled
          onClick={() => void props.onAcceptDelegation()}
        >
          Subagents unavailable
        </button>
        <button
          type="button"
          className="mc-next-composer-inline-button"
          disabled={props.sending}
          onClick={props.onDismissDelegationSuggestion}
        >
          Keep single run
        </button>
      </div>
    </section>
  );
}

const COWORK_STOP_STATE_ONLY_NOTE =
  "State-only: records operator stop intent in GoatCitadel state. It does not terminate the worker by itself — a live executor must honor the recorded stop before the run is treated as stopped.";

export function ComposerCoworkStop({ props }: { props: MissionThreadedActiveSessionSurfaceProps }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const control = props.coworkStopRunControl;
  if (props.mode !== "cowork" || !control) {
    return null;
  }
  const pending = Boolean(props.coworkStopRunPending);
  const stateOnly = control.runtimeEffect === "state_only";
  const reason = control.note?.trim() || undefined;
  const disabled = !control.enabled || pending;
  const confirmMessage = stateOnly
    ? "This records operator stop intent for the active run. For a cowork run with no attached durable run, it only records intent and does not terminate the worker — the run keeps going until a live executor honors the recorded stop."
    : "This cancels the active delegation run. Completed evidence stays available, and any live executor must honor the cancel before the run is treated as stopped.";

  return (
    <section className="mc-next-composer-banner mc-next-composer-cowork-stop" role="status">
      <StatusChip tone="warning">Delegation running</StatusChip>
      <div className="mc-next-composer-cowork-stop-body">
        <p>{reason ?? "Stop the active delegation run."}</p>
        {stateOnly ? <p className="mc-next-composer-cowork-stop-note">{COWORK_STOP_STATE_ONLY_NOTE}</p> : null}
      </div>
      <button
        type="button"
        className="mc-next-panel-button danger"
        disabled={disabled}
        title={reason}
        onClick={() => {
          if (!disabled) {
            setConfirmOpen(true);
          }
        }}
      >
        {pending ? "Stopping..." : "Stop run"}
      </button>
      <ConfirmModal
        open={confirmOpen}
        title="Stop this delegation run?"
        message={confirmMessage}
        confirmLabel="Stop run"
        danger
        pending={pending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          props.onCoworkStopRun?.(control);
        }}
      />
    </section>
  );
}
