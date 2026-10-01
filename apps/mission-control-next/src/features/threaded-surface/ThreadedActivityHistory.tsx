import { useId, useState } from "react";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { StatusChip } from "../native-routes/primitives";
import { getArchiveActionLabel } from "./threaded-surface-model";

export function UtilityChangePlanHistory({ changePlans }: { changePlans: readonly ChangePlanRecord[] }) {
  const [open, setOpen] = useState(false);
  const controlsId = useId();
  if (changePlans.length === 0) {
    return null;
  }

  return (
    <details
      className="mc-next-work-record-history"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary aria-expanded={open} aria-controls={controlsId}>
        Activity history ({changePlans.length})
      </summary>
      <div id={controlsId}>
        <p>Completed receipts stay here after you dismiss them from the conversation.</p>
        <ul className="mc-next-work-record-list">
          {changePlans.map((plan) => (
            <ChangePlanHistoryItem key={`${plan.planId}:${plan.revision}:${plan.status}`} plan={plan} />
          ))}
        </ul>
      </div>
    </details>
  );
}

export function ChangePlanHistoryItem({ plan }: { plan: ChangePlanRecord }) {
  const [open, setOpen] = useState(false);
  const controlsId = useId();
  const title = plan.kind === "session_model" ? "Model change" : plan.title;
  const model =
    plan.request.kind === "session_model" || plan.request.kind === "installation_default_model"
      ? [plan.request.providerId, plan.request.model].filter(Boolean).join(" / ")
      : null;
  const evidence = [...plan.evidenceRefs, ...(plan.result?.evidenceRefs ?? [])];

  return (
    <li className="mc-next-work-record-history-item">
      <div>
        <strong>{title}</strong>
        <span>{model || plan.status}</span>
      </div>
      <StatusChip tone={plan.status === "completed" || plan.status === "applied" ? "success" : "muted"}>
        {plan.status}
      </StatusChip>
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary aria-expanded={open} aria-controls={controlsId}>
          Details
        </summary>
        <div id={controlsId}>
          <span>Scope: {plan.scope}</span>
          <span>Revision: {plan.revision}</span>
          <span>Risk: {plan.risk}</span>
          <span>Impact: {plan.impact}</span>
          {plan.result?.summary ? <span>Result: {plan.result.summary}</span> : null}
          {evidence.length > 0 ? <span>Evidence: {evidence.join(", ")}</span> : null}
        </div>
      </details>
    </li>
  );
}

export function ActivitySessionActions({
  activeProps,
  onOpenBuildEditor,
}: {
  activeProps: MissionThreadedActiveSessionSurfaceProps;
  onOpenBuildEditor?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const controlsId = useId();

  return (
    <>
      {onOpenBuildEditor ? (
        <button type="button" className="mc-next-panel-button" onClick={onOpenBuildEditor}>
          Open build editor
        </button>
      ) : null}
      <details
        className="mc-next-work-record-session-actions"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="mc-next-panel-button" aria-expanded={open} aria-controls={controlsId}>
          Session actions
        </summary>
        <div id={controlsId}>
          <button
            type="button"
            className="mc-next-panel-button"
            disabled={activeProps.sessionArchivePending}
            onClick={activeProps.onToggleArchiveSession}
          >
            {getArchiveActionLabel(activeProps.sessionLifecycleStatus, activeProps.sessionArchivePending)}
          </button>
        </div>
      </details>
    </>
  );
}
