import { useRef, useState } from "react";
import {
  fetchMeshCapabilityPublications,
  requestMeshCapabilityActivation,
  revokeMeshCapabilityActivation,
  type MeshCapabilityActivationRequestResponse,
  type MeshCapabilityPublicationInspectionResponse,
} from "@goatcitadel/mission-control-shared/api/mesh-capabilities";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { useMeshCapabilityOps } from "@goatcitadel/mission-control-shared/hooks/useMeshCapabilityOps";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { Button } from "../../ui/Button";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TimeText } from "../../ui/TimeText";
import { SystemOwnerLink } from "../system/SystemOwnerLink";
import { MeshCapabilityEntryRow } from "./MeshCapabilityEntryRow";
import { MeshInvocationOutcomes } from "./MeshInvocationOutcomes";
import {
  meshApprovalStatus,
  meshCapabilityId,
  meshEffectDiffLabel,
  meshEntryName,
  meshPermissionDiffLabel,
  meshEffectsLabel,
  shortDigest,
} from "./mesh-capability-labels";
import { pendingActivationApproval, refused, stillCurrent, type Review } from "./mesh-activation-gates";

type Receipt = { name: string; response: MeshCapabilityActivationRequestResponse };

const time = (value?: string) =>
  value && Number.isFinite(Date.parse(value)) ? <TimeText value={value} absolute /> : "Not reported";
const UNKNOWN =
  "The outcome is unknown. Publications were read again. Retry re-reads the publication first and sends the same request only if this entry is unchanged.";
const REFUSED = "The Gateway refused this request, so nothing was changed. Review the current publication.";
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
        setReceipt({ name: meshEntryName(reviewed.entry.localId), response });
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
          message: `Request activation of ${meshEntryName(review.entry.localId)} (${shortDigest(review.entry.entrySha256)}, effects: ${meshEffectsLabel(review.entry.effectPosture)}). This creates an approval for this exact entry. Nothing becomes callable until that approval is decided. Publications are re-read first; if the entry changed, nothing is sent.`,
        }
      : review?.kind === "revoke"
        ? {
            title: "Revoke this mesh capability activation?",
            confirm: "Revoke activation",
            message: `Revoke the activation of ${meshEntryName(review.entry.localId)}. Callability ends before its next dispatch, and a new exact-entry review is needed to restore it. Reason: ${review.reason}`,
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
            Capabilities published by accepted mesh nodes, with exact digests, health and activation state.
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
            {receipt.name}: approval is {meshApprovalStatus(receipt.response.approvalStatus).label.toLowerCase()}
            {receipt.response.replayed ? " (an existing request was returned)" : ""}
          </p>
          <p>
            Permissions {meshPermissionDiffLabel(receipt.response.diff.permissionDisposition)} (
            {receipt.response.diff.permissionsAdded.length} added, {receipt.response.diff.permissionsRemoved.length}{" "}
            removed) · effects {meshEffectDiffLabel(receipt.response.diff.effectDisposition)} (
            {meshEffectsLabel(receipt.response.diff.currentEffectPosture)}) · expires{" "}
            {time(receipt.response.approvalExpiresAt)}
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
        <p className="text-fg-muted">No accepted node has published a capability manifest into this workspace.</p>
      ) : manifests.length ? (
        <ul aria-label="Published mesh capability manifests" className="space-y-3">
          {manifests.map((manifest) => (
            <li
              key={`${manifest.manifestSha256}:${manifest.publisherGeneration}`}
              className="space-y-2 rounded-md border border-line bg-raised p-3"
            >
              <h3 className="font-medium text-fg">
                Capabilities from a mesh node{manifest.supersededByManifestSha256 ? " · Superseded" : ""}
              </h3>
              <p className="text-fg-secondary">
                {plural(manifest.entries.length, "capability", "capabilities")} · Published {time(manifest.createdAt)}
              </p>
              <TechnicalDetails label="Manifest identifiers">
                <ul className="space-y-1 break-words">
                  {manifest.entries[0]?.nodeId ? <li>Node ID: {manifest.entries[0].nodeId}</li> : null}
                  <li>
                    Publisher generation {manifest.publisherGeneration} · Admission generation{" "}
                    {manifest.admissionGeneration}
                  </li>
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
                </ul>
              </TechnicalDetails>
              <ul aria-label="Capabilities in this manifest" className="space-y-2">
                {manifest.entries.map((entry) => (
                  <MeshCapabilityEntryRow
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
