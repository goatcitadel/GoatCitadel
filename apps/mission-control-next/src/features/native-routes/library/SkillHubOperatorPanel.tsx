import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Ban, ExternalLink, RefreshCw, ShieldCheck } from "lucide-react";
import {
  createSkillHubOperatorApproval,
  fetchSkillHubOperator,
  type SkillHubOperatorAction,
  type SkillHubOperatorItem,
  type SkillHubOperatorListResponse,
} from "@goatcitadel/mission-control-shared/api/client";
import { NativeCard } from "../NativeRoutePageLayout";
import { formatDateTime, getErrorMessage, type Notice } from "../shared/native-helpers";
import {
  LibraryActionCardGrid,
  LibraryButtonRow,
  LibraryEmptyState,
  LibraryMetricGrid,
  LibraryNotice,
  LibrarySelectableList,
} from "../shared/library-primitives";

export interface SkillHubOperatorPanelProps {
  workspaceId: string;
  onOpenApproval: (approvalId: string) => void;
}

const OPERATOR_ACTIONS: Array<{ action: SkillHubOperatorAction; label: string }> = [
  { action: "install_inactive", label: "Install inactive" },
  { action: "stage_update_candidate", label: "Stage update" },
  { action: "stage_rollback_candidate", label: "Stage rollback" },
  { action: "activate", label: "Request activation" },
  { action: "revoke", label: "Request revoke" },
];

export function SkillHubOperatorPanel({ workspaceId, onOpenApproval }: SkillHubOperatorPanelProps) {
  const [loadedData, setLoadedData] = useState<SkillHubOperatorListResponse | null>(null);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busyAction, setBusyAction] = useState<SkillHubOperatorAction | null>(null);
  const loadGenerationRef = useRef(0);
  const actionGenerationRef = useRef(0);
  const data = loadedData?.workspaceId === workspaceId ? loadedData : null;

  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setError(null);
    try {
      const response = await fetchSkillHubOperator({ workspaceId, limit: 100 });
      if (loadGenerationRef.current !== generation) return;
      setLoadedData(response);
      setSelectedSnapshotId((current) =>
        response.items.some((item) => item.snapshotId === current) ? current : (response.items[0]?.snapshotId ?? ""),
      );
    } catch (loadError) {
      if (loadGenerationRef.current !== generation) return;
      setError(getErrorMessage(loadError));
    } finally {
      if (loadGenerationRef.current === generation) setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
    return () => {
      loadGenerationRef.current += 1;
    };
  }, [load]);

  useEffect(() => {
    actionGenerationRef.current += 1;
    setBusyAction(null);
    setNotice(null);
    return () => {
      actionGenerationRef.current += 1;
    };
  }, [workspaceId]);

  const selected = useMemo(
    () => data?.items.find((item) => item.snapshotId === selectedSnapshotId) ?? null,
    [data?.items, selectedSnapshotId],
  );

  const requestAction = async (operationKind: SkillHubOperatorAction) => {
    if (!selected || !selected.actions[operationKind].allowed) return;
    const actionGeneration = ++actionGenerationRef.current;
    setBusyAction(operationKind);
    setNotice(null);
    try {
      const response = await createSkillHubOperatorApproval({
        workspaceId,
        snapshotId: selected.snapshotId,
        operationKind,
      });
      if (actionGenerationRef.current !== actionGeneration) return;
      setNotice({ tone: "success", message: response.operatorMessage });
      await load();
      if (actionGenerationRef.current !== actionGeneration) return;
      onOpenApproval(response.approval.approvalId);
    } catch (actionError) {
      if (actionGenerationRef.current !== actionGeneration) return;
      setNotice({ tone: "error", message: getErrorMessage(actionError) });
    } finally {
      if (actionGenerationRef.current === actionGeneration) setBusyAction(null);
    }
  };

  return (
    <div className="mc-next-skill-hub" data-testid="skill-hub-operator-panel">
      <NativeCard
        title="Skill Hub lifecycle"
        subtitle="Review exact upstream snapshots, materialize immutable inactive candidates, then activate separately."
        stats={[
          { label: "Snapshots", value: String(data?.summary.snapshots ?? 0) },
          { label: "Candidates", value: String(data?.summary.retainedCandidates ?? 0) },
          { label: "Inactive", value: String(data?.summary.inactive ?? 0) },
          { label: "Blocked", value: String(data?.summary.blocked ?? 0) },
        ]}
      >
        {notice ? <LibraryNotice notice={notice} /> : null}
        <div className="mc-next-skill-hub-boundary" role="note">
          <ShieldCheck size={17} aria-hidden="true" />
          <span>
            Every lifecycle action creates an approval request only. Staged install, update, and rollback candidates
            stay outside callableCatalog until a separate activation settles.
          </span>
        </div>
        {loading ? <p className="mc-next-skill-hub-empty">Loading retained snapshots…</p> : null}
        {!loading && error ? (
          <div className="mc-next-skill-hub-error" role="alert">
            <span>{error}</span>
            <button type="button" className="mc-next-settings-filter" onClick={() => void load()}>
              <RefreshCw size={15} />
              Retry
            </button>
          </div>
        ) : null}
        {!loading && !error && data ? (
          <div className="mc-next-skill-hub-layout">
            <div className="mc-next-skill-hub-list">
              <LibrarySelectableList
                items={data.items.map((item) => ({
                  id: item.snapshotId,
                  title: `${item.title} · ${displayVersion(item)}`,
                  meta: item.runtime.activeVersion
                    ? candidateRuntimeLabel(item)
                    : item.snapshot.blockerCodes.length
                      ? "Blocked"
                      : candidateRuntimeLabel(item),
                  body: candidateListBody(item),
                }))}
                selectedId={selectedSnapshotId}
                onSelect={setSelectedSnapshotId}
                emptyLabel="No upstream snapshots are retained in this workspace."
                maxHeight="min(54vh, 32rem)"
              />
              <LibraryButtonRow>
                <button type="button" className="mc-next-settings-filter" onClick={() => void load()}>
                  <RefreshCw size={15} />
                  Refresh snapshots
                </button>
              </LibraryButtonRow>
              {data.page.truncated || data.page.candidateInventoryTruncated ? (
                <div className="mc-next-skill-hub-boundary" role="note">
                  <span>
                    {data.page.truncated
                      ? `Showing the newest ${data.page.returned} workspace snapshots; more are retained.`
                      : "Candidate inventory reached its safety bound; absence-dependent actions are blocked."}
                  </span>
                </div>
              ) : null}
            </div>
            {selected ? (
              <SkillHubCandidateDetail
                item={selected}
                busyAction={busyAction}
                onAction={(action) => void requestAction(action)}
                onOpenApproval={onOpenApproval}
              />
            ) : (
              <LibraryEmptyState label="Select a retained Skill Hub snapshot." />
            )}
          </div>
        ) : null}
      </NativeCard>
    </div>
  );
}

function SkillHubCandidateDetail({
  item,
  busyAction,
  onAction,
  onOpenApproval,
}: {
  item: SkillHubOperatorItem;
  busyAction: SkillHubOperatorAction | null;
  onAction: (action: SkillHubOperatorAction) => void;
  onOpenApproval: (approvalId: string) => void;
}) {
  const audit = auditSummary(item.snapshot.audit, item.snapshot.auditFloor);
  const permissionChanges = permissionDiffRows(item.snapshot.permissionDiff);
  const approval = item.latestApproval;
  return (
    <section className="mc-next-skill-hub-detail" aria-label={`${item.title} Skill Hub snapshot detail`}>
      <div className="mc-next-skill-hub-heading">
        <div>
          <span>{item.snapshot.sourceProvider}</span>
          <h3>{item.title}</h3>
          <p>{candidateDetailDescription(item)}</p>
        </div>
        <span
          className="mc-next-settings-chip"
          data-state={item.runtime.callable ? "callable" : item.runtime.activeVersion ? "active" : "inactive"}
        >
          {candidateRuntimeLabel(item)}
        </span>
      </div>
      <LibraryMetricGrid
        items={[
          {
            label: "Upstream version",
            value: displayVersion(item),
            meta: item.snapshot.resolvedVersion ?? "No resolved revision",
          },
          {
            label: "Exact digest",
            value: shortHash(item.snapshot.contentTreeSha256),
            meta: item.snapshot.digestChangedFromPrior ? "Changed from prior snapshot" : "Matches prior bytes",
          },
          {
            label: "Trust",
            value: item.snapshot.trustDisposition,
            meta: `${item.snapshot.riskLevel} risk · ${item.candidate?.lifecycleState ?? "review only"}`,
          },
          {
            label: "Runtime",
            value: item.runtime.callable ? "Callable" : item.runtime.activeVersion ? "Projected" : "Not projected",
            meta:
              item.runtime.catalogEntry?.reviewWarning ??
              item.runtime.lifecycle?.trustLabel ??
              "inspectableCatalog only",
          },
        ]}
      />
      <LibraryActionCardGrid
        items={[
          {
            id: "audit",
            label: "Audit snapshot",
            value: audit.policy,
            description: `${audit.scanners} scanner${audit.scanners === 1 ? "" : "s"}; ${audit.findings} finding code${audit.findings === 1 ? "" : "s"}.`,
            meta: item.snapshot.blockerCodes.includes("AUDIT_DOWNGRADE")
              ? "Audit downgrade blocked"
              : `Floor ${audit.floor}`,
            tone: item.snapshot.blockerCodes.includes("AUDIT_DOWNGRADE") ? "danger" : "success",
          },
          {
            id: "permissions",
            label: "Permission envelope",
            value: permissionDisposition(item.snapshot.permissionDiff),
            description: permissionChanges.length
              ? permissionChanges.slice(0, 3).join(" · ")
              : "No permission additions or removals were declared.",
            meta: shortHash(item.snapshot.permissionEnvelopeSha256),
            tone: item.snapshot.blockerCodes.includes("PERMISSION_WIDENED") ? "danger" : "info",
          },
          {
            id: "drift",
            label: "Version and bytes",
            value: item.snapshot.sameVersionDifferentBytes ? "Same-version drift" : "Identity retained",
            description: item.snapshot.sameVersionDifferentBytes
              ? "The same declared or resolved version was observed with different bytes and is blocked."
              : "The declared version remains bound to this exact content digest.",
            meta: item.snapshot.sameVersionDriftSnapshotId
              ? `Compared with ${item.snapshot.sameVersionDriftSnapshotId}`
              : shortHash(item.snapshot.contentTreeSha256),
            tone: item.snapshot.sameVersionDifferentBytes ? "danger" : "success",
          },
          {
            id: "approval",
            label: "Latest approval",
            value: approval?.status ?? "Not requested",
            description: approval
              ? `${approval.operationKind} · ${approval.settlement?.disposition ?? "effect not settled"}`
              : "Install, update, rollback, activation, and revoke remain operator-gated.",
            meta: approval ? formatDateTime(approval.createdAt) : "No mutation requested",
            tone:
              approval?.status === "pending"
                ? "warning"
                : approval?.settlement?.disposition === "applied"
                  ? "success"
                  : "neutral",
          },
        ]}
      />
      {item.snapshot.blockerCodes.length ? (
        <div className="mc-next-skill-hub-blockers" role="alert">
          <Ban size={16} aria-hidden="true" />
          <div>
            <strong>Lifecycle action blocked</strong>
            <span>{item.snapshot.blockerCodes.join(" · ")}</span>
          </div>
        </div>
      ) : null}
      <dl className="mc-next-skill-hub-facts">
        <div>
          <dt>Source</dt>
          <dd>{`${item.snapshot.sourceProvider} · ${item.snapshot.canonicalSourceKey} · ${item.snapshot.sourceRef}`}</dd>
        </div>
        <div>
          <dt>Snapshot</dt>
          <dd>{item.snapshotId}</dd>
        </div>
        <div>
          <dt>Candidate</dt>
          <dd>
            {item.candidate
              ? `${item.candidate.candidateId} / ${item.candidate.versionId}`
              : "Not materialized; snapshot remains review-only"}
          </dd>
        </div>
        <div>
          <dt>Lineage</dt>
          <dd>
            {item.candidate?.supersedesVersionId
              ? `Supersedes ${item.candidate.supersedesVersionId}`
              : item.lineage.latestVersionId
                ? `Latest ${item.lineage.latestVersionId} · ${item.lineage.versionCount} retained`
                : "No candidate lineage yet"}
          </dd>
        </div>
        <div>
          <dt>Artifact</dt>
          <dd>
            {item.artifact
              ? `${item.artifact.fileCount} files · ${formatBytes(item.artifact.totalBytes)} · ${shortHash(item.artifact.manifestSha256)}`
              : "Artifact is not retained"}
          </dd>
        </div>
        <div>
          <dt>Audit digest / floor</dt>
          <dd>{`${shortHash(item.snapshot.auditSha256)} / ${shortHash(item.snapshot.auditFloorSha256)}`}</dd>
        </div>
        <div>
          <dt>Captured</dt>
          <dd>{formatDateTime(item.snapshot.createdAt)}</dd>
        </div>
      </dl>
      <LibraryButtonRow>
        {OPERATOR_ACTIONS.map(({ action, label }) => {
          const pending = item.approvals[action]?.status === "pending";
          return (
            <button
              key={action}
              type="button"
              className="mc-next-settings-filter"
              data-testid={`skill-hub-${action}`}
              disabled={!item.actions[action].allowed || busyAction !== null || pending}
              title={pending ? "An equivalent approval is already pending." : actionTitle(item, action)}
              onClick={() => onAction(action)}
            >
              {action === "revoke" ? <Ban size={15} /> : <ShieldCheck size={15} />}
              {busyAction === action ? "Creating approval…" : pending ? "Approval pending" : label}
            </button>
          );
        })}
        {approval ? (
          <button type="button" className="mc-next-settings-filter" onClick={() => onOpenApproval(approval.approvalId)}>
            <ExternalLink size={15} />
            Open approval
          </button>
        ) : null}
      </LibraryButtonRow>
    </section>
  );
}

function actionTitle(item: SkillHubOperatorItem, action: SkillHubOperatorAction): string | undefined {
  const blockers = item.actions[action].blockers;
  return blockers.length ? `Blocked: ${blockers.join(", ")}` : undefined;
}

function candidateListBody(item: SkillHubOperatorItem): string {
  if (item.snapshot.blockerCodes.length) return item.snapshot.blockerCodes.join(" · ");
  if (item.latestApproval?.status === "pending") return `${item.latestApproval.operationKind} approval pending`;
  if (item.runtime.activeVersion)
    return item.runtime.callable ? "Active in callableCatalog" : "Projected but not callable";
  if (item.candidate?.supersedesVersionId)
    return `Inactive candidate superseding ${item.candidate.supersedesVersionId}`;
  return item.candidate ? "Inactive candidate" : "Review-only snapshot; no candidate materialized";
}

function candidateRuntimeLabel(item: SkillHubOperatorItem): string {
  if (item.runtime.callable) return "Callable";
  if (item.runtime.activeVersion) return "Active, not callable";
  if (!item.candidate) return "Review only";
  if (
    item.candidate.lifecycleState === "revoked" ||
    (item.runtime.lifecycle?.lifecycleState === "revoked" && item.lineage.activeVersionId === item.candidate.versionId)
  ) {
    return "Revoked";
  }
  if (item.candidate.lifecycleState === "deprecated") return "Deprecated";
  return "Inactive";
}

function candidateDetailDescription(item: SkillHubOperatorItem): string {
  const label = candidateRuntimeLabel(item);
  if (label === "Review only") return "Review-only snapshot; no candidate materialized";
  if (label === "Callable") return "Activated candidate is projected into callableCatalog";
  if (label === "Active, not callable") {
    return "Active candidate retained; callableCatalog policy currently blocks invocation";
  }
  if (label === "Revoked") return "Revoked candidate retained as immutable lifecycle evidence";
  if (label === "Deprecated") return "Deprecated candidate retained as immutable lifecycle evidence";
  return "Immutable inactive candidate retained";
}

function displayVersion(item: SkillHubOperatorItem): string {
  return item.snapshot.declaredVersion ?? item.snapshot.resolvedVersion ?? "unversioned";
}

function shortHash(value: string): string {
  return value.length > 16 ? `${value.slice(0, 12)}…` : value;
}

function permissionDisposition(value: Record<string, unknown>): string {
  return typeof value.disposition === "string" ? value.disposition : "unknown";
}

function permissionDiffRows(value: Record<string, unknown>): string[] {
  const dimensions = asRecord(value.dimensions);
  if (!dimensions) return [];
  const rows: string[] = [];
  for (const [name, raw] of Object.entries(dimensions)) {
    const dimension = asRecord(raw);
    if (!dimension) continue;
    const added = stringArray(dimension.added);
    const removed = stringArray(dimension.removed);
    if (added.length) rows.push(`${name}: +${added.join(", ")}`);
    if (removed.length) rows.push(`${name}: −${removed.join(", ")}`);
  }
  return rows;
}

function auditSummary(audit: Record<string, unknown>, floor: Record<string, unknown>) {
  const policyId = typeof audit.policyId === "string" ? audit.policyId : "unknown policy";
  const policyVersion = typeof audit.policyVersion === "string" ? audit.policyVersion : "unknown";
  const policyRevision = typeof audit.policyRevision === "number" ? audit.policyRevision : 0;
  const floorRevision = typeof floor.policyRevision === "number" ? floor.policyRevision : 0;
  return {
    policy: `${policyId} ${policyVersion} r${policyRevision}`,
    floor: `r${floorRevision}`,
    scanners: Array.isArray(audit.scanners) ? audit.scanners.length : 0,
    findings: stringArray(audit.findingCodes).length,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
