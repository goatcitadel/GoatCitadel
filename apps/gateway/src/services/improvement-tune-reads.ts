// P2-W3 — Close the improvement loop.
//
// The weekly self-improvement tuner (improvement-service.ts) WRITES three
// `system_settings` keys. Historically nothing READ them, so the loop never
// closed (a ghost write). This module is the single source of truth for those
// keys: their names, their safe defaults, and — crucially — how a raw stored
// value translates into a behaviour-affecting parameter consumed at the
// decision point each key is meant to influence.
//
// Design invariants:
//   * SAFE DEFAULT — when a key is unset, the resolver returns the value that
//     reproduces the *current* (pre-W3) runtime behaviour byte-for-byte. The
//     loop only changes behaviour once the tuner actually applies a tune.
//   * STORAGE-ONLY READS — every read goes through `SystemSettingsReader`,
//     which is the same store (`system_settings`) the tuner writes to. This
//     keeps `ImprovementService` storage-only (it owns the write/snapshot/
//     revert rail) while the chat-turn/repair code owns the reads.
//   * PURE TRANSLATION — the `resolve*` helpers are pure functions of the raw
//     value, so they are trivially testable and free of side effects.
//
// The three keys and their wired decision points:
//   improvement_tune_live_intent_threshold_v1  → buildRetrievalTrace (live-data
//       web-escalation gate, chat-turn-planning-helpers.ts).
//   improvement_tune_retry_threshold_v1        → the incomplete-completion
//       repair gate in chat-agent-orchestrator.ts (repairIncompleteAssistantCompletion).
//   improvement_tune_blocker_template_v1       → buildToolFailureGuidance
//       (blocked-tool explanation assembly, chat-agent-orchestrator.ts).

/**
 * The three setting keys the weekly tuner writes. Kept here (not imported from
 * improvement-service.ts) so the read side and the write side share a name
 * contract without a module cycle. Values mirror the constants in
 * improvement-service.ts (asserted by a co-located test).
 */
export const IMPROVEMENT_TUNE_SETTING_KEYS = {
  blockerTemplate: "improvement_tune_blocker_template_v1",
  retryThreshold: "improvement_tune_retry_threshold_v1",
  liveIntentThreshold: "improvement_tune_live_intent_threshold_v1",
} as const;

/**
 * Safe defaults — these MUST equal the defaults the tuner reads with `?? …`
 * when it computes the next value, so that "unset" and "first tune baseline"
 * agree, and so unset preserves current behaviour.
 */
export const IMPROVEMENT_TUNE_DEFAULTS = {
  /** Blocker-template strictness level (1..10). 1 = current generic guidance. */
  blockerTemplate: 1,
  /**
   * Retry/repair trigger threshold. 1 = current behaviour (the incomplete
   * completion gate fires exactly as before). 0 = widen so a turn that failed
   * even with a "complete" provider response also gets one repair pass.
   */
  retryThreshold: 1,
  /**
   * Live-data intent sensitivity (0..1). 0.6 = current behaviour (explicit
   * live-intent keywords escalate; nothing extra). Higher = escalate web
   * retrieval on borderline / lower-confidence turns too.
   */
  liveIntentThreshold: 0.6,
} as const;

/**
 * The narrow storage surface these reads need. Matches
 * `Storage["systemSettings"].get`, so callers can pass the repo directly.
 */
export interface SystemSettingsReader {
  get<T = unknown>(key: string): { value: T } | undefined;
}

function readNumericSetting(
  settings: SystemSettingsReader | undefined,
  key: string,
  fallback: number,
): number {
  if (!settings) {
    return fallback;
  }
  const raw = settings.get<unknown>(key)?.value;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  return fallback;
}

// ── Blocker-template strictness ──────────────────────────────────────────

/**
 * Resolve the blocker-template strictness level. Clamped to the same 1..10
 * band the tuner writes (`Math.min(10, current + 1)`), with the floor at 1 so
 * a stray smaller value can never *reduce* blocker specificity below baseline.
 */
export function resolveBlockerTemplateStrictness(raw: number): number {
  if (!Number.isFinite(raw)) {
    return IMPROVEMENT_TUNE_DEFAULTS.blockerTemplate;
  }
  const rounded = Math.round(raw);
  return Math.min(10, Math.max(1, rounded));
}

export function readBlockerTemplateStrictness(settings: SystemSettingsReader | undefined): number {
  return resolveBlockerTemplateStrictness(
    readNumericSetting(settings, IMPROVEMENT_TUNE_SETTING_KEYS.blockerTemplate, IMPROVEMENT_TUNE_DEFAULTS.blockerTemplate),
  );
}

/**
 * True when the strictness level is above baseline and a blocked/denied action
 * should carry the extra, more specific explanation. At the default level (1)
 * this is false and `buildToolFailureGuidance` returns its original text.
 */
export function shouldUseStrictBlockerTemplate(strictness: number): boolean {
  return strictness >= 2;
}

// ── Retry / repair trigger threshold ─────────────────────────────────────

/** Clamp the retry threshold to the band the tuner writes (`Math.max(0, current - 1)`). */
export function resolveRetryRepairThreshold(raw: number): number {
  if (!Number.isFinite(raw)) {
    return IMPROVEMENT_TUNE_DEFAULTS.retryThreshold;
  }
  return Math.max(0, Math.round(raw));
}

export function readRetryRepairThreshold(settings: SystemSettingsReader | undefined): number {
  return resolveRetryRepairThreshold(
    readNumericSetting(settings, IMPROVEMENT_TUNE_SETTING_KEYS.retryThreshold, IMPROVEMENT_TUNE_DEFAULTS.retryThreshold),
  );
}

/**
 * Decide whether the incomplete-completion repair pass should run.
 *
 * Current (default, threshold = 1) behaviour: repair only when the provider
 * response was actually incomplete/truncated. Lowering the threshold to 0
 * widens the gate so a turn that *failed* even though the completion came back
 * "complete" also gets one repair attempt — directly realising the tuner's
 * "attempt one repair more often" intent. This is purely additive: at the
 * default the result is identical to `completionIsIncomplete`.
 */
export function shouldAttemptIncompleteCompletionRepair(input: {
  completionIsIncomplete: boolean;
  turnFailed: boolean;
  retryThreshold: number;
}): boolean {
  if (input.completionIsIncomplete) {
    return true;
  }
  return input.retryThreshold <= 0 && input.turnFailed;
}

// ── Live-data intent sensitivity ─────────────────────────────────────────

/** Clamp the live-intent sensitivity to the [0,1] band the tuner writes (`Math.min(0.95, current + 0.05)`). */
export function resolveLiveIntentThreshold(raw: number): number {
  if (!Number.isFinite(raw)) {
    return IMPROVEMENT_TUNE_DEFAULTS.liveIntentThreshold;
  }
  return Math.min(1, Math.max(0, raw));
}

export function readLiveIntentThreshold(settings: SystemSettingsReader | undefined): number {
  return resolveLiveIntentThreshold(
    readNumericSetting(
      settings,
      IMPROVEMENT_TUNE_SETTING_KEYS.liveIntentThreshold,
      IMPROVEMENT_TUNE_DEFAULTS.liveIntentThreshold,
    ),
  );
}

/**
 * Decide whether layered retrieval should escalate to L2 (web) for a turn that
 * did NOT match an explicit live-intent keyword, based on the L1 retrieval
 * confidence and the tuned sensitivity.
 *
 * The tuner raises this threshold from the 0.6 baseline toward 0.95 when web
 * retrieval is firing too rarely. At the baseline (0.6) the comparison
 * reproduces the existing `l1Base < 0.55` escalation rule exactly, so unset /
 * default behaviour is unchanged. As sensitivity climbs, the L1-confidence bar
 * for escalating rises with it, so borderline turns escalate too.
 */
export function shouldEscalateForLiveIntentSensitivity(input: {
  l1Confidence: number;
  liveIntentThreshold: number;
}): boolean {
  // Baseline 0.6 → 0.55 cutoff (current behaviour). Each +0.05 of sensitivity
  // lifts the cutoff by 0.05, so a more sensitive setting escalates on higher
  // (less-bad) L1 confidence values too.
  const rawCutoff = 0.55 + (input.liveIntentThreshold - IMPROVEMENT_TUNE_DEFAULTS.liveIntentThreshold);
  // Cap the cutoff safely BELOW the normal "memory-on" L1 confidence floor
  // (0.78 in buildRetrievalTrace). Without this cap, a fully-tuned threshold
  // (0.95) lifts the cutoff to ~0.90 > 0.78, which would make EVERY memory-on
  // turn escalate to web/L2 — "always web" after a few tune steps. Capping keeps
  // tuning sharpening live-intent sensitivity (borderline / memory-off turns)
  // without forcing universal escalation of ordinary memory-backed turns.
  const escalationCutoff = Math.min(rawCutoff, LIVE_INTENT_ESCALATION_CUTOFF_CEILING);
  return input.l1Confidence < escalationCutoff;
}

/**
 * Upper bound on the live-intent escalation cutoff. Sits just under the
 * normal+memory `l1Base` (0.78) computed in `buildRetrievalTrace`, so a tuned
 * threshold can never escalate an ordinary memory-backed turn purely on
 * confidence. (Live-intent keyword turns still escalate via their own branch.)
 */
export const LIVE_INTENT_ESCALATION_CUTOFF_CEILING = 0.74;
