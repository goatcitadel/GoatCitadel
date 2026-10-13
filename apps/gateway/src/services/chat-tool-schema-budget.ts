import { canonicalJsonString } from "@goatcitadel/contracts";

export interface ToolSchemaSelectionDiagnostics {
  candidateCount: number;
  duplicateCandidateCount: number;
  selectedCount: number;
  deferredCount: number;
  estimatedSchemaTokens: number;
  softToolCap: number;
  softTokenBudget: number;
  exceededToolCap: boolean;
  exceededTokenBudget: boolean;
  exceptions: Array<{ toolName: string; reason: "essential" | "explicit" | "discovered" }>;
}

export interface ProviderSchemaCandidate {
  canonicalName: string;
  modelName: string;
  definition: Record<string, unknown>;
  requiredReason?: "essential" | "explicit" | "discovered";
}

/** Estimates the actual serialized provider definitions, including array framing. Not tokenizer usage. */
export function estimateSerializedProviderSchemaTokens(definitions: readonly Record<string, unknown>[]): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(definitions), "utf8") / 3);
}

/** Input is already policy filtered and relevance ordered. This changes exposure, never authorization. */
export function selectBoundedProviderSchemas(
  candidates: readonly ProviderSchemaCandidate[],
  softToolCap = 8,
  softTokenBudget = 2200,
): { selected: ProviderSchemaCandidate[]; diagnostics: ToolSchemaSelectionDiagnostics } {
  const unique = new Map<string, ProviderSchemaCandidate>();
  const modelNames = new Map<string, string>();
  const reasonPriority = { essential: 3, explicit: 2, discovered: 1 } as const;
  for (const candidate of candidates) {
    const modelOwner = modelNames.get(candidate.modelName);
    if (modelOwner && modelOwner !== candidate.canonicalName)
      throw new Error("Provider tool model name belongs to conflicting canonical tools.");
    const prior = unique.get(candidate.canonicalName);
    if (prior) {
      if (
        prior.modelName !== candidate.modelName ||
        canonicalJsonString(prior.definition) !== canonicalJsonString(candidate.definition)
      )
        throw new Error("Provider tool canonical name has conflicting schema bindings.");
      if (
        candidate.requiredReason &&
        (!prior.requiredReason || reasonPriority[candidate.requiredReason] > reasonPriority[prior.requiredReason])
      )
        unique.set(candidate.canonicalName, { ...prior, requiredReason: candidate.requiredReason });
    } else unique.set(candidate.canonicalName, { ...candidate });
    modelNames.set(candidate.modelName, candidate.canonicalName);
  }
  const distinct = [...unique.values()];
  const required = distinct.filter((candidate) => candidate.requiredReason);
  const selectedNames = new Set(required.map((candidate) => candidate.canonicalName));
  const selected = [...required];
  for (const candidate of distinct) {
    if (selectedNames.has(candidate.canonicalName) || selected.length >= softToolCap) continue;
    if (
      estimateSerializedProviderSchemaTokens([...selected, candidate].map((entry) => entry.definition)) >
      softTokenBudget
    )
      continue;
    selected.push(candidate);
    selectedNames.add(candidate.canonicalName);
  }
  // Keep provider order stable across eligibility changes and scoring ties.
  selected.sort((left, right) => left.canonicalName.localeCompare(right.canonicalName));
  const estimatedSchemaTokens = estimateSerializedProviderSchemaTokens(selected.map((entry) => entry.definition));
  return {
    selected,
    diagnostics: {
      candidateCount: distinct.length,
      duplicateCandidateCount: candidates.length - distinct.length,
      selectedCount: selected.length,
      deferredCount: distinct.length - selected.length,
      estimatedSchemaTokens,
      softToolCap,
      softTokenBudget,
      exceededToolCap: selected.length > softToolCap,
      exceededTokenBudget: estimatedSchemaTokens > softTokenBudget,
      exceptions: selected
        .filter((entry) => entry.requiredReason)
        .map((entry) => ({ toolName: entry.canonicalName, reason: entry.requiredReason! })),
    },
  };
}
