import { readFileSync } from "node:fs";
import type { LlmModelMetadataEntry, LlmModelMetadataManifest } from "@goatcitadel/contracts";

export interface LlmModelMetadataLoaderResult {
  manifest: LlmModelMetadataManifest;
  errors: string[];
}

const EMPTY_MANIFEST: LlmModelMetadataManifest = { version: 1, entries: {} };

export function loadLlmModelMetadataManifest(path: string): LlmModelMetadataLoaderResult {
  const errors: string[] = [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    errors.push(`llm-model-metadata: could not read ${path}: ${(error as Error).message}`);
    return { manifest: { ...EMPTY_MANIFEST, entries: {} }, errors };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    errors.push(`llm-model-metadata: invalid JSON in ${path}: ${(error as Error).message}`);
    return { manifest: { ...EMPTY_MANIFEST, entries: {} }, errors };
  }
  if (!isManifest(parsed)) {
    errors.push(`llm-model-metadata: ${path} does not match manifest shape`);
    return { manifest: { ...EMPTY_MANIFEST, entries: {} }, errors };
  }
  return { manifest: parsed, errors };
}

export function lookupModelMetadata(
  manifest: LlmModelMetadataManifest,
  providerId: string,
  modelId: string,
): LlmModelMetadataEntry | undefined {
  const exact = manifest.entries[`${providerId}/${modelId}`];
  if (exact) return exact;
  const providerWildcard = manifest.entries[`${providerId}/*`];
  if (providerWildcard) return providerWildcard;
  return undefined;
}

function isManifest(value: unknown): value is LlmModelMetadataManifest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LlmModelMetadataManifest>;
  if (typeof candidate.version !== "number") return false;
  if (!candidate.entries || typeof candidate.entries !== "object") return false;
  for (const entry of Object.values(candidate.entries)) {
    if (!entry || typeof entry !== "object") return false;
    const meta = entry as Partial<LlmModelMetadataEntry>;
    if (typeof meta.contextWindow !== "number" || meta.contextWindow <= 0) return false;
    if (typeof meta.outputTokenLimit !== "number" || meta.outputTokenLimit <= 0) return false;
    if (meta.thinking !== undefined && meta.thinking !== "off" && meta.thinking !== "auto") return false;
  }
  return true;
}
