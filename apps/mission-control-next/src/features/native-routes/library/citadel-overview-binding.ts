import type { CitadelCharterInput, CitadelStructureSnapshot, CitadelTemplateSnapshot } from "@goatcitadel/contracts";
import { blueprintImportMatches, hasBlueprintStructure, isBlueprintPrewriteConflict, sameBlueprintValue } from "./citadel-blueprint-binding";

export type CharterSubmission = Omit<CitadelCharterInput, "citadelId">;
export type CitadelOverviewReview =
  | { kind: "charter"; before: CitadelStructureSnapshot; input: CharterSubmission; submittedPurpose: string; generation: number }
  | { kind: "template"; before: CitadelStructureSnapshot; template: CitadelTemplateSnapshot; generation: number };
export function hasOverviewStructure(value: CitadelStructureSnapshot, citadelId: string) {
  return hasBlueprintStructure(value, citadelId) && (!value.charter || typeof value.charter.purpose === "string");
}
export function validCitadelTemplate(template: CitadelTemplateSnapshot) {
  return Boolean(template && typeof template.id === "string" && template.id && /^[a-f0-9]{64}$/.test(template.revision)
    && typeof template.purpose === "string" && template.purpose.trim() && Array.isArray(template.chambers)
    && Array.isArray(template.goals) && Array.isArray(template.boundaries) && Array.isArray(template.successDefinition));
}
export function overviewReceiptMatches(review: CitadelOverviewReview, saved: CitadelStructureSnapshot) {
  if (!hasOverviewStructure(saved, review.before.citadelId) || !saved.charter || saved.revision === review.before.revision) return false;
  if (review.kind === "template") {
    const template = review.template;
    return blueprintImportMatches(review.before, {
      schemaVersion: "goatcitadel.blueprint.v1", metadata: { name: template.name }, riskNotes: [],
      charter: { purpose: template.purpose, kind: template.kind, goals: template.goals, boundaries: template.boundaries,
        successDefinition: template.successDefinition, riskPosture: template.riskPosture ?? "balanced", modelPolicyDefault: template.modelPolicyDefault ?? "hybrid_guarded" },
      chambers: template.chambers.map(chamber => ({ name: chamber.name, sensitivity: chamber.sensitivity ?? "private", sealed: chamber.sealed ?? false })),
    }, saved);
  }
  return sameBlueprintValue(saved.record && { ...saved.record, hasCharter: undefined }, review.before.record && { ...review.before.record, hasCharter: undefined })
    && sameBlueprintValue(saved.chambers, review.before.chambers)
    && saved.charter.createdAt === review.before.charter?.createdAt
    && Object.entries(review.input).every(([field, value]) => sameBlueprintValue(saved.charter![field as keyof typeof saved.charter], value));
}
export function isOverviewPrewriteConflict(error: unknown) {
  if (isBlueprintPrewriteConflict(error)) return true;
  if (!error || typeof error !== "object") return false;
  const value = error as { status?: number; body?: { code?: string; mutationCommitted?: boolean; committed?: boolean; details?: { reason?: string; mutationCommitted?: boolean; committed?: boolean } } };
  return value.status === 409 && value.body?.code === "WRITE_CONFLICT" && value.body.details?.reason === "CITADEL_TEMPLATE_REVISION_CONFLICT"
    && !value.body.mutationCommitted && !value.body.committed && !value.body.details.mutationCommitted && !value.body.details.committed;
}
