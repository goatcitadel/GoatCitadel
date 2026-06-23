import type { MemoryEmbeddingProfile, MemoryEmbeddingProfileRequest } from "@goatcitadel/contracts";

/**
 * Embedding providers supported behind the single `generateEmbedding` seam.
 *
 * - `pseudo`  — deterministic char-bucket hash. Zero dependencies, ~free, no
 *   semantic signal. The default and the always-available fallback floor.
 * - `llamacpp` — a local llama.cpp-style HTTP embeddings server (the
 *   `POST /embedding` endpoint exposed by `llama-server`/`llama.cpp`).
 * - `remote`  — an OpenAI-compatible `POST /v1/embeddings` endpoint (OpenAI,
 *   Ollama's compat shim, vLLM, TEI, etc.).
 *
 * Provider selection is resolved from `GOATCITADEL_EMBEDDINGS_PROVIDER`
 * (default `pseudo`). Any real provider degrades to `pseudo` on missing config
 * or any runtime/transport error — embeddings are best-effort and the embedding
 * path never throws.
 */
export type EmbeddingProviderId = "pseudo" | "llamacpp" | "remote";

/**
 * Provider selection as resolved from raw config. Adds an `"unsupported"`
 * sentinel for provider ids we do not recognise: unlike the concrete provider
 * ids it never maps onto a real transport — it is always treated as unavailable
 * and degrades to the pseudo fallback (no HTTP attempt), even when an embeddings
 * URL is configured. It is deliberately NOT part of {@link EmbeddingProviderId}
 * (the type stamped onto vectors), which only ever holds real provider ids.
 */
type ResolvedProviderSelection = EmbeddingProviderId | "unsupported";

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
  method: "pseudo-embedding" | "llamacpp-embedding" | "remote-embedding";
}

const PSEUDO_MODEL_ID = "pseudo-hash-v1";
const PSEUDO_DIMENSIONS = 64;
const MIN_PSEUDO_DIMENSIONS = 8;
const MAX_PSEUDO_DIMENSIONS = 512;
const EMBEDDING_VERSION = "goatcitadel-embedding-v1";

const LLAMACPP_DEFAULT_MODEL_ID = "llamacpp-embedding";
const REMOTE_DEFAULT_MODEL_ID = "text-embedding-3-small";
const DEFAULT_EMBEDDINGS_TIMEOUT_MS = 10_000;
const MIN_EMBEDDINGS_TIMEOUT_MS = 250;
const MAX_EMBEDDINGS_TIMEOUT_MS = 120_000;

/**
 * Generate an embedding for `text` using the configured provider, stamping the
 * resulting vector with the resolved profile (provider/modelId/version/
 * dimensions) so `isEmbeddingCurrent` validates correctly and the W1 store +
 * retrieve paths share one consistent dimensionality.
 *
 * The signature is intentionally async and unchanged from the pseudo-only era:
 * W1 callers already `await` it, so adding network I/O for real providers is
 * transparent. On missing config or any error the call resolves to a pseudo
 * embedding (it never rejects) — embeddings are best-effort.
 */
export async function generateEmbedding(
  text: string,
  now = new Date(),
  request?: MemoryEmbeddingProfileRequest,
): Promise<GeneratedEmbedding> {
  const providerId = resolveEmbeddingProviderId(request);
  if (providerId === "pseudo" || providerId === "unsupported") {
    // Pseudo, or an unrecognised provider id — both resolve to a pseudo profile
    // (the latter a `embedding-provider-unavailable` fallback). Never touch the
    // network for an unknown provider, even if an embeddings URL is configured.
    return createPseudoEmbedding(text, now, resolveEmbeddingProfile(request));
  }
  const realProfile = resolveEmbeddingProfile(request);
  if (realProfile.provider === "pseudo") {
    // Resolution already decided the real provider is unusable (bad config) and
    // returned a stamped pseudo-fallback profile.
    return createPseudoEmbedding(text, now, realProfile);
  }
  try {
    const generated = await generateRealEmbedding(providerId, text, now, realProfile);
    if (generated) {
      return generated;
    }
  } catch (error) {
    return createPseudoEmbedding(text, now, pseudoFallbackProfile(request, providerId, describeError(error)));
  }
  return createPseudoEmbedding(text, now, pseudoFallbackProfile(request, providerId, "embedding-empty-result"));
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

/**
 * Attempt a real-provider embedding. Returns `undefined` to signal a soft
 * fallback (config-shaped problem the caller should turn into a pseudo
 * embedding); throws only on transport/parse errors, which the caller catches
 * and likewise converts to a pseudo fallback. The returned vector's length is
 * asserted to equal `profile.dimensions` so store + query embeddings can never
 * silently diverge in dimensionality.
 */
async function generateRealEmbedding(
  providerId: EmbeddingProviderId,
  text: string,
  now: Date,
  profile: MemoryEmbeddingProfile,
): Promise<GeneratedEmbedding | undefined> {
  const config = resolveRealProviderConfig(providerId);
  if (!config) {
    return undefined;
  }
  const rawVector =
    providerId === "llamacpp" ? await fetchLlamaCppEmbedding(config, text) : await fetchRemoteEmbedding(config, text);
  const embedding = sanitizeEmbeddingVector(rawVector);
  if (!embedding || embedding.length !== profile.dimensions) {
    // Dimension mismatch (or empty/invalid vector) would poison cosine
    // similarity against existing vectors — refuse and let the caller fall back.
    throw new Error(
      embedding
        ? `embedding-dimension-mismatch: expected ${profile.dimensions}, received ${embedding.length}`
        : "embedding-invalid-vector",
    );
  }
  return {
    embedding,
    profile,
    method: providerId === "llamacpp" ? "llamacpp-embedding" : "remote-embedding",
    metadata: {
      provider: providerId,
      modelId: profile.modelId,
      dimensions: embedding.length,
      generatedAt: now.toISOString(),
      version: profile.version,
      profileId: profile.profileId,
      profileStatus: profile.status,
    },
  };
}

interface RealProviderConfig {
  url: string;
  modelId: string;
  apiKey?: string;
  timeoutMs: number;
}

function resolveRealProviderConfig(providerId: EmbeddingProviderId): RealProviderConfig | undefined {
  const url = optionalString(process.env.GOATCITADEL_EMBEDDINGS_URL);
  if (!url) {
    return undefined;
  }
  return {
    url,
    modelId:
      optionalString(process.env.GOATCITADEL_EMBEDDINGS_MODEL) ??
      (providerId === "llamacpp" ? LLAMACPP_DEFAULT_MODEL_ID : REMOTE_DEFAULT_MODEL_ID),
    apiKey: optionalString(process.env.GOATCITADEL_EMBEDDINGS_API_KEY),
    timeoutMs: resolveTimeoutMs(process.env.GOATCITADEL_EMBEDDINGS_TIMEOUT_MS),
  };
}

async function fetchLlamaCppEmbedding(config: RealProviderConfig, text: string): Promise<unknown> {
  const payload = await fetchEmbeddingJson(config, {
    body: { content: text },
  });
  // llama.cpp returns `{ embedding: number[] }` or, with newer builds,
  // `[{ embedding: number[] }]` / `{ data: [{ embedding }] }`.
  return (
    pickEmbeddingArray(payload) ??
    pickEmbeddingArray(firstArrayItem(payload)) ??
    pickEmbeddingArray(firstDataItem(payload))
  );
}

async function fetchRemoteEmbedding(config: RealProviderConfig, text: string): Promise<unknown> {
  const payload = await fetchEmbeddingJson(config, {
    body: { model: config.modelId, input: text },
  });
  // OpenAI-compatible shape: `{ data: [{ embedding: number[] }] }`.
  return pickEmbeddingArray(firstDataItem(payload)) ?? pickEmbeddingArray(payload);
}

async function fetchEmbeddingJson(
  config: RealProviderConfig,
  options: { body: Record<string, unknown> },
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(options.body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`embedding-http-${response.status}`);
    }
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function resolveEmbeddingProviderId(request?: MemoryEmbeddingProfileRequest): ResolvedProviderSelection {
  const requested =
    optionalString(request?.provider) ?? optionalString(process.env.GOATCITADEL_EMBEDDINGS_PROVIDER) ?? "pseudo";
  return normalizeProviderId(requested);
}

/**
 * Map an arbitrary provider string onto a known provider selection. Recognised
 * aliases collapse onto `llamacpp`/`remote` (incl. historical values like
 * `remote-openai-compatible`); `pseudo` stays pseudo; anything else resolves to
 * `"unsupported"` so it is treated as unavailable and degrades to the pseudo
 * fallback — a typo'd/misconfigured provider must NEVER make live HTTP calls to
 * the configured embeddings URL under the guise of `remote`.
 */
function normalizeProviderId(value: string): ResolvedProviderSelection {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if (normalized === "pseudo") {
    return "pseudo";
  }
  if (
    normalized === "llamacpp" ||
    normalized === "llama-cpp" ||
    normalized === "llama" ||
    normalized === "local" ||
    normalized === "llama-server"
  ) {
    return "llamacpp";
  }
  if (
    normalized === "remote" ||
    normalized === "openai" ||
    normalized === "openai-compatible" ||
    normalized === "remote-openai-compatible" ||
    normalized === "ollama" ||
    normalized === "vllm" ||
    normalized === "tei"
  ) {
    return "remote";
  }
  // Unknown provider id — unsupported. Resolution stamps an explicit
  // `embedding-provider-unavailable` pseudo fallback and never attempts HTTP.
  return "unsupported";
}

function resolveEmbeddingProfile(request?: MemoryEmbeddingProfileRequest): MemoryEmbeddingProfile {
  const requestedRaw =
    optionalString(request?.provider) ?? optionalString(process.env.GOATCITADEL_EMBEDDINGS_PROVIDER) ?? "pseudo";
  const providerId = normalizeProviderId(requestedRaw);
  const source = resolveEmbeddingProfileSource(request);
  if (providerId === "pseudo") {
    return resolvePseudoProfile(request, source);
  }
  if (providerId === "unsupported") {
    // Unrecognised provider id → unavailable. Stamp the pseudo fallback (with the
    // historical reason) and never resolve a real-provider profile, so the
    // generate path cannot reach the HTTP transport.
    return pseudoFallbackProfile(request, requestedRaw, `embedding-provider-unavailable: ${requestedRaw}`);
  }
  const realProfile = resolveRealProviderProfile(request, providerId, source);
  if (realProfile) {
    return realProfile;
  }
  // Real provider requested but not usably configured → explicit pseudo fallback
  // that preserves the historical `requestedProvider` + reason contract.
  return pseudoFallbackProfile(request, requestedRaw, `embedding-provider-unavailable: ${requestedRaw}`);
}

function resolvePseudoProfile(
  request: MemoryEmbeddingProfileRequest | undefined,
  source: MemoryEmbeddingProfile["source"],
): MemoryEmbeddingProfile {
  const modelId =
    optionalString(request?.modelId) ?? optionalString(process.env.GOATCITADEL_EMBEDDINGS_MODEL) ?? PSEUDO_MODEL_ID;
  const dimensions = normalizePseudoDimensions(
    request?.dimensions ?? optionalNumberFromEnv(process.env.GOATCITADEL_EMBEDDINGS_DIMENSIONS),
  );
  const profileId = optionalString(request?.profileId) ?? `pseudo:${modelId}:${dimensions}:${EMBEDDING_VERSION}`;
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

/**
 * Build the active profile for a real provider, or `undefined` when the
 * provider is not usably configured (missing URL/dimensions). The profile's
 * `dimensions` is the single source of truth for store + query consistency, so
 * a real provider is only "active" when its dimensionality is known up front.
 */
function resolveRealProviderProfile(
  request: MemoryEmbeddingProfileRequest | undefined,
  providerId: EmbeddingProviderId,
  source: MemoryEmbeddingProfile["source"],
): MemoryEmbeddingProfile | undefined {
  const url = optionalString(process.env.GOATCITADEL_EMBEDDINGS_URL);
  const dimensions = request?.dimensions ?? optionalNumberFromEnv(process.env.GOATCITADEL_EMBEDDINGS_DIMENSIONS);
  if (!url || typeof dimensions !== "number" || !Number.isFinite(dimensions) || dimensions <= 0) {
    return undefined;
  }
  const resolvedDimensions = Math.floor(dimensions);
  const modelId =
    optionalString(request?.modelId) ??
    optionalString(process.env.GOATCITADEL_EMBEDDINGS_MODEL) ??
    (providerId === "llamacpp" ? LLAMACPP_DEFAULT_MODEL_ID : REMOTE_DEFAULT_MODEL_ID);
  const profileId =
    optionalString(request?.profileId) ?? `${providerId}:${modelId}:${resolvedDimensions}:${EMBEDDING_VERSION}`;
  return {
    provider: providerId,
    modelId,
    dimensions: resolvedDimensions,
    version: EMBEDDING_VERSION,
    profileId,
    status: "active",
    source,
  };
}

function pseudoFallbackProfile(
  request: MemoryEmbeddingProfileRequest | undefined,
  requestedProvider: string,
  fallbackReason: string,
): MemoryEmbeddingProfile {
  return {
    profileId: "pseudo:pseudo-hash-v1:64:goatcitadel-embedding-v1",
    provider: "pseudo",
    modelId: PSEUDO_MODEL_ID,
    dimensions: PSEUDO_DIMENSIONS,
    version: EMBEDDING_VERSION,
    status: "fallback",
    source: resolveEmbeddingProfileSource(request),
    requestedProvider,
    fallbackReason,
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
    optionalString(process.env.GOATCITADEL_EMBEDDINGS_DIMENSIONS) ||
    optionalString(process.env.GOATCITADEL_EMBEDDINGS_URL)
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

function sanitizeEmbeddingVector(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const numbers: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      return undefined;
    }
    numbers.push(entry);
  }
  return normalizeVector(numbers.map((entry) => Number(entry.toFixed(8))));
}

function pickEmbeddingArray(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value;
  }
  if (isRecord(value) && Array.isArray(value.embedding)) {
    return value.embedding;
  }
  return undefined;
}

function firstArrayItem(value: unknown): unknown {
  return Array.isArray(value) && value.length > 0 ? value[0] : undefined;
}

function firstDataItem(value: unknown): unknown {
  if (isRecord(value) && Array.isArray(value.data) && value.data.length > 0) {
    return value.data[0];
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return "embedding-provider-timeout";
    }
    return `embedding-provider-error: ${error.message}`;
  }
  return "embedding-provider-error";
}

function resolveTimeoutMs(value: unknown): number {
  const parsed = optionalNumberFromEnv(value);
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    return DEFAULT_EMBEDDINGS_TIMEOUT_MS;
  }
  return Math.max(MIN_EMBEDDINGS_TIMEOUT_MS, Math.min(MAX_EMBEDDINGS_TIMEOUT_MS, Math.floor(parsed)));
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
