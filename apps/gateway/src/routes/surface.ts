import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { SurfaceClassifyResponse } from "@goatcitadel/contracts";
import { classifySurfaceHeuristic } from "../services/surface-router-heuristics.js";

const bodySchema = z.object({
  prompt: z.string(),
  workspaceId: z.string().trim().optional(),
  citadelId: z.string().trim().optional(),
  hasBoundProject: z.boolean().optional(),
});

/**
 * Read-only surface classifier endpoint.
 *
 * Calls classifySurfaceHeuristic only — no trace, no LLM judge, no persistence.
 * This is a preview/pre-flight endpoint for clients that want to preview which
 * surface a given prompt would route to before sending a full turn.
 */
export const surfaceRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/api/v1/surface/classify", async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const c = classifySurfaceHeuristic(parsed.data.prompt, {
      hasBoundProject: parsed.data.hasBoundProject ?? false,
    });
    const result: SurfaceClassifyResponse = {
      mode: c.mode,
      confidence: c.confidence,
      source: c.source,
      rationale: c.rationale,
      alternatives: c.alternatives,
    };
    return reply.code(200).send(result);
  });
};
