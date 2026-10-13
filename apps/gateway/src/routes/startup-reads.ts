import type { FastifyPluginAsync } from "fastify";
import { isStartupReadRequest, STARTUP_READ_BATCH_PATH, STARTUP_READ_BATCH_LIMIT, STARTUP_READ_BATCH_QUERY_LIMIT, STARTUP_READ_BATCH_BODY_LIMIT, type StartupReadResponse } from "@goatcitadel/contracts/startup-reads";
import { withRouteAccess } from "./route-access.js";
const RESPONSE_HEADERS = ["content-type", "cache-control", "etag", "x-goatcitadel-correlation-id"] as const;
/** A bounded GET transport; original route guards, owners and error handlers run for every entry. */
export const startupReadRoutes: FastifyPluginAsync = async fastify => {
  fastify.get(STARTUP_READ_BATCH_PATH, withRouteAccess(fastify, "operator"), async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const query = request.query as Record<string, unknown>;
    if (Object.keys(query).some(key => key !== "reads") || typeof query.reads !== "string" ||
      Buffer.byteLength(request.raw.url ?? "", "utf8") > STARTUP_READ_BATCH_QUERY_LIMIT + 100) return reply.code(400).send({ error: "Invalid startup read batch" });
    let items: unknown;
    try { items = JSON.parse(query.reads); } catch { return reply.code(400).send({ error: "Invalid startup read batch" }); }
    if (!Array.isArray(items) || items.length < 1 || items.length > STARTUP_READ_BATCH_LIMIT || !items.every(isStartupReadRequest)) return reply.code(400).send({ error: "Invalid startup read batch" });
    const forwarded = Object.fromEntries(Object.entries(request.headers).filter(([key, value]) => value !== undefined &&
      !["content-length", "transfer-encoding", "connection", "upgrade", "keep-alive", "te", "trailer", "proxy-authorization", "proxy-authenticate"].includes(key)));
    const cookies: string[] = [];
    const results: StartupReadResponse[] = await Promise.all(items.map(async item => {
      const response = await fastify.inject({ method: "GET", url: item.path,
        // Preserve the actual peer and proxy chain; inject's loopback default must never grant authority.
        remoteAddress: request.raw.socket.remoteAddress ?? request.ip,
        headers: { ...forwarded, "x-goatcitadel-correlation-id": item.correlationId,
          ...(item.originSurface ? { "x-goatcitadel-origin-surface": item.originSurface } : {}) },
      });
      // Cookie material remains in HTTP custody, never in the JSON transport envelope.
      const setCookie = response.headers["set-cookie"];
      if (setCookie) cookies.push(...(Array.isArray(setCookie) ? setCookie : [setCookie]));
      if (Buffer.byteLength(response.payload, "utf8") > STARTUP_READ_BATCH_BODY_LIMIT || response.statusCode >= 300 && response.statusCode < 400) return { status: 409, bodyText: "", headers: {}, directReadRequired: true };
      const headers: Record<string, string> = {};
      for (const key of RESPONSE_HEADERS) { const value = response.headers[key]; if (typeof value === "string") headers[key] = value; }
      return { status: response.statusCode, bodyText: response.payload, headers };
    }));
    if (cookies.length) reply.header("set-cookie", cookies);
    return reply.send({ items: results });
  });
};
