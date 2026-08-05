import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { NotFoundError } from "@goatcitadel/contracts";
import { withRouteAccess } from "./route-access.js";

const runParamsSchema = z.object({
  runId: z.string().trim().min(1),
});

// The verify endpoint accepts an arbitrary posted receipt; the service validates its structure and
// returns { valid, reasons } rather than throwing, so we only require a JSON object here.
const verifyBodySchema = z.object({}).passthrough();

export const evidenceReceiptsRoutes: FastifyPluginAsync = async (fastify) => {
  const operatorOnly = withRouteAccess(fastify, "operator");
  const evidenceReceipts = fastify.services.evidenceReceipts;

  // Build + return a signed Evidence Receipt for a run.
  fastify.post("/api/v1/runs/:runId/evidence-receipt", operatorOnly, async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await evidenceReceipts.buildEvidenceReceipt(params.data.runId));
    } catch (error) {
      if (error instanceof NotFoundError) {
        return reply.code(404).send({ error: error.message });
      }
      const httpStatus = readHttpStatus(error);
      if (httpStatus) {
        return reply.code(httpStatus).send({ error: errorMessage(error) });
      }
      throw error;
    }
  });

  // Verify a posted receipt. Offline/self-contained: no run or DB lookup is performed.
  fastify.post("/api/v1/evidence-receipts/verify", operatorOnly, async (request, reply) => {
    const parsed = verifyBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(evidenceReceipts.verifyEvidenceReceipt(parsed.data));
  });
};

function readHttpStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "httpStatus" in error) {
    const status = (error as { httpStatus?: unknown }).httpStatus;
    if (typeof status === "number" && status >= 400 && status <= 599) {
      return status;
    }
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
