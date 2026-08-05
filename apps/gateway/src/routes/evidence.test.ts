import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { evidenceRoutes } from "./evidence.js";

describe("evidence routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  function buildApp(evidence: Record<string, unknown>): FastifyInstance {
    const built = Fastify();
    built.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
    built.decorate("services", { evidence } as never);
    return built;
  }

  it("forwards workspace envelope filters to the evidence service", async () => {
    const listEnvelopes = vi.fn(async () => [{ envelopeId: "env-a", eventKind: "memory_write" }]);
    app = buildApp({ listEnvelopes });
    await app.register(evidenceRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/evidence/envelopes?workspaceId=workspace-a&limit=12",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [{ envelopeId: "env-a", eventKind: "memory_write" }] });
    expect(listEnvelopes).toHaveBeenCalledWith({ workspaceId: "workspace-a", limit: 12 });
  });
});
