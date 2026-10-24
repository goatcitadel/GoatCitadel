import type { LlmProviderSummary } from "@goatcitadel/contracts";

/**
 * Recorded as the fallback reason when the distiller would implicitly run on the active Claude Code CLI.
 * Each CLI call starts its own process, and the distiller blocks the turn's first token: live it delayed
 * the first text by 7-12 s and spent the operator's subscription on a call they never saw (#493).
 */
export const MEMORY_DISTILLER_SKIPPED_PER_CALL_CLI_REASON =
  "distiller_skipped: the active provider starts a Claude Code CLI process per call; the deterministic context was used";

/** Routes the skip through the distiller's existing deterministic fallback. */
export class MemoryDistillerSkippedError extends Error {
  public constructor() {
    super(MEMORY_DISTILLER_SKIPPED_PER_CALL_CLI_REASON);
    this.name = "MemoryDistillerSkippedError";
  }
}

/**
 * True when the distiller fell back to the active provider (no distiller provider is configured) and that
 * provider runs as a Claude Code CLI process. An operator who configured the CLI as the distiller keeps it.
 */
export function isImplicitPerCallCliDistiller(
  configuredProviderId: string | undefined,
  providerId: string,
  providers: readonly Pick<LlmProviderSummary, "providerId" | "apiStyle" | "resolvedApiStyle">[] = [],
): boolean {
  if (configuredProviderId) return false;
  const provider = providers.find((item) => item.providerId === providerId);
  return (provider?.resolvedApiStyle ?? provider?.apiStyle) === "claude-code-cli";
}
