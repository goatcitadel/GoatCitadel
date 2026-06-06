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
  score: number;
  providerIndex: number;
  modelIndex: number;
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

  for (const [providerIndex, provider] of orderedProviders.entries()) {
    for (const [modelIndex, model] of provider.models.entries()) {
      const normalizedModel = model.trim();
      if (!normalizedModel) {
        continue;
      }
      const score = scoreModelCandidate(provider, normalizedModel, query, activeProviderId);
      if (query && score <= 0) {
        continue;
      }
      matches.push({
        providerId: provider.providerId,
        model: normalizedModel,
        providerLabel: provider.label,
        active: provider.providerId === activeProviderId,
        score,
        providerIndex,
        modelIndex,
      });
    }
  }

  matches.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    if (left.active !== right.active) {
      return left.active ? -1 : 1;
    }
    if (left.providerIndex !== right.providerIndex) {
      return left.providerIndex - right.providerIndex;
    }
    return query ? left.modelIndex - right.modelIndex : left.model.localeCompare(right.model);
  });

  return toSuggestionItems(matches.slice(0, limit));
}

function scoreModelCandidate(
  provider: ChatModelProviderOption,
  model: string,
  query: string,
  activeProviderId?: string,
): number {
  const activeBonus = provider.providerId === activeProviderId ? 4 : 0;
  const availabilityScore = scoreProviderAvailability(provider);
  if (!query) {
    return 1 + activeBonus + availabilityScore;
  }
  const normalizedModel = model.trim().toLowerCase();
  const haystack = `${provider.label} ${provider.providerId} ${normalizedModel}`.toLowerCase();
  const compactHaystack = haystack.replace(/[^a-z0-9]+/g, "");
  const compactQuery = query.replace(/[^a-z0-9]+/g, "");
  if (!compactQuery) {
    return 1 + activeBonus + availabilityScore;
  }
  if (normalizedModel === query || compactHaystack === compactQuery) {
    return 100 + activeBonus + availabilityScore;
  }
  if (normalizedModel.startsWith(query) || compactHaystack.startsWith(compactQuery)) {
    return 80 + activeBonus + availabilityScore;
  }
  if (haystack.includes(query) || compactHaystack.includes(compactQuery)) {
    return 60 + activeBonus + availabilityScore;
  }
  const queryParts = query.split(/[^a-z0-9]+/).filter(Boolean);
  if (queryParts.length > 1) {
    return /\s/.test(query) && queryParts.every((part) => haystack.includes(part) || compactHaystack.includes(part))
      ? 55 + activeBonus + availabilityScore
      : 0;
  }
  if (/[^a-z0-9]/.test(query)) {
    return 0;
  }
  const fuzzyScore = scoreOrderedCharacters(compactHaystack, compactQuery);
  return fuzzyScore > 0 ? fuzzyScore + activeBonus + availabilityScore : 0;
}

function scoreProviderAvailability(provider: ChatModelProviderOption): number {
  if (provider.disabled) {
    return -50;
  }
  switch (provider.modelProbeState) {
    case "ready":
      return 8;
    case "error":
      return -40;
    case "empty":
      return -30;
    default:
      return 0;
  }
}

function scoreOrderedCharacters(haystack: string, query: string): number {
  let cursor = 0;
  let gapPenalty = 0;
  for (const char of query) {
    const next = haystack.indexOf(char, cursor);
    if (next < 0) {
      return 0;
    }
    gapPenalty += Math.max(0, next - cursor);
    cursor = next + 1;
  }
  return Math.max(1, 40 - gapPenalty);
}

function toSuggestionItems(matches: ModelCommandCandidate[]): CommandSuggestionItem[] {
  return matches.map((item) => ({
    key: `model-${item.providerId}-${item.model}`,
    command: `/model ${item.providerId}/${item.model}`,
    description: `${item.providerLabel}${item.active ? " · active provider" : ""}`,
    applyValue: `/model ${item.providerId}/${item.model}`,
  }));
}

interface BuildOrchestrationCommandSuggestionsInput {
  draft: string;
}

const STEER_PREFIX = /^\/steer(?:\s+(.*))?$/i;
const QUEUE_PREFIX = /^\/queue(?:\s+(.*))?$/i;
const GOAL_PREFIX = /^\/goal(?:\s+(.*))?$/i;
const BTW_PREFIX = /^\/btw(?:\s+(.*))?$/i;

export function buildOrchestrationCommandSuggestions({
  draft,
}: BuildOrchestrationCommandSuggestionsInput): CommandSuggestionItem[] {
  const trimmed = draft.trimStart();
  const btwMatch = trimmed.match(BTW_PREFIX);
  if (btwMatch) {
    const text = (btwMatch[1] ?? "").trim();
    return [
      {
        key: "btw-side-chat",
        command: "/btw <aside>",
        description: "Open a small side chat tied to this thread without adding to the main transcript.",
        applyValue: text ? `/btw ${text}` : "/btw ",
      },
    ];
  }

  const steerMatch = trimmed.match(STEER_PREFIX);
  if (steerMatch) {
    const instruction = (steerMatch[1] ?? "").trim();
    return [
      {
        key: "steer-instruction",
        command: "/steer <instruction>",
        description: "Inject this text into the active turn before it finishes streaming.",
        applyValue: instruction ? `/steer ${instruction}` : "/steer ",
      },
    ];
  }

  const queueMatch = trimmed.match(QUEUE_PREFIX);
  if (queueMatch) {
    const sub = (queueMatch[1] ?? "").trim().toLowerCase();
    const items: CommandSuggestionItem[] = [
      {
        key: "queue-steer",
        command: "/queue steer",
        description: "Force this message to steer the in-flight run.",
        applyValue: "/queue steer ",
      },
      {
        key: "queue-followup",
        command: "/queue followup",
        description: "Defer this message until the active turn completes.",
        applyValue: "/queue followup ",
      },
      {
        key: "queue-collect",
        command: "/queue collect",
        description: "Stage this message into a collection batch.",
        applyValue: "/queue collect ",
      },
    ];
    if (!sub) {
      return items;
    }
    return items.filter((item) => {
      const subcommand = item.command.split(" ")[1] ?? "";
      return subcommand.startsWith(sub);
    });
  }

  const goalMatch = trimmed.match(GOAL_PREFIX);
  if (goalMatch) {
    const arg = (goalMatch[1] ?? "").trim();
    if (!arg) {
      return [
        {
          key: "goal-set",
          command: "/goal <target>",
          description: "Pin a cross-turn goal that prepends to every turn until cleared.",
          applyValue: "/goal ",
        },
        {
          key: "goal-status",
          command: "/goal status",
          description: "Show the current pinned goal and remaining turn budget.",
          applyValue: "/goal status",
        },
        {
          key: "goal-clear",
          command: "/goal clear",
          description: "Clear the pinned goal.",
          applyValue: "/goal clear",
        },
      ];
    }
    return [
      {
        key: "goal-set",
        command: "/goal <target>",
        description: "Pin a cross-turn goal that prepends to every turn until cleared.",
        applyValue: `/goal ${arg}`,
      },
    ];
  }

  return [];
}
