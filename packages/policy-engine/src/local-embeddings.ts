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
  method: "pseudo-embedding";
}

interface EmbeddingProfile {
  provider: EmbeddingProviderId;
  modelId: string;
  dimensions: number;
  version: string;
}

const PSEUDO_MODEL_ID = "pseudo-hash-v1";
const PSEUDO_DIMENSIONS = 64;
const EMBEDDING_VERSION = "goatcitadel-embedding-v1";

export async function generateEmbedding(text: string, now = new Date()): Promise<GeneratedEmbedding> {
  return createPseudoEmbedding(text, now, embeddingFallbackReason());
}

export function currentEmbeddingProfile(): EmbeddingProfile {
  return resolveEmbeddingProfile();
}

export function isEmbeddingCurrent(
  embedding: number[] | undefined,
  metadata: Record<string, unknown> | undefined,
): boolean {
  if (!embedding || embedding.length === 0) {
    return false;
  }
  const profile = resolveEmbeddingProfile();
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

function createPseudoEmbedding(text: string, now: Date, fallbackReason?: string): GeneratedEmbedding {
  const embedding = pseudoEmbedding(text);
  return {
    embedding,
    method: "pseudo-embedding",
    metadata: {
      provider: "pseudo",
      modelId: PSEUDO_MODEL_ID,
      dimensions: embedding.length,
      generatedAt: now.toISOString(),
      version: EMBEDDING_VERSION,
      ...(fallbackReason ? { fallbackReason } : {}),
    },
  };
}

function resolveEmbeddingProfile(): EmbeddingProfile {
  return {
    provider: "pseudo",
    modelId: PSEUDO_MODEL_ID,
    dimensions: PSEUDO_DIMENSIONS,
    version: EMBEDDING_VERSION,
  };
}

function normalizeVector(values: number[]): number[] {
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (magnitude <= 0) {
    return values;
  }
  return values.map((value) => Number((value / magnitude).toFixed(8)));
}

function embeddingFallbackReason(): string | undefined {
  const requested = optionalString(process.env.GOATCITADEL_EMBEDDINGS_PROVIDER);
  if (requested && requested !== "pseudo") {
    return `embedding-provider-retired: ${requested}`;
  }
  return process.env.NODE_ENV === "test" ? "test-environment-default" : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
