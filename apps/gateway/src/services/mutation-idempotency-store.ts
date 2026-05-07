import type { Storage } from "@goatcitadel/storage";

export type MutationIdempotencyStore = Pick<Storage["mutationIdempotency"], "claim" | "markCompleted" | "markFailed">;
