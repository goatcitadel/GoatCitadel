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
