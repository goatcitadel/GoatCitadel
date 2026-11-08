import type { ComposerPaletteSourceId, ComposerPaletteItem, ComposerPaletteMode } from "./composer-palette.js";

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

/** Below this many typed characters, or with this many name matches, a row that only mentions the query is noise. */
const DESCRIPTION_MATCH_MIN_QUERY_CHARS = 3;
const DESCRIPTION_MATCH_MAX_NAME_MATCHES = 5;
const DESCRIPTION_ONLY_MAX_ROWS = 3;

export function rankComposerPaletteItems(
  items: readonly ComposerPaletteItem[],
  mode: ComposerPaletteMode,
  query: string,
): ComposerPaletteItem[] {
  const normalizedQuery = normalizeSearchText(query);
  const priorities = new Map(MODE_SOURCE_PRIORITY[mode].map((source, index) => [source, index]));
  const seen = new Set<string>();
  const scored = items
    .map((item, index) => ({ item, index, score: scorePaletteItem(item, normalizedQuery) }))
    .filter((candidate) => !normalizedQuery || candidate.score > 0);
  // Name matches always stay. Rows that only mention the query in their description are a fallback for when
  // few names match, and then only a few of them, so "/he" lists /help and its neighbours, not every mention.
  const nameMatches = scored.filter((candidate) => candidate.score >= NAME_MATCH_MIN_SCORE).length;
  const needle = normalizedQuery.replace(/^[/@$]+/u, "");
  const describedAllowance =
    needle.length >= DESCRIPTION_MATCH_MIN_QUERY_CHARS && nameMatches < DESCRIPTION_MATCH_MAX_NAME_MATCHES
      ? DESCRIPTION_ONLY_MAX_ROWS
      : 0;
  let describedKept = 0;
  // The cap applies after ranking and de-duplication, so source registration order never decides which
  // description-only rows survive; the mode's source priority does.
  const withinDescribedCap = ({ score }: { score: number }) => {
    if (!normalizedQuery || score >= NAME_MATCH_MIN_SCORE) return true;
    if (describedKept >= describedAllowance) return false;
    describedKept += 1;
    return true;
  };
  return scored
    .sort((left, right) => {
      // A typed query ranks by how the name matches first (starts with > contains > described); the source
      // order only breaks ties, so "/he" lists /help before commands that merely mention "he" in a description.
      if (normalizedQuery && left.score !== right.score) return right.score - left.score;
      const leftPriority = priorities.get(left.item.source) ?? 99;
      const rightPriority = priorities.get(right.item.source) ?? 99;
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      if (left.score !== right.score) return right.score - left.score;
      return left.index - right.index;
    })
    .filter(({ item }) => {
      // Several catalog entries can share one command (for example each /skill form); one row applies it.
      const identity = `${item.source}\u0000${item.applyValue.trim() || item.command}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    })
    .filter(withinDescribedCap)
    .map(({ item }) => item);
}

const NAME_MATCH_MIN_SCORE = 70;

/** How a name matches a typed query: 100 exact, 80 starts with, 70 contains, 0 no match. The trigger character is ignored. */
export function nameMatchScore(name: string, query: string): number {
  const label = normalizeSearchText(name).replace(/^[/@$]+/u, "");
  const needle = query.replace(/^[/@$]+/u, "");
  if (!needle) return 1;
  if (label === needle) return 100;
  if (label.startsWith(needle)) return 80;
  return label.includes(needle) ? 70 : 0;
}

function scorePaletteItem(item: ComposerPaletteItem, query: string): number {
  if (!query) return 1;
  const byName = nameMatchScore(item.command, query);
  if (byName > 0) return byName;
  // The availability label is the same word on most rows; it is never a reason for a row to match.
  const haystack = normalizeSearchText([item.description, item.sourceLabel, ...(item.keywords ?? [])].join(" "));
  if (haystack.includes(query)) return 60;
  const parts = query.split(" ").filter(Boolean);
  return parts.length > 1 &&
    parts.every((part) => haystack.includes(part) || normalizeSearchText(item.command).includes(part))
    ? 50
    : 0;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/gu, " ");
}
