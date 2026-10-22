import type { RuntimeAuthorityMessage } from "@goatcitadel/contracts";
import { plural } from "@goatcitadel/mission-control-shared/content/format";

const leases = (count: number) => plural(count, "active lease");

/**
 * Operator wording for a runtime authority item's coded state. The Gateway's prose stays in technical details; an
 * unknown code returns undefined so the caller can fall back to it.
 */
export function presentAuthorityMessage(message: RuntimeAuthorityMessage): string | undefined {
  const count = message.count ?? 0;
  const counts = message.counts ?? {};
  const n = (key: string) => counts[key] ?? 0;
  switch (message.code) {
    // The count is the bounded recent window the Gateway read, not a lifetime total.
    case "approval_records_available":
      if (count === 0) return "No approval records are in this workspace's recent window.";
      return `${plural(count, "approval record")} ${count === 1 ? "is" : "are"} in this workspace's recent window.`;
    case "approval_records_unavailable":
      return "Approval records can't be read, so approvals aren't shown.";
    case "worker_leases_checked":
      return `${plural(n("runs"), "running run")} checked: ${plural(n("expired"), "expired or missing lease")} and ${plural(n("stale"), "stale heartbeat")}.`;
    case "mesh_workers":
      return `${plural(n("currentNodes"), "current node")}, ${plural(n("staleNodes"), "stale node")}, ${leases(n("activeLeases"))} and ${plural(n("expiredLeases"), "expired lease")}.`;
    case "local_runtime_disabled":
      return `The local runtime is off, with ${leases(count)}.`;
    case "local_runtime_unhealthy_leases":
      return `${leases(count)}, but the local runtime isn't running and healthy.`;
    case "local_runtime_failed":
      return `The local runtime stopped or failed while it should be running, with ${leases(count)}.`;
    case "local_runtime_starting":
      return `The local runtime is starting, with ${leases(count)}.`;
    case "local_runtime_ready":
      return `The local runtime is ready, with ${leases(count)}.`;
    case "local_runtime_not_ready":
      return `The local runtime isn't running, with ${leases(count)}.`;
    default:
      return undefined;
  }
}
