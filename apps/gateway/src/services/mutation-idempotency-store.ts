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
  discardPending?(
    input: Parameters<Storage["mutationIdempotency"]["discardPending"]>[0],
  ): ReturnType<Storage["mutationIdempotency"]["discardPending"]>;
}
