export type EmbeddingProviderId = "transformers-js" | "pseudo";

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
  method: "transformers-js" | "pseudo-embedding";
}

interface EmbeddingProfile {
  provider: EmbeddingProviderId;
  modelId: string;
  dimensions?: number;
  version: string;
}

type FeatureExtractionPipeline = (
  text: string,
  options: { pooling: "mean"; normalize: true },
) => Promise<{
  data: ArrayLike<number>;
  dims: number[];
  tolist?: () => unknown[];
}>;

const DEFAULT_TRANSFORMERS_MODEL_ID = "onnx-community/all-MiniLM-L6-v2-ONNX";
const PSEUDO_MODEL_ID = "pseudo-hash-v1";
const PSEUDO_DIMENSIONS = 64;
const EMBEDDING_VERSION = "goatcitadel-embedding-v1";

let featureExtractionPipelinePromise: Promise<FeatureExtractionPipeline> | undefined;

export async function generateEmbedding(text: string, now = new Date()): Promise<GeneratedEmbedding> {
  const profile = resolveEmbeddingProfile();
  if (profile.provider === "pseudo") {
    return createPseudoEmbedding(text, now, testFallbackReason());
  }

  try {
    const extractor = await getFeatureExtractionPipeline(profile.modelId);
    const output = await extractor(text, { pooling: "mean", normalize: true });
    const values = Array.from(output.data, (value) => Number(Number(value).toFixed(8)));
    return {
      embedding: values,
      method: "transformers-js",
      metadata: {
        provider: "transformers-js",
        modelId: profile.modelId,
        dimensions: values.length,
        generatedAt: now.toISOString(),
        version: profile.version,
      },
    };
  } catch (error) {
    return createPseudoEmbedding(text, now, fallbackReason(error));
  }
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
    (profile.dimensions === undefined || profile.dimensions === embedding.length)
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

async function getFeatureExtractionPipeline(modelId: string): Promise<FeatureExtractionPipeline> {
  featureExtractionPipelinePromise ??= importRuntimeModule("@huggingface/transformers").then(async (module) => {
    const { pipeline } = module as {
      pipeline: (task: "feature-extraction", model: string, options: { local_files_only: boolean }) => Promise<unknown>;
    };
    const extractor = await pipeline("feature-extraction", modelId, {
      local_files_only: process.env.GOATCITADEL_EMBEDDINGS_LOCAL_FILES_ONLY === "1",
    });
    return extractor as FeatureExtractionPipeline;
  });
  return featureExtractionPipelinePromise;
}

async function importRuntimeModule(specifier: string): Promise<unknown> {
  return import(specifier);
}

function resolveEmbeddingProfile(): EmbeddingProfile {
  const requested = optionalString(process.env.GOATCITADEL_EMBEDDINGS_PROVIDER);
  if (requested === "pseudo" || (!requested && process.env.NODE_ENV === "test")) {
    return {
      provider: "pseudo",
      modelId: PSEUDO_MODEL_ID,
      dimensions: PSEUDO_DIMENSIONS,
      version: EMBEDDING_VERSION,
    };
  }
  return {
    provider: "transformers-js",
    modelId: optionalString(process.env.GOATCITADEL_EMBEDDINGS_MODEL) ?? DEFAULT_TRANSFORMERS_MODEL_ID,
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

function fallbackReason(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return `transformers-js-unavailable: ${error.message.slice(0, 180)}`;
  }
  return "transformers-js-unavailable";
}

function testFallbackReason(): string | undefined {
  return process.env.NODE_ENV === "test" && !optionalString(process.env.GOATCITADEL_EMBEDDINGS_PROVIDER)
    ? "test-environment-default"
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
