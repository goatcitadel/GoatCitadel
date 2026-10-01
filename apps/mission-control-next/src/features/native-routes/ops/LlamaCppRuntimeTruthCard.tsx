import type { LlamaCppRuntimeLeaseDiagnostics, LlamaCppRuntimeStatus } from "@goatcitadel/contracts";
import type { RuntimeSnapshotSourceStatus } from "@goatcitadel/mission-control-shared/hooks/useOpsRuntimeSnapshot";
import { NativeCard, NativeList } from "../NativeRoutePageLayout";
import {
  EmptyState,
  NativeMetricGrid as MetricGrid,
  NoticeBanner,
  StatusChip,
  type StatusChipTone,
} from "../primitives";
import { formatDateTime } from "./runtime-formatters";
import { readRuntimeSourceMessage, type OpsRuntimeData } from "./runtime-overview-model";

export function LlamaCppRuntimeTruthCard({
  status,
  sourceStatus,
}: {
  status: OpsRuntimeData["llamaCpp"] | undefined;
  sourceStatus?: RuntimeSnapshotSourceStatus;
}) {
  const sourceError = sourceStatus?.status === "error" ? readRuntimeSourceMessage(sourceStatus) : null;
  const diagnostics = status?.leaseDiagnostics;
  const restartExhausted = diagnostics?.evidence.lastRestart?.outcome === "exhausted";

  return (
    <NativeCard
      title="llama.cpp service lifecycle"
      subtitle="Lease demand, process ownership, and bounded recovery evidence from the Gateway runtime owner."
      density="compact"
      stats={[
        { label: "Process", value: status?.processState ?? "unavailable" },
        { label: "Health", value: status ? (status.healthy ? "healthy" : "needs attention") : "unavailable" },
      ]}
    >
      <section aria-label="llama.cpp runtime truth" aria-live="polite">
        {sourceError ? (
          <NoticeBanner tone="error" message={`llama.cpp runtime truth unavailable: ${sourceError}`} />
        ) : !status ? (
          <EmptyState size="compact" title="llama.cpp runtime status is unavailable." />
        ) : !diagnostics ? (
          <NoticeBanner
            tone="info"
            message="Lease lifecycle diagnostics are unavailable from this Gateway version. Process health remains visible."
          />
        ) : (
          <>
            <div className="mc-next-runtime-chip-row" aria-label="llama.cpp lifecycle summary">
              <StatusChip tone={toneForLlamaCppLifecycle(status.processState, status.healthy, diagnostics.state)}>
                {formatRuntimeLifecycleLabel(diagnostics.state)}
              </StatusChip>
              <StatusChip tone={diagnostics.ownership === "external" ? "muted" : "default"}>
                {diagnostics.ownership === "external"
                  ? "External process"
                  : diagnostics.ownership === "owned"
                    ? "Gateway owned"
                    : "No process owner"}
              </StatusChip>
              {restartExhausted ? <StatusChip tone="critical">Restart budget exhausted</StatusChip> : null}
            </div>
            <MetricGrid
              items={[
                {
                  label: "Lifecycle",
                  value: formatRuntimeLifecycleLabel(diagnostics.state),
                  meta: `${status.processState} · ${status.healthy ? "healthy" : "not healthy"}`,
                },
                {
                  label: "Ownership",
                  value: formatRuntimeLifecycleLabel(diagnostics.ownership),
                  meta: diagnostics.ownership === "external" ? "Observed; never terminated by leases" : "Process owner",
                },
                {
                  label: "Active leases",
                  value: String(diagnostics.activeLeaseCount),
                  meta: formatLlamaCppLeasePurposes(diagnostics),
                },
                {
                  label: "Persistent demand",
                  value: formatLlamaCppPersistentDemand(diagnostics),
                  meta: "Manual, API, and autostart demand",
                },
                {
                  label: "Idle deadline",
                  value: diagnostics.idleDeadline ? formatDateTime(diagnostics.idleDeadline) : "Not scheduled",
                  meta: diagnostics.state === "idle_pending" ? "Reacquire cancels shutdown" : "No pending idle stop",
                },
              ]}
            />
            <NativeList
              items={diagnostics.purposes.map((item) => ({
                title: formatRuntimeLifecycleLabel(item.purpose),
                meta: `${item.count} lease${item.count === 1 ? "" : "s"}`,
                body: "Active runtime consumer purpose",
              }))}
              emptyLabel="No active lease purposes."
              density="compact"
              maxHeight="min(22vh, 11rem)"
              ariaLabel="Active llama.cpp lease purposes"
            />
            <NativeList
              items={buildLlamaCppRuntimeEvidence(diagnostics)}
              emptyLabel="No probe, exit, or restart evidence recorded yet."
              density="compact"
              maxHeight="min(28vh, 14rem)"
              ariaLabel="Latest llama.cpp runtime evidence"
            />
          </>
        )}
      </section>
    </NativeCard>
  );
}

function buildLlamaCppRuntimeEvidence(diagnostics: LlamaCppRuntimeLeaseDiagnostics) {
  const evidence = diagnostics.evidence;
  return [
    evidence.lastProbe
      ? {
          title: `Latest probe · ${evidence.lastProbe.healthy ? "Healthy" : "Failed"}`,
          meta: formatDateTime(evidence.lastProbe.at),
          body: evidence.lastProbe.healthy ? "Configured endpoint responded." : "Configured endpoint did not respond.",
        }
      : null,
    evidence.lastExit
      ? {
          title: `Latest exit · ${evidence.lastExit.unexpected ? "Unexpected" : "Expected"}`,
          meta: formatDateTime(evidence.lastExit.at),
          body:
            [
              typeof evidence.lastExit.code === "number" ? `code ${evidence.lastExit.code}` : null,
              evidence.lastExit.signal ? `signal ${evidence.lastExit.signal}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || "No exit code or signal recorded.",
        }
      : null,
    evidence.lastRestart
      ? {
          title: `Latest restart · ${formatRuntimeLifecycleLabel(evidence.lastRestart.outcome)}`,
          meta: formatDateTime(evidence.lastRestart.at),
          body:
            evidence.lastRestart.outcome === "exhausted"
              ? "Automatic restart budget is exhausted; operator attention is required."
              : "Most recent owned-process recovery outcome.",
        }
      : null,
  ].filter((item): item is NonNullable<typeof item> => item !== null);
}

function formatLlamaCppLeasePurposes(diagnostics: LlamaCppRuntimeLeaseDiagnostics): string {
  return diagnostics.purposes.length > 0
    ? diagnostics.purposes
        .slice(0, 8)
        .map((item) => `${formatRuntimeLifecycleLabel(item.purpose)} ×${item.count}`)
        .join(", ")
    : "No active purposes";
}

function formatLlamaCppPersistentDemand(diagnostics: LlamaCppRuntimeLeaseDiagnostics): string {
  const sources = Object.entries(diagnostics.persistentDemand)
    .filter(([, enabled]) => enabled)
    .map(([source]) => formatRuntimeLifecycleLabel(source));
  return sources.length > 0 ? sources.join(", ") : "None";
}

function formatRuntimeLifecycleLabel(value: string): string {
  const normalized = value.replaceAll("_", " ");
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function toneForLlamaCppLifecycle(
  processState: LlamaCppRuntimeStatus["processState"],
  healthy: boolean,
  lifecycle: LlamaCppRuntimeLeaseDiagnostics["state"],
): StatusChipTone {
  if (processState === "error") {
    return "critical";
  }
  if (healthy && (lifecycle === "active" || lifecycle === "persistent")) {
    return "success";
  }
  if (lifecycle === "idle" || lifecycle === "closed") {
    return "muted";
  }
  return "warning";
}
