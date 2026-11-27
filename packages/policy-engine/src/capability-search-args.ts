export function parseCapabilitySearchArgs(args: Record<string, unknown>): { query: string; limit: number } | undefined {
  const { query, limit = 5 } = args;
  if (
    Object.keys(args).some((key) => key !== "query" && key !== "limit") ||
    typeof query !== "string" ||
    !query.trim() ||
    query.length > 512 ||
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 5
  ) {
    return undefined;
  }
  return { query: query.trim(), limit };
}
