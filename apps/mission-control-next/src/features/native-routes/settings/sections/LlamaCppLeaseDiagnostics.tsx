import type { LlamaCppRuntimeLeaseDiagnostics } from "@goatcitadel/contracts";
import { SettingsActionList } from "../SettingsShared";
import { NativeMetricGrid } from "../../primitives";

export function LlamaCppLeaseDiagnostics({ diagnostics }: { diagnostics?: LlamaCppRuntimeLeaseDiagnostics }) {
  if (!diagnostics) {
    return (
      <p className="mc-next-settings-help" role="status">
        Lease lifecycle diagnostics are unavailable from this Gateway version.
      </p>
    );
  }

  const evidence = buildLlamaCppLeaseEvidence(diagnostics);
  return (
    <div role="group" aria-label="llama.cpp lease lifecycle" aria-live="polite">
      <NativeMetricGrid
        items={[
          {
            label: "Lifecycle",
            value: formatLifecycleLabel(diagnostics.state),
            meta: diagnostics.idleDeadline
              ? `Idle shutdown ${formatRuntimeEvidenceTime(diagnostics.idleDeadline)}`
              : "No idle shutdown scheduled",
          },
          {
            label: "Ownership",
            value: formatLifecycleLabel(diagnostics.ownership),
            meta: diagnostics.ownership === "external" ? "Observed, never managed" : "Runtime process owner",
          },
          {
            label: "Active leases",
            value: String(diagnostics.activeLeaseCount),
            meta: formatLeasePurposes(diagnostics),
          },
          {
            label: "Persistent demand",
            value: formatPersistentDemand(diagnostics),
            meta: diagnostics.activeLeaseCount > 0 ? "Transient leases are tracked separately" : "No transient leases",
          },
        ]}
      />
      <SettingsActionList
        ariaLabel="llama.cpp lease diagnostics"
        items={evidence}
        emptyLabel="No probe, exit, or restart evidence recorded yet."
        maxHeight="min(24vh, 12rem)"
      />
    </div>
  );
}

function buildLlamaCppLeaseEvidence(diagnostics: LlamaCppRuntimeLeaseDiagnostics) {
  const evidence = diagnostics.evidence;
  return [
    evidence.lastProbe
      ? {
          id: "llamacpp-last-probe",
          label: "Latest probe",
          description: evidence.lastProbe.healthy ? "Healthy endpoint response" : "Endpoint probe failed",
          meta: formatRuntimeEvidenceTime(evidence.lastProbe.at),
        }
      : null,
    evidence.lastExit
      ? {
          id: "llamacpp-last-exit",
          label: "Latest process exit",
          description: evidence.lastExit.unexpected ? "Unexpected owned-process exit" : "Expected process exit",
          meta: [
            typeof evidence.lastExit.code === "number" ? `code ${evidence.lastExit.code}` : null,
            evidence.lastExit.signal ? `signal ${evidence.lastExit.signal}` : null,
            formatRuntimeEvidenceTime(evidence.lastExit.at),
          ]
            .filter(Boolean)
            .join(" · "),
        }
      : null,
    evidence.lastRestart
      ? {
          id: "llamacpp-last-restart",
          label: "Latest restart",
          description: formatLifecycleLabel(evidence.lastRestart.outcome),
          meta: formatRuntimeEvidenceTime(evidence.lastRestart.at),
        }
      : null,
  ].filter((item): item is NonNullable<typeof item> => item !== null);
}

function formatLeasePurposes(diagnostics: LlamaCppRuntimeLeaseDiagnostics): string {
  return diagnostics.purposes.length > 0
    ? diagnostics.purposes.map((item) => `${formatLifecycleLabel(item.purpose)} ×${item.count}`).join(", ")
    : "No active purposes";
}

function formatPersistentDemand(diagnostics: LlamaCppRuntimeLeaseDiagnostics): string {
  const active = Object.entries(diagnostics.persistentDemand)
    .filter(([, enabled]) => enabled)
    .map(([source]) => formatLifecycleLabel(source));
  return active.length > 0 ? active.join(", ") : "None";
}

function formatLifecycleLabel(value: string): string {
  const normalized = value.replaceAll("_", " ");
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatRuntimeEvidenceTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "time unavailable" : date.toLocaleString();
}
