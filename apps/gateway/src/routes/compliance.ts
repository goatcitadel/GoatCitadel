import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { withRouteAccess } from "./route-access.js";

const exportBodySchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  fromTs: z.string().trim().min(1),
  toTs: z.string().trim().min(1),
  limit: z.number().int().positive().optional(),
});

// The verify endpoint accepts an arbitrary posted bundle; the service validates its structure and
// returns { valid, reasons, perReceipt } rather than throwing, so we only require a JSON object here.
const verifyBodySchema = z.object({}).passthrough();

export const complianceRoutes: FastifyPluginAsync = async (fastify) => {
  const operatorOnly = withRouteAccess(fastify, "operator");
  const compliance = fastify.services.compliance;

  // Build + return a signed, offline-verifiable Compliance Bundle for a time range.
  fastify.post("/api/v1/compliance/export", operatorOnly, async (request, reply) => {
    const parsed = exportBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(await compliance.buildComplianceBundle(parsed.data));
    } catch (error) {
      const httpStatus = readHttpStatus(error);
      if (httpStatus) {
        return reply.code(httpStatus).send({ error: errorMessage(error) });
      }
      // Range/timestamp validation failures surface as plain Errors → 400 (operator input problem).
      if (error instanceof Error && isInputValidationError(error)) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  // Verify a posted bundle. Offline/self-contained: no run or DB lookup is performed.
  fastify.post("/api/v1/compliance/verify", operatorOnly, async (request, reply) => {
    const parsed = verifyBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(compliance.verifyComplianceBundle(parsed.data));
  });
};

function isInputValidationError(error: Error): boolean {
  return error.message.includes("fromTs") || error.message.includes("toTs") || error.message.includes("ISO-8601");
}

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
