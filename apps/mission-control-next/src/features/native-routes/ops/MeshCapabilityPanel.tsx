import { useCallback, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  requestMeshCapabilityActivation,
  revokeMeshCapabilityActivation,
  type MeshCapabilityActivationRequestResponse,
  type MeshCapabilityInvocationActivityItem,
  type MeshCapabilityOpsEntry,
  type MeshCapabilityOpsManifest,
} from "@goatcitadel/mission-control-shared/api/mesh-capabilities";
import { useMeshCapabilityOps } from "@goatcitadel/mission-control-shared/hooks/useMeshCapabilityOps";
import { NativeCard } from "../NativeRoutePageLayout";
import { EmptyState, NativeButton, NoticeBanner, StatusChip, type StatusChipTone } from "../primitives";
import "./mesh-capabilities.css";

/**
 * HX-408 M4 Ops surface for governed mesh capability publication.
 *
 * Semantic cards over the server-built projection (never raw schemas or
 * manifest text): publisher identity and generations, manifest digest truth,
 * entry kind, permission/effect posture, health/lease truth via explicit
 * status reasons, inspectable-versus-callable state, activation approval
 * linkage, revocation, and blockers. Operator actions call only the shipped
 * M2 routes — request activation (detached approval) and revoke activation.
 *
 * Invocation outcomes render from the retained realtime events the M3 owner
 * publishes. The durable per-invocation reconciliation queue has no operator
 * inspection route yet, so that portion stays read-only and says so honestly.
 */
export function MeshCapabilityPanel({ workspaceId }: { workspaceId: string }) {
  const ops = useMeshCapabilityOps(workspaceId);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revokeReasons, setRevokeReasons] = useState<Record<string, string>>({});
  const [lastActivation, setLastActivation] = useState<{
    localId: string;
    response: MeshCapabilityActivationRequestResponse;
  } | null>(null);

  const reload = ops.reload;
  const runAction = useCallback(
    async (key: string, operation: () => Promise<void>) => {
      setPendingAction(key);
      setActionError(null);
      try {
        await operation();
        await reload();
      } catch {
        setActionError(
          "The mesh capability action was rejected. Publication state may have drifted — reload and retry against current truth.",
        );
      } finally {
        setPendingAction(null);
      }
    },
    [reload],
  );

  const handleRequestActivation = useCallback(
    (entry: MeshCapabilityOpsEntry) => {
      void runAction(`activate:${entry.entrySha256}`, async () => {
        const response = await requestMeshCapabilityActivation({
          workspaceId,
          capabilityId: deriveCapabilityId(entry),
          manifestSha256: entry.manifestSha256,
          entrySha256: entry.entrySha256,
        });
        setLastActivation({ localId: entry.localId, response });
      });
    },
    [runAction, workspaceId],
  );

  const handleRevokeReason = useCallback((activationId: string, reason: string) => {
    setRevokeReasons((current) => ({ ...current, [activationId]: reason }));
  }, []);

  const handleRevoke = useCallback(
    (entry: MeshCapabilityOpsEntry) => {
      const activationId = entry.activation?.activationId;
      if (!activationId) {
        return;
      }
      const reason = (revokeReasons[activationId] ?? "").trim();
      if (!reason) {
        setActionError("Enter a revocation reason before revoking the activation.");
        return;
      }
      void runAction(`revoke:${activationId}`, async () => {
        await revokeMeshCapabilityActivation({ workspaceId, activationId, reason });
        setLastActivation(null);
      });
    },
    [revokeReasons, runAction, workspaceId],
  );

  const inspection = ops.inspection;
  const manifests = useMemo(() => inspection?.manifests ?? [], [inspection]);
  const entryStats = useMemo(() => {
    const entries = manifests.flatMap((manifest) => manifest.entries);
    return {
      total: entries.length,
      callable: entries.filter((entry) => entry.status === "active").length,
      attention: entries.filter((entry) => ["blocked", "offline", "revoked"].includes(entry.status)).length,
    };
  }, [manifests]);

  return (
    <NativeCard
      title="Mesh capability publications"
      subtitle="Governed publication truth for admitted mesh nodes: inspectable descriptors, exact activation grants, health and lease posture, and dispatch outcomes."
      density="compact"
      className="mc-next-mesh-caps-panel"
      stats={[
        { label: "Manifests", value: String(manifests.length) },
        { label: "Callable", value: String(entryStats.callable) },
        { label: "Attention", value: String(entryStats.attention) },
      ]}
      actions={
        <NativeButton
          variant="outline"
          onClick={() => void reload()}
          disabled={ops.loading}
          aria-label="Reload mesh capability publications"
        >
          <RefreshCw size={15} aria-hidden="true" />
          {ops.loading ? "Reloading" : "Reload"}
        </NativeButton>
      }
    >
      {actionError ? <NoticeBanner tone="error" message={actionError} /> : null}
      {lastActivation ? (
        <ActivationReceiptBanner localId={lastActivation.localId} response={lastActivation.response} />
      ) : null}
      {ops.error ? (
        <NoticeBanner tone="error" message={ops.error} />
      ) : ops.loading && !ops.inspection ? (
        <div aria-busy="true" aria-live="polite">
          <EmptyState size="compact" title="Loading server-built publication projection…" />
        </div>
      ) : manifests.length === 0 ? (
        <EmptyState
          size="compact"
          title="No mesh capability manifests"
          description="No admitted node has published a capability manifest into this workspace."
        />
      ) : (
        <ul className="mc-next-mesh-caps-manifests" role="list" aria-label="Published mesh capability manifests">
          {manifests.map((manifest) => (
            <ManifestCard
              key={`${manifest.manifestSha256}:${manifest.publisherGeneration}`}
              manifest={manifest}
              pendingAction={pendingAction}
              revokeReasons={revokeReasons}
              onRequestActivation={handleRequestActivation}
              onRevokeReason={handleRevokeReason}
              onRevoke={handleRevoke}
            />
          ))}
        </ul>
      )}
      <InvocationActivitySection activity={ops.invocationActivity} activityError={ops.activityError} />
    </NativeCard>
  );
}

function ManifestCard({
  manifest,
  pendingAction,
  revokeReasons,
  onRequestActivation,
  onRevokeReason,
  onRevoke,
}: {
  manifest: MeshCapabilityOpsManifest;
  pendingAction: string | null;
  revokeReasons: Record<string, string>;
  onRequestActivation: (entry: MeshCapabilityOpsEntry) => void;
  onRevokeReason: (activationId: string, reason: string) => void;
  onRevoke: (entry: MeshCapabilityOpsEntry) => void;
}) {
  const publisherNodeId = manifest.entries[0]?.nodeId;
  return (
    <li className="mc-next-mesh-caps-manifest" role="listitem">
      <div className="mc-next-mesh-caps-manifest-head">
        <div className="mc-next-mesh-caps-chip-row">
          {publisherNodeId ? <StatusChip tone="default">{`Node ${publisherNodeId}`}</StatusChip> : null}
          <StatusChip tone="muted">{`Publisher generation ${manifest.publisherGeneration}`}</StatusChip>
          <StatusChip tone="muted">{`Admission generation ${manifest.admissionGeneration}`}</StatusChip>
          {manifest.supersededByManifestSha256 ? <StatusChip tone="warning">Superseded</StatusChip> : null}
        </div>
        <dl className="mc-next-mesh-caps-meta">
          <MetaDigest label="Manifest digest" value={manifest.manifestSha256} />
          {manifest.supersedesManifestSha256 ? (
            <MetaDigest label="Supersedes" value={manifest.supersedesManifestSha256} />
          ) : null}
          <div>
            <dt>Publication key</dt>
            <dd>{manifest.publicationKey}</dd>
          </div>
          <div>
            <dt>Published</dt>
            <dd>
              <time dateTime={manifest.createdAt}>{formatTimestamp(manifest.createdAt)}</time>
            </dd>
          </div>
        </dl>
      </div>
      <ul
        className="mc-next-mesh-caps-entries"
        role="list"
        aria-label={`Entries of manifest ${manifest.publicationKey}`}
      >
        {manifest.entries.map((entry) => (
          <EntryCard
            key={entry.entrySha256}
            entry={entry}
            pendingAction={pendingAction}
            revokeReason={entry.activation ? (revokeReasons[entry.activation.activationId] ?? "") : ""}
            onRequestActivation={onRequestActivation}
            onRevokeReason={onRevokeReason}
            onRevoke={onRevoke}
          />
        ))}
      </ul>
    </li>
  );
}

function EntryCard({
  entry,
  pendingAction,
  revokeReason,
  onRequestActivation,
  onRevokeReason,
  onRevoke,
}: {
  entry: MeshCapabilityOpsEntry;
  pendingAction: string | null;
  revokeReason: string;
  onRequestActivation: (entry: MeshCapabilityOpsEntry) => void;
  onRevokeReason: (activationId: string, reason: string) => void;
  onRevoke: (entry: MeshCapabilityOpsEntry) => void;
}) {
  const activateBusy = pendingAction === `activate:${entry.entrySha256}`;
  const revokeBusy = entry.activation ? pendingAction === `revoke:${entry.activation.activationId}` : false;
  const busy = activateBusy || revokeBusy;
  const canRequestActivation = entry.status === "review_required" && entry.capabilityKind !== "skill";
  const canRevoke = entry.activation !== undefined && !entry.activation.revoked;
  return (
    <li className="mc-next-mesh-caps-entry" data-status={entry.status} role="listitem">
      <div className="mc-next-mesh-caps-entry-head">
        <h4>{entry.localId}</h4>
        <div className="mc-next-mesh-caps-chip-row">
          <StatusChip tone="neutral">{kindLabel(entry.capabilityKind)}</StatusChip>
          <StatusChip tone={toneForStatus(entry.status)}>{statusLabel(entry.status)}</StatusChip>
          <StatusChip
            tone={entry.status === "active" ? "live" : "muted"}
            ariaLabel={entry.status === "active" ? "Callable now" : "Inspect only"}
          >
            {entry.status === "active" ? "Callable" : "Inspect only"}
          </StatusChip>
          <StatusChip tone={toneForEffectPosture(entry.effectPosture)}>
            {`Effects: ${effectPostureLabel(entry.effectPosture)}`}
          </StatusChip>
        </div>
      </div>
      <ul className="mc-next-mesh-caps-reasons" aria-label={`Status reasons for ${entry.localId}`}>
        {entry.reasons.map((reason) => (
          <li key={reason}>{reasonLabel(reason)}</li>
        ))}
      </ul>
      <dl className="mc-next-mesh-caps-meta">
        <MetaDigest label="Entry digest" value={entry.entrySha256} />
        <div>
          <dt>Capability ID</dt>
          <dd>
            <code>{deriveCapabilityId(entry)}</code>
          </dd>
        </div>
        {entry.activation ? (
          <>
            <div>
              <dt>Activation</dt>
              <dd>
                <code>{shortIdentifier(entry.activation.activationId)}</code>
                {` · revision ${entry.activation.activationRevision}`}
                {entry.activation.revoked ? " · revoked" : ""}
              </dd>
            </div>
            <div>
              <dt>Approval</dt>
              <dd>
                <code>{shortIdentifier(entry.activation.approvalId)}</code>
              </dd>
            </div>
          </>
        ) : null}
      </dl>
      {entry.capabilityKind === "skill" ? (
        <p className="mc-next-mesh-caps-hint">
          Skill descriptors are review-only: activation can only stage an inactive candidate through the governed skill
          lifecycle and is deferred until exact byte transfer ships.
        </p>
      ) : null}
      <div className="mc-next-mesh-caps-entry-actions">
        {canRequestActivation ? (
          <NativeButton
            variant="default"
            onClick={() => onRequestActivation(entry)}
            disabled={busy}
            aria-label={`Request activation of ${entry.localId}`}
          >
            {activateBusy ? "Requesting…" : "Request activation"}
          </NativeButton>
        ) : null}
        {canRevoke && entry.activation ? (
          <div className="mc-next-mesh-caps-revoke">
            <label className="mc-next-mesh-caps-revoke-reason">
              <span>Revocation reason</span>
              <input
                type="text"
                value={revokeReason}
                maxLength={2_000}
                disabled={busy}
                placeholder="Why callability must end"
                onChange={(event) => onRevokeReason(entry.activation!.activationId, event.target.value)}
              />
            </label>
            <NativeButton
              variant="destructive"
              onClick={() => onRevoke(entry)}
              disabled={busy || revokeReason.trim().length === 0}
              aria-label={`Revoke activation of ${entry.localId}`}
            >
              {revokeBusy ? "Revoking…" : "Revoke activation"}
            </NativeButton>
          </div>
        ) : null}
      </div>
    </li>
  );
}

function ActivationReceiptBanner({
  localId,
  response,
}: {
  localId: string;
  response: MeshCapabilityActivationRequestResponse;
}) {
  const added = response.diff.permissionsAdded.length;
  const removed = response.diff.permissionsRemoved.length;
  const effect = response.diff.priorEffectPosture
    ? `${effectPostureLabel(response.diff.priorEffectPosture)} to ${effectPostureLabel(response.diff.currentEffectPosture)}`
    : effectPostureLabel(response.diff.currentEffectPosture);
  return (
    <section className="mc-next-mesh-caps-receipt" aria-label={`Activation request receipt for ${localId}`}>
      <div className="mc-next-mesh-caps-chip-row">
        <StatusChip tone={response.replayed ? "muted" : "success"}>
          {response.replayed ? "Request replayed" : "Approval requested"}
        </StatusChip>
        <StatusChip tone="default">{`Approval ${response.approvalStatus}`}</StatusChip>
        <StatusChip tone="muted">{`Revision ${response.activationRevision}`}</StatusChip>
      </div>
      <p>
        {`${localId}: approval `}
        <code>{shortIdentifier(response.approvalId)}</code>
        {` awaits an operator decision. Permission diff ${response.diff.permissionDisposition} (${added} added, ${removed} removed); effect posture ${response.diff.effectDisposition} (${effect}).`}
        {response.approvalExpiresAt ? " It expires " : ""}
        {response.approvalExpiresAt ? (
          <time dateTime={response.approvalExpiresAt}>{formatTimestamp(response.approvalExpiresAt)}</time>
        ) : null}
        {response.approvalExpiresAt ? "." : ""}
      </p>
    </section>
  );
}

function InvocationActivitySection({
  activity,
  activityError,
}: {
  activity: readonly MeshCapabilityInvocationActivityItem[];
  activityError: string | null;
}) {
  const reconciliationCount = activity.filter((item) => item.manualReconciliationRequired).length;
  return (
    <section className="mc-next-mesh-caps-invocations" aria-label="Mesh invocation outcomes">
      <h4>{`Invocation outcomes (${activity.length})`}</h4>
      {activityError ? <NoticeBanner tone="warning" message={activityError} /> : null}
      {reconciliationCount > 0 ? (
        <NoticeBanner
          tone="warning"
          message={`${reconciliationCount} invocation${reconciliationCount === 1 ? "" : "s"} settled with unknown delivery and await manual operator reconciliation. Automatic replay is suppressed.`}
        />
      ) : null}
      {activity.length === 0 ? (
        activityError ? null : (
          <EmptyState
            size="compact"
            title="No recent mesh invocations"
            description="Dispatch and settlement events from generation-fenced mesh invocations appear here as they are retained."
          />
        )
      ) : (
        <ul role="list" aria-label="Recent mesh invocation outcomes">
          {activity.map((item) => (
            <li key={item.invocationId} className="mc-next-mesh-caps-invocation" role="listitem">
              <div className="mc-next-mesh-caps-chip-row">
                <StatusChip tone={toneForInvocation(item)}>{invocationStateLabel(item)}</StatusChip>
                {item.settlementAuthority ? (
                  <StatusChip tone="muted">{`Settled by ${item.settlementAuthority}`}</StatusChip>
                ) : null}
                {item.manualReconciliationRequired ? (
                  <StatusChip tone="critical">Manual reconciliation required</StatusChip>
                ) : null}
              </div>
              <p>
                <code>{item.capabilityId}</code>
                {` on node ${item.nodeId} · `}
                <time dateTime={item.observedAt}>{formatTimestamp(item.observedAt)}</time>
                {item.errorCode ? ` · ${humanizeCode(item.errorCode)}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
      <p className="mc-next-mesh-caps-hint">
        Dispatch truth is durable: every invocation retains an immutable intent and one terminal settlement, and expired
        unsettled intents settle to a bounded unknown outcome that requires manual reconciliation. A dedicated operator
        route for the per-invocation reconciliation queue does not exist yet, so this view is read-only observability
        from retained events — it never acknowledges or replays anything.
      </p>
    </section>
  );
}

function MetaDigest({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <code title={`sha256:${value}`}>{`sha256:${value.slice(0, 12)}…`}</code>
      </dd>
    </div>
  );
}

function deriveCapabilityId(entry: MeshCapabilityOpsEntry): string {
  return `mesh:${entry.nodeId}:${entry.capabilityKind}:${entry.localId}`;
}

function shortIdentifier(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 18)}…`;
}

function formatTimestamp(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}

function kindLabel(kind: MeshCapabilityOpsEntry["capabilityKind"]): string {
  switch (kind) {
    case "tool":
      return "Tool";
    case "mcp_server":
      return "MCP server";
    case "skill":
      return "Skill";
  }
}

function statusLabel(status: MeshCapabilityOpsEntry["status"]): string {
  switch (status) {
    case "review_required":
      return "Review required";
    case "active":
      return "Active";
    case "revoked":
      return "Revoked";
    case "offline":
      return "Offline";
    case "superseded":
      return "Superseded";
    case "blocked":
      return "Blocked";
  }
}

function toneForStatus(status: MeshCapabilityOpsEntry["status"]): StatusChipTone {
  switch (status) {
    case "active":
      return "success";
    case "review_required":
      return "default";
    case "superseded":
      return "muted";
    case "offline":
      return "warning";
    case "revoked":
    case "blocked":
      return "critical";
  }
}

function effectPostureLabel(posture: MeshCapabilityOpsEntry["effectPosture"]): string {
  switch (posture) {
    case "none":
      return "none";
    case "read_only":
      return "read only";
    case "write_local":
      return "write local";
    case "external_side_effect":
      return "external side effect";
    case "unknown":
      // Preserved verbatim — an unknown posture is never upgraded for display.
      return "unknown";
  }
}

function toneForEffectPosture(posture: MeshCapabilityOpsEntry["effectPosture"]): StatusChipTone {
  switch (posture) {
    case "none":
    case "read_only":
      return "neutral";
    case "write_local":
      return "warning";
    case "external_side_effect":
    case "unknown":
      return "critical";
  }
}

const REASON_LABELS: Record<string, string> = {
  activation_live: "Exact activation revalidates live (publisher, health, lease, and generation all current).",
  operator_review_required: "Awaiting operator review; publication alone never grants callability.",
  activation_revoked: "A prior activation was revoked; a new exact-entry review is required.",
  skill_descriptor_never_callable: "Skill descriptors are never callable from the catalog.",
  node_admission_revoked: "The node admission was revoked; only immutable evidence remains inspectable.",
  publisher_health_revoked: "The publisher health authority was revoked.",
  publisher_health_offline: "Publisher health is offline; callability is removed before the next dispatch.",
  publisher_health_suspect: "Publisher health is suspect; callability is removed before the next dispatch.",
  node_disconnected: "The node is disconnected; the catalog projection changed, immutable records remain.",
  publication_lease_expired: "The capability-publication lease expired; the publisher must re-acquire it.",
  certificate_drift: "Certificate drift against the admission binding blocks this publisher.",
  publication_state_unverifiable: "Publication state cannot be verified against durable truth.",
  publisher_generation_superseded:
    "A newer publisher generation superseded this manifest; reconnect never resumes an old one.",
  manifest_superseded: "A newer manifest superseded this one; supersession never mutates the prior bytes.",
};

function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? humanizeCode(reason);
}

function humanizeCode(code: string): string {
  return code.replaceAll("_", " ");
}

function toneForInvocation(item: MeshCapabilityInvocationActivityItem): StatusChipTone {
  if (item.phase === "dispatched") return "live";
  switch (item.disposition) {
    case "succeeded":
      return "success";
    case "failed":
    case "timed_out":
      return "warning";
    case "cancelled":
      return "muted";
    case "unknown":
      return "critical";
    default:
      return "muted";
  }
}

function invocationStateLabel(item: MeshCapabilityInvocationActivityItem): string {
  if (item.phase === "dispatched") return "Dispatched";
  const disposition = item.disposition ? humanizeCode(item.disposition) : "settled";
  return item.phase === "reconciled" ? `Reconciled: ${disposition}` : `Settled: ${disposition}`;
}
