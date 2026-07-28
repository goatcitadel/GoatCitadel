export type ComposerPaletteSourceId =
  | "commands"
  | "models"
  | "agents"
  | "skills"
  | "projects"
  | "files"
  | "knowledge"
  | "urls"
  | "external_sources"
  | "prompt_packs"
  | "documents";

export type ComposerPaletteMode = "commands" | "context" | "skills" | "all";

export type ComposerPaletteAction =
  | { type: "insert_command"; value: string }
  | { type: "select_model"; providerId: string; model: string }
  | { type: "select_preset"; agentId: string }
  | { type: "switch_project"; projectId: string; projectName: string }
  | { type: "attach_file"; relativePath: string }
  | { type: "attach_context"; attachmentId: string }
  | {
      type: "attach_document";
      documentKind: "personal_note" | "generated_artifact";
      documentId: string;
      label: string;
    }
  | { type: "attach_url"; url: string }
  | { type: "launch_external_source" }
  | {
      type: "open_template_form";
      invocation: Omit<import("@goatcitadel/contracts").RunTemplateInvocation, "values">;
      schema: import("@goatcitadel/contracts").RunVariableSchema;
      template: string;
      defaults?: import("@goatcitadel/contracts").RunVariableBindings;
    };

export interface ComposerPaletteItem {
  key: string;
  command: string;
  description: string;
  applyValue: string;
  source: ComposerPaletteSourceId;
  sourceLabel: string;
  availabilityLabel: string;
  action: ComposerPaletteAction;
  keywords?: string[];
}

export interface ComposerPaletteSourceFailure {
  source: ComposerPaletteSourceId;
  sourceLabel: string;
  message: string;
}

export interface ComposerPaletteSearchResult {
  items: ComposerPaletteItem[];
  failures: ComposerPaletteSourceFailure[];
}

export interface ComposerPaletteSourceContext {
  sessionKey: string;
  workspaceId: string;
}

export interface ComposerPaletteSourceDefinition {
  id: ComposerPaletteSourceId;
  label: string;
  load: (context: ComposerPaletteSourceContext) => Promise<ComposerPaletteItem[]> | ComposerPaletteItem[];
}

export interface ComposerPaletteSearchInput extends ComposerPaletteSourceContext {
  mode: ComposerPaletteMode;
  query: string;
  limit?: number;
}

interface CachedSourceResult {
  expiresAt: number;
  promise: Promise<ComposerPaletteItem[]>;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_RESULT_LIMIT = 24;

const MODE_SOURCE_PRIORITY: Record<ComposerPaletteMode, readonly ComposerPaletteSourceId[]> = {
  commands: [
    "commands",
    "models",
    "prompt_packs",
    "skills",
    "agents",
    "projects",
    "files",
    "knowledge",
    "documents",
    "urls",
    "external_sources",
  ],
  context: [
    "agents",
    "prompt_packs",
    "projects",
    "files",
    "knowledge",
    "documents",
    "urls",
    "external_sources",
    "skills",
    "models",
    "commands",
  ],
  skills: [
    "skills",
    "commands",
    "agents",
    "prompt_packs",
    "models",
    "projects",
    "files",
    "knowledge",
    "documents",
    "urls",
    "external_sources",
  ],
  all: [
    "commands",
    "models",
    "agents",
    "prompt_packs",
    "skills",
    "projects",
    "files",
    "knowledge",
    "documents",
    "urls",
    "external_sources",
  ],
};

export class ComposerPaletteSourceRegistry {
  private readonly sources = new Map<ComposerPaletteSourceId, ComposerPaletteSourceDefinition>();
  private readonly cache = new Map<string, CachedSourceResult>();

  public constructor(
    sources: readonly ComposerPaletteSourceDefinition[],
    private readonly cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  ) {
    for (const source of sources) {
      this.sources.set(source.id, source);
    }
  }

  public async search(input: ComposerPaletteSearchInput): Promise<ComposerPaletteSearchResult> {
    const settled = await Promise.allSettled(
      [...this.sources.values()].map(async (source) => ({
        source,
        items: await this.loadSource(source, input),
      })),
    );
    const failures: ComposerPaletteSourceFailure[] = [];
    const loaded: ComposerPaletteItem[] = [];

    for (const [index, result] of settled.entries()) {
      const source = [...this.sources.values()][index];
      if (!source) continue;
      if (result.status === "fulfilled") {
        loaded.push(...result.value.items);
        continue;
      }
      failures.push({
        source: source.id,
        sourceLabel: source.label,
        message: result.reason instanceof Error ? result.reason.message : "Source unavailable",
      });
    }

    return {
      items: rankComposerPaletteItems(loaded, input.mode, input.query).slice(0, input.limit ?? DEFAULT_RESULT_LIMIT),
      failures,
    };
  }

  public clearSession(sessionKey: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${sessionKey}\u0000`)) this.cache.delete(key);
    }
  }

  private loadSource(
    source: ComposerPaletteSourceDefinition,
    context: ComposerPaletteSourceContext,
  ): Promise<ComposerPaletteItem[]> {
    const cacheKey = `${context.sessionKey}\u0000${context.workspaceId}\u0000${source.id}`;
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.promise;

    const promise = Promise.resolve().then(() => source.load(context));
    this.cache.set(cacheKey, { expiresAt: now + this.cacheTtlMs, promise });
    promise.catch(() => {
      if (this.cache.get(cacheKey)?.promise === promise) this.cache.delete(cacheKey);
    });
    return promise;
  }
}

export function detectComposerPaletteTrigger(draft: string): { mode: ComposerPaletteMode; query: string } | null {
  const slashMatch = draft.trimStart().match(/^\/([^\n]*)$/u);
  if (slashMatch) return { mode: "commands", query: slashMatch[1]?.trim() ?? "" };

  const tokenMatch = draft.match(/(?:^|\s)([@$])([^\s]*)$/u);
  if (!tokenMatch) return null;
  return {
    mode: tokenMatch[1] === "$" ? "skills" : "context",
    query: tokenMatch[2] ?? "",
  };
}

export function rankComposerPaletteItems(
  items: readonly ComposerPaletteItem[],
  mode: ComposerPaletteMode,
  query: string,
): ComposerPaletteItem[] {
  const normalizedQuery = normalizeSearchText(query);
  const priorities = new Map(MODE_SOURCE_PRIORITY[mode].map((source, index) => [source, index]));
  return items
    .map((item, index) => ({ item, index, score: scorePaletteItem(item, normalizedQuery) }))
    .filter((candidate) => !normalizedQuery || candidate.score > 0)
    .sort((left, right) => {
      const leftPriority = priorities.get(left.item.source) ?? 99;
      const rightPriority = priorities.get(right.item.source) ?? 99;
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      if (left.score !== right.score) return right.score - left.score;
      return left.index - right.index;
    })
    .map(({ item }) => item);
}

export function createUrlPaletteItem(value: string): ComposerPaletteItem | null {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return {
    key: `url-${trimmed}`,
    command: trimmed,
    description: "Attach this URL through the existing governed knowledge-source flow.",
    applyValue: trimmed,
    source: "urls",
    sourceLabel: "URL",
    availabilityLabel: "Ready to attach",
    action: { type: "attach_url", url: trimmed },
    keywords: [parsed.hostname],
  };
}

function scorePaletteItem(item: ComposerPaletteItem, query: string): number {
  if (!query) return 1;
  const label = normalizeSearchText(item.command);
  const haystack = normalizeSearchText(
    [item.command, item.description, item.sourceLabel, item.availabilityLabel, ...(item.keywords ?? [])].join(" "),
  );
  if (label === query) return 100;
  if (label.startsWith(query)) return 80;
  if (haystack.includes(query)) return 60;
  const parts = query.split(" ").filter(Boolean);
  return parts.length > 1 && parts.every((part) => haystack.includes(part)) ? 50 : 0;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/gu, " ");
}
