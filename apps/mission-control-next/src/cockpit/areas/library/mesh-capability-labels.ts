import type {
  MeshCapabilityInvocationActivityItem,
  MeshCapabilityOpsEntry,
} from "@goatcitadel/mission-control-shared/api/mesh-capabilities";
import type { StatusPresentation } from "@goatcitadel/mission-control-shared/content/status-vocabulary";

/** The Gateway's capability id for one exact entry, as the Classic owner derives it. */
export function meshCapabilityId(entry: MeshCapabilityOpsEntry): string {
  return `mesh:${entry.nodeId}:${entry.capabilityKind}:${entry.localId}`;
}

export const shortDigest = (value: string) => `sha256:${value.slice(0, 12)}…`;

/** A value the Gateway adds later is shown as itself, never as "undefined" or an upgraded label. */
export const meshKindLabel = (kind: string) => (MESH_KIND as Record<string, string | undefined>)[kind] ?? kind;
export const meshStatus = (status: string): StatusPresentation =>
  (MESH_STATUS as Record<string, StatusPresentation | undefined>)[status] ?? { label: status, tone: "neutral" };
export const meshEffectsLabel = (posture: string) =>
  (MESH_EFFECTS as Record<string, string | undefined>)[posture] ?? posture;

const MESH_KIND: Record<MeshCapabilityOpsEntry["capabilityKind"], string> = {
  tool: "Tool",
  mcp_server: "MCP server",
  skill: "Skill",
};

const MESH_STATUS: Record<MeshCapabilityOpsEntry["status"], StatusPresentation> = {
  review_required: { label: "Review required", tone: "neutral" },
  active: { label: "Active", tone: "done" },
  revoked: { label: "Revoked", tone: "failed" },
  offline: { label: "Offline", tone: "waiting" },
  superseded: { label: "Superseded", tone: "neutral" },
  blocked: { label: "Blocked", tone: "failed" },
};

/** An unknown posture is never upgraded for display. */
const MESH_EFFECTS: Record<MeshCapabilityOpsEntry["effectPosture"], string> = {
  none: "none",
  read_only: "read only",
  write_local: "write local",
  external_side_effect: "external side effect",
  unknown: "unknown",
};

const REASONS: Record<string, string> = {
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

export const meshReason = (reason: string) => REASONS[reason] ?? reason.replaceAll("_", " ");

export function invocationState(item: MeshCapabilityInvocationActivityItem): StatusPresentation {
  if (item.phase === "dispatched") return { label: "Dispatched", tone: "running" };
  if (item.phase === "reconciled") return { label: "Reconciled", tone: "neutral" };
  switch (item.disposition) {
    case "succeeded":
      return { label: "Succeeded", tone: "done" };
    case "failed":
      return { label: "Failed", tone: "failed" };
    case "timed_out":
      return { label: "Timed out", tone: "failed" };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral" };
    case "unknown":
      return { label: "Unknown outcome", tone: "waiting" };
    default:
      return { label: "Settled", tone: "neutral" };
  }
}
