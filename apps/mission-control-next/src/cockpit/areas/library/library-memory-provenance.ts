const OTHER_SOURCE_KEYS = ["source", "sourceRef", "sourceKind", "sourceTurnId", "actorId", "origin"] as const;

const KNOWN_SOURCE_LINES: Readonly<Record<string, string>> = {
  approved_memory_lifecycle: "Saved through a change you approved.",
  scheduler: "Saved by a scheduled job.",
  memory_context: "Saved from conversation context.",
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Plain-words reasons a memory item exists, from the metadata the Gateway recorded. */
export function describeMemoryProvenance(metadata: Readonly<Record<string, unknown>>): {
  lines: string[];
  conversationId?: string;
} {
  const lines: string[] = [];
  const conversationId = text(metadata.sourceSessionId);
  if (conversationId) lines.push("Remembered from a conversation.");
  const known = typeof metadata.source === "string" ? KNOWN_SOURCE_LINES[metadata.source] : undefined;
  if (known) lines.push(known);
  if (!lines.length && OTHER_SOURCE_KEYS.some((key) => typeof metadata[key] === "string"))
    lines.push("A source was recorded. Its details are under Memory source identifiers.");
  if (!lines.length) lines.push("No source was recorded for this item.");
  return conversationId ? { lines, conversationId } : { lines };
}
