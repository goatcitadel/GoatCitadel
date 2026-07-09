import type { ChatMode } from "@goatcitadel/contracts";

export function ThreadedLoadingState({
  approvalsCount,
  mode,
  projectCount,
  sessionCount,
  workspaceName,
}: {
  approvalsCount: number;
  mode: ChatMode;
  projectCount: number | null;
  sessionCount: number | null;
  workspaceName: string;
}) {
  const label = "Chat";
  const focus =
    mode === "code"
      ? "Preparing source context, workbench evidence, and validation posture."
      : mode === "cowork"
        ? "Preparing supervised work, checkpoints, and approvals."
        : "Preparing model, policy, context, and recent threads.";

  return (
    <section className="mc-next-threaded-loading" aria-live="polite" aria-busy="true">
      <div className="mc-next-threaded-loading-copy">
        <p>{label}</p>
        <h2>Preparing {label}</h2>
        <span>{focus}</span>
      </div>
      <div className="mc-next-threaded-loading-grid" aria-label={`${label} startup readiness`}>
        <span>
          <strong>{workspaceName}</strong>
          <span>Workspace</span>
        </span>
        <span>
          <strong>{formatLoadingMetric(sessionCount)}</strong>
          <span>Sessions</span>
        </span>
        <span>
          <strong>{formatLoadingMetric(projectCount)}</strong>
          <span>Projects</span>
        </span>
        <span>
          <strong>{approvalsCount}</strong>
          <span>Approvals</span>
        </span>
      </div>
      <ol className="mc-next-threaded-loading-steps">
        <li>Connecting session history</li>
        <li>Checking runtime posture</li>
        <li>Opening the conversation surface</li>
      </ol>
    </section>
  );
}

function formatLoadingMetric(value: number | null): string {
  return value === null ? "Loading" : String(value);
}
