import type { CitadelBlueprint, CitadelStructureSnapshot } from "@goatcitadel/contracts";

/** Compare persisted data without depending on response object key order. */
export function sameBlueprintValue(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, normalize(entry)])) : value;
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

export function hasBlueprintStructure(value: CitadelStructureSnapshot, citadelId: string): boolean {
  return Boolean(value && value.citadelId === citadelId && /^[a-f0-9]{64}$/.test(value.revision)
    && (!value.record || value.record.citadelId === citadelId)
    && (!value.charter || value.charter.citadelId === citadelId)
    && Array.isArray(value.chambers) && value.chambers.every(item => item.citadelId === citadelId && typeof item.chamberId === "string")
    && new Set(value.chambers.map(item => item.chamberId)).size === value.chambers.length);
}

export function blueprintImportMatches(before: CitadelStructureSnapshot, blueprint: CitadelBlueprint, saved: CitadelStructureSnapshot): boolean {
  if (!hasBlueprintStructure(saved, before.citadelId) || !saved.charter || saved.revision === before.revision
    || !sameBlueprintValue(saved.record && { ...saved.record, hasCharter: undefined }, before.record && { ...before.record, hasCharter: undefined })) return false;
  for (const [field, value] of Object.entries(blueprint.charter)) {
    if (!sameBlueprintValue(saved.charter[field as keyof typeof saved.charter], value)) return false;
  }
  if (saved.charter.defaultChamberId !== undefined || saved.charter.createdAt !== (before.charter?.createdAt ?? saved.charter.createdAt)) return false;
  const retained = new Map(before.chambers.map(item => [item.chamberId, item]));
  if (before.chambers.some(item => !sameBlueprintValue(saved.chambers.find(after => after.chamberId === item.chamberId), item))) return false;
  const added = saved.chambers.filter(item => !retained.has(item.chamberId));
  return sameBlueprintValue(added.map(({ name, sensitivity, sealed }) => ({ name, sensitivity, sealed }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), blueprint.chambers.map(item => ({ ...item }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

export function isBlueprintPrewriteConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { status?: number; body?: { code?: string; mutationCommitted?: boolean; committed?: boolean; details?: { reason?: string; mutationCommitted?: boolean; committed?: boolean } } };
  const body = value.body;
  return value.status === 409 && body?.code === "WRITE_CONFLICT"
    && ["CITADEL_STRUCTURE_REVISION_CONFLICT", "CITADEL_ARCHIVED"].includes(body.details?.reason ?? "")
    && !body.mutationCommitted && !body.committed && !body.details?.mutationCommitted && !body.details?.committed;
}
