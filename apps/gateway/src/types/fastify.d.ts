import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    idempotencyKey: string;
    mutationCommitted: boolean;
    mutationIdempotencyOutcome?: "pending" | "committed" | "failed_before_commit" | null;
    /** Request-local bridge to the claimed persistent mutation row. Never serialize this callback. */
    mutationIdempotencyCommit?: (() => Promise<void>) | null;
    mutationIdempotencyState?: {
      method: string;
      routePath: string;
      idempotencyKey: string;
      actorScope: string;
      claimToken?: string;
    } | null;
  }
}
