import {
  ConflictError,
  type MemoryEmbeddingProfile,
  type MemoryEmbeddingProfileRequest,
  type ModelUsageAttributionContext,
  type ModelUsageCostSource,
  type ModelUsageCredentialSource,
  type ModelUsageCredentialType,
  type ModelUsagePool,
  type ModelUsagePricingSource,
} from "@goatcitadel/contracts";
import { readBoundedResponseJson } from "./sandbox/network-guard.js";

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
 * or any ordinary runtime/transport error — embeddings are best-effort. An
 * explicit caller abort or canonical usage-settlement failure is propagated
 * instead of being hidden behind a pseudo fallback.
 */
export type EmbeddingProviderId = "pseudo" | "llamacpp" | "remote";

export type EmbeddingLeasePurpose =
  | "memory_write"
  | "document_ingest"
  | "embedding_index"
  | "embedding_query"
  | "embedding_repair";

export interface LocalEmbeddingRuntimeLease {
  release(): void | Promise<void>;
}

export interface LocalEmbeddingLeaseRequest {
  providerId: "llamacpp";
  url: string;
  purpose: EmbeddingLeasePurpose;
  signal?: AbortSignal;
}

export type AcquireLocalEmbeddingLease = (
  request: LocalEmbeddingLeaseRequest,
) => Promise<LocalEmbeddingRuntimeLease | undefined>;

/**
 * Structural usage-accounting port kept in policy-engine so this package does
 * not depend on gateway-core. The Gateway binds its canonical accounting
 * service to this port at composition time.
 */
export interface EmbeddingUsageAttempt {
  readonly eventId: string;
  observe(usage: unknown): void;
  observeNormalized(observation: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    costUsd?: number;
    costSource?: ModelUsageCostSource;
    pricingSource?: ModelUsagePricingSource;
    effectiveModelId?: string;
  }): void;
  succeed(usage?: unknown): { eventId: string };
  fail(error: unknown, usage?: unknown): { eventId: string };
  cancel(reason?: unknown): { eventId: string };
}

export interface EmbeddingUsageDispatchReservation {
  readonly eventId: string;
  accept(): EmbeddingUsageAttempt;
  abandon(): void;
  markDispatchUnknown(reason?: string): void;
}

export interface EmbeddingUsageDispatchInput {
  source: "embedding_runtime";
  attribution: ModelUsageAttributionContext;
  requestedProviderId?: string;
  requestedModelId?: string;
  effectiveProviderId: Exclude<EmbeddingProviderId, "pseudo">;
  effectiveModelId: string;
  effectiveApiStyle: "llamacpp_embedding" | "openai_embeddings";
  transportAttemptIndex: number;
  credential: {
    credentialType: ModelUsageCredentialType;
    usagePool: ModelUsagePool;
    credentialSource: ModelUsageCredentialSource;
  };
  pricing?: {
    catalogVersion?: string;
    catalogHash?: string;
    inputRateUsdPerMillion?: number;
    outputRateUsdPerMillion?: number;
    cachedInputRateUsdPerMillion?: number;
  };
}

export type PrepareEmbeddingUsageDispatch = (
  input: EmbeddingUsageDispatchInput,
) => EmbeddingUsageDispatchReservation | undefined;

/**
 * Canonical usage ownership or settlement could not be persisted. This must
 * fail closed instead of looking like an ordinary best-effort pseudo fallback;
 * any retained intent/accepted record remains recoverable by the accounting
 * owner's lease-recovery path.
 */
export class EmbeddingUsageSettlementError extends Error {
  public constructor(cause: unknown) {
    super("Embedding usage accounting persistence failed", { cause });
    this.name = "EmbeddingUsageSettlementError";
  }
}

export interface EmbeddingRuntimeOptions {
  purpose: EmbeddingLeasePurpose;
  signal?: AbortSignal;
  acquireLocalServiceLease?: AcquireLocalEmbeddingLease;
  /** Stable caller lineage for the logical embedding operation. */
  modelUsageAttribution?: ModelUsageAttributionContext;
  /** Canonical pre-fetch intent owner, normally bound by GatewayService. */
  prepareModelUsageDispatch?: PrepareEmbeddingUsageDispatch;
  /** Internal transport retry ordinal; the current runtime performs no retries. */
  transportAttemptIndex?: number;
}

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
  /** Canonical provider-attempt references for provenance linking. */
  modelUsageEventIds?: string[];
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

// A single-input embedding response is one vector (even 8192 dims ≈ ~200 KB of
// JSON floats). 2 MiB matches DEFAULT_FETCH_MAX_RESPONSE_BYTES with >10x headroom.
const MAX_EMBEDDINGS_RESPONSE_BYTES = 2 * 1024 * 1024;
const LOCAL_EMBEDDING_ZERO_PRICING = Object.freeze({
  catalogVersion: "goatcitadel-local-embedding-zero-v1",
  // SHA-256 of the frozen canonical payload
  // {"cachedInputRateUsdPerMillion":0,"inputRateUsdPerMillion":0,"outputRateUsdPerMillion":0}.
  catalogHash: "6b36ae888f77a29b1bb877cbfad5abbe9b0b19490164945f405da1e32aca2e56",
  inputRateUsdPerMillion: 0,
  outputRateUsdPerMillion: 0,
  cachedInputRateUsdPerMillion: 0,
});

/**
 * Generate an embedding for `text` using the configured provider, stamping the
 * resulting vector with the resolved profile (provider/modelId/version/
 * dimensions) so `isEmbeddingCurrent` validates correctly and the W1 store +
 * retrieve paths share one consistent dimensionality.
 *
 * The original first three arguments remain compatible with the pseudo-only
 * era. W1 callers already `await` it, so adding network I/O and the optional
 * request-scoped runtime options is transparent. On missing config or provider
 * error the call resolves to a pseudo embedding. An explicit caller abort or
 * canonical usage-settlement failure rejects.
 */
export async function generateEmbedding(
  text: string,
  now = new Date(),
  request?: MemoryEmbeddingProfileRequest,
  runtimeOptions?: EmbeddingRuntimeOptions,
): Promise<GeneratedEmbedding> {
  throwIfCallerAborted(runtimeOptions?.signal);
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
    const generated = await generateRealEmbedding(providerId, text, now, realProfile, runtimeOptions);
    if (generated) {
      return generated;
    }
  } catch (error) {
    if (error instanceof ConflictError || error instanceof EmbeddingUsageSettlementError) {
      throw error;
    }
    throwIfCallerAborted(runtimeOptions?.signal);
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
  runtimeOptions?: EmbeddingRuntimeOptions,
): Promise<GeneratedEmbedding | undefined> {
  const config = resolveRealProviderConfig(providerId);
  if (!config) {
    return undefined;
  }
  throwIfCallerAborted(runtimeOptions?.signal);
  const lease =
    providerId === "llamacpp" && runtimeOptions?.acquireLocalServiceLease
      ? await runtimeOptions.acquireLocalServiceLease({
          providerId: "llamacpp",
          url: config.url,
          purpose: runtimeOptions.purpose,
          ...(runtimeOptions.signal ? { signal: runtimeOptions.signal } : {}),
        })
      : undefined;
  let dispatched: EmbeddingProviderFetch | undefined;
  let settlementStarted = false;
  try {
    throwIfCallerAborted(runtimeOptions?.signal);
    dispatched =
      providerId === "llamacpp"
        ? await fetchLlamaCppEmbedding(config, text, runtimeOptions)
        : await fetchRemoteEmbedding(config, text, runtimeOptions);
    if (dispatched.usage !== undefined) {
      dispatched.attempt?.observe(dispatched.usage);
    }
    if (dispatched.reportedModelId) {
      dispatched.attempt?.observeNormalized({ effectiveModelId: dispatched.reportedModelId });
    }
    const embedding = sanitizeEmbeddingVector(dispatched.rawVector);
    if (!embedding || embedding.length !== profile.dimensions) {
      // Dimension mismatch (or empty/invalid vector) would poison cosine
      // similarity against existing vectors — refuse and let the caller fall back.
      throw new Error(
        embedding
          ? `embedding-dimension-mismatch: expected ${profile.dimensions}, received ${embedding.length}`
          : "embedding-invalid-vector",
      );
    }
    throwIfCallerAborted(runtimeOptions?.signal);
    let terminal: { eventId: string } | undefined;
    if (dispatched.attempt) {
      settlementStarted = true;
      try {
        terminal = dispatched.attempt.succeed();
      } catch (error) {
        throw new EmbeddingUsageSettlementError(error);
      }
    }
    return {
      embedding,
      profile,
      method: providerId === "llamacpp" ? "llamacpp-embedding" : "remote-embedding",
      ...(terminal ? { modelUsageEventIds: [terminal.eventId] } : {}),
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
  } catch (error) {
    if (dispatched?.attempt && !settlementStarted) {
      try {
        if (runtimeOptions?.signal?.aborted) {
          dispatched.attempt.cancel(runtimeOptions.signal.reason ?? error);
        } else {
          dispatched.attempt.fail(error);
        }
      } catch (settlementError) {
        throw asEmbeddingUsageSettlementError(settlementError);
      }
    }
    throw error;
  } finally {
    await releaseEmbeddingLease(lease);
  }
}

interface RealProviderConfig {
  url: string;
  modelId: string;
  apiKey?: string;
  timeoutMs: number;
}

interface EmbeddingProviderFetch {
  rawVector: unknown;
  usage?: unknown;
  reportedModelId?: string;
  attempt?: EmbeddingUsageAttempt;
}

interface EmbeddingJsonFetch {
  payload: unknown;
  attempt?: EmbeddingUsageAttempt;
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

async function fetchLlamaCppEmbedding(
  config: RealProviderConfig,
  text: string,
  runtimeOptions?: EmbeddingRuntimeOptions,
): Promise<EmbeddingProviderFetch> {
  const fetched = await fetchEmbeddingJson("llamacpp", config, runtimeOptions, {
    body: { content: text },
  });
  const payload = fetched.payload;
  // llama.cpp returns `{ embedding: number[] }` or, with newer builds,
  // `[{ embedding: number[] }]` / `{ data: [{ embedding }] }`.
  return {
    rawVector:
      pickEmbeddingArray(payload) ??
      pickEmbeddingArray(firstArrayItem(payload)) ??
      pickEmbeddingArray(firstDataItem(payload)),
    ...extractEmbeddingUsage(payload),
    ...(fetched.attempt ? { attempt: fetched.attempt } : {}),
  };
}

async function fetchRemoteEmbedding(
  config: RealProviderConfig,
  text: string,
  runtimeOptions?: EmbeddingRuntimeOptions,
): Promise<EmbeddingProviderFetch> {
  const fetched = await fetchEmbeddingJson("remote", config, runtimeOptions, {
    body: { model: config.modelId, input: text },
  });
  const payload = fetched.payload;
  // OpenAI-compatible shape: `{ data: [{ embedding: number[] }] }`.
  return {
    rawVector: pickEmbeddingArray(firstDataItem(payload)) ?? pickEmbeddingArray(payload),
    ...extractEmbeddingUsage(payload),
    ...(fetched.attempt ? { attempt: fetched.attempt } : {}),
  };
}

async function fetchEmbeddingJson(
  providerId: Exclude<EmbeddingProviderId, "pseudo">,
  config: RealProviderConfig,
  runtimeOptions: EmbeddingRuntimeOptions | undefined,
  options: { body: Record<string, unknown> },
): Promise<EmbeddingJsonFetch> {
  throwIfCallerAborted(runtimeOptions?.signal);
  let reservation: EmbeddingUsageDispatchReservation | undefined;
  try {
    reservation = runtimeOptions?.prepareModelUsageDispatch?.(
      buildEmbeddingUsageDispatchInput(providerId, config, runtimeOptions),
    );
  } catch (error) {
    throw asEmbeddingUsageSettlementError(error);
  }
  const dispatchController = new AbortController();
  let responsePromise: Promise<Response>;
  try {
    responsePromise = fetch(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(options.body),
      signal: combineAbortSignal(runtimeOptions?.signal, config.timeoutMs, dispatchController.signal),
    });
  } catch (error) {
    try {
      reservation?.abandon();
    } catch (settlementError) {
      throw asEmbeddingUsageSettlementError(settlementError);
    }
    throw error;
  }

  let attempt: EmbeddingUsageAttempt | undefined;
  try {
    attempt = reservation?.accept();
  } catch (error) {
    try {
      try {
        reservation?.markDispatchUnknown("embedding_transport_acceptance_persistence_failed");
      } catch (settlementError) {
        throw asEmbeddingUsageSettlementError(settlementError);
      }
    } finally {
      dispatchController.abort(error);
      void Promise.resolve(responsePromise).catch(() => undefined);
    }
    throw asEmbeddingUsageSettlementError(error);
  }

  try {
    const response = await responsePromise;
    if (!response.ok) {
      throw new Error(`embedding-http-${response.status}`);
    }
    const payload = await readBoundedResponseJson(response, {
      maxBytes: MAX_EMBEDDINGS_RESPONSE_BYTES,
      timeoutMs: config.timeoutMs,
    });
    return { payload, ...(attempt ? { attempt } : {}) };
  } catch (error) {
    if (attempt) {
      try {
        if (runtimeOptions?.signal?.aborted) {
          attempt.cancel(runtimeOptions.signal.reason ?? error);
        } else {
          attempt.fail(error);
        }
      } catch (settlementError) {
        throw asEmbeddingUsageSettlementError(settlementError);
      }
    }
    throw error;
  }
}

function combineAbortSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  dispatchSignal?: AbortSignal,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signals = [timeoutSignal, ...(signal ? [signal] : []), ...(dispatchSignal ? [dispatchSignal] : [])];
  return signals.length === 1 ? timeoutSignal : AbortSignal.any(signals);
}

function buildEmbeddingUsageDispatchInput(
  providerId: Exclude<EmbeddingProviderId, "pseudo">,
  config: RealProviderConfig,
  runtimeOptions: EmbeddingRuntimeOptions,
): EmbeddingUsageDispatchInput {
  const attribution: ModelUsageAttributionContext = {
    ...runtimeOptions.modelUsageAttribution,
    callKind: "embedding",
    utilityKind: runtimeOptions.modelUsageAttribution?.utilityKind ?? runtimeOptions.purpose,
  };
  return {
    source: "embedding_runtime",
    attribution,
    requestedProviderId: attribution.requestedProviderId ?? providerId,
    requestedModelId: attribution.requestedModelId ?? config.modelId,
    effectiveProviderId: providerId,
    effectiveModelId: config.modelId,
    effectiveApiStyle: providerId === "llamacpp" ? "llamacpp_embedding" : "openai_embeddings",
    transportAttemptIndex: normalizeTransportAttemptIndex(runtimeOptions.transportAttemptIndex),
    credential:
      providerId === "llamacpp"
        ? { credentialType: "unknown", usagePool: "local", credentialSource: "none" }
        : {
            credentialType: config.apiKey ? "api_key" : "unknown",
            usagePool: "standard",
            credentialSource: config.apiKey ? "env" : "none",
          },
    ...(providerId === "llamacpp" ? { pricing: LOCAL_EMBEDDING_ZERO_PRICING } : {}),
  };
}

function normalizeTransportAttemptIndex(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function extractEmbeddingUsage(payload: unknown): Pick<EmbeddingProviderFetch, "usage" | "reportedModelId"> {
  if (!isRecord(payload)) {
    return {};
  }
  const usage = isRecord(payload.usage) ? payload.usage : undefined;
  const reportedModelId = optionalString(payload.model);
  return {
    ...(usage ? { usage } : {}),
    ...(reportedModelId ? { reportedModelId } : {}),
  };
}

function throwIfCallerAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  const error = new Error("Embedding generation was aborted");
  error.name = "AbortError";
  throw error;
}

function asEmbeddingUsageSettlementError(cause: unknown): EmbeddingUsageSettlementError {
  return cause instanceof EmbeddingUsageSettlementError ? cause : new EmbeddingUsageSettlementError(cause);
}

async function releaseEmbeddingLease(lease: LocalEmbeddingRuntimeLease | undefined): Promise<void> {
  if (!lease) {
    return;
  }
  try {
    await lease.release();
  } catch {
    // Cleanup must not replace a valid vector or the provider error that caused
    // a best-effort pseudo fallback.
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
