import type { ChatSessionPrefsPatch } from "@goatcitadel/contracts";
import type { MissionThreadedContextDockProps } from "@goatcitadel/threaded-surface-core";

function formatPreferenceDraftFields(patch: ChatSessionPrefsPatch): string {
  const fields = Object.keys(patch)
    .filter((key) => key !== "expectedRevision")
    .map((key) => key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase());
  return fields.length > 0 ? fields.join(", ") : "session preferences";
}

export function ThreadedContextConflictNotices({ props }: { props: MissionThreadedContextDockProps }) {
  return (
    <>
      {props.preferenceConflictDraft ? (
        <div className="mc-next-context-card" role="status" aria-live="polite">
          <p className="mc-next-panel-kicker">Unsaved preference draft</p>
          <p>
            The server preferences changed elsewhere. The latest server state remains canonical. Pending:{" "}
            {formatPreferenceDraftFields(props.preferenceConflictDraft)}.
          </p>
          <div className="mc-next-context-actions">
            <button
              type="button"
              className="mc-next-panel-button"
              onClick={() => void props.onRetryPreferenceConflictDraft()}
            >
              Retry preference changes
            </button>
            <button type="button" className="mc-next-panel-button" onClick={props.onDiscardPreferenceConflictDraft}>
              Discard preference draft
            </button>
          </div>
        </div>
      ) : null}

      {props.proactivePolicyConflict && props.proactivePolicyDraft ? (
        <div className="mc-next-context-card" role="status" aria-live="polite">
          <p className="mc-next-panel-kicker">Unsaved policy draft</p>
          <p>The server policy changed elsewhere. The latest server state remains canonical.</p>
          <button
            type="button"
            className="mc-next-panel-button"
            onClick={() => void props.onProactivePolicyPatch(props.proactivePolicyDraft!)}
          >
            Retry preserved changes
          </button>
        </div>
      ) : null}
    </>
  );
}
