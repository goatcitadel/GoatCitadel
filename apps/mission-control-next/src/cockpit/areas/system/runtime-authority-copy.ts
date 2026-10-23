import type { RuntimeAuthorityMessage } from "@goatcitadel/contracts";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { AUTHORITY_SENTENCES, presentPatternedCode } from "./runtime-authority-wording";

const leases = (count: number) => plural(count, "active lease");

const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

/** The counts each code's wording needs; a message missing one is not worded, so a missing count never reads as 0. */
const REQUIRED_COUNTS: Record<string, readonly string[]> = {
  worker_leases_checked: ["runs", "expired", "stale"],
  mesh_workers: ["currentNodes", "staleNodes", "activeLeases", "expiredLeases"],
  config_generation: ["revision"],
  config_reconciliation_pending: ["owners", "transaction", "mirrors"],
};
const NEEDS_COUNT = new Set([
  "approval_records_available",
  "local_runtime_disabled",
  "local_runtime_unhealthy_leases",
  "local_runtime_failed",
  "local_runtime_starting",
  "local_runtime_ready",
  "local_runtime_not_ready",
  "backup_failed",
]);

/**
 * Operator wording for a runtime authority item's coded state. The Gateway's prose stays in technical details; an
 * unknown code, or a known one missing a count its wording needs, returns undefined so the caller can fall back to it.
 */
export function presentAuthorityMessage(message: RuntimeAuthorityMessage): string | undefined {
  if (NEEDS_COUNT.has(message.code) && !isCount(message.count)) return undefined;
  const counts = message.counts ?? {};
  if (REQUIRED_COUNTS[message.code]?.some((key) => !isCount(counts[key]))) return undefined;
  const count = message.count ?? 0;
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
    case "backup_failed":
      return `The latest backup didn't verify: ${plural(count, "problem")} found.`;
    case "config_generation":
      return `Version ${n("revision")} of the configuration is active.`;
    case "config_reconciliation_pending": {
      const waiting = [
        n("owners") ? "runtime parts picking up the new configuration" : "",
        n("transaction") ? "a configuration change being saved" : "",
        n("mirrors") ? "a configuration copy being repaired" : "",
      ].filter(Boolean);
      return waiting.length ? `Waiting on ${waiting.join(" and ")}.` : undefined;
    }
    case "config_recovered":
    case "config_recovered_attention": {
      const at = isCount(counts.revision) ? ` at version ${counts.revision}` : "";
      return message.code === "config_recovered"
        ? `Startup recovered the configuration${at}.`
        : `Startup recovered the configuration${at}, but the result needs a look.`;
    }
    default:
      return AUTHORITY_SENTENCES[message.code] ?? presentPatternedCode(message.code);
  }
}
