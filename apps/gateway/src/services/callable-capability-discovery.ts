import type { CapabilityCatalogEntry } from "@goatcitadel/contracts";

/** Metadata-only retrieval over a server-scoped callable catalog. Scores are never permissions. */
export function searchCallableCapabilities(input: {
  query: string;
  limit?: number;
  callableCatalog: readonly CapabilityCatalogEntry[];
}): Record<string, unknown> {
  if (
    !input.query.trim() ||
    input.query.length > 512 ||
    (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 5))
  ) {
    throw new Error("Capability discovery requires a bounded query and limit from 1 to 5.");
  }
  const terms = [...new Set(input.query.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 32);
  const scored = input.callableCatalog
    .filter((entry) => entry.callable && (entry.kind === "tool" || entry.kind === "skill"))
    .slice(0, 2000)
    .map((entry) => {
      const title = `${entry.title} ${entry.toolName ?? ""} ${entry.skillId ?? ""}`.slice(0, 1024).toLocaleLowerCase();
      const summary = entry.summary.slice(0, 2048).toLocaleLowerCase();
      return {
        entry,
        score: terms.reduce(
          (score, term) => score + (title.includes(term) ? 4 : 0) + (summary.includes(term) ? 1 : 0),
          0,
        ),
      };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.entry.capabilityId.localeCompare(right.entry.capabilityId))
    .slice(0, input.limit ?? 5);
  return {
    discoveryOnly: true,
    capabilities: scored.map(({ entry }) => ({
      kind: entry.kind,
      capabilityId: entry.capabilityId,
      title: entry.title.slice(0, 256),
      summary: entry.summary.slice(0, 512),
      ...(entry.toolName ? { toolName: entry.toolName } : {}),
      ...(entry.skillId ? { skillId: entry.skillId } : {}),
    })),
  };
}

/** Result content nominates tools only; the runner must rebuild from its current policy-filtered catalog. */
export function discoveredToolNamesFromResult(result: unknown): string[] {
  if (
    !result ||
    typeof result !== "object" ||
    !("discoveryOnly" in result) ||
    result.discoveryOnly !== true ||
    !("capabilities" in result) ||
    !Array.isArray(result.capabilities)
  )
    return [];
  return [
    ...new Set(
      result.capabilities.slice(0, 5).flatMap((entry: unknown) => {
        if (
          !entry ||
          typeof entry !== "object" ||
          !("kind" in entry) ||
          entry.kind !== "tool" ||
          !("toolName" in entry) ||
          typeof entry.toolName !== "string" ||
          entry.toolName.length > 256
        )
          return [];
        return [entry.toolName];
      }),
    ),
  ];
}
