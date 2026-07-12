import type { Storage } from "@goatcitadel/storage";

export interface MutationIdempotencyStore {
  claim(
    input: Parameters<Storage["mutationIdempotency"]["claim"]>[0],
  ): ReturnType<Storage["mutationIdempotency"]["claim"]>;
  markCompleted(input: Parameters<Storage["mutationIdempotency"]["markCompleted"]>[0]): boolean | void;
  markFailed(input: Parameters<Storage["mutationIdempotency"]["markFailed"]>[0]): boolean | void;
}
