import type { ChatGeneratedArtifactRecord, DesignAdvisory } from "@goatcitadel/contracts";
import { DESIGN_DETECTOR_RULES_VERSION, detectDesignAdvisories } from "@goatcitadel/skills";

/** Bounded memo of derived advisories keyed by rule-set version and content hash (artifacts are immutable per hash). */
export const ARTIFACT_ADVISORY_CACHE_MAX = 256;
const cache = new Map<string, DesignAdvisory[]>();

/**
 * HTML artifacts carry informational design advisories derived from their content on every read.
 * They are never stored: the artifact tables stay unchanged and the field always reflects the
 * current rule set. Redacted projections and other kinds are returned untouched. Reads are memoized
 * per content hash so list polls of hundreds of artifacts do not rescan unchanged content.
 */
export function withDesignAdvisories(artifact: ChatGeneratedArtifactRecord): ChatGeneratedArtifactRecord {
  if (artifact.kind !== "html" || artifact.publicProjection?.contentRedacted) return artifact;
  const designAdvisories = derive(artifact);
  return designAdvisories.length > 0 ? { ...artifact, designAdvisories } : artifact;
}

function derive(artifact: ChatGeneratedArtifactRecord): DesignAdvisory[] {
  const key = artifact.contentHash ? `${DESIGN_DETECTOR_RULES_VERSION}:${artifact.contentHash}` : undefined;
  if (key) {
    const cached = cache.get(key);
    if (cached) {
      // Refresh recency so the bounded map evicts the least recently used hash.
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
  }
  const advisories = detectDesignAdvisories(artifact.content);
  if (key) {
    cache.set(key, advisories);
    while (cache.size > ARTIFACT_ADVISORY_CACHE_MAX) {
      const oldest = cache.keys().next().value as string | undefined;
      if (!oldest) break;
      cache.delete(oldest);
    }
  }
  return advisories;
}
