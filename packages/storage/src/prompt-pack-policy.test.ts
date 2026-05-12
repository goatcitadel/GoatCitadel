import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PROMPT_PACK_POLICY_V2,
  DEFAULT_PROMPT_PACK_POLICY_V3,
  type PromptPackPolicyV2,
  type PromptPackPolicyV3,
} from "@goatcitadel/contracts";
import {
  hashPromptPackPolicyV2,
  hashPromptPackPolicyV3,
  normalizePromptPackPolicyV2,
  normalizePromptPackPolicyV3,
  parsePromptPackPolicyV2,
  parsePromptPackPolicyV3,
  stringifyPromptPackPolicyV2,
  stringifyPromptPackPolicyV3,
} from "./prompt-pack-policy.js";

test("normalizes, stringifies, parses, and hashes v2 prompt-pack policies canonically", () => {
  const messyPolicy = {
    scoringSchemaVersion: "v2",
    threshold: 80,
    weights: {
      usability: 5,
      robustness: 15,
      executionQuality: 20,
      honesty: 25,
      taskSuccess: 35,
    },
    minScores: {
      usability: null,
      honesty: 2,
      taskSuccess: 3,
    },
    judgeRequired: true,
    reviewOnDisagreementAt: 2,
    criticalDimensionsMustBeApplicable: true,
    hardFailSignals: ["run_failed", "tool_tier_violation"],
    ignored: "dropped",
  };

  const normalized = normalizePromptPackPolicyV2(messyPolicy);
  const reorderedPolicy: PromptPackPolicyV2 = {
    scoringSchemaVersion: "v2",
    threshold: 80,
    weights: {
      usability: 5,
      robustness: 15,
      executionQuality: 20,
      honesty: 25,
      taskSuccess: 35,
    },
    minScores: {
      honesty: 2,
      taskSuccess: 3,
    },
    judgeRequired: true,
    reviewOnDisagreementAt: 2,
    criticalDimensionsMustBeApplicable: true,
    hardFailSignals: ["run_failed", "tool_tier_violation"],
  };

  assert.deepEqual(normalized, {
    scoringSchemaVersion: "v2",
    threshold: 80,
    weights: {
      taskSuccess: 35,
      honesty: 25,
      executionQuality: 20,
      robustness: 15,
      usability: 5,
    },
    minScores: {
      taskSuccess: 3,
      honesty: 2,
    },
    judgeRequired: true,
    reviewOnDisagreementAt: 2,
    criticalDimensionsMustBeApplicable: true,
    hardFailSignals: ["run_failed", "tool_tier_violation"],
  });
  assert.deepEqual(parsePromptPackPolicyV2(stringifyPromptPackPolicyV2(reorderedPolicy)), normalized);
  assert.match(hashPromptPackPolicyV2(normalized), /^[a-f0-9]{64}$/);
  assert.equal(hashPromptPackPolicyV2(normalized), hashPromptPackPolicyV2(reorderedPolicy));
});

test("normalizes v2 policies with omitted min scores", () => {
  const withoutMinScores = {
    ...DEFAULT_PROMPT_PACK_POLICY_V2,
    minScores: undefined,
  };
  const withNullMinScores = {
    ...DEFAULT_PROMPT_PACK_POLICY_V2,
    minScores: null,
  };

  assert.deepEqual(normalizePromptPackPolicyV2(withoutMinScores).minScores, {});
  assert.deepEqual(normalizePromptPackPolicyV2(withNullMinScores).minScores, {});
});

test("returns undefined for absent or malformed v2 policy JSON", () => {
  assert.equal(parsePromptPackPolicyV2(), undefined);
  assert.equal(parsePromptPackPolicyV2(null), undefined);
  assert.equal(parsePromptPackPolicyV2(""), undefined);
  assert.equal(parsePromptPackPolicyV2("{not-json"), undefined);
  assert.equal(parsePromptPackPolicyV2(JSON.stringify({ scoringSchemaVersion: "v3" })), undefined);
});

test("rejects malformed v2 policy fields with explicit errors", () => {
  const base = DEFAULT_PROMPT_PACK_POLICY_V2;

  assert.throws(() => normalizePromptPackPolicyV2(null), /must be a v2 object/);
  assert.throws(() => normalizePromptPackPolicyV2([]), /must be a v2 object/);
  assert.throws(() => normalizePromptPackPolicyV2({ ...base, threshold: Number.NaN }), /threshold/);
  assert.throws(() => normalizePromptPackPolicyV2({ ...base, judgeRequired: "yes" }), /judgeRequired/);
  assert.throws(
    () => normalizePromptPackPolicyV2({ ...base, criticalDimensionsMustBeApplicable: 1 }),
    /criticalDimensions/,
  );
  assert.throws(() => normalizePromptPackPolicyV2({ ...base, weights: null }), /weights must be an object/);
  assert.throws(
    () => normalizePromptPackPolicyV2({ ...base, weights: { ...base.weights, taskSuccess: Infinity } }),
    /weights\.taskSuccess/,
  );
  assert.throws(() => normalizePromptPackPolicyV2({ ...base, minScores: "bad" }), /minScores must be an object/);
  assert.throws(
    () => normalizePromptPackPolicyV2({ ...base, minScores: { taskSuccess: 4.5 } }),
    /minScores\.taskSuccess/,
  );
  assert.throws(() => normalizePromptPackPolicyV2({ ...base, hardFailSignals: "run_failed" }), /hardFailSignals/);
  assert.throws(() => normalizePromptPackPolicyV2({ ...base, hardFailSignals: ["not_real"] }), /hardFailSignals\[0\]/);
});

test("normalizes, stringifies, parses, and hashes v3 prompt-pack policies canonically", () => {
  const messyPolicy = {
    scoringSchemaVersion: "v3",
    threshold: 81,
    weights: {
      recoveryQuality: 4,
      efficiency: 3,
      orchestrationQuality: 6,
      toolUseQuality: 8,
      operatorUsefulness: 12,
      formatAdherence: 10,
      evidenceGrounding: 12,
      truthfulness: 20,
      taskSuccess: 25,
    },
    minScores: {
      evidenceGrounding: 2,
      truthfulness: 3,
      taskSuccess: 3,
      recoveryQuality: null,
    },
    judgeRequired: true,
    reviewOnDisagreementAt: 2,
    criticalDimensionsMustBeApplicable: true,
    hardFailSignals: ["run_failed", "judge_timeout"],
    attributionRequiredFor: ["review", "fail"],
    ignored: "dropped",
  };

  const normalized = normalizePromptPackPolicyV3(messyPolicy);
  const reorderedPolicy: PromptPackPolicyV3 = {
    scoringSchemaVersion: "v3",
    threshold: 81,
    weights: {
      recoveryQuality: 4,
      efficiency: 3,
      orchestrationQuality: 6,
      toolUseQuality: 8,
      operatorUsefulness: 12,
      formatAdherence: 10,
      evidenceGrounding: 12,
      truthfulness: 20,
      taskSuccess: 25,
    },
    minScores: {
      evidenceGrounding: 2,
      truthfulness: 3,
      taskSuccess: 3,
    },
    judgeRequired: true,
    reviewOnDisagreementAt: 2,
    criticalDimensionsMustBeApplicable: true,
    hardFailSignals: ["run_failed", "judge_timeout"],
    attributionRequiredFor: ["review", "fail"],
  };

  assert.deepEqual(normalized, {
    scoringSchemaVersion: "v3",
    threshold: 81,
    weights: {
      taskSuccess: 25,
      truthfulness: 20,
      evidenceGrounding: 12,
      formatAdherence: 10,
      operatorUsefulness: 12,
      toolUseQuality: 8,
      orchestrationQuality: 6,
      efficiency: 3,
      recoveryQuality: 4,
    },
    minScores: {
      taskSuccess: 3,
      truthfulness: 3,
      evidenceGrounding: 2,
    },
    judgeRequired: true,
    reviewOnDisagreementAt: 2,
    criticalDimensionsMustBeApplicable: true,
    hardFailSignals: ["run_failed", "judge_timeout"],
    attributionRequiredFor: ["review", "fail"],
  });
  assert.deepEqual(parsePromptPackPolicyV3(stringifyPromptPackPolicyV3(reorderedPolicy)), normalized);
  assert.match(hashPromptPackPolicyV3(normalized), /^[a-f0-9]{64}$/);
  assert.equal(hashPromptPackPolicyV3(normalized), hashPromptPackPolicyV3(reorderedPolicy));
});

test("returns undefined for absent or malformed v3 policy JSON", () => {
  assert.equal(parsePromptPackPolicyV3(), undefined);
  assert.equal(parsePromptPackPolicyV3(null), undefined);
  assert.equal(parsePromptPackPolicyV3(""), undefined);
  assert.equal(parsePromptPackPolicyV3("{not-json"), undefined);
  assert.equal(parsePromptPackPolicyV3(JSON.stringify({ scoringSchemaVersion: "v2" })), undefined);
});

test("rejects malformed v3 policy fields with explicit errors", () => {
  const base = DEFAULT_PROMPT_PACK_POLICY_V3;

  assert.throws(() => normalizePromptPackPolicyV3(undefined), /must be a v3 object/);
  assert.throws(() => normalizePromptPackPolicyV3({ ...base, threshold: "80" }), /threshold/);
  assert.throws(
    () => normalizePromptPackPolicyV3({ ...base, reviewOnDisagreementAt: Number.POSITIVE_INFINITY }),
    /reviewOnDisagreementAt/,
  );
  assert.throws(() => normalizePromptPackPolicyV3({ ...base, judgeRequired: 1 }), /judgeRequired/);
  assert.throws(
    () => normalizePromptPackPolicyV3({ ...base, criticalDimensionsMustBeApplicable: "true" }),
    /criticalDimensions/,
  );
  assert.throws(() => normalizePromptPackPolicyV3({ ...base, weights: [] }), /weights must be an object/);
  assert.throws(
    () => normalizePromptPackPolicyV3({ ...base, weights: { ...base.weights, recoveryQuality: undefined } }),
    /weights\.recoveryQuality/,
  );
  assert.throws(() => normalizePromptPackPolicyV3({ ...base, minScores: [] }), /minScores must be an object/);
  assert.throws(
    () => normalizePromptPackPolicyV3({ ...base, minScores: { truthfulness: 5 } }),
    /minScores\.truthfulness/,
  );
  assert.throws(() => normalizePromptPackPolicyV3({ ...base, hardFailSignals: null }), /hardFailSignals/);
  assert.throws(() => normalizePromptPackPolicyV3({ ...base, hardFailSignals: [1] }), /hardFailSignals\[0\]/);
  assert.throws(
    () => normalizePromptPackPolicyV3({ ...base, attributionRequiredFor: "fail" }),
    /attributionRequiredFor/,
  );
  assert.throws(
    () => normalizePromptPackPolicyV3({ ...base, attributionRequiredFor: ["pass"] }),
    /attributionRequiredFor\[0\]/,
  );
});
