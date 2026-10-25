import type { FastifyRequest } from "fastify";

const DEFAULT_ALLOWED_ORIGINS =
  "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173,http://127.0.0.1:8787";

/** The caller's Mission Control origin, only when it is one of the configured allowed origins. */
export function allowedRequestOrigin(request: FastifyRequest): string | undefined {
  const raw = request.headers.origin || request.headers.referer;
  if (typeof raw !== "string") return undefined;
  try {
    const origin = new URL(raw).origin;
    const allowed = (process.env.GOATCITADEL_ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS)
      .split(",")
      .map((value) => value.trim());
    return allowed.includes(origin) ? origin : undefined;
  } catch {
    return undefined;
  }
}
