export function detectPromptPackIncompleteOutput(response: string): boolean {
  return (
    /\bpartial answer\b/.test(response) ||
    /\bdid not finish cleanly\b/.test(response) ||
    /\bcould not confidently produce the full requested\b/.test(response) ||
    /\bcould not complete\b/.test(response) ||
    /\bbest next move: retry\b/.test(response) ||
    /\brecovered from tool output\b/.test(response)
  );
}

export function detectPromptPackPartialReadBlocker(response: string): boolean {
  const mentionsPartialRead =
    /\btruncat(?:ed|ion)?\b|\bpartial read\b|\boutput was cut off\b|\bneed the full file\b/.test(response);
  const stoppedInsteadOfRecovering =
    /\bcannot determine\b|\bcould not identify\b|\bcan't identify\b|\bfailed to answer\b|\bneed a narrower query\b|\bneed more input\b|\bexact patch points?\b/.test(
      response,
    );
  return mentionsPartialRead && stoppedInsteadOfRecovering;
}

export function hasMarkdownTableOutput(responseText: string): boolean {
  return /\|[^\n]+\|[\t ]*\n[\t ]*\|(?:[\t ]*:?-{3,}:?[\t ]*\|)+/m.test(responseText);
}

export function promptPositivelyRequiresJsonOutput(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  if (!/\bjson\b/.test(normalized)) {
    return false;
  }
  if (
    /\bdo not return json\b/.test(normalized) ||
    /\bdo not use json\b/.test(normalized) ||
    /\bno json\b/.test(normalized) ||
    /\bdo not return\b[\s\S]{0,20}\bjson\b/.test(normalized)
  ) {
    return false;
  }
  return (
    /\b(return|respond|output|provide|emit|format|formatted|as|full)\b[\s\S]{0,60}\bjson\b/.test(normalized) ||
    /\bjson\b[\s\S]{0,40}\b(array|object|only|required)\b/.test(normalized)
  );
}

export function promptPositivelyRequiresTableOutput(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  if (!/\btable\b/.test(normalized)) {
    return false;
  }
  if (
    /\bdo not return a table\b/.test(normalized) ||
    /\bdo not return table\b/.test(normalized) ||
    /\bdo not use a table\b/.test(normalized) ||
    /\bno table\b/.test(normalized)
  ) {
    return false;
  }
  return (
    /\b(compare|present|return|summari[sz]e|list|format)\b[\s\S]{0,80}\btable\b/.test(normalized) ||
    /\btable\b[\s\S]{0,40}\bformat\b/.test(normalized)
  );
}

export function hasJsonLikeStructuredOutput(responseText: string): boolean {
  const trimmed = responseText.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return true;
  }
  return /```(?:json)?\s*[[{]/i.test(trimmed);
}
