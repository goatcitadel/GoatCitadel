import { readFileSync } from "node:fs";
import type {
  ChatCompletionReasoningEffort,
  LlmModelMetadataEntry,
  LlmModelMetadataManifest,
} from "@goatcitadel/contracts";

export interface LlmModelMetadataLoaderResult {
  manifest: LlmModelMetadataManifest;
  errors: string[];
}

const EMPTY_MANIFEST: LlmModelMetadataManifest = { version: 1, entries: {} };
const REASONING_EFFORTS = new Set<ChatCompletionReasoningEffort>([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

export function loadLlmModelMetadataManifest(path: string): LlmModelMetadataLoaderResult {
  const errors: string[] = [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    errors.push(`llm-model-metadata: could not read ${path}: ${(error as Error).message}`);
    return { manifest: { ...EMPTY_MANIFEST }, errors };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    errors.push(`llm-model-metadata: invalid JSON in ${path}: ${(error as Error).message}`);
    return { manifest: { ...EMPTY_MANIFEST }, errors };
  }
  if (!isManifest(parsed)) {
    errors.push(`llm-model-metadata: ${path} does not match manifest shape`);
    return { manifest: { ...EMPTY_MANIFEST }, errors };
  }
  return { manifest: parsed, errors };
}

export function lookupModelMetadata(
  manifest: LlmModelMetadataManifest,
  providerId: string,
  modelId: string,
): LlmModelMetadataEntry | undefined {
  const exact = lookupExactModelMetadata(manifest, providerId, modelId);
  if (exact) return exact;
  const providerWildcard = manifest.entries[`${providerId}/*`];
  if (providerWildcard) return providerWildcard;
  return undefined;
}

/** Exact model metadata is required for model-scoped capability grants. */
export function lookupExactModelMetadata(
  manifest: LlmModelMetadataManifest,
  providerId: string,
  modelId: string,
): LlmModelMetadataEntry | undefined {
  return manifest.entries[`${providerId}/${modelId}`];
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
    if (
      meta.status !== undefined &&
      meta.status !== "available" &&
      meta.status !== "experimental" &&
      meta.status !== "deprecated" &&
      meta.status !== "retired"
    ) {
      return false;
    }
    if (meta.retiresOn !== undefined && typeof meta.retiresOn !== "string") return false;
    if (meta.tokenMultiplier !== undefined && (typeof meta.tokenMultiplier !== "number" || meta.tokenMultiplier <= 0)) {
      return false;
    }
    if (meta.reasoning !== undefined && !isReasoningMetadata(meta.reasoning)) return false;
  }
  return true;
}

function isReasoningMetadata(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as {
    supportedEfforts?: unknown;
    providerEffortMap?: unknown;
  };
  if (!Array.isArray(candidate.supportedEfforts) || candidate.supportedEfforts.length === 0) return false;
  if (!candidate.supportedEfforts.every(isReasoningEffort)) return false;
  if (new Set(candidate.supportedEfforts).size !== candidate.supportedEfforts.length) return false;
  if (candidate.providerEffortMap === undefined) return true;
  if (
    !candidate.providerEffortMap ||
    typeof candidate.providerEffortMap !== "object" ||
    Array.isArray(candidate.providerEffortMap)
  ) {
    return false;
  }
  for (const [requested, providerEffort] of Object.entries(candidate.providerEffortMap)) {
    if (!isReasoningEffort(requested) || !isReasoningEffort(providerEffort)) return false;
    if (!candidate.supportedEfforts.includes(requested)) return false;
  }
  return true;
}

function isReasoningEffort(value: unknown): value is ChatCompletionReasoningEffort {
  return typeof value === "string" && REASONING_EFFORTS.has(value as ChatCompletionReasoningEffort);
}
