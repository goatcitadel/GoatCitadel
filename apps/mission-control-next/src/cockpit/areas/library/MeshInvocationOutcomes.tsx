import type { MeshCapabilityInvocationActivityItem } from "@goatcitadel/mission-control-shared/api/mesh-capabilities";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { StatusBadge } from "../../ui/StatusBadge";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TimeText } from "../../ui/TimeText";
import { MESH_SETTLED_BY, invocationState, meshErrorLabel, meshNameFromCapabilityId } from "./mesh-capability-labels";

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
          {plural(reconcile, "invocation")} settled with an unknown delivery and {reconcile === 1 ? "awaits" : "await"}{" "}
          manual reconciliation.
        </p>
      ) : null}
      {activity.length ? (
        <ul aria-label="Recent mesh invocation outcomes" className="divide-y divide-line-subtle">
          {activity.map((item) => (
            <li key={item.invocationId} className="space-y-1 py-2">
              <div className="flex flex-wrap gap-1">
                <StatusBadge status={invocationState(item)} />
                {item.settlementAuthority ? (
                  <StatusBadge status={{ label: MESH_SETTLED_BY[item.settlementAuthority], tone: "neutral" }} />
                ) : null}
                {item.manualReconciliationRequired ? (
                  <StatusBadge status={{ label: "Manual reconciliation required", tone: "failed" }} />
                ) : null}
              </div>
              <p className="break-words">
                {meshNameFromCapabilityId(item.capabilityId)} · <TimeText value={item.observedAt} absolute />
                {item.errorCode ? ` · ${meshErrorLabel(item.errorCode)}` : ""}
              </p>
              <TechnicalDetails label="Invocation identifiers">
                <p className="wrap-anywhere">
                  Capability: <code>{item.capabilityId}</code> · Node: {item.nodeId} · Invocation: {item.invocationId}
                  {item.errorCode ? ` · Error code: ${item.errorCode}` : ""}
                </p>
              </TechnicalDetails>
            </li>
          ))}
        </ul>
      ) : error ? null : (
        <p className="text-fg-muted">No recent mesh invocations.</p>
      )}
      <p className="text-xs text-fg-muted">
        Read-only: outcomes come from retained events. Nothing here acknowledges or reruns an invocation; there is no
        operator route for the reconciliation queue yet.
      </p>
    </section>
  );
}
