import type { ChatModelProviderOption } from "@goatcitadel/mission-control-shared/components/ChatModelPicker";

export interface CommandSuggestionItem {
  key: string;
  command: string;
  description: string;
  applyValue: string;
}

interface BuildModelCommandSuggestionsInput {
  draft: string;
  providers: ChatModelProviderOption[];
  activeProviderId?: string;
  limit?: number;
}

interface ModelCommandCandidate {
  providerId: string;
  model: string;
  providerLabel: string;
  active: boolean;
}

export function buildModelCommandSuggestions({
  draft,
  providers,
  activeProviderId,
  limit = 8,
}: BuildModelCommandSuggestionsInput): CommandSuggestionItem[] {
  const match = draft.trimStart().match(/^\/model(?:\s+(.*))?$/i);
  if (!match) {
    return [];
  }

  const query = (match[1] ?? "").trim().toLowerCase();
  const orderedProviders = [...providers].sort((left, right) => {
    if (left.providerId === activeProviderId && right.providerId !== activeProviderId) {
      return -1;
    }
    if (right.providerId === activeProviderId && left.providerId !== activeProviderId) {
      return 1;
    }
    return left.label.localeCompare(right.label);
  });
  const matches: ModelCommandCandidate[] = [];

  for (const provider of orderedProviders) {
    const models = [...provider.models].sort((left, right) => {
      const leftScore = scoreMatch(left, query);
      const rightScore = scoreMatch(right, query);
      if (leftScore !== rightScore) {
        return rightScore - leftScore;
      }
      return left.localeCompare(right);
    });

    for (const model of models) {
      const normalizedModel = model.trim();
      if (!normalizedModel) {
        continue;
      }
      if (query && !normalizedModel.toLowerCase().includes(query)) {
        continue;
      }
      matches.push({
        providerId: provider.providerId,
        model: normalizedModel,
        providerLabel: provider.label,
        active: provider.providerId === activeProviderId,
      });
      if (matches.length >= limit) {
        return toSuggestionItems(matches);
      }
    }
  }

  return toSuggestionItems(matches);
}

function scoreMatch(model: string, query: string): number {
  if (!query) {
    return 1;
  }
  const normalized = model.toLowerCase();
  if (normalized === query) {
    return 4;
  }
  if (normalized.startsWith(query)) {
    return 3;
  }
  if (normalized.includes(query)) {
    return 2;
  }
  return 0;
}

function toSuggestionItems(matches: ModelCommandCandidate[]): CommandSuggestionItem[] {
  return matches.map((item) => ({
    key: `model-${item.providerId}-${item.model}`,
    command: `/model ${item.providerId}/${item.model}`,
    description: `${item.providerLabel}${item.active ? " · active provider" : ""}`,
    applyValue: `/model ${item.providerId}/${item.model}`,
  }));
}
