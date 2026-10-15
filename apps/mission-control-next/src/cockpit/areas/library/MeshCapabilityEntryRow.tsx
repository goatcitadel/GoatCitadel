import type { MeshCapabilityOpsEntry } from "@goatcitadel/mission-control-shared/api/mesh-capabilities";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { SystemOwnerLink } from "../system/SystemOwnerLink";
import {
  meshCapabilityId,
  meshEffectsLabel,
  meshEntryName,
  meshKindLabel,
  meshReason,
  meshStatus,
  shortDigest,
} from "./mesh-capability-labels";
import type { Review } from "./mesh-activation-gates";

/** One exact published entry: plain name and state first, digests and ids in Technical details. */
export function MeshCapabilityEntryRow({
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
  const name = meshEntryName(entry.localId);
  return (
    <li className="space-y-2 rounded-md border border-line p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h4 className="break-words font-semibold text-fg">{name}</h4>
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
      <ul aria-label={`Status reasons for ${name}`} className="list-disc space-y-1 pl-5">
        {entry.reasons.map((item) => (
          <li key={item}>{meshReason(item)}</li>
        ))}
      </ul>
      {activation ? (
        <p className="text-fg-secondary">{activation.revoked ? "Activation revoked" : "Activation recorded"}</p>
      ) : null}
      <TechnicalDetails label="Capability identifiers">
        <ul className="space-y-1 break-words">
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
            </li>
          ) : null}
        </ul>
      </TechnicalDetails>
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
          aria-label={`Review activation request for ${name}`}
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
              className="mt-1 block min-h-11 w-full rounded-md border border-line-control bg-canvas px-2 text-fg"
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
            aria-label={`Review revoke of ${name}`}
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
