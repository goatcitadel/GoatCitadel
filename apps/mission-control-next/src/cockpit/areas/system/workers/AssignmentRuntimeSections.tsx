import type { ReactNode } from "react";
import type { RemoteWorkerTruth } from "@goatcitadel/contracts";
import { formatBytes, formatMoney } from "@goatcitadel/mission-control-shared/content/format";
import { NativeOutputDownloads } from "../../../../features/remote-workers/NativeOutputDownloads";
import { useRemoteWorkerAssignmentRuntime } from "../../../../features/remote-workers/useRemoteWorkerAssignmentRuntime";
import { Button } from "../../../ui/Button";
import { TechnicalDetails } from "../../../ui/TechnicalDetails";
import { TimeText } from "../../../ui/TimeText";
import { SOURCE_WORDS } from "./worker-copy";

type Runtime = NonNullable<ReturnType<typeof useRemoteWorkerAssignmentRuntime>["data"]>;
type Assignment = Parameters<typeof useRemoteWorkerAssignmentRuntime>[0]["assignment"];

const count = (value: number | null | undefined) =>
  value === null || value === undefined ? "Not reported" : value.toLocaleString();
const size = (value: number | null | undefined) =>
  value === null || value === undefined ? "Not reported" : formatBytes(value);

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
      {rows.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-fg-muted">{term}</dt>
          <dd className="text-fg">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Part({ title, truth, children }: { title: string; truth: RemoteWorkerTruth<unknown>; children: ReactNode }) {
  return (
    <section className="border-t border-line-subtle pt-3">
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      <p className="mb-2 text-xs text-fg-muted">
        {SOURCE_WORDS[truth.authorityClass] ?? "Not available"} · <TimeText value={truth.observedAt} prefix="checked" />
      </p>
      {truth.value === null ? <p className="text-sm text-fg-muted">{title} unavailable.</p> : children}
      <TechnicalDetails label={`${title} source`}>
        <p className="break-all font-mono text-xs">
          {truth.authorityClass} · {truth.owner}
        </p>
      </TechnicalDetails>
    </section>
  );
}

const CONTACT: Readonly<Record<string, string>> = {
  not_observed: "Not seen in the kept sign-in history",
  recent: "Recent signed-in request",
  stale: "Last signed-in request is old",
};

function Usage({ usage }: { usage: NonNullable<Runtime["usageAndCost"]["value"]> }) {
  const metric = (key: "inputTokens" | "outputTokens" | "cachedInputTokens" | "costUsd") => {
    const coverage = usage.usage.metricAvailability[key];
    const value = key === "costUsd" ? formatMoney(usage.usage.costUsd) : count(usage.usage[key]);
    return (
      <>
        {value}
        {coverage.complete ? "" : " · incomplete"}
        <span className="block text-xs text-fg-muted">
          {count(coverage.knownAttemptCount)} known, {count(coverage.unknownAttemptCount)} unknown attempts
        </span>
      </>
    );
  };
  return (
    <>
      <Facts
        rows={[
          ["Provider attempts", count(usage.usage.attemptCount)],
          ["Uncertain sends", count(usage.usage.uncertainDispatchCount)],
          ["Input tokens", metric("inputTokens")],
          ["Output tokens", metric("outputTokens")],
          ["Cached input tokens", metric("cachedInputTokens")],
          ["Recorded cost", metric("costUsd")],
          ["Outstanding holds", count(usage.pendingReservations)],
          ["Reserved requests", count(usage.reservedRequests)],
          ["Reserved cost", formatMoney(usage.reservedCostMicrousd / 1_000_000)],
        ]}
      />
      <p className="mt-2 text-sm text-fg-secondary">
        Incomplete recorded cost is a lower bound. Reserved amounts are outstanding holds, not a final bill.
      </p>
      <TechnicalDetails label="Exact amounts">
        <p className="font-mono text-xs">
          cost {usage.usage.costUsd ?? "not reported"} USD · reserved {usage.reservedCostMicrousd} microUSD
        </p>
      </TechnicalDetails>
    </>
  );
}

/** What the worker reported for one assignment generation: contact, usage and cost, resource cell and outputs. */
export function AssignmentRuntimeSections({
  workspaceId,
  assignment,
  refreshKey,
}: {
  workspaceId: string;
  assignment: Assignment;
  refreshKey?: string;
}) {
  const { data, error, reload } = useRemoteWorkerAssignmentRuntime({ workspaceId, assignment, refreshKey });
  if (error)
    return (
      <p role="alert" className="text-sm text-status-failed">
        {error.startsWith("Assignment identity changed")
          ? error
          : "Assignment runtime is unavailable. Nothing about health, usage or settlement was assumed."}
      </p>
    );
  if (!data)
    return (
      <p role="status" className="text-sm text-fg-muted">
        Loading assignment runtime…
      </p>
    );
  const contact = data.connectionHealth.value;
  const usage = data.usageAndCost.value;
  const cell = data.resourceCell.value;
  const effects = data.artifactAndEffects.value;
  return (
    <div className="space-y-3">
      <Button size="sm" onClick={reload}>
        Refresh assignment
      </Button>
      <Part title="Signed-in contact" truth={data.connectionHealth}>
        {contact ? (
          <>
            <Facts
              rows={[
                ["Last contact", CONTACT[contact.freshness] ?? "Unknown"],
                [
                  "Last signed in",
                  contact.lastAuthenticatedAt ? <TimeText value={contact.lastAuthenticatedAt} /> : "Not seen",
                ],
              ]}
            />
            <p className="mt-2 text-sm text-fg-secondary">
              A past signed-in request does not establish an open connection, current authorization or readiness to run.
              Pruned history can read as not seen.
            </p>
          </>
        ) : null}
      </Part>
      <Part title="Usage and cost" truth={data.usageAndCost}>
        {usage ? <Usage usage={usage} /> : null}
      </Part>
      <Part title="Resource cell" truth={data.resourceCell}>
        {cell ? (
          <>
            <Facts
              rows={[
                ["Peak disk", size(cell.peakDiskBytes)],
                ["Peak memory", size(cell.peakMemoryBytes)],
                ["Peak files", count(cell.peakFileCount)],
                ["Peak processes", count(cell.peakProcessCount)],
                ["Kept diagnostics", size(cell.retainedDiagnosticBytes)],
                ["Updated", <TimeText key="u" value={cell.updatedAt} />],
              ]}
            />
            <p className="mt-2 text-sm text-fg-secondary">A stored run state does not mean the process is alive now.</p>
            <TechnicalDetails label="Cell details">
              <p className="break-all font-mono text-xs">
                {cell.cellId} · {cell.backend} · run {cell.executionState} r{cell.executionRevision} · cleanup{" "}
                {cell.cleanupState} r{cell.cleanupRevision} · backup {cell.backupState} r{cell.backupRevision}
              </p>
            </TechnicalDetails>
          </>
        ) : null}
      </Part>
      <Part title="Outputs and effects" truth={data.artifactAndEffects}>
        {effects ? (
          <Facts
            rows={[
              ["Uploads", count(effects.uploadCount)],
              ["Saved uploads", count(effects.committedUploadCount)],
              ["Held back uploads", count(effects.quarantinedUploadCount)],
              ["Files listed", count(effects.manifestFileCount)],
              ["Listed size", size(effects.manifestTotalBytes)],
              ["Effect receipts", count(effects.effectReceiptCount)],
            ]}
          />
        ) : null}
        <p className="mt-2 text-sm text-fg-secondary">Receipt counts do not mean an effect finished.</p>
        <NativeOutputDownloads key={`${data.assignmentId}:${data.assignmentGeneration}`} runtime={data} />
      </Part>
    </div>
  );
}
