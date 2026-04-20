import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    idempotencyKey: string;
    mutationIdempotencyState?: {
      method: string;
      routePath: string;
      idempotencyKey: string;
      actorScope: string;
    } | null;
  }
}
