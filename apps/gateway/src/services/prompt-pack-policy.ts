import {
  DEFAULT_PROMPT_PACK_POLICY_V2,
  type PromptPackScoreDimensionV2,
  type PromptPackScoreDimensionV3,
  type PromptPackScoringSchemaVersion,
} from "@goatcitadel/contracts";

export const PROMPT_PACK_PASS_THRESHOLD = 7;
export const PROMPT_PACK_CAPABILITY_KEYS = ["routing", "honesty", "handoff", "robustness", "usability"] as const;
export const PROMPT_PACK_V2_DIMENSIONS = [
  "taskSuccess",
  "honesty",
  "executionQuality",
  "robustness",
  "usability",
] as const satisfies readonly PromptPackScoreDimensionV2[];
export const PROMPT_PACK_V2_SCHEMA_VERSION = "v2";
export const PROMPT_PACK_V2_SCORER_VERSION = "2026-04-16.2";
export const PROMPT_PACK_V2_JUDGE_RUBRIC_VERSION = "2026-04-09.1";
export const PROMPT_PACK_V3_SCHEMA_VERSION = "v3";
export const PROMPT_PACK_V3_SCORER_VERSION = "2026-05-v3.1";
export const PROMPT_PACK_V3_JUDGE_RUBRIC_VERSION = "outcome-execution-attribution-2026-05";
export const PROMPT_PACK_V2_PASS_THRESHOLD = DEFAULT_PROMPT_PACK_POLICY_V2.threshold;
export const PROMPT_PACK_V2_SCORING_ENABLED_ENV = "PROMPT_PACK_V2_SCORING_ENABLED";
export const PROMPT_PACK_DEFAULT_SCORING_SCHEMA_VERSION: PromptPackScoringSchemaVersion = PROMPT_PACK_V3_SCHEMA_VERSION;
export const PROMPT_PACK_V3_OUTCOME_DIMENSIONS = [
  "taskSuccess",
  "truthfulness",
  "evidenceGrounding",
  "formatAdherence",
  "operatorUsefulness",
] as const;
export const PROMPT_PACK_V3_EXECUTION_DIMENSIONS = [
  "toolUseQuality",
  "orchestrationQuality",
  "efficiency",
  "recoveryQuality",
] as const;
export const PROMPT_PACK_V3_DIMENSIONS = [
  ...PROMPT_PACK_V3_OUTCOME_DIMENSIONS,
  ...PROMPT_PACK_V3_EXECUTION_DIMENSIONS,
] as const satisfies readonly PromptPackScoreDimensionV3[];
export const PROMPT_PACK_BENCHMARK_MAX_FAILURE_SIGNALS = 5;
export const PROMPT_PACK_BENCHMARK_MAX_TESTS = 200;
export const PROMPT_PACK_BENCHMARK_MAX_PROVIDERS = 10;
export const PROMPT_PACK_BENCHMARK_MAX_CONCURRENCY = 4;
export const PROMPT_PACK_BENCHMARK_CLAIM_TTL_MS = 120_000;
export const PROMPT_PACK_BENCHMARK_CLAIM_HEARTBEAT_MS = 30_000;
export const DEFAULT_PROMPT_PACK_EXPORT_DIR = "artifacts/prompt-lab";
export const DEFAULT_PROMPT_PACK_EXPORT_ARCHIVE_DIR = "runs";
