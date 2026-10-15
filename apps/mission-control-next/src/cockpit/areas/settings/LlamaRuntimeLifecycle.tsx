import { useRef, useState } from "react";
import type { LlamaCppRuntimeLeaseDiagnostics, LlamaCppRuntimeStatus } from "@goatcitadel/contracts";
import { refreshLlamaCppRuntime, stopLlamaCppRuntime } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { Button } from "../../ui/Button";
import { TimeText } from "../../ui/TimeText";

type LeaseEvidenceRecord = LlamaCppRuntimeLeaseDiagnostics["evidence"];
const LEASE_STATES: Record<LlamaCppRuntimeLeaseDiagnostics["state"], string> = {
  idle: "Idle",
  starting: "Starting",
  active: "Active",
  idle_pending: "Idle, shutting down soon",
  persistent: "Kept running",
  closed: "Closed",
};
const START_REASONS: Record<NonNullable<LeaseEvidenceRecord["lastStart"]>["reason"], string> = {
  manual: "Manual start",
  api: "API request",
  autostart: "Autostart",
  lease: "Incoming request",
  restart: "Restart",
  other: "Other",
};
const START_OUTCOMES: Record<NonNullable<LeaseEvidenceRecord["lastStart"]>["outcome"], string> = {
  requested: "Requested",
  ready: "Ready",
  failed: "Failed",
};
const RESTART_OUTCOMES: Record<NonNullable<LeaseEvidenceRecord["lastRestart"]>["outcome"], string> = {
  scheduled: "Scheduled",
  attempting: "Attempting",
  ready: "Ready",
  failed: "Failed",
  exhausted: "Gave up after retries",
};

const STOPPABLE = new Set<LlamaCppRuntimeStatus["processState"]>(["starting", "running", "error"]);
const OWNERSHIP: Record<LlamaCppRuntimeLeaseDiagnostics["ownership"], string> = {
  owned: "Owned by GoatCitadel",
  external: "External, observed only",
  none: "No process owned",
};

function requests(count: number) {
  return `${plural(count, "active request")} ${count === 1 ? "is" : "are"}`;
}

/** What keeps the runtime alive besides individual requests. */
function demandLabel(demand: LlamaCppRuntimeLeaseDiagnostics["persistentDemand"]) {
  const sources = [demand.manual ? "Manual start" : "", demand.api ? "API" : "", demand.autostart ? "Autostart" : ""];
  return sources.filter(Boolean).join(", ") || "Nothing persistent";
}

function LeaseEvidence({ diagnostics }: { diagnostics: LlamaCppRuntimeLeaseDiagnostics }) {
  const { evidence } = diagnostics;
  const purposes = diagnostics.purposes.map((item) => `${item.purpose} ${item.count}`).join(", ");
  return (
    <ul aria-label="llama.cpp lease lifecycle" className="space-y-1 text-sm text-fg-secondary">
      <li>Lifecycle: {LEASE_STATES[diagnostics.state] ?? "Unknown"}</li>
      <li>Ownership: {OWNERSHIP[diagnostics.ownership]}</li>
      <li>
        Active requests: {diagnostics.activeLeaseCount}
        {purposes ? ` (${purposes})` : ""}
      </li>
      <li>Kept running by: {demandLabel(diagnostics.persistentDemand)}</li>
      <li>
        Idle shutdown:{" "}
        {diagnostics.idleDeadline ? <TimeText absolute value={diagnostics.idleDeadline} /> : "Not scheduled"}
      </li>
      {evidence.lastStart ? (
        <li>
          Latest start: {START_REASONS[evidence.lastStart.reason] ?? "Unknown"} ·{" "}
          {START_OUTCOMES[evidence.lastStart.outcome] ?? "Unknown"} · <TimeText value={evidence.lastStart.at} />
        </li>
      ) : null}
      {evidence.lastProbe ? (
        <li>
          Latest probe: {evidence.lastProbe.healthy ? "healthy" : "failed"} · <TimeText value={evidence.lastProbe.at} />
        </li>
      ) : null}
      {evidence.lastExit ? (
        <li>
          Latest process exit: {evidence.lastExit.unexpected ? "unexpected" : "expected"}
          {typeof evidence.lastExit.code === "number" ? ` · code ${evidence.lastExit.code}` : ""}
          {evidence.lastExit.signal ? ` · signal ${evidence.lastExit.signal}` : ""} ·{" "}
          <TimeText value={evidence.lastExit.at} />
        </li>
      ) : null}
      {evidence.lastRestart ? (
        <li>
          Latest restart: {RESTART_OUTCOMES[evidence.lastRestart.outcome] ?? "Unknown"} ·{" "}
          <TimeText value={evidence.lastRestart.at} />
        </li>
      ) : null}
    </ul>
  );
}

/**
 * llama.cpp lifecycle for the managed runtime: lease evidence, a status probe, and a reviewed stop of a process
 * GoatCitadel owns. The stop re-reads the runtime first and refuses if ownership changed or more work started.
 */
export function LlamaRuntimeLifecycle({
  managementMode,
  status,
  busy,
  onChanged,
}: {
  managementMode?: "external" | "managed";
  status?: LlamaCppRuntimeStatus;
  busy: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const [review, setReview] = useState<{ pid?: number; activeLeaseCount: number } | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const running = useRef(false);
  const diagnostics = status?.leaseDiagnostics;
  const stoppable = Boolean(
    managementMode === "managed" && status && diagnostics?.ownership === "owned" && STOPPABLE.has(status.processState),
  );

  async function run(action: () => Promise<string>) {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setNotice("");
    try {
      setNotice(await action());
    } finally {
      await onChanged().catch(() => undefined);
      running.current = false;
      setPending(false);
    }
  }

  const refresh = () =>
    run(async () => {
      try {
        await refreshLlamaCppRuntime();
        return "Runtime status refreshed from the Gateway.";
      } catch (error) {
        return `Runtime status could not be refreshed: ${describeApiError(error).summary}`;
      }
    });

  const stop = (reviewed: { pid?: number; activeLeaseCount: number }) =>
    run(async () => {
      setReview(null);
      let current: LlamaCppRuntimeStatus;
      try {
        current = await refreshLlamaCppRuntime();
      } catch (error) {
        return `The runtime could not be re-read, so it was not stopped: ${describeApiError(error).summary}`;
      }
      const lease = current.leaseDiagnostics;
      if (
        lease?.ownership !== "owned" ||
        current.pid !== reviewed.pid ||
        lease.activeLeaseCount > reviewed.activeLeaseCount
      ) {
        return "The runtime changed since your review, so it was not stopped. Review it again.";
      }
      try {
        await stopLlamaCppRuntime();
        return "Stop requested. The status shown is read back from the Gateway.";
      } catch {
        return "The stop outcome is unknown. The runtime status was read again; check it before acting.";
      }
    });

  const locked = busy || pending;
  return (
    <section aria-label="llama.cpp lifecycle" className="space-y-3 rounded-md border border-line bg-raised p-3">
      <h4 className="text-sm font-semibold text-fg">llama.cpp lifecycle</h4>
      {diagnostics ? (
        <LeaseEvidence diagnostics={diagnostics} />
      ) : (
        <p role="status" className="text-sm text-fg-muted">
          This Gateway does not report llama.cpp lifecycle diagnostics.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={locked} onClick={() => void refresh()}>
          Refresh runtime status
        </Button>
        {stoppable ? (
          <Button
            size="sm"
            variant="danger"
            disabled={locked}
            onClick={() => setReview({ pid: status?.pid, activeLeaseCount: diagnostics?.activeLeaseCount ?? 0 })}
          >
            Review stop
          </Button>
        ) : null}
      </div>
      {managementMode !== "managed" ? (
        <p className="text-xs text-fg-muted">Stop an external llama.cpp server through its own process manager.</p>
      ) : diagnostics && !stoppable ? (
        <p className="text-xs text-fg-muted">No GoatCitadel-owned llama.cpp process is running.</p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-fg-secondary">
          {notice}
        </p>
      ) : null}
      <ConfirmModal
        open={Boolean(review)}
        danger
        title="Stop the llama.cpp runtime?"
        confirmLabel="Stop llama.cpp runtime"
        cancelLabel="Keep running"
        message={`Stop the GoatCitadel-owned llama.cpp process${review?.pid ? ` (process ${review.pid})` : ""}. ${
          review?.activeLeaseCount
            ? `${requests(review.activeLeaseCount)} using this runtime and will be interrupted.`
            : "No active requests are using it."
        } The runtime is re-read first; if anything changed, nothing is stopped.`}
        pending={pending}
        onCancel={() => setReview(null)}
        onConfirm={() => {
          if (review) void stop(review);
        }}
      />
    </section>
  );
}
