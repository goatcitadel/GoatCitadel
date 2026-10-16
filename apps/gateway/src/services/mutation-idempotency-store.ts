import type { AsyncStorage as Storage } from "@goatcitadel/storage";

export interface MutationIdempotencyStore {
  claim(
    input: Parameters<Storage["mutationIdempotency"]["claim"]>[0],
  ): ReturnType<Storage["mutationIdempotency"]["claim"]>;
  markCompleted(
    input: Parameters<Storage["mutationIdempotency"]["markCompleted"]>[0],
  ): ReturnType<Storage["mutationIdempotency"]["markCompleted"]>;
  markFailed(
    input: Parameters<Storage["mutationIdempotency"]["markFailed"]>[0],
  ): ReturnType<Storage["mutationIdempotency"]["markFailed"]>;
  /** Reads one recorded attempt; used only for the caller-scoped attempt outcome read. */
  get?(
    input: Parameters<Storage["mutationIdempotency"]["get"]>[0],
  ): ReturnType<Storage["mutationIdempotency"]["get"]> | Awaited<ReturnType<Storage["mutationIdempotency"]["get"]>>;
  discardPending?(
    input: Parameters<Storage["mutationIdempotency"]["discardPending"]>[0],
  ): ReturnType<Storage["mutationIdempotency"]["discardPending"]>;
  /** Dispatch fence; external side-effect runs apply their default takeover lease only when present. */
  markDispatched?(
    input: Parameters<Storage["mutationIdempotency"]["markDispatched"]>[0],
  ): ReturnType<Storage["mutationIdempotency"]["markDispatched"]>;
  markUnknownAfterSend?(
    input: Parameters<Storage["mutationIdempotency"]["markUnknownAfterSend"]>[0],
  ): ReturnType<Storage["mutationIdempotency"]["markUnknownAfterSend"]>;
}
