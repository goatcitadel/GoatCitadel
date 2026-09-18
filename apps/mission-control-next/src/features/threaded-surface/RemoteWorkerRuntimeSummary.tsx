import type { RemoteWorkerAssignmentProjection } from "@goatcitadel/contracts";
import { useRemoteWorkerAssignmentRuntime } from "../remote-workers/useRemoteWorkerAssignmentRuntime";
import { NativeOutputDownloads } from "../remote-workers/NativeOutputDownloads";

const dollars = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 6 });
const cost = (value: number | undefined) => (value === undefined ? "Unavailable" : dollars.format(value));
const count = (value: number | null | undefined) => (value == null ? "Unavailable" : value.toLocaleString());
const label = (value: string) => value.replaceAll("_", " ");

export function RemoteWorkerRuntimeSummary(props: {
  workspaceId: string;
  assignment: RemoteWorkerAssignmentProjection;
  refreshKey: number;
}) {
  const { data, loading, error, reload } = useRemoteWorkerAssignmentRuntime(props);
  const usage = data?.usageAndCost.value;
  const effects = data?.artifactAndEffects.value;
  const cell = data?.resourceCell.value;
  const contact = data?.connectionHealth.value;
  return (
    <div className="mc-next-remote-activity__runtime" aria-label="Worker runtime evidence" aria-busy={loading}>
      {error ? (
        <p className="mc-next-remote-activity__unavailable" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p className="mc-next-remote-activity__unavailable" role="status">
          Loading worker evidence…
        </p>
      ) : null}
      {data ? (
        <>
          <dl className="mc-next-remote-activity__metrics">
            <div>
              <dt>Recorded cost</dt>
              <dd>
                {cost(usage?.usage.costUsd)}
                {usage && !usage.usage.metricAvailability.costUsd.complete ? " · partial" : ""}
              </dd>
            </div>
            <div>
              <dt>Budget held</dt>
              <dd>
                {usage
                  ? `${cost(usage.reservedCostMicrousd / 1_000_000)} · ${count(usage.reservedRequests)} requests`
                  : "Unavailable"}
              </dd>
            </div>
            <div>
              <dt>Artifact files</dt>
              <dd>
                {count(effects?.manifestFileCount)}
                {effects?.verificationState
                  ? ` · ${{ not_required: "verification not required", pending: "verification pending", satisfied: "verified" }[effects.verificationState]}`
                  : ""}
              </dd>
            </div>
            <div>
              <dt>Effect receipts</dt>
              <dd>
                {effects
                  ? `${count(effects.effectReceiptCount)} of ${count(effects.effectIntentCount)} intents · ${count(effects.effectReconciliationCount)} ${effects.effectReconciliationCount === 1 ? "needs" : "need"} reconciliation`
                  : "Unavailable"}
              </dd>
            </div>
          </dl>
          <details className="mc-next-remote-activity__details">
            <summary>Execution evidence</summary>
            <p>
              Observed <time dateTime={data.observedAt}>{data.observedAt}</time>
            </p>
            <dl className="mc-next-remote-activity__metrics">
              <div>
                <dt>Provider attempts</dt>
                <dd>{count(usage?.usage.attemptCount)}</dd>
              </div>
              <div>
                <dt>Uncertain dispatches</dt>
                <dd>{count(usage?.usage.uncertainDispatchCount)}</dd>
              </div>
              {(["inputTokens", "outputTokens", "cachedInputTokens"] as const).map((metric) => (
                <div key={metric}>
                  <dt>
                    {
                      {
                        inputTokens: "Input tokens",
                        outputTokens: "Output tokens",
                        cachedInputTokens: "Cached input tokens",
                      }[metric]
                    }
                  </dt>
                  <dd>
                    {count(usage?.usage[metric])}
                    {usage && !usage.usage.metricAvailability[metric].complete ? " · partial" : ""}
                  </dd>
                </div>
              ))}
              <div>
                <dt>Cost coverage</dt>
                <dd>
                  {usage
                    ? `${count(usage.usage.metricAvailability.costUsd.knownAttemptCount)} known / ${count(usage.usage.metricAvailability.costUsd.unknownAttemptCount)} unknown attempts`
                    : "Unavailable"}
                </dd>
              </div>
              <div>
                <dt>Outstanding reservations</dt>
                <dd>{count(usage?.pendingReservations)}</dd>
              </div>
              <div>
                <dt>Recorded execution</dt>
                <dd>{cell ? label(cell.executionState) : "Unavailable"}</dd>
              </div>
              <div>
                <dt>Cleanup</dt>
                <dd>{cell ? label(cell.cleanupState) : "Unavailable"}</dd>
              </div>
              <div>
                <dt>Backup</dt>
                <dd>{cell ? label(cell.backupState) : "Unavailable"}</dd>
              </div>
              <div>
                <dt>Memory limit</dt>
                <dd>{cell ? `${count(cell.capacity.memoryLimitBytes)} bytes` : "Unavailable"}</dd>
              </div>
              <div>
                <dt>Disk reservation</dt>
                <dd>{cell ? `${count(cell.capacity.logicalDiskBytes)} bytes` : "Unavailable"}</dd>
              </div>
              <div>
                <dt>Last authenticated request</dt>
                <dd>{contact ? (contact.lastAuthenticatedAt ?? "Not observed in retained history") : "Unavailable"}</dd>
              </div>
              <div>
                <dt>Connection status</dt>
                <dd>Unavailable</dd>
              </div>
            </dl>
            <p>
              Partial cost covers recorded usage only. Budget holds are reservations. Effect receipts can include failed
              or uncertain outcomes.
            </p>
            <p>Recorded contact and execution state do not establish current connection or process health.</p>
            <NativeOutputDownloads key={`${data.assignmentId}:${data.assignmentGeneration}`} runtime={data} />
            <p className="mc-next-remote-activity__sources">
              Usage: {data.usageAndCost.authorityClass} ({data.usageAndCost.owner}). Artifacts/effects:{" "}
              {data.artifactAndEffects.authorityClass} ({data.artifactAndEffects.owner}). Cell:{" "}
              {data.resourceCell.authorityClass} ({data.resourceCell.owner}). Contact:{" "}
              {data.connectionHealth.authorityClass} ({data.connectionHealth.owner}).
            </p>
          </details>
        </>
      ) : null}
      <button type="button" className="mc-next-remote-activity__ops-link" disabled={loading} onClick={reload}>
        Refresh worker evidence
      </button>
    </div>
  );
}
