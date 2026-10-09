import type { MeshCapabilityInvocationActivityItem } from "@goatcitadel/mission-control-shared/api/mesh-capabilities";
import { StatusBadge } from "../../ui/StatusBadge";
import { invocationState } from "./mesh-capability-labels";

const time = (value?: string) =>
  value && Number.isFinite(Date.parse(value)) ? (
    <time dateTime={value}>{new Date(value).toLocaleString()}</time>
  ) : (
    "Not reported"
  );

/** Read-only mesh invocation outcomes from retained events; nothing here acknowledges or replays an invocation. */
export function MeshInvocationOutcomes({
  activity,
  error,
}: {
  activity: readonly MeshCapabilityInvocationActivityItem[];
  error: string | null;
}) {
  const reconcile = activity.filter((item) => item.manualReconciliationRequired).length;
  return (
    <section aria-label="Mesh invocation outcomes" className="space-y-2">
      <h3 className="font-semibold text-fg">Invocation outcomes ({activity.length})</h3>
      {error ? (
        <p role="alert" className="text-status-failed">
          {error}
        </p>
      ) : null}
      {reconcile ? (
        <p role="status" className="text-status-waiting">
          {reconcile} invocation{reconcile === 1 ? "" : "s"} settled with an unknown delivery and await
          {reconcile === 1 ? "s" : ""} manual reconciliation.
        </p>
      ) : null}
      {activity.length ? (
        <ul aria-label="Recent mesh invocation outcomes" className="space-y-2">
          {activity.map((item) => (
            <li key={item.invocationId} className="space-y-1 rounded-md border border-line p-2">
              <div className="flex flex-wrap gap-1">
                <StatusBadge status={invocationState(item)} />
                {item.settlementAuthority ? (
                  <StatusBadge status={{ label: `Settled by ${item.settlementAuthority}`, tone: "neutral" }} />
                ) : null}
                {item.manualReconciliationRequired ? (
                  <StatusBadge status={{ label: "Manual reconciliation required", tone: "failed" }} />
                ) : null}
              </div>
              <p className="break-words">
                <code className="wrap-anywhere">{item.capabilityId}</code> on node {item.nodeId} ·{" "}
                {time(item.observedAt)}
                {item.errorCode ? ` · ${item.errorCode.replaceAll("_", " ")}` : ""}
              </p>
            </li>
          ))}
        </ul>
      ) : error ? null : (
        <p className="text-fg-muted">No recent mesh invocations.</p>
      )}
      <p className="text-xs text-fg-muted">
        Read-only: outcomes come from retained events. Nothing here acknowledges or replays an invocation; there is no
        operator route for the reconciliation queue yet.
      </p>
    </section>
  );
}
