import type {
  MeshCapabilityOpsEntry,
  MeshCapabilityPublicationInspectionResponse,
} from "@goatcitadel/mission-control-shared/api/mesh-capabilities";
import { fetchApprovals } from "@goatcitadel/mission-control-shared/api/approvals";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";

export type Review =
  | { kind: "activate"; entry: MeshCapabilityOpsEntry }
  | { kind: "revoke"; entry: MeshCapabilityOpsEntry; activationId: string; reason: string };

/** A 4xx is a definitive refusal; only a lost or failed response leaves the outcome unknown. */
export const refused = (error: unknown) =>
  isApiRequestError(error) && typeof error.status === "number" && error.status >= 400 && error.status < 500;

const MAX_APPROVAL_PAGES = 10;
/**
 * A pending activation approval for this capability, if any. The publication projection shows only applied
 * activations, so a pending approval is read from the approvals owner; an incomplete read is an error, never "none".
 */
export async function pendingActivationApproval(workspaceId: string, capabilityId: string): Promise<string | null> {
  let cursor: string | undefined;
  for (let page = 0; page < MAX_APPROVAL_PAGES; page += 1) {
    const response = await fetchApprovals({
      status: "pending",
      workspaceId,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    const match = response.items.find(
      (item) =>
        item.kind === "mesh.capability.activate" &&
        item.status === "pending" &&
        item.payload.capabilityId === capabilityId &&
        item.payload.workspaceId === workspaceId,
    );
    if (match) return match.approvalId;
    if (!response.nextCursor) return null;
    cursor = response.nextCursor;
  }
  throw new Error("Too many pending approvals to check.");
}

/** The reviewed entry is still the same exact publication in the fresh read. */
export function stillCurrent(review: Review, inspection: MeshCapabilityPublicationInspectionResponse) {
  const fresh = inspection.manifests
    .flatMap((manifest) => manifest.entries)
    .find(
      (item) => item.entrySha256 === review.entry.entrySha256 && item.manifestSha256 === review.entry.manifestSha256,
    );
  if (!fresh) return false;
  // An applied (live) activation is never requested again; a pending approval is checked separately before sending.
  if (review.kind === "activate")
    return (
      fresh.status === "review_required" &&
      fresh.capabilityKind !== "skill" &&
      (!fresh.activation || fresh.activation.revoked)
    );
  return fresh.activation?.activationId === review.activationId && !fresh.activation.revoked;
}
