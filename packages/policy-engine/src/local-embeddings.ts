import type { MemoryEmbeddingProfile, MemoryEmbeddingProfileRequest } from "@goatcitadel/contracts";

export type EmbeddingProviderId = "pseudo";

export interface EmbeddingMetadata extends Record<string, unknown> {
  provider: EmbeddingProviderId;
  modelId: string;
  dimensions: number;
  generatedAt: string;
  version: string;
  fallbackReason?: string;
}

export interface GeneratedEmbedding {
  embedding: number[];
  metadata: EmbeddingMetadata;
  profile: MemoryEmbeddingProfile;
  method: "pseudo-embedding";
}

const PSEUDO_MODEL_ID = "pseudo-hash-v1";
const PSEUDO_DIMENSIONS = 64;
const MIN_PSEUDO_DIMENSIONS = 8;
const MAX_PSEUDO_DIMENSIONS = 512;
const EMBEDDING_VERSION = "goatcitadel-embedding-v1";

export async function generateEmbedding(
  text: string,
  now = new Date(),
  request?: MemoryEmbeddingProfileRequest,
): Promise<GeneratedEmbedding> {
  return createPseudoEmbedding(text, now, resolveEmbeddingProfile(request));
}

export function currentEmbeddingProfile(request?: MemoryEmbeddingProfileRequest): MemoryEmbeddingProfile {
  return resolveEmbeddingProfile(request);
}

export function isEmbeddingCurrent(
  embedding: number[] | undefined,
  metadata: Record<string, unknown> | undefined,
  request?: MemoryEmbeddingProfileRequest,
): boolean {
  if (!embedding || embedding.length === 0) {
    return false;
  }
  const profile = resolveEmbeddingProfile(request);
  if (!metadata) {
    return false;
  }
  const provider = optionalString(metadata.provider);
  const modelId = optionalString(metadata.modelId);
  const version = optionalString(metadata.version);
  const dimensions = typeof metadata.dimensions === "number" ? metadata.dimensions : undefined;
  return (
    provider === profile.provider &&
    modelId === profile.modelId &&
    version === profile.version &&
    dimensions === embedding.length &&
    dimensions === profile.dimensions &&
    profile.dimensions === embedding.length
  );
}

export function isEmbeddingCompatible(
  embedding: number[] | undefined,
  metadata: Record<string, unknown> | undefined,
  queryMetadata: EmbeddingMetadata,
): embedding is number[] {
  if (!embedding || embedding.length !== queryMetadata.dimensions) {
    return false;
  }
  if (!metadata) {
    return queryMetadata.provider === "pseudo";
  }
  return (
    optionalString(metadata.provider) === queryMetadata.provider &&
    optionalString(metadata.modelId) === queryMetadata.modelId &&
    optionalString(metadata.version) === queryMetadata.version &&
    metadata.dimensions === queryMetadata.dimensions
  );
}

export function pseudoEmbedding(text: string, dimensions = PSEUDO_DIMENSIONS): number[] {
  const buckets = new Array<number>(dimensions).fill(0);
  for (let index = 0; index < text.length; index += 1) {
    const bucketIndex = index % buckets.length;
    buckets[bucketIndex] = (buckets[bucketIndex] ?? 0) + text.charCodeAt(index) / 255;
  }
  return normalizeVector(buckets.map((value) => Number(value.toFixed(6))));
}

function createPseudoEmbedding(text: string, now: Date, profile: MemoryEmbeddingProfile): GeneratedEmbedding {
  const embedding = pseudoEmbedding(text, profile.dimensions);
  const fallbackReason = embeddingFallbackReason(profile);
  return {
    embedding,
    profile,
    method: "pseudo-embedding",
    metadata: {
      provider: "pseudo",
      modelId: profile.modelId,
      dimensions: embedding.length,
      generatedAt: now.toISOString(),
      version: profile.version,
      profileId: profile.profileId,
      profileStatus: profile.status,
      ...(fallbackReason ? { fallbackReason } : {}),
    },
  };
}

function resolveEmbeddingProfile(request?: MemoryEmbeddingProfileRequest): MemoryEmbeddingProfile {
  const requestedProvider =
    optionalString(request?.provider) ?? optionalString(process.env.GOATCITADEL_EMBEDDINGS_PROVIDER) ?? "pseudo";
  const source = resolveEmbeddingProfileSource(request);
  if (requestedProvider !== "pseudo") {
    return {
      profileId: "pseudo:pseudo-hash-v1:64:goatcitadel-embedding-v1",
      provider: "pseudo",
      modelId: PSEUDO_MODEL_ID,
      dimensions: PSEUDO_DIMENSIONS,
      version: EMBEDDING_VERSION,
      status: "fallback",
      source,
      requestedProvider,
      fallbackReason: `embedding-provider-unavailable: ${requestedProvider}`,
    };
  }
  const modelId = optionalString(request?.modelId) ?? optionalString(process.env.GOATCITADEL_EMBEDDINGS_MODEL) ?? PSEUDO_MODEL_ID;
  const dimensions = normalizePseudoDimensions(
    request?.dimensions ?? optionalNumberFromEnv(process.env.GOATCITADEL_EMBEDDINGS_DIMENSIONS),
  );
  const profileId =
    optionalString(request?.profileId) ?? `pseudo:${modelId}:${dimensions}:${EMBEDDING_VERSION}`;
  return {
    provider: "pseudo",
    modelId,
    dimensions,
    version: EMBEDDING_VERSION,
    profileId,
    status: "active",
    source,
  };
}

function resolveEmbeddingProfileSource(
  request: MemoryEmbeddingProfileRequest | undefined,
): MemoryEmbeddingProfile["source"] {
  if (
    optionalString(request?.provider) ||
    optionalString(request?.modelId) ||
    optionalString(request?.profileId) ||
    typeof request?.dimensions === "number"
  ) {
    return "request";
  }
  if (
    optionalString(process.env.GOATCITADEL_EMBEDDINGS_PROVIDER) ||
    optionalString(process.env.GOATCITADEL_EMBEDDINGS_MODEL) ||
    optionalString(process.env.GOATCITADEL_EMBEDDINGS_DIMENSIONS)
  ) {
    return "environment";
  }
  return "default";
}

function normalizeVector(values: number[]): number[] {
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (magnitude <= 0) {
    return values;
  }
  return values.map((value) => Number((value / magnitude).toFixed(8)));
}

function normalizePseudoDimensions(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return PSEUDO_DIMENSIONS;
  }
  return Math.max(MIN_PSEUDO_DIMENSIONS, Math.min(MAX_PSEUDO_DIMENSIONS, Math.floor(value)));
}

function optionalNumberFromEnv(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function embeddingFallbackReason(profile: MemoryEmbeddingProfile): string | undefined {
  if (profile.fallbackReason) {
    return profile.fallbackReason;
  }
  return process.env.NODE_ENV === "test" ? "test-environment-default" : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
