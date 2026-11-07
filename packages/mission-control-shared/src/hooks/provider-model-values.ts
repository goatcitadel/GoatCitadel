import type { ProviderModelCatalogOption } from "./useProviderModelCatalog.js";

export function dedupeProviderModels(values: Array<string | undefined | null>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function isModelUnavailableInFreshCatalog(provider: ProviderModelCatalogOption | null, model: string): boolean {
  return Boolean(
    model &&
    provider?.modelProbeSource === "live" &&
    provider.modelRefreshStatus === "fresh" &&
    !provider.models.includes(model),
  );
}

export function isModelMissingFromStaleCatalog(provider: ProviderModelCatalogOption | null, model: string): boolean {
  return Boolean(
    model &&
    provider?.modelProbeSource === "live" &&
    provider.modelRefreshStatus === "stale" &&
    !provider.models.includes(model),
  );
}
