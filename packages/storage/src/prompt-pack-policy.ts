import { createHash } from "node:crypto";
import type {
  PromptPackDimensionScoreV2,
  PromptPackDimensionScoreV3,
  PromptPackPolicyV2,
  PromptPackPolicyV3,
  PromptPackReasonCode,
  PromptPackScoreDimensionV2,
  PromptPackScoreDimensionV3,
} from "@goatcitadel/contracts";

const PROMPT_PACK_DIMENSIONS: readonly PromptPackScoreDimensionV2[] = [
  "taskSuccess",
  "honesty",
  "executionQuality",
  "robustness",
  "usability",
];

const PROMPT_PACK_V3_DIMENSIONS: readonly PromptPackScoreDimensionV3[] = [
  "taskSuccess",
  "truthfulness",
  "evidenceGrounding",
  "formatAdherence",
  "operatorUsefulness",
  "toolUseQuality",
  "orchestrationQuality",
  "efficiency",
  "recoveryQuality",
];

const PROMPT_PACK_REASON_CODES = new Set<PromptPackReasonCode>([
  "tool_tier_violation",
  "unsupported_access_claim",
  "run_failed",
  "approval_paused",
  "missing_required_json",
  "missing_required_table",
  "missing_required_citation_evidence",
  "self_reported_incomplete",
  "off_target_meta_analysis",
  "judge_fallback",
  "judge_schema_repair",
  "judge_invalid",
  "judge_timeout",
  "major_disagreement",
  "critical_dimension_not_applicable",
]);

const PROMPT_PACK_POLICY_V2_NORMALIZED_KEYS = {
  scoringSchemaVersion: true,
  threshold: true,
  weights: true,
  minScores: true,
  judgeRequired: true,
  reviewOnDisagreementAt: true,
  criticalDimensionsMustBeApplicable: true,
  hardFailSignals: true,
} satisfies Record<keyof PromptPackPolicyV2, true>;

const PROMPT_PACK_POLICY_V3_NORMALIZED_KEYS = {
  scoringSchemaVersion: true,
  threshold: true,
  weights: true,
  minScores: true,
  judgeRequired: true,
  reviewOnDisagreementAt: true,
  criticalDimensionsMustBeApplicable: true,
  hardFailSignals: true,
  attributionRequiredFor: true,
} satisfies Record<keyof PromptPackPolicyV3, true>;

export function parsePromptPackPolicyV2(raw?: string | null): PromptPackPolicyV2 | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    return normalizePromptPackPolicyV2(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function normalizePromptPackPolicyV2(value: unknown): PromptPackPolicyV2 {
  if (!isRecord(value) || value.scoringSchemaVersion !== "v2") {
    throw new Error("Prompt-pack policy must be a v2 object.");
  }
  const threshold = readFiniteNumber(value.threshold, "threshold");
  const reviewOnDisagreementAt = readFiniteNumber(value.reviewOnDisagreementAt, "reviewOnDisagreementAt");
  const judgeRequired = readBoolean(value.judgeRequired, "judgeRequired");
  const criticalDimensionsMustBeApplicable = readBoolean(
    value.criticalDimensionsMustBeApplicable,
    "criticalDimensionsMustBeApplicable",
  );
  const weights = normalizeDimensionNumberRecord(value.weights, "weights");
  const minScores = normalizeDimensionScoreRecord(value.minScores);
  const hardFailSignals = normalizeReasonCodes(value.hardFailSignals);
  void PROMPT_PACK_POLICY_V2_NORMALIZED_KEYS;

  return {
    scoringSchemaVersion: "v2",
    threshold,
    weights,
    minScores,
    judgeRequired,
    reviewOnDisagreementAt,
    criticalDimensionsMustBeApplicable,
    hardFailSignals,
  };
}

export function stringifyPromptPackPolicyV2(policy: PromptPackPolicyV2): string {
  return JSON.stringify(normalizePromptPackPolicyV2(policy));
}

export function hashPromptPackPolicyV2(policy: PromptPackPolicyV2): string {
  return createHash("sha256").update(stringifyPromptPackPolicyV2(policy)).digest("hex");
}

export function parsePromptPackPolicyV3(raw?: string | null): PromptPackPolicyV3 | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    return normalizePromptPackPolicyV3(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function normalizePromptPackPolicyV3(value: unknown): PromptPackPolicyV3 {
  if (!isRecord(value) || value.scoringSchemaVersion !== "v3") {
    throw new Error("Prompt-pack policy must be a v3 object.");
  }
  const threshold = readFiniteNumber(value.threshold, "threshold");
  const reviewOnDisagreementAt = readFiniteNumber(value.reviewOnDisagreementAt, "reviewOnDisagreementAt");
  const judgeRequired = readBoolean(value.judgeRequired, "judgeRequired");
  const criticalDimensionsMustBeApplicable = readBoolean(
    value.criticalDimensionsMustBeApplicable,
    "criticalDimensionsMustBeApplicable",
  );
  const weights = normalizeDimensionNumberRecordV3(value.weights, "weights");
  const minScores = normalizeDimensionScoreRecordV3(value.minScores);
  const hardFailSignals = normalizeReasonCodes(value.hardFailSignals);
  const attributionRequiredFor = normalizeAttributionRequiredFor(value.attributionRequiredFor);
  void PROMPT_PACK_POLICY_V3_NORMALIZED_KEYS;

  return {
    scoringSchemaVersion: "v3",
    threshold,
    weights,
    minScores,
    judgeRequired,
    reviewOnDisagreementAt,
    criticalDimensionsMustBeApplicable,
    hardFailSignals,
    attributionRequiredFor,
  };
}

export function stringifyPromptPackPolicyV3(policy: PromptPackPolicyV3): string {
  return JSON.stringify(normalizePromptPackPolicyV3(policy));
}

export function hashPromptPackPolicyV3(policy: PromptPackPolicyV3): string {
  return createHash("sha256").update(stringifyPromptPackPolicyV3(policy)).digest("hex");
}

function normalizeDimensionNumberRecord(value: unknown, fieldName: string): Record<PromptPackScoreDimensionV2, number> {
  if (!isRecord(value)) {
    throw new Error(`Prompt-pack policy ${fieldName} must be an object.`);
  }
  return {
    taskSuccess: readFiniteNumber(value.taskSuccess, `${fieldName}.taskSuccess`),
    honesty: readFiniteNumber(value.honesty, `${fieldName}.honesty`),
    executionQuality: readFiniteNumber(value.executionQuality, `${fieldName}.executionQuality`),
    robustness: readFiniteNumber(value.robustness, `${fieldName}.robustness`),
    usability: readFiniteNumber(value.usability, `${fieldName}.usability`),
  };
}

function normalizeDimensionNumberRecordV3(
  value: unknown,
  fieldName: string,
): Record<PromptPackScoreDimensionV3, number> {
  if (!isRecord(value)) {
    throw new Error(`Prompt-pack policy ${fieldName} must be an object.`);
  }
  const normalized = {} as Record<PromptPackScoreDimensionV3, number>;
  for (const dimension of PROMPT_PACK_V3_DIMENSIONS) {
    normalized[dimension] = readFiniteNumber(value[dimension], `${fieldName}.${dimension}`);
  }
  return normalized;
}

function normalizeDimensionScoreRecord(
  value: unknown,
): Partial<Record<PromptPackScoreDimensionV2, PromptPackDimensionScoreV2>> {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("Prompt-pack policy minScores must be an object.");
  }
  const normalized: Partial<Record<PromptPackScoreDimensionV2, PromptPackDimensionScoreV2>> = {};
  for (const dimension of PROMPT_PACK_DIMENSIONS) {
    const rawScore = value[dimension];
    if (rawScore === undefined || rawScore === null) {
      continue;
    }
    normalized[dimension] = readDimensionScore(rawScore, `minScores.${dimension}`);
  }
  return normalized;
}

function normalizeDimensionScoreRecordV3(
  value: unknown,
): Partial<Record<PromptPackScoreDimensionV3, PromptPackDimensionScoreV3>> {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("Prompt-pack policy minScores must be an object.");
  }
  const normalized: Partial<Record<PromptPackScoreDimensionV3, PromptPackDimensionScoreV3>> = {};
  for (const dimension of PROMPT_PACK_V3_DIMENSIONS) {
    const rawScore = value[dimension];
    if (rawScore === undefined || rawScore === null) {
      continue;
    }
    normalized[dimension] = readDimensionScore(rawScore, `minScores.${dimension}`) as PromptPackDimensionScoreV3;
  }
  return normalized;
}

function normalizeAttributionRequiredFor(value: unknown): Array<"review" | "fail"> {
  if (!Array.isArray(value)) {
    throw new Error("Prompt-pack policy attributionRequiredFor must be an array.");
  }
  return value.map((entry, index) => {
    if (entry !== "review" && entry !== "fail") {
      throw new Error(`Prompt-pack policy attributionRequiredFor[${index}] is invalid.`);
    }
    return entry;
  });
}

function normalizeReasonCodes(value: unknown): PromptPackReasonCode[] {
  if (!Array.isArray(value)) {
    throw new Error("Prompt-pack policy hardFailSignals must be an array.");
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || !PROMPT_PACK_REASON_CODES.has(entry as PromptPackReasonCode)) {
      throw new Error(`Prompt-pack policy hardFailSignals[${index}] is invalid.`);
    }
    return entry as PromptPackReasonCode;
  });
}

function readFiniteNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Prompt-pack policy ${fieldName} must be a finite number.`);
  }
  return value;
}

function readBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Prompt-pack policy ${fieldName} must be a boolean.`);
  }
  return value;
}

function readDimensionScore(value: unknown, fieldName: string): PromptPackDimensionScoreV2 {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 4) {
    throw new Error(`Prompt-pack policy ${fieldName} must be an integer score from 0 to 4.`);
  }
  return value as PromptPackDimensionScoreV2;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
