import { findProviderTemplate } from "@goatcitadel/contracts";

export interface ChatModelSuggestionRuntime {
  activeModel?: string;
  activeProviderId?: string;
  providers: Array<{
    defaultModel?: string;
    label: string;
    providerId: string;
  }>;
}

export interface ChatModelSuggestion {
  model: string;
  providerId: string;
  providerLabel: string;
}

export async function listChatModelSuggestions(
  deps: {
    getRuntime(): ChatModelSuggestionRuntime;
    listLlmModels(providerId?: string): Promise<Array<{ id: string }>>;
  },
  query: string,
  limit = 25,
): Promise<ChatModelSuggestion[]> {
  const runtime = deps.getRuntime();
  const normalizedQuery = query.trim().toLowerCase();
  let activeProviderRemoteModels: string[] = [];
  if (runtime.activeProviderId) {
    try {
      activeProviderRemoteModels = dedupeStrings(
        (await deps.listLlmModels(runtime.activeProviderId)).map((item) => item.id),
      );
    } catch {
      activeProviderRemoteModels = [];
    }
  }

  const providers = [...runtime.providers].sort((left, right) => {
    if (left.providerId === runtime.activeProviderId && right.providerId !== runtime.activeProviderId) {
      return -1;
    }
    if (right.providerId === runtime.activeProviderId && left.providerId !== runtime.activeProviderId) {
      return 1;
    }
    return left.label.localeCompare(right.label);
  });
  const results: ChatModelSuggestion[] = [];
  const seen = new Set<string>();

  for (const provider of providers) {
    const template = findProviderTemplate(provider.providerId);
    const candidates = dedupeStrings(
      [
        provider.defaultModel ?? "",
        provider.providerId === runtime.activeProviderId ? (runtime.activeModel ?? "") : "",
        ...(template?.knownModels ?? []),
        ...(provider.providerId === runtime.activeProviderId ? activeProviderRemoteModels : []),
      ].filter((value) => value.trim().length > 0),
    );

    candidates.sort((left, right) => {
      const leftScore = scoreChatModelSuggestion(left, normalizedQuery);
      const rightScore = scoreChatModelSuggestion(right, normalizedQuery);
      if (leftScore !== rightScore) {
        return rightScore - leftScore;
      }
      return left.localeCompare(right);
    });

    for (const model of candidates) {
      if (seen.has(model)) {
        continue;
      }
      if (normalizedQuery && !model.toLowerCase().includes(normalizedQuery)) {
        continue;
      }
      seen.add(model);
      results.push({
        model,
        providerId: provider.providerId,
        providerLabel: provider.label,
      });
      if (results.length >= limit) {
        return results;
      }
    }
  }
  return results;
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function scoreChatModelSuggestion(model: string, query: string): number {
  if (!query) {
    return 0;
  }
  const lower = model.toLowerCase();
  if (lower === query) {
    return 100;
  }
  if (lower.startsWith(query)) {
    return 75;
  }
  if (lower.includes(query)) {
    return 50;
  }
  return 0;
}
