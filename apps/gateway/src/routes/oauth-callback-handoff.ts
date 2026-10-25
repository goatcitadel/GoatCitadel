import type { FastifyInstance } from "fastify";
import { z } from "zod";

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

export interface OAuthCallbackHandoffOptions {
  /** Public Gateway path the provider redirects to. */
  path: string;
  /** Mission Control route that receives the hand-off; the code travels only in the URL fragment. */
  returnRoute: string;
  fragment: string;
  /** Extra guidance on the page shown for an unknown or expired sign-in. */
  unknownHint?: string;
}

export interface OAuthCallbackHandoff {
  /**
   * Remembers which allowed Mission Control origin started this sign-in, so the provider's
   * redirect can hand the code back there. This stores no code and grants no authority: the
   * operator still completes the exchange through an authenticated completion request.
   */
  remember(state: string, origin: string | undefined, now?: number): void;
  register(fastify: FastifyInstance): void;
  reset(): void;
}

/** The MCP and Google sign-in redirects share one hand-off: exchange nothing, forward the result in a fragment. */
export function createOAuthCallbackHandoff(options: OAuthCallbackHandoffOptions): OAuthCallbackHandoff {
  const pendingReturns = new Map<string, { origin: string; expiresAt: number }>();
  const take = (state: string, now = Date.now()): string | undefined => {
    const entry = pendingReturns.get(state);
    pendingReturns.delete(state);
    return entry && entry.expiresAt > now ? entry.origin : undefined;
  };
  return {
    remember(state, origin, now = Date.now()) {
      if (!origin) return;
      for (const [key, entry] of pendingReturns) if (entry.expiresAt <= now) pendingReturns.delete(key);
      if (pendingReturns.size >= MAX_PENDING_RETURNS) pendingReturns.delete(pendingReturns.keys().next().value!);
      pendingReturns.set(state, { origin, expiresAt: now + RETURN_TTL_MS });
    },
    register(fastify) {
      fastify.get(options.path, routeOptions, async (request, reply) => {
        reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
        const parsed = callbackSchema.safeParse(request.query);
        if (!parsed.success) {
          return reply.code(400).type("text/html").send(renderOAuthCallbackPage("invalid", options.unknownHint));
        }
        const origin = take(parsed.data.state);
        if (!origin) {
          return reply.code(410).type("text/html").send(renderOAuthCallbackPage("unknown", options.unknownHint));
        }
        const fragment = new URLSearchParams({
          state: parsed.data.state,
          ...(parsed.data.code ? { code: parsed.data.code } : { error: parsed.data.error! }),
        });
        return reply.redirect(`${origin}${options.returnRoute}#${options.fragment}&${fragment.toString()}`, 303);
      });
    },
    reset() {
      pendingReturns.clear();
    },
  };
}

function renderOAuthCallbackPage(kind: "invalid" | "unknown", unknownHint?: string): string {
  const title = kind === "invalid" ? "Sign-in response not recognised" : "Sign-in not found";
  const detail =
    kind === "invalid"
      ? "The provider did not return a usable result. Return to GoatCitadel and start Connect again."
      : `This sign-in was not started from this Gateway session, or it expired. Return to GoatCitadel and start Connect again.${unknownHint ? ` ${unknownHint}` : ""}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;color:#dff7f4;background:#071112}main{max-width:560px;padding:32px;text-align:center}p{color:#9ac7c2;line-height:1.5}</style>
</head><body><main><h1>${title}</h1><p>${detail}</p></main></body></html>`;
}
