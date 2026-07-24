import type { AcquireLocalEmbeddingLease, LocalEmbeddingLeaseRequest } from "@goatcitadel/policy-engine";
import type { LlmLocalServiceLease, LlmLocalServiceLeaseRequest } from "./llm-service.js";
import { normalizeLlamaCppProviderBaseUrl, type LlamaCppRuntimeService } from "./llama-cpp-runtime-service.js";

export interface BoundLlamaCppLeaseInput {
  request: LlmLocalServiceLeaseRequest;
  configuredBaseUrl: string;
  runtime: Pick<LlamaCppRuntimeService, "acquireLease">;
}

export interface BoundLlamaCppEmbeddingLeaseInput {
  request: LocalEmbeddingLeaseRequest;
  configuredBaseUrl: string;
  runtime: Pick<LlamaCppRuntimeService, "acquireLease">;
}

/**
 * Bind a provider request to the one configured llama.cpp runtime before it
 * can create process demand. Provider aliases, alternate ports/paths, URL
 * credentials, and query/hash variants never acquire the host-owned service.
 */
export async function acquireBoundLlamaCppLease(
  input: BoundLlamaCppLeaseInput,
): Promise<LlmLocalServiceLease | undefined> {
  if (input.request.providerId.trim().toLowerCase() !== "llamacpp") {
    return undefined;
  }
  const requestedEndpoint = canonicalProviderEndpoint(input.request.baseUrl);
  const configuredEndpoint = canonicalProviderEndpoint(input.configuredBaseUrl);
  if (!requestedEndpoint || !configuredEndpoint || requestedEndpoint !== configuredEndpoint) {
    return undefined;
  }
  return input.runtime.acquireLease(
    { purpose: input.request.purpose },
    input.request.signal ? { signal: input.request.signal } : undefined,
  );
}

const LLAMACPP_EMBEDDING_PATHS = new Set(["/embedding", "/v1/embeddings"]);

/** Bind the explicit llama embedding transport to the configured runtime origin. */
export const acquireBoundLlamaCppEmbeddingLease: (
  input: BoundLlamaCppEmbeddingLeaseInput,
) => ReturnType<AcquireLocalEmbeddingLease> = async (input) => {
  if (input.request.providerId.trim().toLowerCase() !== "llamacpp") {
    return undefined;
  }
  const requested = canonicalEmbeddingEndpoint(input.request.url);
  const configured = canonicalProviderEndpoint(input.configuredBaseUrl);
  if (!requested || !configured || requested.origin !== new URL(configured).origin.toLowerCase()) {
    return undefined;
  }
  return input.runtime.acquireLease(
    { purpose: input.request.purpose },
    input.request.signal ? { signal: input.request.signal } : undefined,
  );
};

function canonicalProviderEndpoint(raw: string): string | undefined {
  try {
    const parsed = new URL(normalizeLlamaCppProviderBaseUrl(raw));
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return undefined;
    }
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.origin.toLowerCase()}${pathname}`;
  } catch {
    return undefined;
  }
}

function canonicalEmbeddingEndpoint(raw: string): { origin: string; pathname: string } | undefined {
  try {
    const parsed = new URL(raw);
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !LLAMACPP_EMBEDDING_PATHS.has(pathname.toLowerCase())
    ) {
      return undefined;
    }
    return { origin: parsed.origin.toLowerCase(), pathname };
  } catch {
    return undefined;
  }
}
