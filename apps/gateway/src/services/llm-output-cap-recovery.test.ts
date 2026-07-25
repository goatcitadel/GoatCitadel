import { describe, expect, it } from "vitest";
import {
  extractProviderOwnedOutputCapErrorText,
  parseProviderOutputCapEvidence,
  resolveOutputCapRecovery,
} from "./llm-output-cap-recovery.js";

const payload = {
  model: "test-model",
  messages: [
    { role: "system", content: "Frozen routed context and system guidance" },
    { role: "user", content: "Summarize the attached evidence" },
  ],
  tools: [{ type: "function", function: { name: "read_evidence", parameters: { type: "object" } } }],
};

describe("output-cap recovery evidence", () => {
  it("extracts bounded provider-owned error fields without scanning echoed request content", () => {
    expect(
      extractProviderOwnedOutputCapErrorText(
        JSON.stringify({ error: { message: "Range of max_tokens should be [1, 2048]" }, echoedUser: "ignored" }),
      ),
    ).toBe("Range of max_tokens should be [1, 2048]");
    expect(
      extractProviderOwnedOutputCapErrorText(
        JSON.stringify({ echoedRequest: { message: "Range of max_tokens should be [1, 2048]" } }),
      ),
    ).toBeUndefined();
  });
  it("parses and verifies the Anthropic availability equation", () => {
    expect(
      parseProviderOutputCapEvidence(
        "max_tokens: 32768 > context_window: 200000 - input_tokens: 190000 = available_tokens: 10000",
      ),
    ).toEqual({
      status: "recognized",
      evidence: {
        format: "anthropic_equation",
        providerAvailableOutputTokens: 10_000,
        providerReportedRequestedOutputTokens: 32_768,
        providerReportedContextWindowTokens: 200_000,
        providerReportedInputTokens: 190_000,
      },
    });
  });

  it("parses bounded provider output ranges without inventing prompt availability", () => {
    expect(parseProviderOutputCapEvidence("Range of max_tokens should be [1, 65536]")).toEqual({
      status: "recognized",
      evidence: {
        format: "bounded_range",
        providerAvailableOutputTokens: 65_536,
        providerMinimumOutputTokens: 1,
      },
    });
  });

  it("parses request-wide text and tool input breakdowns", () => {
    expect(
      parseProviderOutputCapEvidence(
        "Maximum context length is 200000 tokens (150000 of text input, 40000 of tool input, 12000 in the output)",
      ),
    ).toEqual({
      status: "recognized",
      evidence: {
        format: "context_breakdown",
        providerAvailableOutputTokens: 10_000,
        providerReportedRequestedOutputTokens: 12_000,
        providerReportedContextWindowTokens: 200_000,
        providerReportedInputTokens: 190_000,
      },
    });
  });

  it("parses character-count servers conservatively before applying the complete-request estimate", () => {
    expect(
      parseProviderOutputCapEvidence(
        "This model's maximum context length is 65536 tokens. However, you requested 65536 output tokens and your prompt contains 77409 characters.",
      ),
    ).toEqual({
      status: "recognized",
      evidence: {
        format: "character_prompt",
        providerAvailableOutputTokens: 39_733,
        providerReportedRequestedOutputTokens: 65_536,
        providerReportedContextWindowTokens: 65_536,
        providerReportedInputTokens: 25_803,
      },
    });
  });

  it("rejects contradictory arithmetic and duplicate advertised availability", () => {
    expect(
      parseProviderOutputCapEvidence(
        "max_tokens: 32768 > context_window: 200000 - input_tokens: 190000 = available_tokens: 9000",
      ),
    ).toEqual({ status: "contradictory" });
    expect(
      parseProviderOutputCapEvidence(
        "max_tokens: 32768 > context_window: 200000 - input_tokens: 190000 = available_tokens: 10000; available_tokens: 9000",
      ),
    ).toEqual({ status: "contradictory" });
    expect(
      parseProviderOutputCapEvidence(
        "max_tokens: 32768 > context_window: 200000 - input_tokens: 190000 = available_tokens: 10000; Range of max_tokens should be [1, 8192]",
      ),
    ).toEqual({ status: "contradictory" });
    expect(
      parseProviderOutputCapEvidence(
        "Range of max_tokens should be [1, 2048]\nRange of max_tokens should be [1, 1024]",
      ),
    ).toEqual({ status: "contradictory" });
    expect(
      parseProviderOutputCapEvidence(
        "max_tokens: 4096 > context_window: 16384 - input_tokens: 14336 = available_tokens: 2048\n" +
          "max_tokens: 2048 > context_window: 16384 - input_tokens: 14336 = available_tokens: 2048",
      ),
    ).toEqual({ status: "contradictory" });
  });

  it("accepts identical repeated claims but rejects quantified evidence mixed with another failure class", () => {
    expect(
      parseProviderOutputCapEvidence(
        "Range of max_tokens should be [1, 2048]\nRange of max_tokens should be [1, 2048]",
      ),
    ).toMatchObject({ status: "recognized", evidence: { providerAvailableOutputTokens: 2048 } });
    expect(
      parseProviderOutputCapEvidence(
        "Range of max_tokens should be [1, 2048]\nPrompt is too long: input exceeds context",
      ),
    ).toEqual({ status: "contradictory" });
    expect(
      parseProviderOutputCapEvidence("Range of max_tokens should be [1, 2048]\nUnauthorized: invalid API key"),
    ).toEqual({ status: "contradictory" });
  });

  it("distinguishes unquantified output-cap errors from unrelated and parameter-compatibility errors", () => {
    expect(parseProviderOutputCapEvidence("max_tokens should be lower for this request")).toEqual({
      status: "recognized",
    });
    expect(parseProviderOutputCapEvidence("some unrelated 400 error")).toEqual({ status: "not_recognized" });
    expect(
      parseProviderOutputCapEvidence(
        "Unsupported parameter: max_tokens is not supported with this model. Use max_completion_tokens instead.",
      ),
    ).toEqual({ status: "not_recognized" });
  });
});

describe("output-cap recovery decision", () => {
  it("uses the smaller provider/request budget, subtracts margin, and only lowers the cap", () => {
    const decision = resolveOutputCapRecovery({
      errorText: "max_tokens: 32768 > context_window: 200000 - input_tokens: 190000 = available_tokens: 10000",
      requestedOutputTokenCap: 32_768,
      effectiveOutputTokenCap: 32_768,
      configuredContextWindowTokens: 200_000,
      requestPayload: payload,
      safetyMarginTokens: 64,
    });
    expect(decision).toMatchObject({
      retry: true,
      requestedOutputTokenCap: 32_768,
      priorEffectiveOutputTokenCap: 32_768,
      effectiveOutputTokenCap: 9_936,
      providerAvailableOutputTokens: 10_000,
      configuredContextWindowTokens: 200_000,
      safetyMarginTokens: 64,
      evidenceFormat: "anthropic_equation",
    });
  });

  it("includes system, routed context, messages, and tools by estimating the exact payload", () => {
    const largePayload = {
      ...payload,
      messages: [
        { role: "system", content: "r".repeat(18_000) },
        { role: "user", content: "u".repeat(4_000) },
      ],
      tools: [{ description: "t".repeat(8_000) }],
    };
    const decision = resolveOutputCapRecovery({
      errorText: "Range of max_tokens should be [1, 65536]",
      requestedOutputTokenCap: 65_536,
      effectiveOutputTokenCap: 65_536,
      configuredContextWindowTokens: 10_000,
      requestPayload: largePayload,
      safetyMarginTokens: 64,
    });
    expect(decision.retry).toBe(true);
    if (!decision.retry) return;
    expect(decision.requestInputTokenEstimate).toBeGreaterThan(4_000);
    expect(decision.effectiveOutputTokenCap).toBe(
      decision.configuredContextWindowTokens - decision.requestInputTokenEstimate - decision.safetyMarginTokens,
    );
  });

  it("fails closed when provider availability is missing or the prior effective cap is unknown", () => {
    expect(
      resolveOutputCapRecovery({
        errorText: "max_tokens should be lower for this request",
        effectiveOutputTokenCap: 4096,
        configuredContextWindowTokens: 16_384,
        requestPayload: payload,
      }),
    ).toEqual({ retry: false, reasonCode: "provider_availability_missing" });
    expect(
      resolveOutputCapRecovery({
        errorText: "Range of max_tokens should be [1, 8192]",
        configuredContextWindowTokens: 16_384,
        requestPayload: payload,
      }),
    ).toMatchObject({ retry: false, reasonCode: "current_effective_cap_unknown" });
  });

  it("rejects stale or contradictory provider request-cap evidence", () => {
    expect(
      resolveOutputCapRecovery({
        errorText: "max_tokens: 32768 > context_window: 200000 - input_tokens: 190000 = available_tokens: 10000",
        requestedOutputTokenCap: 32_768,
        effectiveOutputTokenCap: 16_384,
        configuredContextWindowTokens: 200_000,
        requestPayload: payload,
      }),
    ).toMatchObject({ retry: false, reasonCode: "provider_evidence_contradictory" });
  });

  it("never retries when the computed cap would stay equal, increase, or fall below one", () => {
    expect(
      resolveOutputCapRecovery({
        errorText: "Range of max_tokens should be [1, 8192]",
        requestedOutputTokenCap: 1024,
        effectiveOutputTokenCap: 1024,
        configuredContextWindowTokens: 64_000,
        requestPayload: payload,
      }),
    ).toMatchObject({ retry: false, reasonCode: "retry_would_not_reduce_cap" });
    expect(
      resolveOutputCapRecovery({
        errorText: "Range of max_tokens should be [1, 32]",
        requestedOutputTokenCap: 1024,
        effectiveOutputTokenCap: 1024,
        configuredContextWindowTokens: 64_000,
        requestPayload: payload,
        safetyMarginTokens: 64,
      }),
    ).toMatchObject({ retry: false, reasonCode: "retry_cap_below_minimum" });
  });

  it("never raises a computed cap to satisfy a provider minimum and rejects invalid supplied multipliers", () => {
    expect(
      resolveOutputCapRecovery({
        errorText: "Range of max_tokens should be [1024, 1050]",
        requestedOutputTokenCap: 4096,
        effectiveOutputTokenCap: 4096,
        configuredContextWindowTokens: 64_000,
        requestPayload: payload,
        safetyMarginTokens: 64,
      }),
    ).toMatchObject({ retry: false, reasonCode: "retry_cap_below_provider_minimum" });
    expect(
      resolveOutputCapRecovery({
        errorText: "Range of max_tokens should be [1, 2048]",
        requestedOutputTokenCap: 4096,
        effectiveOutputTokenCap: 4096,
        configuredContextWindowTokens: 64_000,
        requestPayload: payload,
        tokenMultiplier: Number.NaN,
      }),
    ).toMatchObject({ retry: false, reasonCode: "invalid_request_estimate" });
  });

  it("does not treat input overflow as output-cap recovery", () => {
    expect(
      resolveOutputCapRecovery({
        errorText: "Prompt is too long: input exceeds the context window even with max_tokens=1",
        requestedOutputTokenCap: 4096,
        effectiveOutputTokenCap: 4096,
        configuredContextWindowTokens: 4096,
        requestPayload: payload,
      }),
    ).toEqual({ retry: false, reasonCode: "not_output_cap_error" });
  });
});
