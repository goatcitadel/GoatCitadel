import type { CitadelAccessChange, CitadelAccessSnapshot } from "@goatcitadel/contracts";
import { sameBlueprintValue } from "./citadel-blueprint-binding";

export type AccessEditorChange = Extract<CitadelAccessChange, { type: "add_ward" | "remove_ward" | "assign_agent" | "unassign_agent" }>;
export function hasCitadelAccessSnapshot(value: CitadelAccessSnapshot, citadelId: string) {
  return Boolean(value && value.citadelId === citadelId && /^[a-f0-9]{64}$/.test(value.revision)
    && value.structure?.citadelId === citadelId && Array.isArray(value.structure.chambers)
    && [value.council, value.wards, value.passages, value.members, value.integrations].every(Array.isArray)
    && value.council.every(item => item.citadelId === citadelId && typeof item.assignmentId === "string" && typeof item.agentId === "string")
    && value.wards.every(item => item.citadelId === citadelId && typeof item.wardId === "string" && typeof item.name === "string" && typeof item.actionPattern === "string"));
}
export function accessMutationMatches(before: CitadelAccessSnapshot, after: CitadelAccessSnapshot, change: AccessEditorChange) {
  if (!hasCitadelAccessSnapshot(after, before.citadelId) || after.revision === before.revision) return false;
  for (const field of ["structure", "passages", "members", "integrations"] as const) if (!sameBlueprintValue(before[field], after[field])) return false;
  if (change.type === "add_ward" || change.type === "remove_ward") {
    if (!sameBlueprintValue(before.council, after.council)) return false;
    if (change.type === "remove_ward") return before.wards.some(item => item.wardId === change.wardId)
      && sameBlueprintValue(after.wards, before.wards.filter(item => item.wardId !== change.wardId));
    const prior = new Set(before.wards.map(item => item.wardId)), added = after.wards.filter(item => !prior.has(item.wardId));
    return added.length === 1 && sameBlueprintValue(after.wards.filter(item => prior.has(item.wardId)), before.wards)
      && added[0]!.name === change.ward.name && added[0]!.actionPattern === change.ward.actionPattern && added[0]!.effect === change.ward.effect;
  }
  if (!sameBlueprintValue(before.wards, after.wards)) return false;
  const agentId = change.type === "assign_agent" ? change.assignment.agentId : change.agentId;
  if (change.type === "unassign_agent") return before.council.some(item => item.agentId === agentId)
    && sameBlueprintValue(after.council, before.council.filter(item => item.agentId !== agentId));
  if (before.council.some(item => item.agentId === agentId)) return false;
  const prior = new Set(before.council.map(item => item.assignmentId)), added = after.council.filter(item => !prior.has(item.assignmentId));
  return added.length === 1 && added[0]!.agentId === agentId && sameBlueprintValue(after.council.filter(item => prior.has(item.assignmentId)), before.council);
}
export function isAccessPrewriteConflict(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const value = error as { status?: number; body?: { code?: string; mutationCommitted?: boolean; committed?: boolean; details?: { reason?: string; mutationCommitted?: boolean; committed?: boolean } } };
  return value.status === 409 && value.body?.code === "WRITE_CONFLICT" && value.body.details?.reason === "CITADEL_ACCESS_REVISION_CONFLICT"
    && !value.body.mutationCommitted && !value.body.committed && !value.body.details.mutationCommitted && !value.body.details.committed;
}
