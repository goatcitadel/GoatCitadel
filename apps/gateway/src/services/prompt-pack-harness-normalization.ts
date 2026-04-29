import type { ChatNormalizationProfile, ChatToolRunRecord } from "@goatcitadel/contracts";

interface PromptPackHarnessNormalizeArgs {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}

interface PromptPackHarnessNormalizationInput extends PromptPackHarnessNormalizeArgs {
  normalizationProfile?: ChatNormalizationProfile;
  normalizePromptLabContractOutput: (input: PromptPackHarnessNormalizeArgs) => string;
  normalizeRepoGroundedInspectionOutput: (input: PromptPackHarnessNormalizeArgs) => string;
}

export interface PromptPackHarnessNormalizationResult {
  responseText: string;
  signals: string[];
}

export function applyPromptPackHarnessNormalization(
  input: PromptPackHarnessNormalizationInput,
): PromptPackHarnessNormalizationResult {
  if (input.normalizationProfile !== "prompt_pack_harness") {
    return {
      responseText: input.responseText,
      signals: [],
    };
  }

  let responseText = input.responseText;
  const signals: string[] = [];
  const normalizationArgs = {
    prompt: input.prompt,
    responseText,
    toolRuns: input.toolRuns,
  };

  if (isPromptLabHarnessContent(input.prompt)) {
    const normalized = input.normalizePromptLabContractOutput(normalizationArgs);
    if (normalized !== responseText) {
      responseText = normalized;
      signals.push("prompt_lab_contract");
    }
  }

  const repoInspectionContent = isPromptLabHarnessContent(input.prompt)
    ? extractPromptLabUserTaskForNormalization(input.prompt)
    : input.prompt;
  if (looksLikeRepoGroundedInspectionPrompt(repoInspectionContent)) {
    const normalized = input.normalizeRepoGroundedInspectionOutput({
      ...normalizationArgs,
      responseText,
    });
    if (normalized !== responseText) {
      responseText = normalized;
      signals.push("repo_grounded_inspection");
    }
  }

  return {
    responseText,
    signals,
  };
}

export function isPromptLabHarnessContent(content: string): boolean {
  const normalized = content.toLowerCase();
  return normalized.includes("## prompt lab run contract") || normalized.includes("## prompt lab tooling contract");
}

function extractPromptLabUserTaskForNormalization(content: string): string {
  const match = content.match(/## User Task\s*\n([\s\S]*?)(?:\n## |\s*$)/i);
  return match?.[1]?.trim() || content;
}

export function looksLikeRepoGroundedInspectionPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return (
    /\binspect(?: the)? (?:repo|repository|codebase|workspace)\b/.test(normalized) ||
    /\buse (?:(?:file|code|file\/code|file or code)(?: tools?)?)\b/.test(normalized) ||
    /\b(?:file|code) tools\b/.test(normalized) ||
    /\bexact files?\b/.test(normalized) ||
    /\bexact evidence\b/.test(normalized) ||
    /\bexact citations?\b/.test(normalized) ||
    /\bcurrent implementation\b/.test(normalized) ||
    /\bguidance-loading chain\b/.test(normalized) ||
    /\binspect\b[\s\S]{0,80}\b(?:routes|services|wiring|contracts?|tests?|ui|copy|prompt lab|prompt-pack)\b/.test(
      normalized,
    ) ||
    (/\bcurrent\b/.test(normalized) && /\b(repo|repository|workspace|codebase)\b/.test(normalized))
  );
}
