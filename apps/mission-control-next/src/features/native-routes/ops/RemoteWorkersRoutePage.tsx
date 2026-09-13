import { RecordEvidence as WorkerRecordEvidence } from "../shared/RecordEvidence";
import { DetailInspector } from "../../../components/DetailInspector";
import { FocusedDetail } from "../shared/FocusedDetail";
import { useDraftLeave } from "../library/DraftLeaveDialog";
import { hasSessionDraft, useSessionDraftVersion } from "../library/session-drafts";
import { RemoteWorkerAssignmentRuntimePanel } from "./RemoteWorkerAssignmentRuntimePanel";
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
import { routeKicker } from "@next/app/route-model";
import { NativePageFrame } from "../NativeRoutePageLayout";
import { EmptyState, ErrorState, NativeButton, StatusChip, type StatusChipTone } from "../primitives";
import type { NativeRoutePagesProps } from "../types";
import {
  REMOTE_WORKER_REALTIME_COALESCE_MS,
  RemoteWorkerRealtimeCursor,
  subscribeRemoteWorkerRealtime,
} from "../../../app/remote-worker-realtime";
import "./remote-workers.css";
import { RemoteWorkerBudgetPanel } from "./RemoteWorkerBudgetPanel";

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
        <span>Inspect assignment usage</span>
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
      <details>
        <summary>Admission and provenance record</summary>
        <WorkerRecordEvidence value={item} />
      </details>
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
}: {
  assignment: RemoteWorkerAssignmentProjection;
  expanded: boolean;
  events: RemoteWorkerAssignmentEventPage | "error" | undefined;
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
            <dd>{freshness ? (freshness.fresh ? "fresh" : "expired") : "unavailable"}</dd>
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
      <h3>Retained event summaries</h3>
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
        <span>
          Resource cell reconciliation is unavailable. Stored cell evidence is available from assignment details.
        </span>
      </div>
      <div className="mc-next-remote-workers__facts">
        <TruthTag authority={reconciliation.cleanup.authorityClass} />
        <span>Cleanup reconciliation is unavailable. Inspect retained cleanup state from its assignment.</span>
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
  const leave = useDraftLeave();
  const [workerPanel, setWorkerPanel] = useState<"identity" | "budget" | null>(null);
  const openWorkerPanel = (panel: "identity" | "budget") =>
    leave.request(() => {
      setExpandedAssignment(null);
      setWorkerPanel(panel);
    });
  useSessionDraftVersion();
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
  const eventSequence = useRef(0);
  const eventBusy = useRef(false);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [eventError, setEventError] = useState<string | null>(null);
  const assignmentPageCount = useRef(1);
  const [moreAssignmentsBusy, setMoreAssignmentsBusy] = useState(false);
  const [moreAssignmentsError, setMoreAssignmentsError] = useState<string | null>(null);
  const moreAssignmentsLock = useRef(false);
  const loadAssignmentPages = useCallback(
    async (workerId: string) => {
      let result = await fetchRemoteWorkerAssignments(workspaceId, { workerId, limit: 50 });
      const rows = new Map(result.items.map((item) => [item.assignmentId, item]));
      const seen = new Set<string>();
      for (let page = 1; page < assignmentPageCount.current && result.nextCursor; page++) {
        const cursor = result.nextCursor;
        if (seen.has(cursor)) throw new Error("Assignment cursor repeated");
        seen.add(cursor);
        const next = await fetchRemoteWorkerAssignments(workspaceId, { workerId, limit: 50, cursor });
        next.items.forEach((item) => rows.set(item.assignmentId, item));
        result = { ...next, items: [...rows.values()] };
      }
      return result;
    },
    [workspaceId],
  );

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
        loadAssignmentPages(workerId),
        fetchRemoteWorkerReconciliation(workspaceId, workerId),
      ]);
      if (detailSequenceRef.current !== loadId) return;
      setDetail(detailResult.status === "fulfilled" ? detailResult.value : null);
      setAssignments(assignmentResult.status === "fulfilled" ? assignmentResult.value : null);
      setReconciliation(reconciliationResult.status === "fulfilled" ? reconciliationResult.value : null);
      setDetailError(detailResult.status === "rejected" ? "This worker's detail is unavailable." : null);
      setDetailLoading(false);
    },
    [workspaceId, loadAssignmentPages],
  );

  const loadMoreAssignments = async () => {
    if (!selectedWorkerId || !assignments?.nextCursor || moreAssignmentsLock.current || detailLoading) return;
    const id = detailSequenceRef.current;
    const current = assignments;
    moreAssignmentsLock.current = true;
    setMoreAssignmentsBusy(true);
    setMoreAssignmentsError(null);
    try {
      const next = await fetchRemoteWorkerAssignments(workspaceId, {
        workerId: selectedWorkerId,
        limit: 50,
        cursor: current.nextCursor,
      });
      if (id !== detailSequenceRef.current) return;
      if (next.nextCursor === current.nextCursor) throw new Error("Assignment cursor repeated");
      const rows = new Map(current.items.map((item) => [item.assignmentId, item]));
      next.items.forEach((item) => rows.set(item.assignmentId, item));
      assignmentPageCount.current++;
      setAssignments({ ...next, items: [...rows.values()] });
    } catch {
      if (id === detailSequenceRef.current)
        setMoreAssignmentsError("Additional assignments are unavailable. Retry to continue from the loaded records.");
    } finally {
      moreAssignmentsLock.current = false;
      if (id === detailSequenceRef.current) setMoreAssignmentsBusy(false);
    }
  };

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
    assignmentPageCount.current = 1;
    setMoreAssignmentsBusy(false);
    setMoreAssignmentsError(null);
    setExpandedAssignment(null);
    setWorkerPanel(null);
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

  const expandedIdentity = assignments?.items.find((item) => item.assignmentId === expandedAssignment)?.identity.value;
  useEffect(() => {
    const lifecycle = eventSequence;
    const sequence = ++lifecycle.current;
    eventBusy.current = false;
    setLoadingEvents(false);
    setEventError(null);
    if (!expandedAssignment || expandedIdentity?.assignmentGeneration === undefined) return;
    setEventPages((prev) => {
      const next = { ...prev };
      delete next[expandedAssignment];
      return next;
    });
    let cancelled = false;
    void (async () => {
      try {
        const page = await fetchRemoteWorkerAssignmentEvents(workspaceId, expandedAssignment, { limit: 50 });
        if (
          page.workspaceId !== workspaceId ||
          page.assignmentId !== expandedAssignment ||
          page.assignmentGeneration !== expandedIdentity.assignmentGeneration
        )
          throw new Error("Event generation changed");
        if (!cancelled) setEventPages((prev) => ({ ...prev, [expandedAssignment]: page }));
      } catch {
        if (!cancelled) setEventPages((prev) => ({ ...prev, [expandedAssignment]: "error" }));
      }
    })();
    return () => {
      cancelled = true;
      if (lifecycle.current === sequence) lifecycle.current++;
    };
  }, [expandedAssignment, expandedIdentity?.assignmentGeneration, assignments?.observedAt, workspaceId]);

  const loadNewerEvents = async () => {
    const current = expandedAssignment ? eventPages[expandedAssignment] : undefined;
    if (
      !expandedAssignment ||
      !current ||
      current === "error" ||
      current.nextAfterSequence === undefined ||
      eventBusy.current
    )
      return;
    const sequence = eventSequence.current;
    eventBusy.current = true;
    setLoadingEvents(true);
    setEventError(null);
    try {
      const next = await fetchRemoteWorkerAssignmentEvents(workspaceId, expandedAssignment, {
        limit: 50,
        afterSequence: current.nextAfterSequence,
      });
      if (sequence !== eventSequence.current) return;
      if (next.assignmentGeneration !== current.assignmentGeneration) throw new Error("Event generation changed");
      const rows = new Map(current.items.map((item) => [item.sequence, item]));
      next.items.forEach((item) => rows.set(item.sequence, item));
      setEventPages((prev) => ({ ...prev, [expandedAssignment]: { ...next, items: [...rows.values()] } }));
    } catch {
      if (sequence === eventSequence.current)
        setEventError("Additional event summaries are unavailable. Loaded evidence remains available.");
    } finally {
      if (sequence === eventSequence.current) {
        eventBusy.current = false;
        setLoadingEvents(false);
      }
    }
  };

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
      kicker={routeKicker(props.route)}
      title="Remote workers"
      description="Operator-visible remote-worker registry, assignments, events, and reconciliation."
      loading={registry.loading && !registry.page}
      error={null}
    >
      <div className="mc-next-remote-workers" data-has-selection={selectedWorkerId ? "true" : "false"}>
        {!selectedWorkerId ? (
          <section
            className="mc-next-remote-workers__registry"
            aria-label="Remote worker registry"
            aria-busy={registry.loading}
          >
            <h2>Registry</h2>
            {registry.error ? (
              <ErrorState title="Registry unavailable" description={registry.error} />
            ) : items.length === 0 && !registry.loading ? (
              <EmptyState
                title="No remote workers"
                description="No workers have been admitted to this workspace yet."
              />
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
            {registry.moreError ? <p role="alert">{registry.moreError}</p> : null}
            {registry.page?.nextCursor ? (
              <NativeButton variant="outline" disabled={registry.loadingMore} onClick={() => void registry.loadMore()}>
                {registry.loadingMore ? "Loading workers…" : "Load more workers"}
              </NativeButton>
            ) : null}
          </section>
        ) : null}

        <section className="mc-next-remote-workers__detail" aria-label="Remote worker detail" aria-busy={detailLoading}>
          {selectedWorkerId ? (
            <FocusedDetail
              title={selectedItem?.admission.value?.workerLabel ?? shortId(selectedWorkerId)}
              onClose={() => leave.request(() => setSelectedWorkerId(null))}
            >
              <div className="mc-next-runtime-actions">
                <StatusChip tone={postureTone(selectedItem?.posture.value ?? null)}>
                  {selectedItem?.posture.value ?? "Unavailable"}
                </StatusChip>
                <NativeButton variant="outline" onClick={() => openWorkerPanel("identity")}>
                  Worker details
                </NativeButton>
                <NativeButton variant="outline" onClick={() => openWorkerPanel("budget")}>
                  Spending budgets
                  {hasSessionDraft("worker:" + workspaceId + ":" + selectedWorkerId + ":budget") ? " · Unsaved" : ""}
                </NativeButton>
                <NativeButton variant="ghost" onClick={() => void loadDetail(selectedWorkerId)}>
                  Refresh worker
                </NativeButton>
              </div>
              {visibleDetailError ? (
                <ErrorState title="Detail unavailable" description={visibleDetailError} size="inline" />
              ) : null}
              <DetailInspector
                open={workerPanel === "identity"}
                title="Worker details"
                onClose={() => setWorkerPanel(null)}
              >
                {selectedItem ? (
                  <>
                    <IdentityCard item={selectedItem} />
                    <ControlsCard item={selectedItem} />
                  </>
                ) : null}
                {visibleReconciliation ? (
                  <ReconciliationCard reconciliation={visibleReconciliation} />
                ) : (
                  <p>Reconciliation unavailable.</p>
                )}
              </DetailInspector>
              <DetailInspector
                open={workerPanel === "budget"}
                title="Spending budgets"
                onClose={() => leave.request(() => setWorkerPanel(null))}
              >
                {selectedItem ? (
                  <RemoteWorkerBudgetPanel
                    key={`${workspaceId}:${selectedItem.workerId}:${selectedItem.admission.value?.workerGeneration}`}
                    workspaceId={workspaceId}
                    worker={selectedItem}
                  />
                ) : null}
              </DetailInspector>
              <section className="mc-next-remote-workers__section" aria-label="Assignments">
                <h3>Assignments</h3>
                {visibleAssignments === null ? (
                  <p className="mc-next-remote-workers__unavailable">Assignments are loading or unavailable.</p>
                ) : visibleAssignments.items.length === 0 ? (
                  <p className="mc-next-remote-workers__unavailable">No assignments reference this worker.</p>
                ) : (
                  visibleAssignments.items.map((assignment) => (
                    <article className="mc-next-remote-workers__assignment" key={assignment.assignmentId}>
                      <div className="mc-next-remote-workers__assignment-head">
                        <strong>{shortId(assignment.assignmentId)}</strong>
                        <StatusChip tone={phaseTone(assignment.phase.value)}>
                          {assignment.phase.value ?? "unknown"}
                        </StatusChip>
                      </div>
                      <p>
                        {assignment.lineage.value?.sessionId
                          ? "Session " + shortId(assignment.lineage.value.sessionId)
                          : "Session unavailable"}
                        {assignment.settlement.value ? " · " + assignment.settlement.value.outcome : ""}
                      </p>
                      <NativeButton
                        variant="outline"
                        aria-label={"Inspect assignment " + assignment.assignmentId}
                        onClick={() =>
                          leave.request(() => {
                            setWorkerPanel(null);
                            toggleAssignment(assignment.assignmentId);
                          })
                        }
                      >
                        Assignment details
                      </NativeButton>
                    </article>
                  ))
                )}
                {moreAssignmentsError ? <p role="alert">{moreAssignmentsError}</p> : null}
                {visibleAssignments?.nextCursor ? (
                  <NativeButton
                    variant="outline"
                    disabled={moreAssignmentsBusy}
                    onClick={() => void loadMoreAssignments()}
                  >
                    {moreAssignmentsBusy ? "Loading assignments…" : "Load more assignments"}
                  </NativeButton>
                ) : null}
              </section>

              <DetailInspector
                open={Boolean(expandedAssignment)}
                title="Assignment details"
                onClose={() => setExpandedAssignment(null)}
              >
                {visibleAssignments?.items
                  .filter((assignment) => assignment.assignmentId === expandedAssignment)
                  .map((assignment) => (
                    <div key={assignment.assignmentId}>
                      <RemoteWorkerAssignmentRuntimePanel
                        workspaceId={workspaceId}
                        assignment={assignment}
                        refreshKey={visibleAssignments.observedAt}
                      />
                      <AssignmentCard assignment={assignment} expanded events={eventPages[assignment.assignmentId]} />
                      {eventError ? <p role="alert">{eventError}</p> : null}
                      <NativeButton
                        variant="outline"
                        disabled={
                          loadingEvents ||
                          !eventPages[assignment.assignmentId] ||
                          eventPages[assignment.assignmentId] === "error"
                        }
                        onClick={() => void loadNewerEvents()}
                      >
                        {loadingEvents ? "Loading summaries…" : "Load newer event summaries"}
                      </NativeButton>
                      <details>
                        <summary>Canonical assignment record</summary>
                        <WorkerRecordEvidence value={assignment} />
                      </details>
                    </div>
                  ))}
                {!visibleAssignments?.items.some((assignment) => assignment.assignmentId === expandedAssignment) ? (
                  <p>Assignment evidence is loading or unavailable.</p>
                ) : null}
              </DetailInspector>
            </FocusedDetail>
          ) : null}
        </section>
      </div>
      {leave.dialog}
    </NativePageFrame>
  );
}
