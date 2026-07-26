import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  RemoteWorkerAssignmentEventPage,
  RemoteWorkerAssignmentPage,
  RemoteWorkerAssignmentProjection,
  RemoteWorkerReconciliation,
  RemoteWorkerReconciliationObservation,
  RemoteWorkerRegistryDetail,
  RemoteWorkerRegistryItem,
  RemoteWorkerTruth,
} from "@goatcitadel/contracts";
import {
  fetchRemoteWorkerAssignmentEvents,
  fetchRemoteWorkerAssignments,
  fetchRemoteWorkerDetail,
  fetchRemoteWorkerReconciliation,
} from "@goatcitadel/mission-control-shared/api/remote-workers";
import { useRemoteWorkerRegistry } from "@goatcitadel/mission-control-shared/hooks/useRemoteWorkerRegistry";
import { NativePageFrame } from "../NativeRoutePageLayout";
import { EmptyState, ErrorState, NativeButton, StatusChip, type StatusChipTone } from "../primitives";
import type { NativeRoutePagesProps } from "../types";
import {
  REMOTE_WORKER_REALTIME_COALESCE_MS,
  RemoteWorkerRealtimeCursor,
  subscribeRemoteWorkerRealtime,
} from "../../../app/remote-worker-realtime";
import "./remote-workers.css";

const AUTHORITY_LABEL: Record<string, string> = {
  canonical_record: "Canonical",
  derived_projection: "Projected",
  retained_signal: "Retained",
  unavailable: "Unavailable",
};

function TruthTag({ authority }: { authority: string }) {
  return (
    <span className="mc-next-remote-workers__truth" data-authority={authority}>
      {AUTHORITY_LABEL[authority] ?? authority}
    </span>
  );
}

function shortId(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 12)}…`;
}

function postureTone(posture: string | null): StatusChipTone {
  if (posture === "active") return "success";
  if (posture === "quarantined") return "warning";
  if (posture === "revoked") return "critical";
  return "muted";
}

function phaseTone(phase: string | null): StatusChipTone {
  if (phase === "settled") return "success";
  if (phase === "leased") return "live";
  if (phase === "lease_expired" || phase === "cancelling") return "warning";
  return "muted";
}

function observationTone(status: string): StatusChipTone {
  if (status === "consistent") return "success";
  if (status === "divergent") return "warning";
  return "muted";
}

function DigestReveal({ label, digest }: { label: string; digest: string }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="mc-next-remote-workers__digest">
      <span>{revealed ? digest : `${digest.slice(0, 10)}…`}</span>
      <NativeButton
        variant="ghost"
        onClick={() => setRevealed((prev) => !prev)}
        aria-label={`${revealed ? "Hide" : "Reveal"} the full ${label} digest`}
      >
        {revealed ? "Hide" : "Reveal"}
      </NativeButton>
    </div>
  );
}

function WorkerRow({
  item,
  selected,
  onSelect,
}: {
  item: RemoteWorkerRegistryItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const admission = item.admission.value;
  const posture = item.posture.value;
  return (
    <button type="button" className="mc-next-remote-workers__worker" aria-current={selected} onClick={onSelect}>
      <span className="mc-next-remote-workers__worker-title">
        <h3>{admission ? admission.workerLabel : shortId(item.workerId)}</h3>
        <StatusChip tone={postureTone(posture)}>{posture ?? "unknown"}</StatusChip>
      </span>
      <span className="mc-next-remote-workers__facts">
        <span>{shortId(item.workerId)}</span>
        {admission ? <span>gen {admission.workerGeneration}</span> : null}
        {admission ? <span>{admission.capabilityClassCount} capabilities</span> : null}
        <span>Health unavailable</span>
        <span>Usage unavailable</span>
      </span>
    </button>
  );
}

function IdentityCard({ item }: { item: RemoteWorkerRegistryItem }) {
  const admission = item.admission.value;
  if (!admission) return null;
  return (
    <section className="mc-next-remote-workers__section" aria-label="Identity">
      <h3>
        Identity <TruthTag authority={item.admission.authorityClass} />
      </h3>
      <dl className="mc-next-remote-workers__fact-grid">
        <dt>Worker</dt>
        <dd>{admission.workerId}</dd>
        <dt>Node</dt>
        <dd>{admission.nodeId}</dd>
        <dt>Generation</dt>
        <dd>{admission.workerGeneration}</dd>
        <dt>Platform</dt>
        <dd>
          {admission.platform} · {admission.architecture}
        </dd>
        <dt>Workspaces</dt>
        <dd>{admission.allowedWorkspaceCount}</dd>
        <dt>Capabilities</dt>
        <dd>{admission.capabilityClassCount}</dd>
        <dt>Admitted</dt>
        <dd>{admission.admittedAt}</dd>
        <dt>Public key</dt>
        <dd>
          <DigestReveal label="public key" digest={admission.publicKeySpkiSha256} />
        </dd>
        <dt>Certificate</dt>
        <dd>
          <DigestReveal label="client certificate" digest={admission.clientCertificateSha256} />
        </dd>
        <dt>Runtime manifest</dt>
        <dd>
          <DigestReveal label="runtime manifest" digest={admission.runtimeManifestSha256} />
        </dd>
      </dl>
    </section>
  );
}

function ControlsCard({ item }: { item: RemoteWorkerRegistryItem }) {
  const control = item.control.value;
  return (
    <section className="mc-next-remote-workers__section" aria-label="Controls">
      <h3>
        Controls <TruthTag authority={item.control.authorityClass} />
      </h3>
      <p className="mc-next-remote-workers__facts">
        <StatusChip tone={postureTone(item.posture.value)}>{item.posture.value ?? "unknown"}</StatusChip>
      </p>
      {control ? (
        <dl className="mc-next-remote-workers__fact-grid">
          <dt>Action</dt>
          <dd>{control.action}</dd>
          <dt>Control revision</dt>
          <dd>{control.controlRevision}</dd>
          <dt>Recorded</dt>
          <dd>{control.createdAt}</dd>
        </dl>
      ) : (
        <p className="mc-next-remote-workers__unavailable">
          No containment control is recorded. Rotation, quarantine, and revoke stay under live authority in Ops.
        </p>
      )}
    </section>
  );
}

function AssignmentCard({
  assignment,
  expanded,
  events,
  onToggle,
}: {
  assignment: RemoteWorkerAssignmentProjection;
  expanded: boolean;
  events: RemoteWorkerAssignmentEventPage | "error" | undefined;
  onToggle: () => void;
}) {
  const lease = assignment.lease.value;
  const freshness = assignment.leaseFreshness.value;
  const control = assignment.control.value;
  const settlement = assignment.settlement.value;
  const materialization = assignment.materialization.value;
  const lineage = assignment.lineage.value;
  return (
    <article className="mc-next-remote-workers__assignment">
      <div className="mc-next-remote-workers__assignment-head">
        <strong>{shortId(assignment.assignmentId)}</strong>
        <StatusChip tone={phaseTone(assignment.phase.value)}>{assignment.phase.value ?? "unknown"}</StatusChip>
      </div>
      <dl className="mc-next-remote-workers__fact-grid">
        {lineage?.sessionId ? (
          <>
            <dt>Session</dt>
            <dd>{shortId(lineage.sessionId)}</dd>
          </>
        ) : null}
        {lineage?.turnId ? (
          <>
            <dt>Turn</dt>
            <dd>{shortId(lineage.turnId)}</dd>
          </>
        ) : null}
        {lease ? (
          <>
            <dt>Lease revision</dt>
            <dd>{lease.leaseRevision}</dd>
            <dt>Watermarks</dt>
            <dd>
              sent {lease.workerSentThrough} · acked {lease.serverAcknowledgedThrough}
            </dd>
            <dt>Lease</dt>
            <dd>{freshness?.fresh ? "fresh" : "expired"}</dd>
          </>
        ) : null}
        {control ? (
          <>
            <dt>Control</dt>
            <dd>
              {control.action} · rev {control.controlRevision}
            </dd>
          </>
        ) : null}
        {settlement ? (
          <>
            <dt>Settlement</dt>
            <dd>
              {settlement.outcome} · {settlement.origin}
            </dd>
          </>
        ) : null}
        {materialization ? (
          <>
            <dt>Materialization</dt>
            <dd>
              {materialization.count} ({materialization.chatTranscriptCount} chat ·{" "}
              {materialization.durableRunResultCount} run)
            </dd>
          </>
        ) : null}
      </dl>
      <NativeButton variant="outline" onClick={onToggle} aria-expanded={expanded}>
        {expanded ? "Hide events" : "Show events"}
      </NativeButton>
      {expanded ? (
        <div className="mc-next-remote-workers__events">
          {events === undefined ? (
            <p role="status">Loading event summaries…</p>
          ) : events === "error" ? (
            <p role="alert">Event summaries are unavailable.</p>
          ) : events.items.length === 0 ? (
            <p>No events for the current generation.</p>
          ) : (
            <>
              <ul>
                {events.items.map((event) => (
                  <li key={event.eventId}>
                    #{event.sequence} {event.eventType} · sent-through {event.workerSentThrough}
                  </li>
                ))}
              </ul>
              <p className="mc-next-remote-workers__unavailable">
                Omitted bodies — transcript deltas {events.omitted.transcriptDeltas}, terminal output{" "}
                {events.omitted.terminalOutputs}, diagnostics {events.omitted.diagnostics}.
              </p>
            </>
          )}
        </div>
      ) : null}
    </article>
  );
}

function ReconciliationRow({
  label,
  truth,
}: {
  label: string;
  truth: RemoteWorkerTruth<RemoteWorkerReconciliationObservation>;
}) {
  const observation = truth.value;
  return (
    <div className="mc-next-remote-workers__facts">
      <StatusChip tone={observation ? observationTone(observation.status) : "muted"}>
        {observation ? observation.status : "unavailable"}
      </StatusChip>
      <span>
        <strong>{label}:</strong> {observation ? observation.summary : "Owner unavailable."}
      </span>
      <TruthTag authority={truth.authorityClass} />
    </div>
  );
}

function ReconciliationCard({ reconciliation }: { reconciliation: RemoteWorkerReconciliation }) {
  return (
    <section className="mc-next-remote-workers__section" aria-label="Reconciliation">
      <h3>Reconciliation</h3>
      <ReconciliationRow label="Admission & control" truth={reconciliation.admissionControl} />
      <ReconciliationRow label="Assignment & lease" truth={reconciliation.assignmentLease} />
      <ReconciliationRow label="Settlement & materialization" truth={reconciliation.settlementMaterialization} />
      <div className="mc-next-remote-workers__facts">
        <TruthTag authority={reconciliation.resourceCell.authorityClass} />
        <span>Resource cell — HX-505 owner not composed in this tranche.</span>
      </div>
      <div className="mc-next-remote-workers__facts">
        <TruthTag authority={reconciliation.cleanup.authorityClass} />
        <span>Cleanup — HX-505 owner not composed in this tranche.</span>
      </div>
    </section>
  );
}

export function RemoteWorkersRoutePage(props: NativeRoutePagesProps) {
  return <RemoteWorkersWorkspaceRoutePage key={props.activeWorkspaceId} {...props} />;
}

function RemoteWorkersWorkspaceRoutePage(props: NativeRoutePagesProps) {
  const workspaceId = props.activeWorkspaceId;
  const registry = useRemoteWorkerRegistry(workspaceId);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [detailScope, setDetailScope] = useState<{ workspaceId: string; workerId: string } | null>(null);
  const [detail, setDetail] = useState<RemoteWorkerRegistryDetail | null>(null);
  const [assignments, setAssignments] = useState<RemoteWorkerAssignmentPage | null>(null);
  const [reconciliation, setReconciliation] = useState<RemoteWorkerReconciliation | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [expandedAssignment, setExpandedAssignment] = useState<string | null>(null);
  const [eventPages, setEventPages] = useState<Record<string, RemoteWorkerAssignmentEventPage | "error">>({});
  const detailSequenceRef = useRef(0);

  const loadDetail = useCallback(
    async (workerId: string) => {
      const loadId = detailSequenceRef.current + 1;
      detailSequenceRef.current = loadId;
      setDetailScope({ workspaceId, workerId });
      setDetail(null);
      setAssignments(null);
      setReconciliation(null);
      setDetailLoading(true);
      setDetailError(null);
      const [detailResult, assignmentResult, reconciliationResult] = await Promise.allSettled([
        fetchRemoteWorkerDetail(workspaceId, workerId),
        fetchRemoteWorkerAssignments(workspaceId, { workerId, limit: 50 }),
        fetchRemoteWorkerReconciliation(workspaceId, workerId),
      ]);
      if (detailSequenceRef.current !== loadId) return;
      setDetail(detailResult.status === "fulfilled" ? detailResult.value : null);
      setAssignments(assignmentResult.status === "fulfilled" ? assignmentResult.value : null);
      setReconciliation(reconciliationResult.status === "fulfilled" ? reconciliationResult.value : null);
      setDetailError(detailResult.status === "rejected" ? "This worker's detail is unavailable." : null);
      setDetailLoading(false);
    },
    [workspaceId],
  );

  useEffect(() => {
    if (!selectedWorkerId) {
      setDetailScope(null);
      setDetail(null);
      setAssignments(null);
      setReconciliation(null);
      setDetailLoading(false);
      setDetailError(null);
      setExpandedAssignment(null);
      setEventPages({});
      return;
    }
    setExpandedAssignment(null);
    setEventPages({});
    void loadDetail(selectedWorkerId);
    return () => {
      detailSequenceRef.current += 1;
    };
  }, [selectedWorkerId, loadDetail]);

  // Synced-ref pattern: the realtime effect below reads the freshest reload
  // callbacks and selection without re-subscribing on every render.
  const registryReloadRef = useRef(registry.reload);
  const loadDetailRef = useRef(loadDetail);
  const selectedRef = useRef(selectedWorkerId);
  useEffect(() => {
    registryReloadRef.current = registry.reload;
    loadDetailRef.current = loadDetail;
    selectedRef.current = selectedWorkerId;
  }, [registry.reload, loadDetail, selectedWorkerId]);

  useEffect(() => {
    const cursor = new RemoteWorkerRealtimeCursor();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pendingDetail = false;
    const flush = () => {
      timer = null;
      void registryReloadRef.current();
      const selected = selectedRef.current;
      if (pendingDetail && selected) void loadDetailRef.current(selected);
      pendingDetail = false;
    };
    const unsubscribe = subscribeRemoteWorkerRealtime((signal) => {
      if (signal.kind === "change" && signal.workspaceId !== workspaceId) return;
      const decision = cursor.decide(signal);
      if (!decision.reload) return;
      if (
        signal.kind === "replay_gap" ||
        signal.entity === "assignment" ||
        (signal.entity === "worker" && signal.entityId === selectedRef.current)
      ) {
        pendingDetail = true;
      }
      if (timer === null) timer = setTimeout(flush, REMOTE_WORKER_REALTIME_COALESCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
      cursor.reset();
    };
  }, [workspaceId]);

  useEffect(() => {
    if (!expandedAssignment) return;
    let cancelled = false;
    void (async () => {
      try {
        const page = await fetchRemoteWorkerAssignmentEvents(workspaceId, expandedAssignment, { limit: 50 });
        if (!cancelled) setEventPages((prev) => ({ ...prev, [expandedAssignment]: page }));
      } catch {
        if (!cancelled) setEventPages((prev) => ({ ...prev, [expandedAssignment]: "error" }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expandedAssignment, workspaceId]);

  const toggleAssignment = useCallback((assignmentId: string) => {
    setExpandedAssignment((prev) => (prev === assignmentId ? null : assignmentId));
  }, []);

  const items = useMemo(() => registry.page?.items ?? [], [registry.page]);
  const detailMatchesSelection = detailScope?.workspaceId === workspaceId && detailScope.workerId === selectedWorkerId;
  const visibleDetail = detailMatchesSelection ? detail : null;
  const visibleAssignments = detailMatchesSelection ? assignments : null;
  const visibleReconciliation = detailMatchesSelection ? reconciliation : null;
  const visibleDetailError = detailMatchesSelection ? detailError : null;
  const selectedItem = useMemo(
    () => visibleDetail?.item ?? items.find((item) => item.workerId === selectedWorkerId) ?? null,
    [items, selectedWorkerId, visibleDetail],
  );

  return (
    <NativePageFrame
      area="ops"
      kicker="Observe"
      title="Remote workers"
      description="Operator-visible remote-worker registry, assignments, events, and reconciliation."
      loading={registry.loading && !registry.page}
      error={null}
    >
      <div className="mc-next-remote-workers" data-has-selection={selectedWorkerId ? "true" : "false"}>
        <section
          className="mc-next-remote-workers__registry"
          aria-label="Remote worker registry"
          aria-busy={registry.loading}
        >
          <h2>Registry</h2>
          {registry.error ? (
            <ErrorState title="Registry unavailable" description={registry.error} />
          ) : items.length === 0 && !registry.loading ? (
            <EmptyState title="No remote workers" description="No workers have been admitted to this workspace yet." />
          ) : (
            items.map((item) => (
              <WorkerRow
                key={item.workerId}
                item={item}
                selected={item.workerId === selectedWorkerId}
                onSelect={() => setSelectedWorkerId(item.workerId)}
              />
            ))
          )}
        </section>

        <section className="mc-next-remote-workers__detail" aria-label="Remote worker detail" aria-busy={detailLoading}>
          {selectedWorkerId ? (
            <>
              <NativeButton
                className="mc-next-remote-workers__back"
                variant="ghost"
                onClick={() => setSelectedWorkerId(null)}
              >
                ← Back to registry
              </NativeButton>
              <h2>{selectedItem?.admission.value?.workerLabel ?? shortId(selectedWorkerId)}</h2>
              {visibleDetailError ? (
                <ErrorState title="Detail unavailable" description={visibleDetailError} size="inline" />
              ) : null}
              {selectedItem ? <IdentityCard item={selectedItem} /> : null}
              {selectedItem ? <ControlsCard item={selectedItem} /> : null}

              <section className="mc-next-remote-workers__section" aria-label="Assignments">
                <h3>Assignments</h3>
                {visibleAssignments === null ? (
                  <p className="mc-next-remote-workers__unavailable">Assignments are loading or unavailable.</p>
                ) : visibleAssignments.items.length === 0 ? (
                  <p className="mc-next-remote-workers__unavailable">No assignments reference this worker.</p>
                ) : (
                  visibleAssignments.items.map((assignment) => (
                    <AssignmentCard
                      key={assignment.assignmentId}
                      assignment={assignment}
                      expanded={expandedAssignment === assignment.assignmentId}
                      events={eventPages[assignment.assignmentId]}
                      onToggle={() => toggleAssignment(assignment.assignmentId)}
                    />
                  ))
                )}
              </section>

              {visibleReconciliation ? <ReconciliationCard reconciliation={visibleReconciliation} /> : null}

              <section className="mc-next-remote-workers__section" aria-label="Usage and diagnostics">
                <h3>Usage & diagnostics</h3>
                <p className="mc-next-remote-workers__unavailable">
                  Usage and cost (HX-503) and bounded diagnostics are not composed in this visibility tranche. No cost
                  or health is inferred from absent evidence.
                </p>
              </section>
            </>
          ) : (
            <EmptyState
              title="Select a worker"
              description="Choose a remote worker to inspect its identity, assignments, and reconciliation."
            />
          )}
        </section>
      </div>
    </NativePageFrame>
  );
}
