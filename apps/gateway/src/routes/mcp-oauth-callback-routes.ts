import type { FastifyInstance } from "fastify";
import { z } from "zod";

export const MCP_OAUTH_CALLBACK_PATH = "/api/v1/mcp/oauth/callback";
/** Mission Control route that receives the hand-off; the code travels only in the URL fragment. */
export const MCP_OAUTH_RETURN_ROUTE = "/settings/connections";
export const MCP_OAUTH_RETURN_FRAGMENT = "mcp-oauth-return";

const RETURN_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_RETURNS = 64;
// Silent logging keeps the authorization code in the query string out of request logs.
const routeOptions = { logLevel: "silent", config: { rateLimit: { max: 60 } } } as const;

const callbackSchema = z
  .object({
    state: z.string().min(1).max(128),
    code: z.string().min(1).max(4096).optional(),
    error: z.string().max(128).optional(),
  })
  .refine((input) => Boolean(input.code) !== Boolean(input.error));

const pendingReturns = new Map<string, { origin: string; expiresAt: number }>();

/**
 * Remembers which allowed Mission Control origin started this sign-in, so the provider's
 * redirect can hand the code back there. This stores no code and grants no authority:
 * the operator still completes the exchange through the reviewed completion step.
 */
export function rememberMcpOAuthReturn(state: string, origin: string | undefined, now = Date.now()): void {
  if (!origin) return;
  for (const [key, entry] of pendingReturns) if (entry.expiresAt <= now) pendingReturns.delete(key);
  if (pendingReturns.size >= MAX_PENDING_RETURNS) pendingReturns.delete(pendingReturns.keys().next().value!);
  pendingReturns.set(state, { origin, expiresAt: now + RETURN_TTL_MS });
}

function takeMcpOAuthReturn(state: string, now = Date.now()): string | undefined {
  const entry = pendingReturns.get(state);
  pendingReturns.delete(state);
  return entry && entry.expiresAt > now ? entry.origin : undefined;
}

export function __resetMcpOAuthReturnsForTests(): void {
  pendingReturns.clear();
}

export function registerMcpOAuthCallbackRoute(fastify: FastifyInstance): void {
  fastify.get(MCP_OAUTH_CALLBACK_PATH, routeOptions, async (request, reply) => {
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
    const parsed = callbackSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).type("text/html").send(renderMcpOAuthCallbackPage("invalid"));
    }
    const origin = takeMcpOAuthReturn(parsed.data.state);
    if (!origin) {
      return reply.code(410).type("text/html").send(renderMcpOAuthCallbackPage("unknown"));
    }
    const fragment = new URLSearchParams({
      state: parsed.data.state,
      ...(parsed.data.code ? { code: parsed.data.code } : { error: parsed.data.error! }),
    });
    return reply.redirect(
      `${origin}${MCP_OAUTH_RETURN_ROUTE}#${MCP_OAUTH_RETURN_FRAGMENT}&${fragment.toString()}`,
      303,
    );
  });
}

function renderMcpOAuthCallbackPage(kind: "invalid" | "unknown"): string {
  const title = kind === "invalid" ? "Sign-in response not recognised" : "Sign-in not found";
  const detail =
    kind === "invalid"
      ? "The provider did not return a usable result. Return to GoatCitadel and start Connect again."
      : "This sign-in was not started from this Gateway session, or it expired. Return to GoatCitadel and start Connect again. " +
        "To finish it by hand, copy the code and state from this page's address bar into the server's OAuth controls in Settings.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;color:#dff7f4;background:#071112}main{max-width:560px;padding:32px;text-align:center}p{color:#9ac7c2;line-height:1.5}</style>
</head><body><main><h1>${title}</h1><p>${detail}</p></main></body></html>`;
}
