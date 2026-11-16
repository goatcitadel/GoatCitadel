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

export function isCanonicalIntentString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.normalize("NFKC").trim() === value
  );
}

export function isOptionalCanonicalIntentString(value: unknown, maxLength: number): value is string | undefined {
  return value === undefined || isCanonicalIntentString(value, maxLength);
}

export function isOptionalPositiveRevision(value: unknown): value is number | undefined {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) > 0);
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export function isCanonicalIsoDateTime(value: unknown): value is string {
  if (!isCanonicalIntentString(value, 64)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
