import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { RuntimeRepairSweepSnapshot } from "@goatcitadel/contracts";
import { runtimeRepairsRoutes } from "./runtime-repairs.js";

const snapshot: RuntimeRepairSweepSnapshot = {
  mode: "detect_only",
  ready: true,
  lastTickAt: "2026-11-27T12:00:00.000Z",
  detectors: [{ detectorId: "durable.dead-letter", lastRunAt: "2026-11-27T12:00:00.000Z", truncated: false }],
  open: [],
  recentlyCleared: [],
};

function readHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

describe("runtime repair routes", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function buildApp(service = { snapshot: vi.fn(() => snapshot) }) {
    const next = Fastify();
    next.decorate("gatewayConfig", { assistant: { auth: { mode: "token" } } } as never);
    next.decorateRequest("authActorId", "anonymous");
    next.decorateRequest("authActorSource", "none");
    next.addHook("onRequest", async (request) => {
      const source = readHeader(request, "x-test-auth-source");
      request.authActorSource = ["token", "basic", "loopback", "device"].includes(source ?? "")
        ? (source as FastifyRequest["authActorSource"])
        : "none";
      request.authActorId = readHeader(request, "x-test-auth-actor") ?? "anonymous";
    });
    next.decorate("requireOperatorAuth", async (request: FastifyRequest, reply: FastifyReply) => {
      if (["token", "basic", "loopback"].includes(request.authActorSource)) return;
      return reply.code(403).send({ error: "Operator authentication is required." });
    });
    await next.register(runtimeRepairsRoutes, { service });
    app = next;
    return { app: next, service };
  }

  it("returns the sweep snapshot to an operator without caching it", async () => {
    const { app: next, service } = await buildApp();
    const response = await next.inject({
      method: "GET",
      url: "/api/v1/ops/runtime-repairs",
      headers: { "x-test-auth-source": "token", "x-test-auth-actor": "operator:request" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual(snapshot);
    expect(service.snapshot).toHaveBeenCalledTimes(1);
  });

  it.each(["none", "device"])("rejects a %s principal", async (source) => {
    const { app: next, service } = await buildApp();
    const response = await next.inject({
      method: "GET",
      url: "/api/v1/ops/runtime-repairs",
      headers: { "x-test-auth-source": source },
    });
    expect(response.statusCode).toBe(403);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(service.snapshot).not.toHaveBeenCalled();
  });

  it("offers no way to change anything", async () => {
    const { app: next } = await buildApp();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const response = await next.inject({
        method,
        url: "/api/v1/ops/runtime-repairs",
        headers: { "x-test-auth-source": "token" },
      });
      expect(response.statusCode).toBe(404);
    }
  });

  it("refuses to register without a service", async () => {
    const next = Fastify();
    await expect(next.register(runtimeRepairsRoutes, { service: undefined as never }).ready()).rejects.toThrow(
      "explicit service",
    );
    await next.close();
  });
});
