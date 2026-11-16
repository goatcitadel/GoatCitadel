import type { CandidateSkillVersionRecord } from "@goatcitadel/contracts";
import type { SkillHubSnapshotRecord } from "@goatcitadel/storage";

// Small pure helpers of the Skill Hub operator service: orderings, de-duplication and input normalization.

export function compareSnapshotPosition(left: SkillHubSnapshotRecord, right: SkillHubSnapshotRecord): number {
  return left.createdAt.localeCompare(right.createdAt) || left.snapshotId.localeCompare(right.snapshotId);
}

export function compareCandidateNewest(left: CandidateSkillVersionRecord, right: CandidateSkillVersionRecord): number {
  return right.updatedAt.localeCompare(left.updatedAt) || right.versionId.localeCompare(left.versionId);
}

export function uniqueCandidates(candidates: CandidateSkillVersionRecord[]): CandidateSkillVersionRecord[] {
  return [...new Map(candidates.map((candidate) => [candidate.versionId, candidate])).values()];
}

export function readMetadataString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

export function normalizeRequired(value: string, label: string, maxLength: number): string {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maxLength || normalized !== value) {
    throw new TypeError(`Skill Hub ${label} is missing, oversized, or noncanonical.`);
  }
  return normalized;
}

export function normalizeOptional(value: string | undefined, label: string, maxLength: number): string | undefined {
  return value === undefined ? undefined : normalizeRequired(value, label, maxLength);
}

export function normalizeLimit(value: number | undefined, max: number): number {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value)) throw new TypeError("Skill Hub list limit must be an integer.");
  return Math.max(1, Math.min(value, max));
}
