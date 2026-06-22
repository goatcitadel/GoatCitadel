import { describe, expect, it } from "vitest";
import {
  IMPROVEMENT_TUNE_DEFAULTS,
  IMPROVEMENT_TUNE_SETTING_KEYS,
  type SystemSettingsReader,
  readBlockerTemplateStrictness,
  readLiveIntentThreshold,
  readRetryRepairThreshold,
  resolveBlockerTemplateStrictness,
  resolveLiveIntentThreshold,
  resolveRetryRepairThreshold,
  shouldAttemptIncompleteCompletionRepair,
  shouldEscalateForLiveIntentSensitivity,
  shouldUseStrictBlockerTemplate,
} from "./improvement-tune-reads.js";

function settingsWith(values: Record<string, unknown>): SystemSettingsReader {
  return {
    get<T = unknown>(key: string): { value: T } | undefined {
      if (!(key in values)) {
        return undefined;
      }
      return { value: values[key] as T };
    },
  };
}

describe("improvement-tune-reads: key/name contract", () => {
  // Asserts the read side and the write side agree on the setting names. If the
  // tuner's consts in improvement-service.ts drift, this fails loudly so the
  // loop cannot silently re-open (write key A, read key B).
  it("uses the exact setting keys the weekly tuner writes", () => {
    expect(IMPROVEMENT_TUNE_SETTING_KEYS.blockerTemplate).toBe("improvement_tune_blocker_template_v1");
    expect(IMPROVEMENT_TUNE_SETTING_KEYS.retryThreshold).toBe("improvement_tune_retry_threshold_v1");
    expect(IMPROVEMENT_TUNE_SETTING_KEYS.liveIntentThreshold).toBe("improvement_tune_live_intent_threshold_v1");
  });

  it("uses defaults that match the tuner's `?? <default>` baselines", () => {
    // improvement-service.ts reads each key with these fallbacks when computing
    // the next value, so unset must resolve to the same baseline.
    expect(IMPROVEMENT_TUNE_DEFAULTS.blockerTemplate).toBe(1);
    expect(IMPROVEMENT_TUNE_DEFAULTS.retryThreshold).toBe(1);
    expect(IMPROVEMENT_TUNE_DEFAULTS.liveIntentThreshold).toBe(0.6);
  });
});

describe("improvement-tune-reads: safe defaults preserve current behaviour", () => {
  it("returns the safe default when the store is undefined", () => {
    expect(readBlockerTemplateStrictness(undefined)).toBe(1);
    expect(readRetryRepairThreshold(undefined)).toBe(1);
    expect(readLiveIntentThreshold(undefined)).toBe(0.6);
  });

  it("returns the safe default when the key is unset", () => {
    const settings = settingsWith({});
    expect(readBlockerTemplateStrictness(settings)).toBe(1);
    expect(readRetryRepairThreshold(settings)).toBe(1);
    expect(readLiveIntentThreshold(settings)).toBe(0.6);
  });

  it("ignores non-numeric / non-finite stored values and falls back to the default", () => {
    const settings = settingsWith({
      [IMPROVEMENT_TUNE_SETTING_KEYS.blockerTemplate]: "loud",
      [IMPROVEMENT_TUNE_SETTING_KEYS.retryThreshold]: null,
      [IMPROVEMENT_TUNE_SETTING_KEYS.liveIntentThreshold]: Number.NaN,
    });
    expect(readBlockerTemplateStrictness(settings)).toBe(1);
    expect(readRetryRepairThreshold(settings)).toBe(1);
    expect(readLiveIntentThreshold(settings)).toBe(0.6);
  });
});

describe("improvement-tune-reads: reads the tuned value", () => {
  it("reads an applied blocker-template strictness", () => {
    const settings = settingsWith({ [IMPROVEMENT_TUNE_SETTING_KEYS.blockerTemplate]: 4 });
    expect(readBlockerTemplateStrictness(settings)).toBe(4);
  });

  it("reads an applied (lowered) retry threshold", () => {
    const settings = settingsWith({ [IMPROVEMENT_TUNE_SETTING_KEYS.retryThreshold]: 0 });
    expect(readRetryRepairThreshold(settings)).toBe(0);
  });

  it("reads an applied (raised) live-intent threshold", () => {
    const settings = settingsWith({ [IMPROVEMENT_TUNE_SETTING_KEYS.liveIntentThreshold]: 0.85 });
    expect(readLiveIntentThreshold(settings)).toBe(0.85);
  });
});

describe("improvement-tune-reads: clamping matches the tuner's write bands", () => {
  it("clamps blocker strictness to 1..10", () => {
    expect(resolveBlockerTemplateStrictness(0)).toBe(1);
    expect(resolveBlockerTemplateStrictness(-5)).toBe(1);
    expect(resolveBlockerTemplateStrictness(11)).toBe(10);
    expect(resolveBlockerTemplateStrictness(3.4)).toBe(3);
  });

  it("clamps retry threshold to >= 0", () => {
    expect(resolveRetryRepairThreshold(-3)).toBe(0);
    expect(resolveRetryRepairThreshold(2.6)).toBe(3);
  });

  it("clamps live-intent threshold to [0,1]", () => {
    expect(resolveLiveIntentThreshold(-0.2)).toBe(0);
    expect(resolveLiveIntentThreshold(1.5)).toBe(1);
    expect(resolveLiveIntentThreshold(0.6)).toBe(0.6);
  });
});

describe("shouldUseStrictBlockerTemplate", () => {
  it("is off at the baseline level (1) and on once the tuner raises it", () => {
    expect(shouldUseStrictBlockerTemplate(1)).toBe(false);
    expect(shouldUseStrictBlockerTemplate(2)).toBe(true);
    expect(shouldUseStrictBlockerTemplate(10)).toBe(true);
  });
});

describe("shouldAttemptIncompleteCompletionRepair", () => {
  it("default threshold (1) is byte-identical to `completionIsIncomplete`", () => {
    // Incomplete completion always repairs, regardless of threshold.
    expect(
      shouldAttemptIncompleteCompletionRepair({ completionIsIncomplete: true, turnFailed: false, retryThreshold: 1 }),
    ).toBe(true);
    // Complete completion at the default threshold never adds a repair — even a
    // failed-but-complete turn (current behaviour).
    expect(
      shouldAttemptIncompleteCompletionRepair({ completionIsIncomplete: false, turnFailed: true, retryThreshold: 1 }),
    ).toBe(false);
    expect(
      shouldAttemptIncompleteCompletionRepair({ completionIsIncomplete: false, turnFailed: false, retryThreshold: 1 }),
    ).toBe(false);
  });

  it("lowered threshold (0) widens to failed-but-complete turns", () => {
    expect(
      shouldAttemptIncompleteCompletionRepair({ completionIsIncomplete: false, turnFailed: true, retryThreshold: 0 }),
    ).toBe(true);
    // A successful, complete turn is still never repaired even at threshold 0.
    expect(
      shouldAttemptIncompleteCompletionRepair({ completionIsIncomplete: false, turnFailed: false, retryThreshold: 0 }),
    ).toBe(false);
  });
});

describe("shouldEscalateForLiveIntentSensitivity", () => {
  it("at the 0.6 baseline reproduces the existing l1<0.55 escalation rule", () => {
    expect(shouldEscalateForLiveIntentSensitivity({ l1Confidence: 0.2, liveIntentThreshold: 0.6 })).toBe(true);
    expect(shouldEscalateForLiveIntentSensitivity({ l1Confidence: 0.54, liveIntentThreshold: 0.6 })).toBe(true);
    expect(shouldEscalateForLiveIntentSensitivity({ l1Confidence: 0.55, liveIntentThreshold: 0.6 })).toBe(false);
    expect(shouldEscalateForLiveIntentSensitivity({ l1Confidence: 0.78, liveIntentThreshold: 0.6 })).toBe(false);
  });

  it("a raised sensitivity escalates on higher (less-bad) L1 confidence too", () => {
    // At 0.78 the cutoff lifts to 0.55 + (0.78 - 0.6) = 0.73, so the standard
    // memory-on L1 base (0.78) still does NOT escalate, but a 0.7 confidence does.
    expect(shouldEscalateForLiveIntentSensitivity({ l1Confidence: 0.7, liveIntentThreshold: 0.78 })).toBe(true);
    expect(shouldEscalateForLiveIntentSensitivity({ l1Confidence: 0.78, liveIntentThreshold: 0.78 })).toBe(false);
  });

  it("at the MAX tuned threshold (0.95) does NOT force every memory-on turn to escalate", () => {
    // Regression: the raw cutoff at 0.95 is 0.55 + 0.35 = 0.90 > the normal
    // memory-on l1Base (0.78). Without the cap that made EVERY memory-on turn
    // escalate ("always web"). The cutoff is capped just below 0.78, so:
    //   - normal+memory turns (l1Base 0.78) do NOT escalate on confidence alone,
    const maxThreshold = resolveLiveIntentThreshold(1); // tuner clamps to 0.95-ish band; 1 → 1, cap still applies
    expect(shouldEscalateForLiveIntentSensitivity({ l1Confidence: 0.78, liveIntentThreshold: maxThreshold })).toBe(
      false,
    );
    expect(shouldEscalateForLiveIntentSensitivity({ l1Confidence: 0.78, liveIntentThreshold: 0.95 })).toBe(false);
    //   - but weak/memory-off turns (l1Base 0.2, or borderline 0.64) still do.
    expect(shouldEscalateForLiveIntentSensitivity({ l1Confidence: 0.2, liveIntentThreshold: 0.95 })).toBe(true);
    expect(shouldEscalateForLiveIntentSensitivity({ l1Confidence: 0.64, liveIntentThreshold: 0.95 })).toBe(true);
  });
});

// Integration-flavoured guard: drive the actual buildRetrievalTrace decision at
// the max tuned threshold and assert ordinary memory-on turns are not all forced
// to web/L2. This protects the *wiring* (cutoff vs l1Base) end to end.
describe("buildRetrievalTrace live-intent escalation under a fully-tuned threshold", () => {
  it("does not escalate an ordinary memory-on, non-live-intent turn at threshold 0.95", async () => {
    const { buildRetrievalTrace } = await import("./chat-turn-planning-helpers.js");
    const trace = buildRetrievalTrace({
      content: "Summarize my notes about the project plan.",
      retrievalMode: "layered",
      memoryMode: "on",
      webMode: "auto",
      liveIntentThreshold: 0.95,
    });
    expect(trace.confidenceL1).toBe(0.78);
    expect(trace.l2Used).toBe(false);
    expect(trace.escalationReason).toBeUndefined();
  });

  it("still escalates an explicit live-intent turn at threshold 0.95", async () => {
    const { buildRetrievalTrace } = await import("./chat-turn-planning-helpers.js");
    const trace = buildRetrievalTrace({
      content: "What is the latest price right now?",
      retrievalMode: "layered",
      memoryMode: "on",
      webMode: "auto",
      liveIntentThreshold: 0.95,
    });
    expect(trace.l2Used).toBe(true);
    expect(trace.escalationReason).toBe("explicit_live_data_intent");
  });
});
