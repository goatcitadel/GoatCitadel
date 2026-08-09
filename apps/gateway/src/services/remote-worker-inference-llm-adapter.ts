import type { ModelUsageAttributionContext, RemoteWorkerInferenceMessage } from "@goatcitadel/contracts";
import type {
  BeginModelUsageDispatchInput,
  ModelUsageCredentialLineage,
  ModelUsagePricingLineage,
} from "@goatcitadel/gateway-core";
import { extractProviderOwnedOutputCapErrorText, resolveOutputCapRecovery } from "./llm-output-cap-recovery.js";
import type { Awaitable } from "./remote-worker-owner-port.js";

/**
 * HX-503 assignment-bound inference LLM adapter (production-dark).
 *
 * Performs one Gateway-selected provider/model dispatch for a claimed inference
 * request. It delegates every attempt/usage/outcome/cost truth to HX-306 (it
 * never recomputes usage or cost) and retains only the existing bounded
 * output-cap recovery behavior: at most one compatible request-shape retry with
 * a safely reduced output cap, following one logical budget. Cross-provider
 * fallback is forbidden in V1.
 *
 * The provider transport is injected so the owner is proven single-host without
 * a live listener. Only classified error codes and provider output text ever
 * leave the adapter; raw provider errors, headers, bodies, private reasoning,
 * and credentials never enter the returned outcome.
 */

export interface RemoteWorkerInferenceProviderResolution {
  readonly providerId: string;
  readonly modelId: string;
  readonly apiStyle: string;
  readonly configuredContextWindowTokens?: number;
  readonly credential: ModelUsageCredentialLineage;
  readonly pricing?: ModelUsagePricingLineage;
}

export interface RemoteWorkerInferenceProviderDispatchInput {
  readonly resolution: RemoteWorkerInferenceProviderResolution;
  readonly messages: readonly RemoteWorkerInferenceMessage[];
  readonly effectiveOutputTokenCap: number;
  readonly reasoningTokenCeiling: number;
  readonly temperatureMilli: number;
  readonly transportAttemptIndex: number;
  readonly signal?: AbortSignal;
}

export interface RemoteWorkerInferenceProviderChunk {
  readonly text: string;
}

export type RemoteWorkerInferenceProviderResult =
  | {
      readonly outcome: "success";
      readonly chunks: readonly RemoteWorkerInferenceProviderChunk[];
      readonly usage?: unknown;
    }
  | { readonly outcome: "output_cap_error"; readonly providerErrorBody: string }
  | { readonly outcome: "error"; readonly errorCode: string }
  | { readonly outcome: "dispatch_unknown"; readonly errorCode: string };

/** Injected provider seam. In V1 tests it is a deterministic double; live wiring is a later row. */
export interface RemoteWorkerInferenceProviderTransport {
  dispatch(input: RemoteWorkerInferenceProviderDispatchInput): Promise<RemoteWorkerInferenceProviderResult>;
}

/** Narrow HX-306 accounting seam, satisfied structurally by ModelUsageAccountingService. */
export interface RemoteWorkerInferenceAccountingHandle {
  observe(usage: unknown): void;
  succeed(usage?: unknown): Awaitable<unknown>;
  fail(error: unknown, usage?: unknown): Awaitable<unknown>;
  cancel(reason?: unknown): Awaitable<unknown>;
}

export interface RemoteWorkerInferenceAccountingReservation {
  readonly eventId: string;
  accept(): Awaitable<RemoteWorkerInferenceAccountingHandle>;
  abandon(): Awaitable<void>;
  markDispatchUnknown(reason?: string): Awaitable<void>;
}

export interface RemoteWorkerInferenceAccountingPort {
  prepareDispatch(input: BeginModelUsageDispatchInput): Awaitable<RemoteWorkerInferenceAccountingReservation>;
}

export interface RemoteWorkerInferenceDispatchRequest {
  readonly attribution: ModelUsageAttributionContext;
  readonly resolution: RemoteWorkerInferenceProviderResolution;
  readonly messages: readonly RemoteWorkerInferenceMessage[];
  /** Worker-supplied output ceiling, preserved across recovery retries. */
  readonly requestedOutputTokenCap: number;
  /** Gateway-effective output cap (min of worker and governance ceilings). */
  readonly effectiveOutputTokenCap: number;
  readonly reasoningTokenCeiling: number;
  readonly temperatureMilli: number;
  readonly signal?: AbortSignal;
}

export type RemoteWorkerInferenceDispatchTerminal = "completed" | "failed" | "cancelled" | "dispatch_unknown";

export interface RemoteWorkerInferenceDispatchOutcome {
  readonly terminalState: RemoteWorkerInferenceDispatchTerminal;
  /** Provider output text chunks delivered to the worker outbox (secret-free). */
  readonly chunks: readonly string[];
  /** HX-306 event id of the settling attempt (consumed, never recomputed). */
  readonly usageEventId: string;
  /** Every HX-306 attempt event id, including recovery attempts. */
  readonly usageEventIds: readonly string[];
  readonly transportAttempts: number;
  /** Classified error code on failure; never a raw provider body. */
  readonly errorCode?: string;
}

const RECOVERY_TOKEN_MULTIPLIER = 1;

export class RemoteWorkerInferenceLlmAdapter {
  public constructor(
    private readonly accounting: RemoteWorkerInferenceAccountingPort,
    private readonly transport: RemoteWorkerInferenceProviderTransport,
  ) {}

  public async dispatch(request: RemoteWorkerInferenceDispatchRequest): Promise<RemoteWorkerInferenceDispatchOutcome> {
    if (request.attribution.callKind !== "delegation_worker") {
      throw new TypeError("Remote worker inference dispatch requires callKind delegation_worker.");
    }
    const usageEventIds: string[] = [];
    let effectiveOutputTokenCap = assertPositive(request.effectiveOutputTokenCap, "effectiveOutputTokenCap");
    let transportAttemptIndex = 0;
    let parentEventId: string | undefined;
    let recoveryRemaining = 1;

    for (;;) {
      const disposition = transportAttemptIndex === 0 ? "initial" : "reduced_retry";
      const reservation = await this.accounting.prepareDispatch({
        source: "llm_service",
        attribution: request.attribution,
        effectiveProviderId: request.resolution.providerId,
        effectiveModelId: request.resolution.modelId,
        effectiveApiStyle: request.resolution.apiStyle,
        transportAttemptIndex,
        credential: request.resolution.credential,
        ...(request.resolution.pricing ? { pricing: request.resolution.pricing } : {}),
        outputCap: {
          requestedOutputTokenCap: request.requestedOutputTokenCap,
          effectiveOutputTokenCap,
          disposition,
        },
        ...(parentEventId ? { transportRetry: { parentEventId, reason: "output_cap_recovery" as const } } : {}),
      });
      usageEventIds.push(reservation.eventId);

      let pending: Promise<RemoteWorkerInferenceProviderResult>;
      try {
        pending = this.transport.dispatch({
          resolution: request.resolution,
          messages: request.messages,
          effectiveOutputTokenCap,
          reasoningTokenCeiling: request.reasoningTokenCeiling,
          temperatureMilli: request.temperatureMilli,
          transportAttemptIndex,
          ...(request.signal ? { signal: request.signal } : {}),
        });
      } catch (error) {
        // The transport threw before a durable network attempt was accepted.
        await reservation.abandon();
        return this.failure("failed", usageEventIds, transportAttemptIndex + 1, classifyThrow(error, request.signal));
      }

      let handle: RemoteWorkerInferenceAccountingHandle;
      try {
        handle = await reservation.accept();
      } catch {
        // The provider may have accepted the request, but the canonical attempt
        // fence did not persist. Never await, retry, or expose that result.
        void pending.catch(() => undefined);
        await reservation.markDispatchUnknown();
        return this.failure(
          "dispatch_unknown",
          usageEventIds,
          transportAttemptIndex + 1,
          "transport_acceptance_persistence_failed",
        );
      }

      let result: RemoteWorkerInferenceProviderResult;
      try {
        result = await pending;
      } catch (error) {
        await handle.fail(error);
        return this.failure("failed", usageEventIds, transportAttemptIndex + 1, classifyThrow(error, request.signal));
      }

      if (result.outcome === "success") {
        handle.observe(result.usage ?? {});
        await handle.succeed();
        return {
          terminalState: "completed",
          chunks: result.chunks.map((chunk) => chunk.text),
          usageEventId: reservation.eventId,
          usageEventIds,
          transportAttempts: transportAttemptIndex + 1,
        };
      }

      if (result.outcome === "output_cap_error") {
        await handle.fail(new Error("provider_output_cap"));
        if (recoveryRemaining > 0) {
          const errorText = extractProviderOwnedOutputCapErrorText(result.providerErrorBody);
          const decision = errorText
            ? resolveOutputCapRecovery({
                errorText,
                requestedOutputTokenCap: request.requestedOutputTokenCap,
                effectiveOutputTokenCap,
                ...(request.resolution.configuredContextWindowTokens === undefined
                  ? {}
                  : { configuredContextWindowTokens: request.resolution.configuredContextWindowTokens }),
                requestPayload: { messages: request.messages, temperatureMilli: request.temperatureMilli },
                tokenMultiplier: RECOVERY_TOKEN_MULTIPLIER,
              })
            : ({ retry: false, reasonCode: "not_output_cap_error" } as const);
          if (decision.retry) {
            parentEventId = reservation.eventId;
            effectiveOutputTokenCap = decision.effectiveOutputTokenCap;
            transportAttemptIndex += 1;
            recoveryRemaining -= 1;
            continue;
          }
        }
        return this.failure("failed", usageEventIds, transportAttemptIndex + 1, "output_cap");
      }

      if (result.outcome === "dispatch_unknown") {
        await handle.fail(new Error(result.errorCode));
        return this.failure(
          "dispatch_unknown",
          usageEventIds,
          transportAttemptIndex + 1,
          sanitizeCode(result.errorCode),
        );
      }

      await handle.fail(new Error(result.errorCode));
      return this.failure("failed", usageEventIds, transportAttemptIndex + 1, sanitizeCode(result.errorCode));
    }
  }

  private failure(
    terminalState: Exclude<RemoteWorkerInferenceDispatchTerminal, "completed">,
    usageEventIds: readonly string[],
    transportAttempts: number,
    errorCode: string,
  ): RemoteWorkerInferenceDispatchOutcome {
    return {
      terminalState,
      chunks: [],
      usageEventId: usageEventIds[usageEventIds.length - 1]!,
      usageEventIds,
      transportAttempts,
      errorCode,
    };
  }
}

function classifyThrow(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted) return "cancelled";
  if (error instanceof Error && (error.name === "AbortError" || /\b(?:abort|cancel)/iu.test(error.message))) {
    return "cancelled";
  }
  return "transport_error";
}

function sanitizeCode(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "_")
    .slice(0, 80);
  return normalized || "provider_error";
}

function assertPositive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`Remote worker inference ${field} must be a positive integer.`);
  }
  return value;
}
