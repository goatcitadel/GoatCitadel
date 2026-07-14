import { canonicalJsonString } from "@goatcitadel/contracts";
import { estimateTokensFromText } from "@goatcitadel/memory-core";

const DEFAULT_OUTPUT_CAP_SAFETY_MARGIN_TOKENS = 64;
const MAX_PROVIDER_TOKEN_VALUE = 10_000_000;

export type OutputCapRecoveryRejectReason =
  | "not_output_cap_error"
  | "provider_evidence_contradictory"
  | "provider_availability_missing"
  | "configured_context_window_missing"
  | "current_effective_cap_unknown"
  | "invalid_request_estimate"
  | "request_estimate_exhausts_context"
  | "retry_cap_below_minimum"
  | "retry_cap_below_provider_minimum"
  | "retry_would_not_reduce_cap";

export interface OutputCapRecoveryEvidence {
  providerAvailableOutputTokens: number;
  providerMinimumOutputTokens?: number;
  providerReportedRequestedOutputTokens?: number;
  providerReportedContextWindowTokens?: number;
  providerReportedInputTokens?: number;
  format: "anthropic_equation" | "bounded_range" | "context_breakdown" | "character_prompt" | "vllm_context";
}

export type OutputCapRecoveryDecision =
  | {
      retry: false;
      reasonCode: OutputCapRecoveryRejectReason;
      evidence?: OutputCapRecoveryEvidence;
    }
  | {
      retry: true;
      reasonCode: "safe_lower_cap";
      requestedOutputTokenCap?: number;
      priorEffectiveOutputTokenCap: number;
      effectiveOutputTokenCap: number;
      providerAvailableOutputTokens: number;
      providerMinimumOutputTokens?: number;
      requestInputTokenEstimate: number;
      configuredContextWindowTokens: number;
      safetyMarginTokens: number;
      evidenceFormat: OutputCapRecoveryEvidence["format"];
    };

export interface ResolveOutputCapRecoveryInput {
  errorText: string;
  /** Original caller request, retained across all transport retries. */
  requestedOutputTokenCap?: number;
  /** Exact cap sent on the failed network attempt. Unknown defaults fail closed. */
  effectiveOutputTokenCap?: number;
  /** Frozen server-owned context window for the exact provider/model route. */
  configuredContextWindowTokens?: number;
  /** Exact provider payload for the retry candidate, including system/context/messages/tools. */
  requestPayload: Readonly<Record<string, unknown>>;
  tokenMultiplier?: number;
  safetyMarginTokens?: number;
}

/**
 * Extract only provider-owned error text. JSON request echoes, user messages,
 * and tool arguments are never searched for retry instructions.
 */
export function extractProviderOwnedOutputCapErrorText(rawBody: string): string | undefined {
  const bounded = rawBody.trim();
  if (!bounded || bounded.length > 64 * 1024) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bounded);
  } catch {
    return bounded;
  }
  if (typeof parsed === "string") return parsed.trim() || undefined;
  if (!isRecord(parsed)) return undefined;
  const error = parsed.error;
  const candidates = [
    typeof error === "string" ? error : undefined,
    isRecord(error) && typeof error.message === "string" ? error.message : undefined,
    isRecord(error) && typeof error.detail === "string" ? error.detail : undefined,
    typeof parsed.message === "string" ? parsed.message : undefined,
    typeof parsed.detail === "string" ? parsed.detail : undefined,
  ];
  if (Array.isArray(parsed.errors)) {
    for (const item of parsed.errors.slice(0, 8)) {
      if (typeof item === "string") candidates.push(item);
      else if (isRecord(item) && typeof item.message === "string") candidates.push(item.message);
    }
  }
  const normalized = candidates.map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  return normalized.length > 0 ? normalized.join("\n") : undefined;
}

/**
 * Decide whether one provider output-cap failure can be retried safely.
 *
 * The helper is intentionally side-effect free. It never changes history,
 * context-window metadata, compaction state, or the request payload. Callers
 * must still bound retry count and persist every transport attempt through the
 * canonical model-usage ledger.
 */
export function resolveOutputCapRecovery(input: ResolveOutputCapRecoveryInput): OutputCapRecoveryDecision {
  const parsed = parseProviderOutputCapEvidence(input.errorText);
  if (parsed.status === "not_recognized") {
    return { retry: false, reasonCode: "not_output_cap_error" };
  }
  if (parsed.status === "contradictory") {
    return { retry: false, reasonCode: "provider_evidence_contradictory" };
  }
  if (!parsed.evidence) {
    return { retry: false, reasonCode: "provider_availability_missing" };
  }
  const evidence = parsed.evidence;
  const contextWindow = positiveSafeInteger(input.configuredContextWindowTokens);
  if (!contextWindow) {
    return { retry: false, reasonCode: "configured_context_window_missing", evidence };
  }
  const effectiveCap = positiveSafeInteger(input.effectiveOutputTokenCap);
  if (!effectiveCap) {
    return { retry: false, reasonCode: "current_effective_cap_unknown", evidence };
  }
  const requestedCap = positiveSafeInteger(input.requestedOutputTokenCap);
  if (
    (input.requestedOutputTokenCap !== undefined && !requestedCap) ||
    (requestedCap !== undefined && effectiveCap > requestedCap) ||
    (evidence.providerReportedRequestedOutputTokens !== undefined &&
      evidence.providerReportedRequestedOutputTokens !== effectiveCap)
  ) {
    return { retry: false, reasonCode: "provider_evidence_contradictory" };
  }

  let canonicalPayload: string;
  try {
    canonicalPayload = canonicalJsonString(input.requestPayload);
  } catch {
    return { retry: false, reasonCode: "invalid_request_estimate", evidence };
  }
  const multiplier = normalizeTokenMultiplier(input.tokenMultiplier);
  if (multiplier === undefined) {
    return { retry: false, reasonCode: "invalid_request_estimate", evidence };
  }
  const requestEstimate = Math.ceil(estimateTokensFromText(canonicalPayload) * multiplier);
  if (!Number.isSafeInteger(requestEstimate) || requestEstimate <= 0) {
    return { retry: false, reasonCode: "invalid_request_estimate", evidence };
  }
  const locallyAvailable = contextWindow - requestEstimate;
  if (locallyAvailable <= 0) {
    return { retry: false, reasonCode: "request_estimate_exhausts_context", evidence };
  }
  const safetyMargin = normalizeSafetyMargin(input.safetyMarginTokens);
  const boundedAvailability = Math.min(evidence.providerAvailableOutputTokens, locallyAvailable);
  const retryCap = Math.floor(boundedAvailability - safetyMargin);
  if (retryCap < 1) {
    return { retry: false, reasonCode: "retry_cap_below_minimum", evidence };
  }
  if (evidence.providerMinimumOutputTokens !== undefined && retryCap < evidence.providerMinimumOutputTokens) {
    return { retry: false, reasonCode: "retry_cap_below_provider_minimum", evidence };
  }
  if (retryCap >= effectiveCap) {
    return { retry: false, reasonCode: "retry_would_not_reduce_cap", evidence };
  }

  return {
    retry: true,
    reasonCode: "safe_lower_cap",
    ...(requestedCap === undefined ? {} : { requestedOutputTokenCap: requestedCap }),
    priorEffectiveOutputTokenCap: effectiveCap,
    effectiveOutputTokenCap: retryCap,
    providerAvailableOutputTokens: evidence.providerAvailableOutputTokens,
    ...(evidence.providerMinimumOutputTokens === undefined
      ? {}
      : { providerMinimumOutputTokens: evidence.providerMinimumOutputTokens }),
    requestInputTokenEstimate: requestEstimate,
    configuredContextWindowTokens: contextWindow,
    safetyMarginTokens: safetyMargin,
    evidenceFormat: evidence.format,
  };
}

type ParsedEvidenceResult =
  | { status: "not_recognized" }
  | { status: "contradictory" }
  | { status: "recognized"; evidence?: OutputCapRecoveryEvidence };

export function parseProviderOutputCapEvidence(errorText: string): ParsedEvidenceResult {
  const normalized = errorText.trim().toLowerCase();
  if (!normalized || normalized.length > 64 * 1024) {
    return { status: "not_recognized" };
  }

  const parsers = [
    parseAnthropicEquation,
    parseBoundedRange,
    parseContextBreakdown,
    parseCharacterPrompt,
    parseVllmContext,
  ] as const;
  const candidates = parsers.flatMap((parser) => parser(normalized));
  if (candidates.length > 0 && hasConflictingProviderErrorClass(normalized)) {
    return { status: "contradictory" };
  }
  for (const candidate of candidates) {
    if (
      !isProviderEvidenceInternallyConsistent(candidate) ||
      hasConflictingAdvertisedAvailability(normalized, candidate)
    ) {
      return { status: "contradictory" };
    }
  }
  if (candidates.length > 0) {
    const evidence = [...candidates].sort((left, right) => evidenceSpecificity(right) - evidenceSpecificity(left))[0]!;
    if (candidates.some((candidate) => !providerEvidenceAgrees(evidence, candidate))) {
      return { status: "contradictory" };
    }
    return { status: "recognized", evidence };
  }

  if (mentionsOutputCap(normalized)) {
    return { status: "recognized" };
  }
  return { status: "not_recognized" };
}

function providerEvidenceAgrees(left: OutputCapRecoveryEvidence, right: OutputCapRecoveryEvidence): boolean {
  if (left.providerAvailableOutputTokens !== right.providerAvailableOutputTokens) return false;
  for (const key of [
    "providerReportedRequestedOutputTokens",
    "providerReportedContextWindowTokens",
    "providerReportedInputTokens",
  ] as const) {
    if (left[key] !== undefined && right[key] !== undefined && left[key] !== right[key]) return false;
  }
  if (
    left.providerMinimumOutputTokens !== undefined &&
    right.providerMinimumOutputTokens !== undefined &&
    left.providerMinimumOutputTokens !== right.providerMinimumOutputTokens
  )
    return false;
  return true;
}

function evidenceSpecificity(value: OutputCapRecoveryEvidence): number {
  return [
    value.providerReportedRequestedOutputTokens,
    value.providerReportedContextWindowTokens,
    value.providerReportedInputTokens,
  ].filter((item) => item !== undefined).length;
}

function parseAnthropicEquation(value: string): OutputCapRecoveryEvidence[] {
  return [
    ...value.matchAll(
      /max_(?:tokens|output_tokens|completion_tokens)\s*:\s*(\d+)\s*>\s*context_(?:window|length)\s*:\s*(\d+)\s*-\s*input_tokens\s*:\s*(\d+)\s*=\s*available_tokens\s*:\s*(\d+)/gu,
    ),
  ]
    .map((match) =>
      buildEvidence({
        format: "anthropic_equation",
        requested: match[1]!,
        context: match[2]!,
        input: match[3]!,
        available: match[4]!,
      }),
    )
    .filter((item): item is OutputCapRecoveryEvidence => Boolean(item));
}

function parseBoundedRange(value: string): OutputCapRecoveryEvidence[] {
  return [
    ...value.matchAll(
      /range of max_(?:tokens|output_tokens|completion_tokens) should be\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/gu,
    ),
  ].map((match) => {
    const minimum = parseProviderInteger(match[1]);
    const maximum = parseProviderInteger(match[2]);
    if (!minimum || !maximum || minimum > maximum) {
      return {
        format: "bounded_range",
        providerAvailableOutputTokens: 0,
      } satisfies OutputCapRecoveryEvidence;
    }
    return {
      format: "bounded_range",
      providerAvailableOutputTokens: maximum,
      providerMinimumOutputTokens: minimum,
    } satisfies OutputCapRecoveryEvidence;
  });
}

function parseContextBreakdown(value: string): OutputCapRecoveryEvidence[] {
  return [
    ...value.matchAll(
      /maximum context length is\s*(\d+)\s*tokens?[\s\S]{0,512}?\(\s*(\d+)\s+of text input\s*,\s*(\d+)\s+of tool input\s*,\s*(\d+)\s+in the output\s*\)/gu,
    ),
  ].map((match) => {
    const contextValue = parseProviderInteger(match[1]);
    const textInput = parseProviderInteger(match[2]);
    const toolInput = parseProviderInteger(match[3]);
    const output = parseProviderInteger(match[4]);
    if (!contextValue || textInput === undefined || toolInput === undefined || !output) {
      return { format: "context_breakdown", providerAvailableOutputTokens: 0 } satisfies OutputCapRecoveryEvidence;
    }
    return {
      format: "context_breakdown",
      providerAvailableOutputTokens: contextValue - textInput - toolInput,
      providerReportedRequestedOutputTokens: output,
      providerReportedContextWindowTokens: contextValue,
      providerReportedInputTokens: textInput + toolInput,
    } satisfies OutputCapRecoveryEvidence;
  });
}

function parseCharacterPrompt(value: string): OutputCapRecoveryEvidence[] {
  return [
    ...value.matchAll(
      /maximum context length is\s*(\d+)\s*tokens?[\s\S]{0,512}?requested\s*(\d+)\s*output tokens?[\s\S]{0,512}?prompt contains\s*(\d+)\s*characters?/gu,
    ),
  ].map((match) => {
    const contextValue = parseProviderInteger(match[1]);
    const requestedValue = parseProviderInteger(match[2]);
    const characterValue = parseProviderInteger(match[3]);
    if (!contextValue || !requestedValue || characterValue === undefined) {
      return { format: "character_prompt", providerAvailableOutputTokens: 0 } satisfies OutputCapRecoveryEvidence;
    }
    const estimatedInputTokens = Math.ceil(characterValue / 3);
    return {
      format: "character_prompt",
      providerAvailableOutputTokens: contextValue - estimatedInputTokens,
      providerReportedRequestedOutputTokens: requestedValue,
      providerReportedContextWindowTokens: contextValue,
      providerReportedInputTokens: estimatedInputTokens,
    } satisfies OutputCapRecoveryEvidence;
  });
}

function parseVllmContext(value: string): OutputCapRecoveryEvidence[] {
  return [
    ...value.matchAll(
      /maximum context length is\s*(\d+)\s*tokens?[\s\S]{0,512}?requested\s*(\d+)\s*output tokens?[\s\S]{0,512}?prompt contains\s*(?:at least\s*)?(\d+)\s*input tokens?(?:[\s\S]{0,256}?total of\s*(?:at least\s*)?(\d+)\s*tokens?)?/gu,
    ),
  ]
    .map((match) => {
      const evidence = buildEvidence({
        format: "vllm_context",
        requested: match[2]!,
        context: match[1]!,
        input: match[3]!,
        available: String((parseProviderInteger(match[1]) ?? 0) - (parseProviderInteger(match[3]) ?? 0)),
      });
      if (!evidence) return undefined;
      if (match[4]) {
        const totalValue = parseProviderInteger(match[4]);
        if (
          !totalValue ||
          totalValue < evidence.providerReportedInputTokens! + evidence.providerReportedRequestedOutputTokens!
        ) {
          return { ...evidence, providerAvailableOutputTokens: 0 };
        }
      }
      return evidence;
    })
    .filter((item): item is OutputCapRecoveryEvidence => Boolean(item));
}

function buildEvidence(input: {
  format: OutputCapRecoveryEvidence["format"];
  requested: string;
  context: string;
  input: string;
  available: string;
}): OutputCapRecoveryEvidence | undefined {
  const requested = parseProviderInteger(input.requested);
  const context = parseProviderInteger(input.context);
  const inputTokens = parseProviderInteger(input.input);
  const available = parseProviderInteger(input.available);
  if (!requested || !context || inputTokens === undefined || !available) {
    return {
      format: input.format,
      providerAvailableOutputTokens: 0,
    };
  }
  return {
    format: input.format,
    providerAvailableOutputTokens: available,
    providerReportedRequestedOutputTokens: requested,
    providerReportedContextWindowTokens: context,
    providerReportedInputTokens: inputTokens,
  };
}

function isProviderEvidenceInternallyConsistent(evidence: OutputCapRecoveryEvidence): boolean {
  if (!positiveSafeInteger(evidence.providerAvailableOutputTokens)) return false;
  const context = evidence.providerReportedContextWindowTokens;
  const input = evidence.providerReportedInputTokens;
  if (context !== undefined && (!positiveSafeInteger(context) || evidence.providerAvailableOutputTokens > context)) {
    return false;
  }
  if (input !== undefined && (!Number.isSafeInteger(input) || input < 0)) {
    return false;
  }
  if (context !== undefined && input !== undefined && context - input !== evidence.providerAvailableOutputTokens) {
    return false;
  }
  const requested = evidence.providerReportedRequestedOutputTokens;
  return requested === undefined || Boolean(positiveSafeInteger(requested));
}

function hasConflictingAdvertisedAvailability(value: string, evidence: OutputCapRecoveryEvidence): boolean {
  const advertised = [
    ...value.matchAll(/available_tokens\s*[:=]\s*(\d+)/gu),
    ...value.matchAll(/available\s+tokens\s*[:=]\s*(\d+)/gu),
  ]
    .map((match) => parseProviderInteger(match[1]))
    .filter((item): item is number => item !== undefined);
  return advertised.some((item) => item !== evidence.providerAvailableOutputTokens);
}

function mentionsOutputCap(value: string): boolean {
  const mentionsParameter = /max_(?:tokens|output_tokens|completion_tokens)/u.test(value);
  const unsupportedParameter = /unsupported parameter|not supported|use ['"]?max_/u.test(value);
  const inputOverflow = /prompt (?:is )?too long|input (?:itself )?(?:exceeds|over)|too many input tokens/u.test(value);
  return mentionsParameter && !unsupportedParameter && !inputOverflow;
}

function hasConflictingProviderErrorClass(value: string): boolean {
  return (
    /unsupported parameter|not supported|use ['"]?max_/u.test(value) ||
    /prompt (?:is )?too long|input (?:itself )?(?:exceeds|over)|too many input tokens/u.test(value) ||
    /invalid api key|unauthorized|forbidden|authentication (?:failed|required)|permission denied/u.test(value) ||
    /rate[ _-]?limit|too many requests|quota exceeded/u.test(value)
  );
}

function parseProviderInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_PROVIDER_TOKEN_VALUE ? parsed : undefined;
}

function positiveSafeInteger(value: number | undefined): number | undefined {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 && (value ?? 0) <= MAX_PROVIDER_TOKEN_VALUE
    ? value
    : undefined;
}

function normalizeTokenMultiplier(value: number | undefined): number | undefined {
  if (value === undefined) return 1;
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 16 ? value : undefined;
}

function normalizeSafetyMargin(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 && (value ?? 0) <= 4096
    ? value!
    : DEFAULT_OUTPUT_CAP_SAFETY_MARGIN_TOKENS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
