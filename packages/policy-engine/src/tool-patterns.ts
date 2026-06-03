const MAX_PATTERN_LENGTH = 512;
const MAX_TOOL_NAME_LENGTH = 512;
const MAX_PATTERN_CACHE_ENTRIES = 1_000;

const patternCache = new Map<string, RegExp>();

export function matchesToolPattern(pattern: string, toolName: string): boolean {
  const trimmed = pattern.trim();
  const name = toolName.trim();
  if (!trimmed || !name || trimmed.length > MAX_PATTERN_LENGTH || name.length > MAX_TOOL_NAME_LENGTH) {
    return false;
  }
  if (trimmed === "*") {
    return true;
  }
  if (!trimmed.includes("*")) {
    return trimmed === name;
  }
  let regex = getCachedPattern(trimmed);
  if (!regex) {
    const escaped = trimmed.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*");
    regex = new RegExp(`^${escaped}$`);
    cachePattern(trimmed, regex);
  }
  return regex.test(name);
}

export function matchesAnyToolPattern(values: Iterable<string>, toolName: string): boolean {
  for (const value of values) {
    if (matchesToolPattern(value, toolName)) {
      return true;
    }
  }
  return false;
}

function getCachedPattern(pattern: string): RegExp | undefined {
  const regex = patternCache.get(pattern);
  if (regex) {
    patternCache.delete(pattern);
    patternCache.set(pattern, regex);
  }
  return regex;
}

function cachePattern(pattern: string, regex: RegExp): void {
  if (patternCache.size >= MAX_PATTERN_CACHE_ENTRIES) {
    const oldest = patternCache.keys().next().value;
    if (typeof oldest === "string") {
      patternCache.delete(oldest);
    }
  }
  patternCache.set(pattern, regex);
}
