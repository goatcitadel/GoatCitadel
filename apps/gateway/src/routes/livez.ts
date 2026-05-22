import type { FastifyPluginAsync } from "fastify";

/**
 * Minimal "is this Fastify process up and accepting HTTP?" probe.
 *
 * Distinct from `/health` because /health takes a fresh database snapshot on
 * every request, which means /health can return non-200 (or hang) while the
 * gateway process itself is fine — for example during bundled Postgres
 * recovery, or when a transient query stall is in flight.
 *
 * `/livez` deliberately touches no services and performs no I/O, so:
 *   - The supervisor can use it as a fast "process is responding" signal
 *     separate from the "fully ready" signal that /health provides.
 *   - External monitoring can distinguish "gateway is dead, restart it" from
 *     "gateway is up, database is degraded".
 *
 * Process uptime is included so callers can correlate the response with a
 * particular boot generation without needing to scrape logs.
 */
export const livezRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/livez",
    {
      // Liveness probes are not user mutations; rate limiting them is hostile
      // to monitoring. Allow unlimited polling.
      config: { rateLimit: false },
    },
    async () => ({
      status: "ok",
      service: "gateway",
      uptimeSeconds: Math.round(process.uptime()),
    }),
  );
};
