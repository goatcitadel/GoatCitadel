const patternCache = new Map<string, RegExp>();

export function matchesToolPattern(pattern: string, toolName: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed === "*") {
    return true;
  }
  if (!trimmed.includes("*")) {
    return trimmed === toolName;
  }
  let regex = patternCache.get(trimmed);
  if (!regex) {
    const escaped = trimmed
      .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
      .replace(/\*/g, ".*");
    regex = new RegExp(`^${escaped}$`);
    patternCache.set(trimmed, regex);
  }
  return regex.test(toolName);
}

export function matchesAnyToolPattern(values: Iterable<string>, toolName: string): boolean {
  for (const value of values) {
    if (matchesToolPattern(value, toolName)) {
      return true;
    }
  }
  return false;
}
