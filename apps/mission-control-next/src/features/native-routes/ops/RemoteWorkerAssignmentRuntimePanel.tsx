import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  RemoteWorkerAssignmentProjection,
  RemoteWorkerAssignmentRuntime,
  RemoteWorkerTruth,
} from "@goatcitadel/contracts";
import { fetchRemoteWorkerAssignmentRuntime } from "@goatcitadel/mission-control-shared/api/remote-workers";
import { NativeButton, NoticeBanner } from "../primitives";

const number = (value: number | null | undefined) =>
  value === null || value === undefined ? "Unavailable" : value.toLocaleString();
const bytes = (value: number | null | undefined) =>
  value === null || value === undefined ? "Unavailable" : number(value) + " bytes";
const usd = (value: number | undefined) =>
  value === undefined
    ? "Unavailable"
    : new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(value);
function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="mc-next-remote-workers__fact-grid">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
function TruthSection({
  title,
  truth,
  children,
}: {
  title: string;
  truth: RemoteWorkerTruth<unknown>;
  children: ReactNode;
}) {
  return (
    <section className="mc-next-worker-runtime-section">
      <h3>{title}</h3>
      <p className="mc-next-help-text">
        {truth.authorityClass.replaceAll("_", " ")} · observed {truth.observedAt}
        <small>Source: {truth.owner}</small>
      </p>
      {truth.value === null ? <p>{title} unavailable.</p> : children}
    </section>
  );
}

/** Render retained canonical evidence only for the exact selected generation. */
export function RemoteWorkerAssignmentRuntimePanel({
  workspaceId,
  assignment,
  refreshKey,
}: {
  workspaceId: string;
  assignment: RemoteWorkerAssignmentProjection;
  refreshKey?: string;
}) {
  const identity = assignment.identity.value;
  const key = [
    workspaceId,
    assignment.assignmentId,
    identity?.assignmentGeneration,
    identity?.workerId,
    identity?.workerGeneration,
  ].join(":");
  const [state, setState] = useState<{ key: string; data: RemoteWorkerAssignmentRuntime | null; error: string | null }>(
    { key, data: null, error: null },
  );
  const [attempt, setAttempt] = useState(0);
  const sequence = useRef(0);
  useEffect(() => {
    const requestId = ++sequence.current;
    setState({ key, data: null, error: null });
    void fetchRemoteWorkerAssignmentRuntime(workspaceId, assignment.assignmentId)
      .then((result) => {
        if (sequence.current !== requestId) return;
        if (
          result.workspaceId !== workspaceId ||
          result.assignmentId !== assignment.assignmentId ||
          result.assignmentGeneration !== (identity?.assignmentGeneration ?? null) ||
          result.workerId !== (identity?.workerId ?? null) ||
          result.workerGeneration !== (identity?.workerGeneration ?? null)
        ) {
          setState({
            key,
            data: null,
            error: "Assignment identity changed. Refresh the worker before inspecting this generation.",
          });
          return;
        }
        setState({ key, data: result, error: null });
      })
      .catch(() => {
        if (sequence.current === requestId)
          setState({
            key,
            data: null,
            error: "Assignment runtime evidence is unavailable. No health, usage, or settlement was inferred.",
          });
      });
    return () => {
      sequence.current = requestId + 1;
    };
  }, [
    workspaceId,
    assignment.assignmentId,
    identity?.assignmentGeneration,
    identity?.workerId,
    identity?.workerGeneration,
    key,
    refreshKey,
    attempt,
  ]);
  const data = state.key === key ? state.data : null;
  const error = state.key === key ? state.error : null;
  const usage = data?.usageAndCost.value;
  const cell = data?.resourceCell.value;
  const effects = data?.artifactAndEffects.value;
  const contact = data?.connectionHealth.value;
  return (
    <div className="mc-next-worker-runtime" aria-label="Assignment runtime evidence">
      <NativeButton variant="outline" onClick={() => setAttempt((value) => value + 1)}>
        Refresh assignment evidence
      </NativeButton>
      {error ? (
        <NoticeBanner tone="error" message={error} />
      ) : !data ? (
        <p role="status">Loading assignment runtime evidence…</p>
      ) : (
        <>
          <Facts
            rows={[
              ["Assignment", data.assignmentId],
              ["Assignment generation", number(data.assignmentGeneration)],
              ["Worker", data.workerId ?? "Unavailable"],
              ["Worker generation", number(data.workerGeneration)],
              ["Observed", data.observedAt],
            ]}
          />
          <TruthSection title="Authenticated contact" truth={data.connectionHealth}>
            {contact ? (
              <>
                <Facts
                  rows={[
                    [
                      "Observation",
                      contact.freshness === "not_observed"
                        ? "Not observed in retained authentication history"
                        : contact.freshness === "recent"
                          ? "Recent authenticated request"
                          : "Stale authenticated request",
                    ],
                    ["Last authenticated", contact.lastAuthenticatedAt ?? "Not observed"],
                    ["Evaluated", contact.evaluatedAt],
                    ["Stale after", contact.staleAfter ?? "Unavailable"],
                    ["Recent window", number(contact.recentWindowMs) + " ms"],
                    ["Connection", "Unavailable"],
                    ["Basis", contact.basis],
                    ["Retention", contact.retention],
                  ]}
                />
                <p>
                  A past authenticated request does not establish an open connection, current authorization, or
                  execution readiness. Pruned history can become not observed.
                </p>
              </>
            ) : null}
          </TruthSection>
          <TruthSection title="Usage and cost" truth={data.usageAndCost}>
            {usage ? (
              <>
                <Facts
                  rows={[
                    ["Provider attempts", number(usage.usage.attemptCount)],
                    ["Uncertain dispatches", number(usage.usage.uncertainDispatchCount)],
                    ["Tracked attempts", number(usage.usage.trackedAttemptCount)],
                    ["Unknown attempts", number(usage.usage.unknownAttemptCount)],
                    ...(["inputTokens", "outputTokens", "cachedInputTokens", "costUsd"] as const).map((metric) => {
                      const coverage = usage.usage.metricAvailability[metric];
                      const label = {
                        inputTokens: "Input tokens",
                        outputTokens: "Output tokens",
                        cachedInputTokens: "Cached input tokens",
                        costUsd: "Recorded cost (USD)",
                      }[metric];
                      const value = metric === "costUsd" ? usd(usage.usage[metric]) : number(usage.usage[metric]);
                      return [
                        label,
                        <>
                          {value}
                          {!coverage.complete ? " · incomplete" : ""}
                          <small>
                            {number(coverage.knownAttemptCount)} known / {number(coverage.unknownAttemptCount)} unknown
                            attempts
                          </small>
                        </>,
                      ] as [string, ReactNode];
                    }),
                    ["Outstanding holds", number(usage.pendingReservations)],
                    ["Reserved requests", number(usage.reservedRequests)],
                    [
                      "Reserved cost",
                      usd(usage.reservedCostMicrousd / 1_000_000) +
                        " (" +
                        number(usage.reservedCostMicrousd) +
                        " microUSD)",
                    ],
                  ]}
                />
                <p>
                  Incomplete recorded cost is a lower bound. Reserved amounts are outstanding holds, not a final bill.
                </p>
              </>
            ) : null}
          </TruthSection>
          <TruthSection title="Resource cell" truth={data.resourceCell}>
            {cell ? (
              <>
                <Facts
                  rows={[
                    ["Cell", cell.cellId],
                    ["Backend", cell.backend],
                    ["Retained execution state", cell.executionState],
                    ["Execution revision", number(cell.executionRevision)],
                    ["Cleanup state", cell.cleanupState],
                    ["Cleanup revision", number(cell.cleanupRevision)],
                    ["Backup state", cell.backupState],
                    ["Backup revision", number(cell.backupRevision)],
                    ["Updated", cell.updatedAt],
                    ["Peak disk", bytes(cell.peakDiskBytes)],
                    ["Peak memory", bytes(cell.peakMemoryBytes)],
                    ["Peak files", number(cell.peakFileCount)],
                    ["Peak processes", number(cell.peakProcessCount)],
                    ["Retained diagnostics", bytes(cell.retainedDiagnosticBytes)],
                    ["Failed cleanup retained", bytes(cell.failedCleanupRetainedBytes)],
                    ["Quarantine retained", bytes(cell.quarantineRetainedBytes)],
                  ]}
                />
                <p>Stored execution state does not establish current process liveness.</p>
                <details>
                  <summary>Capacity reservation</summary>
                  <Facts
                    rows={[
                      ["Schema", cell.capacity.schemaVersion],
                      ["Logical disk", bytes(cell.capacity.logicalDiskBytes)],
                      ["Allocated disk", bytes(cell.capacity.allocatedDiskBytes)],
                      ["Files", number(cell.capacity.fileLimit)],
                      ["Inodes", number(cell.capacity.inodeLimit)],
                      ["Processes", number(cell.capacity.processLimit)],
                      ["CPU limit", number(cell.capacity.cpuLimitMilli) + " milliCPU"],
                      ["Wall time", number(cell.capacity.wallLimitMs) + " ms"],
                      ["Memory", bytes(cell.capacity.memoryLimitBytes)],
                      ["Raw output", bytes(cell.capacity.rawOutputLimitBytes)],
                      ["Diagnostics", bytes(cell.capacity.diagnosticLimitBytes)],
                      ["Artifact ceiling", bytes(cell.capacity.artifactCeilingBytes)],
                      ["Backup staging", bytes(cell.capacity.backupStagingBytes)],
                      ["Backup publication", bytes(cell.capacity.backupPublicationBytes)],
                    ]}
                  />
                </details>
              </>
            ) : null}
          </TruthSection>
          <TruthSection title="Artifacts and effects" truth={data.artifactAndEffects}>
            {effects ? (
              <Facts
                rows={[
                  ["Uploads", number(effects.uploadCount)],
                  ["Committed uploads", number(effects.committedUploadCount)],
                  ["Quarantined uploads", number(effects.quarantinedUploadCount)],
                  ["Cleanup pending", number(effects.cleanupPendingCount)],
                  ["Manifest files", number(effects.manifestFileCount)],
                  ["Manifest bytes", bytes(effects.manifestTotalBytes)],
                  ["Artifact verification", effects.verificationState ?? "Unavailable"],
                  ["Effect intents", number(effects.effectIntentCount)],
                  ["Effect receipts", number(effects.effectReceiptCount)],
                  ["Effect reconciliations", number(effects.effectReconciliationCount)],
                ]}
              />
            ) : null}
            <p>Receipt counts do not establish successful effect settlement.</p>
          </TruthSection>
        </>
      )}
    </div>
  );
}
