import type { BlueprintReviewSummary, CitadelBlueprint, MasonAnswers, MasonSession } from "@goatcitadel/contracts";
import { sameBlueprintValue } from "./citadel-blueprint-binding";

export const MASON_KINDS = [
  "personal",
  "company",
  "project",
  "household",
  "client",
  "creator",
  "learning",
  "team",
  "custom",
] as const;
export const MASON_POSTURES = ["conservative", "balanced", "collaborative", "automation_forward"] as const;
const arrayFields = ["goals", "sensitiveAreas", "boundaries", "successDefinition"] as const;
export function masonAnswerPatch(value: Partial<MasonAnswers>): Partial<MasonAnswers> {
  const patch = { ...value };
  for (const key of arrayFields) if (patch[key]) patch[key] = patch[key].map(item => item.trim()).filter(Boolean);
  if (!patch.name?.trim()) delete patch.name;
  else patch.name = patch.name.trim();
  if (patch.purpose !== undefined) patch.purpose = patch.purpose.trim();
  return patch;
}
export function validMasonAnswers(value: Partial<MasonAnswers>): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (!value.kind || MASON_KINDS.includes(value.kind)) &&
    (!value.riskPosture || MASON_POSTURES.includes(value.riskPosture)) &&
    ["name", "purpose"].every(
      (key) => value[key as "name" | "purpose"] === undefined || typeof value[key as "name" | "purpose"] === "string",
    ) &&
    arrayFields.every(
      (key) =>
        value[key] === undefined || (Array.isArray(value[key]) && value[key].every((item) => typeof item === "string")),
    ) &&
    (value.preferLocalForSensitive === undefined || typeof value.preferLocalForSensitive === "boolean"),
  );
}
export function validMasonSession(value: MasonSession, id?: string): boolean {
  return Boolean(
    value &&
    typeof value.sessionId === "string" &&
    value.sessionId.trim() &&
    (!id || value.sessionId === id) &&
    ["collecting", "drafted"].includes(value.status) &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    Date.parse(value.updatedAt) >= Date.parse(value.createdAt) &&
    validMasonAnswers(value.answers),
  );
}
export function masonReceiptMatches(before: MasonSession, after: MasonSession, patch?: Partial<MasonAnswers>): boolean {
  return (
    validMasonSession(after, before.sessionId) &&
    after.createdAt === before.createdAt &&
    Date.parse(after.updatedAt) >= Date.parse(before.updatedAt) &&
    after.status === before.status &&
    (!patch || sameBlueprintValue(after.answers, { ...before.answers, ...patch }))
  );
}
export function masonCanDraft(session: MasonSession | null): boolean {
  return Boolean(session?.answers.kind && session.answers.purpose?.trim());
}
export function masonSummaryMatches(blueprint: CitadelBlueprint, summary: BlueprintReviewSummary): boolean {
  return Boolean(
    summary &&
    summary.name === blueprint.metadata.name &&
    summary.kind === blueprint.charter.kind &&
    summary.chamberCount === blueprint.chambers.length &&
    summary.sealedChamberCount === blueprint.chambers.filter((item) => item.sealed).length &&
    sameBlueprintValue(summary.boundaries, blueprint.charter.boundaries ?? []) &&
    sameBlueprintValue(summary.riskNotes, blueprint.riskNotes ?? []) &&
    Array.isArray(summary.lines) &&
    summary.lines.every((line) => typeof line === "string"),
  );
}
