import type { ChatCompletionReasoningEffort } from "@goatcitadel/contracts";

export type AnthropicThinkingMode =
  | "manual"
  | "adaptive_opt_in"
  | "adaptive_default_disable_supported"
  | "adaptive_always_on";

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export function resolveAnthropicThinkingMode(model: string): AnthropicThinkingMode {
  const normalized = model.trim().toLowerCase();
  if (normalized.includes("fable-5") || normalized.includes("mythos")) {
    return "adaptive_always_on";
  }
  if (/claude-sonnet-5(?:$|[.-])/u.test(normalized)) {
    return "adaptive_default_disable_supported";
  }
  const adaptiveVersion = normalized.match(/claude-(?:opus|sonnet)-(\d+)-(\d+)/u);
  if (adaptiveVersion) {
    const major = Number.parseInt(adaptiveVersion[1] ?? "", 10);
    const minor = Number.parseInt(adaptiveVersion[2] ?? "", 10);
    if (major > 4 || (major === 4 && minor >= 6)) {
      return "adaptive_opt_in";
    }
  }
  return "manual";
}

export function resolveAnthropicEffort(input: {
  effort: ChatCompletionReasoningEffort;
  model: string;
}): AnthropicEffort | undefined {
  if (input.effort === "none") {
    if (resolveAnthropicThinkingMode(input.model) === "adaptive_always_on") {
      throw new Error(`Anthropic model ${input.model} cannot honor an explicit reasoning-off request.`);
    }
    return undefined;
  }
  if (input.effort === "ultra") {
    throw new Error("Anthropic Messages does not support the ultra reasoning effort.");
  }
  const thinkingMode = resolveAnthropicThinkingMode(input.model);
  const normalizedModel = input.model.trim().toLowerCase();
  if (
    input.effort === "xhigh" &&
    ((thinkingMode === "adaptive_opt_in" && !/claude-opus-4-(?:7|8)(?:$|[.-])/u.test(normalizedModel)) ||
      normalizedModel.includes("mythos-preview"))
  ) {
    throw new Error(`Anthropic model ${input.model} does not support xhigh reasoning effort.`);
  }
  return input.effort;
}

export function resolveAnthropicThinkingBudgetTokens(effort: ChatCompletionReasoningEffort): number | undefined {
  switch (effort) {
    case "none":
      return undefined;
    case "low":
      return 1_024;
    case "medium":
      return 4_096;
    case "high":
      return 8_192;
    case "xhigh":
      return 16_384;
    case "max":
      return 32_768;
    case "ultra":
      return 65_536;
  }
}

export function resolveAnthropicMaxTokensForVisibleOutput(input: {
  effort: ChatCompletionReasoningEffort;
  visibleOutputTokenBudget: number;
}): number {
  if (!Number.isSafeInteger(input.visibleOutputTokenBudget) || input.visibleOutputTokenBudget <= 0) {
    throw new TypeError("Anthropic visible output token budget must be a positive safe integer.");
  }
  return (resolveAnthropicThinkingBudgetTokens(input.effort) ?? 0) + input.visibleOutputTokenBudget;
}

export function assertAnthropicThinkingFitsMaxTokens(input: {
  effort: ChatCompletionReasoningEffort;
  maxTokens: number;
}): void {
  const thinkingBudgetTokens = resolveAnthropicThinkingBudgetTokens(input.effort);
  if (thinkingBudgetTokens === undefined) {
    return;
  }
  if (!Number.isSafeInteger(input.maxTokens) || input.maxTokens <= thinkingBudgetTokens) {
    throw new Error(
      `Anthropic max_tokens must be greater than the ${thinkingBudgetTokens}-token thinking budget for ${input.effort} reasoning.`,
    );
  }
}
