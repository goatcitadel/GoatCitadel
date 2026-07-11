import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    idempotencyKey: string;
    mutationCommitted: boolean;
    mutationIdempotencyState?: {
      method: string;
      routePath: string;
      idempotencyKey: string;
      actorScope: string;
    } | null;
  }
}
