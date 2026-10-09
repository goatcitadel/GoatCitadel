import { useRef, useState } from "react";
import {
  fetchMeshCapabilityPublications,
  requestMeshCapabilityActivation,
  revokeMeshCapabilityActivation,
  type MeshCapabilityActivationRequestResponse,
  type MeshCapabilityOpsEntry,
  type MeshCapabilityPublicationInspectionResponse,
} from "@goatcitadel/mission-control-shared/api/mesh-capabilities";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { useMeshCapabilityOps } from "@goatcitadel/mission-control-shared/hooks/useMeshCapabilityOps";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import { SystemOwnerLink } from "../system/SystemOwnerLink";
import { MeshInvocationOutcomes } from "./MeshInvocationOutcomes";
import {
  meshCapabilityId,
  meshReason,
  meshEffectsLabel,
  meshKindLabel,
  meshStatus,
  shortDigest,
} from "./mesh-capability-labels";
import { pendingActivationApproval, refused, stillCurrent, type Review } from "./mesh-activation-gates";

type Receipt = { localId: string; response: MeshCapabilityActivationRequestResponse };

const time = (value?: string) =>
  value && Number.isFinite(Date.parse(value)) ? (
    <time dateTime={value}>{new Date(value).toLocaleString()}</time>
  ) : (
    "Not reported"
  );
const UNKNOWN =
  "The outcome is unknown. Publications were read again. Retry re-reads the publication first and sends the same request only if this entry is unchanged.";
const REFUSED = "The Gateway refused this request, so nothing was changed. Review the current publication.";
function EntryRow({
  entry,
  busy,
  reason,
  onReason,
  onReview,
}: {
  entry: MeshCapabilityOpsEntry;
  busy: boolean;
  reason: string;
  onReason: (value: string) => void;
  onReview: (review: Review) => void;
}) {
  const canActivate = entry.status === "review_required" && entry.capabilityKind !== "skill";
  const activation = entry.activation;
  return (
    <li className="space-y-2 rounded-md border border-line p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h4 className="break-words font-semibold text-fg">{entry.localId}</h4>
        <div className="flex flex-wrap gap-1">
          <StatusBadge status={{ label: meshKindLabel(entry.capabilityKind), tone: "neutral" }} />
          <StatusBadge status={meshStatus(entry.status)} />
          <StatusBadge
            status={{
              label: entry.status === "active" ? "Callable" : "Inspect only",
              tone: entry.status === "active" ? "running" : "neutral",
            }}
          />
          <StatusBadge
            status={{
              label: `Effects: ${meshEffectsLabel(entry.effectPosture)}`,
              tone:
                entry.effectPosture === "external_side_effect" || entry.effectPosture === "unknown"
                  ? "waiting"
                  : "neutral",
            }}
          />
        </div>
      </div>
      <ul aria-label={`Status reasons for ${entry.localId}`} className="list-disc space-y-1 pl-5">
        {entry.reasons.map((item) => (
          <li key={item}>{meshReason(item)}</li>
        ))}
      </ul>
      <ul className="space-y-1 break-words text-fg-secondary">
        <li>
          Entry digest: <code title={`sha256:${entry.entrySha256}`}>{shortDigest(entry.entrySha256)}</code>
        </li>
        <li>
          Capability ID: <code className="wrap-anywhere">{meshCapabilityId(entry)}</code>
        </li>
        {activation ? (
          <li>
            Activation <code className="wrap-anywhere">{activation.activationId}</code> · revision{" "}
            {activation.activationRevision}
            {activation.revoked ? " · revoked" : ""}
          </li>
        ) : null}
      </ul>
      {activation ? (
        <SystemOwnerLink
          href={`/inbox?approvalId=${encodeURIComponent(activation.approvalId)}`}
          scope={[entry.entrySha256, activation.approvalId]}
        >
          Open activation approval
        </SystemOwnerLink>
      ) : null}
      {entry.capabilityKind === "skill" ? (
        <p className="text-fg-muted">
          Skill descriptors are review-only: activation can only stage an inactive candidate through the governed skill
          lifecycle and is deferred until exact byte transfer ships.
        </p>
      ) : null}
      {canActivate ? (
        <Button
          size="sm"
          disabled={busy}
          aria-label={`Review activation request for ${entry.localId}`}
          onClick={() => onReview({ kind: "activate", entry })}
        >
          Review activation request
        </Button>
      ) : null}
      {activation && !activation.revoked ? (
        <div className="space-y-2">
          <label className="block">
            Revocation reason
            <input
              className="mt-1 block min-h-11 w-full rounded-md border border-line bg-canvas px-2 text-fg"
              value={reason}
              maxLength={2_000}
              disabled={busy}
              placeholder="Why callability must end"
              onChange={(event) => onReason(event.target.value)}
            />
          </label>
          <Button
            size="sm"
            variant="danger"
            disabled={busy || !reason.trim()}
            aria-label={`Review revoke of ${entry.localId}`}
            onClick={() =>
              onReview({ kind: "revoke", entry, activationId: activation.activationId, reason: reason.trim() })
            }
          >
            Review revoke
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Governed mesh capability publications for one workspace: manifests and exact entries, a reviewed activation request
 * (it creates an approval; nothing becomes callable until it is decided) and a reasoned, reviewed revocation. Each
 * action re-reads the publications and acts only if the reviewed entry is unchanged.
 */
export function MeshCapabilityPublications({ workspaceId }: { workspaceId: string }) {
  const ops = useMeshCapabilityOps(workspaceId);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [review, setReview] = useState<Review | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [retry, setRetry] = useState<Review | null>(null);
  const [pendingApproval, setPendingApproval] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const manifests = ops.inspection?.manifests ?? [];

  async function run(action: () => Promise<string>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setNotice("");
    try {
      setNotice(await action());
    } finally {
      await ops.reload();
      running.current = false;
      setBusy(false);
    }
  }

  async function dispatch(reviewed: Review) {
    setRetry(null);
    try {
      if (reviewed.kind === "activate") {
        const response = await requestMeshCapabilityActivation({
          workspaceId,
          capabilityId: meshCapabilityId(reviewed.entry),
          manifestSha256: reviewed.entry.manifestSha256,
          entrySha256: reviewed.entry.entrySha256,
        });
        setReceipt({ localId: reviewed.entry.localId, response });
        return "The activation request was recorded. Publications were read again.";
      }
      await revokeMeshCapabilityActivation({
        workspaceId,
        activationId: reviewed.activationId,
        reason: reviewed.reason,
      });
      setReceipt(null);
      setReasons((value) => ({ ...value, [reviewed.activationId]: "" }));
      return "The activation was revoked. Publications were read again.";
    } catch (error) {
      if (refused(error)) return REFUSED;
      setRetry(reviewed);
      return UNKNOWN;
    }
  }

  const confirm = (reviewed: Review) =>
    run(async () => {
      setReview(null);
      let fresh: MeshCapabilityPublicationInspectionResponse;
      try {
        fresh = await fetchMeshCapabilityPublications(workspaceId);
      } catch {
        return "Publications could not be re-read, so nothing was sent.";
      }
      if (!stillCurrent(reviewed, fresh))
        return "This entry changed since your review, so nothing was sent. Review the current publication.";
      setPendingApproval(null);
      if (reviewed.kind === "activate") {
        let pending: string | null;
        try {
          pending = await pendingActivationApproval(workspaceId, meshCapabilityId(reviewed.entry));
        } catch {
          return "Pending approvals could not be checked, so nothing was sent.";
        }
        if (pending) {
          setRetry(null);
          setPendingApproval(pending);
          return "An activation approval for this capability is already pending, so nothing was sent.";
        }
      }
      return dispatch(reviewed);
    });

  const copy =
    review?.kind === "activate"
      ? {
          title: "Request activation of this mesh capability?",
          confirm: "Request activation",
          message: `Request activation of ${review.entry.localId} (${shortDigest(review.entry.entrySha256)}, effects: ${meshEffectsLabel(review.entry.effectPosture)}). This creates an approval for this exact entry. Nothing becomes callable until that approval is decided. Publications are re-read first; if the entry changed, nothing is sent.`,
        }
      : review?.kind === "revoke"
        ? {
            title: "Revoke this mesh capability activation?",
            confirm: "Revoke activation",
            message: `Revoke the activation of ${review.entry.localId}. Callability ends before its next dispatch, and a new exact-entry review is needed to restore it. Reason: ${review.reason}`,
          }
        : { title: "", confirm: "", message: "" };

  return (
    <section
      aria-labelledby="mesh-publications-title"
      className="mt-4 space-y-3 rounded-lg border border-line bg-sunken p-4 text-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="mesh-publications-title" className="font-display text-base font-semibold text-fg">
            Mesh capability publications
          </h2>
          <p className="mt-1 text-fg-secondary">
            Capabilities published by admitted mesh nodes, with exact digests, health and activation state.
          </p>
        </div>
        <Button size="sm" disabled={busy || ops.loading} onClick={() => void ops.reload()}>
          {ops.loading ? "Reloading publications" : "Reload publications"}
        </Button>
      </div>
      {receipt ? (
        <div
          aria-label="Activation request receipt"
          role="group"
          className="space-y-1 rounded-md border border-line bg-raised p-3"
        >
          <p className="font-medium text-fg">
            {receipt.localId}: approval is {receipt.response.approvalStatus}
            {receipt.response.replayed ? " (an existing request was returned)" : ""}
          </p>
          <p>
            Permissions {receipt.response.diff.permissionDisposition} ({receipt.response.diff.permissionsAdded.length}{" "}
            added, {receipt.response.diff.permissionsRemoved.length} removed) · effects{" "}
            {receipt.response.diff.effectDisposition} ({meshEffectsLabel(receipt.response.diff.currentEffectPosture)}) ·
            expires {time(receipt.response.approvalExpiresAt)}
          </p>
          <SystemOwnerLink
            href={`/inbox?approvalId=${encodeURIComponent(receipt.response.approvalId)}`}
            scope={[workspaceId, receipt.response.approvalId]}
          >
            Review the activation approval
          </SystemOwnerLink>
        </div>
      ) : null}
      {pendingApproval ? (
        <SystemOwnerLink
          href={`/inbox?approvalId=${encodeURIComponent(pendingApproval)}`}
          scope={[workspaceId, pendingApproval]}
        >
          Open the pending activation approval
        </SystemOwnerLink>
      ) : null}
      {notice ? (
        <p role="status" className="text-fg-secondary">
          {notice}
        </p>
      ) : null}
      {retry ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => void confirm(retry)}>
            Retry the same request
          </Button>
          <Button size="sm" disabled={busy} onClick={() => setRetry(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}
      {ops.error ? (
        <p role="alert" className="text-status-failed">
          {ops.error}
        </p>
      ) : ops.loading && !ops.inspection ? (
        <p role="status" className="text-fg-muted">
          Reading mesh publications…
        </p>
      ) : ops.inspection && !manifests.length ? (
        <p className="text-fg-muted">No admitted node has published a capability manifest into this workspace.</p>
      ) : manifests.length ? (
        <ul aria-label="Published mesh capability manifests" className="space-y-3">
          {manifests.map((manifest) => (
            <li
              key={`${manifest.manifestSha256}:${manifest.publisherGeneration}`}
              className="space-y-2 rounded-md border border-line bg-raised p-3"
            >
              <h3 className="font-medium text-fg">
                {manifest.entries[0]?.nodeId ? `Node ${manifest.entries[0].nodeId} · ` : ""}Publisher generation{" "}
                {manifest.publisherGeneration} · Admission generation {manifest.admissionGeneration}
                {manifest.supersededByManifestSha256 ? " · Superseded" : ""}
              </h3>
              <ul className="space-y-1 break-words text-fg-secondary">
                <li>
                  Manifest digest:{" "}
                  <code title={`sha256:${manifest.manifestSha256}`}>{shortDigest(manifest.manifestSha256)}</code>
                </li>
                {manifest.supersedesManifestSha256 ? (
                  <li>
                    Supersedes: <code>{shortDigest(manifest.supersedesManifestSha256)}</code>
                  </li>
                ) : null}
                <li>Publication key: {manifest.publicationKey}</li>
                <li>Published: {time(manifest.createdAt)}</li>
              </ul>
              <ul aria-label={`Entries of manifest ${manifest.publicationKey}`} className="space-y-2">
                {manifest.entries.map((entry) => (
                  <EntryRow
                    key={entry.entrySha256}
                    entry={entry}
                    busy={busy}
                    reason={entry.activation ? (reasons[entry.activation.activationId] ?? "") : ""}
                    onReason={(value) =>
                      entry.activation &&
                      setReasons((current) => ({ ...current, [entry.activation!.activationId]: value }))
                    }
                    onReview={setReview}
                  />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}
      <MeshInvocationOutcomes activity={ops.invocationActivity} error={ops.activityError} />
      <ConfirmModal
        open={Boolean(review)}
        danger={review?.kind === "revoke"}
        title={copy.title}
        message={copy.message}
        confirmLabel={copy.confirm}
        cancelLabel="Keep current state"
        pending={busy}
        onCancel={() => setReview(null)}
        onConfirm={() => {
          if (review) void confirm(review);
        }}
      />
    </section>
  );
}
