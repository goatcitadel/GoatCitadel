export function resolvePromptPackJudgeTarget(input: {
  inputProviderId?: string;
  inputModel?: string;
  runProviderId?: string;
  runModel?: string;
  defaultProviderId?: string;
  defaultModel?: string;
}): { providerId?: string; model?: string } {
  if (input.inputProviderId || input.inputModel) {
    return {
      providerId: input.inputProviderId ?? input.runProviderId ?? input.defaultProviderId,
      model: input.inputModel ?? input.runModel ?? input.defaultModel,
    };
  }
  if (!shouldPreferPromptPackJudgeDefaults(input.runProviderId, input.runModel)) {
    return {
      providerId: input.runProviderId ?? input.defaultProviderId,
      model: input.runModel ?? input.defaultModel,
    };
  }
  return {
    providerId: input.defaultProviderId ?? input.runProviderId,
    model: input.defaultModel ?? input.runModel,
  };
}

export function shouldPreferPromptPackJudgeDefaults(providerId?: string, model?: string): boolean {
  const normalizedProviderId = (providerId ?? "").trim().toLowerCase();
  const normalizedModel = (model ?? "").trim().toLowerCase();
  return (
    normalizedProviderId.includes("moonshot") ||
    normalizedModel.includes("kimi") ||
    normalizedProviderId.includes("ollama") ||
    normalizedProviderId.includes("llamacpp") ||
    normalizedProviderId.includes("lmstudio") ||
    normalizedProviderId.includes("localai") ||
    normalizedModel.includes("qwen")
  );
}

export function shouldUsePromptPackJudgeJsonMode(providerId?: string, model?: string): boolean {
  const normalizedProviderId = (providerId ?? "").trim().toLowerCase();
  const normalizedModel = (model ?? "").trim().toLowerCase();
  if (
    normalizedProviderId.includes("glm") ||
    normalizedProviderId.includes("z.ai") ||
    normalizedModel.includes("glm-5")
  ) {
    return false;
  }
  return true;
}
